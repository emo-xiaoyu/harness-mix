// Event Normalizer：把 Runtime 现有的统一事件（legacy kind）标准化为 CoreEvent（§12）。
// 第一阶段不重写任何 Adapter，只在公共入口处 normalize。
// 本模块对 Harness 名称零感知：输入已经是 Adapter 转换后的统一事件。
class EventNormalizer {
  /**
   * @param {{ threadId: string, source?: string }} context source 仅为溯源标签，不参与逻辑分支
   */
  constructor({ threadId, source } = {}) {
    this.threadId = threadId;
    this.source = source ?? null;
    this.turnId = null;
    this.turnActive = false;
    this.currentMessageItemId = null;   // 当前 streaming 的 agent_message
    this.currentReasoningItemId = null; // 当前 streaming 的 reasoning
    this.segmentSequence = 0;
    this.activeSlot = null;
    this.interactions = new Map();
    this.toolItems = new Map();         // toolCallId -> itemId
  }

  /** Turn 开始：先产出 user_message（已完成），后续 delta 归入本 Turn */
  beginTurn(turnId, userText, attachments = []) {
    this.turnId = turnId;
    this.currentNativeRef = undefined;
    this.turnActive = true;
    this.currentMessageItemId = null;
    this.currentReasoningItemId = null;
    this.toolItems.clear();
    this.interactions.clear();
    this.activeSlot = null;
    this.segmentSequence = 0;
    const itemId = `item_user_${turnId}`;
    return [
      this.#event({ type: 'item.started', itemId, payload: { type: 'user_message', content: userText, ...(attachments.length ? { attachments } : {}) } }),
      this.#event({ type: 'item.completed', itemId }),
    ];
  }

  /**
   * legacy 统一事件 → CoreEvent 序列（一个 legacy 事件可展开为多个 CoreEvent）
   * @returns Array<Partial<CoreEvent>>
   */
  normalize(legacy) {
    if (!legacy || typeof legacy !== 'object') return [];
    if (!this.turnActive && ['text-delta', 'thinking-delta', 'tool', 'artifact', 'approval', 'interaction-responded', 'plan', 'file-change'].includes(legacy.kind)) return [];
    this.currentNativeRef = legacy.nativeRef;
    switch (legacy.kind) {
      case 'text-delta':
        return this.#delta('agent_message', 'currentMessageItemId', legacy.text);
      case 'thinking-delta':
        return this.#delta('reasoning', 'currentReasoningItemId', legacy.text);
      case 'tool':
        return this.#tool(legacy);
      case 'artifact':
        return this.#artifact(legacy);
      case 'approval':
        if (this.interactions.has(legacy.requestId)) return [];
        this.interactions.set(legacy.requestId, `interaction_${this.turnId}_${legacy.requestId}`);
        return [this.#approval(legacy), this.#event({ type: 'turn.waiting' })];
      case 'interaction-responded': {
        const itemId = this.interactions.get(legacy.requestId);
        if (!itemId) return [];
        this.interactions.delete(legacy.requestId);
        return [this.#event({ type: 'item.updated', itemId, payload: { interactionStatus: 'responded' } }),
          this.#event({ type: 'item.completed', itemId }),
          ...(this.interactions.size ? [] : [this.#event({ type: 'turn.resumed' })])];
      }
      case 'plan':
        return [this.#event({ type: 'plan.updated', payload: { entries: legacy.entries ?? [] } })];
      case 'file-change':
        return [this.#event({ type: 'files.updated', payload: { source: legacy.source ?? 'native', changes: legacy.changes ?? [] } })];
      case 'usage':
        return [this.#event({ type: 'usage.updated', payload: { ...(legacy.usage ?? {}) } })];
      case 'session':
        return [this.#event({
          type: 'thread.updated',
          payload: {
            ...(legacy.nativeSessionId ? { nativeSessionRef: { sessionId: String(legacy.nativeSessionId) } } : {}),
            ...(legacy.model ? { metadata: { model: legacy.model } } : {}),
          },
        })];
      case 'status':
      case 'notice':
        return this.#notice(legacy);
      case 'completed':
        // 结算闸门：Turn 已结算后迟到的重复结算事件不再产生 CoreEvent（如 cancel 后
        // 原生流仍送达 agent_settled / result），防止影子侧出现非法状态迁移。
        if (!this.turnActive) return [];
        this.turnActive = false;
        return [
          ...(!legacy.finalAnswer || legacy.stopReason && legacy.stopReason !== 'completed' || !this.currentMessageItemId ? [] : [this.#event({ type: 'item.updated', itemId: this.currentMessageItemId, payload: { phase: 'final' } })]),
          this.#event({ type: 'turn.completed', payload: { stopReason: legacy.stopReason ?? 'completed' } }),
        ];
      case 'error':
        if (!this.turnActive) return [];
        this.turnActive = false;
        return [this.#event({ type: 'turn.failed', payload: { message: String(legacy.message ?? 'unknown error') } })];
      default:
        return [];
    }
  }

  /* ---------------- 内部 ---------------- */

  #event({ type, itemId, payload, nativeRef }) {
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: itemId ?? null,
      source: this.source,
      nativeRef: { ...this.currentNativeRef, ...nativeRef },
      type,
      payload: payload ?? {},
    };
  }

  #delta(itemType, slot, text) {
    if (typeof text !== 'string' || !text) return [];
    const closed = this.activeSlot && this.activeSlot !== slot ? this.#closeSegment() : [];
    if (!this[slot]) {
      const itemId = this.#newSegment(slot, itemType);
      return [
        ...closed,
        this.#event({ type: 'item.started', itemId, payload: { type: itemType, ...(itemType === 'agent_message' ? { phase: 'progress' } : {}) } }),
        this.#event({ type: 'item.delta', itemId, payload: { text } }),
      ];
    }
    return [this.#event({ type: 'item.delta', itemId: this[slot], payload: { text } })];
  }

  // 同一 Turn 可能有多段 message/reasoning（与工具调用交替），用唯一后缀区分
  #newSegment(slot, itemType) {
    this.activeSlot = slot;
    this[slot] = `item_${itemType}_${this.turnId}_${++this.segmentSequence}`;
    return this[slot];
  }

  #closeSegment() {
    const itemId = this.activeSlot ? this[this.activeSlot] : null;
    this.currentMessageItemId = null;
    this.currentReasoningItemId = null;
    this.activeSlot = null;
    return itemId ? [this.#event({ type: 'item.completed', itemId })] : [];
  }

  #tool(legacy) {
    const key = legacy.toolCallId ?? `anon:${legacy.title ?? 'tool'}`;
    let itemId = this.toolItems.get(key);
    const events = [];
    const state = legacy.state ?? 'running';
    if (!itemId) {
      itemId = `item_tool_${this.turnId}_${this.toolItems.size}`;
      this.toolItems.set(key, itemId);
      events.push(...this.#closeSegment());
      // 新工具出现意味着上一段 message/reasoning 已结束，后续 delta 开新段
      this.currentMessageItemId = null;
      this.currentReasoningItemId = null;
      events.push(this.#event({
        type: 'item.started',
        itemId,
        nativeRef: legacy.toolCallId ? { toolCallId: String(legacy.toolCallId) } : undefined,
        payload: { type: 'tool_call', title: legacy.title ?? '工具', state,
          ...(legacy.collaboration ? { collaboration: legacy.collaboration } : {}) },
      }));
    }
    const patch = {};
    if (legacy.collaboration) patch.collaboration = legacy.collaboration;
    for (const k of ['detail', 'input', 'output']) {
      if (typeof legacy[k] === 'string') patch[k] = legacy[k];
      else if (legacy[k] != null) patch[k] = JSON.stringify(legacy[k]);
    }
    if (legacy.title) patch.title = legacy.title;
    patch.state = state;
    events.push(this.#event({ type: 'item.updated', itemId, payload: patch }));
    if (state !== 'running') {
      events.push(this.#event({ type: 'item.completed', itemId, payload: { state } }));
    }
    return events;
  }

  #artifact(legacy) {
    const a = legacy.artifact;
    if (!a || typeof a !== 'object') return [];
    // 产物挂在当前 agent_message 上；若尚无消息段则先建段
    if (!this.currentMessageItemId) {
      const itemId = this.#newSegment('currentMessageItemId', 'agent_message');
      return [
        this.#event({ type: 'item.started', itemId, payload: { type: 'agent_message' } }),
        this.#event({
          type: 'item.updated',
          itemId,
          payload: { artifacts: [{ id: a.id, type: a.type, name: a.name, mime: a.mime, uri: a.uri, data: a.data }] },
        }),
      ];
    }
    return [this.#event({
      type: 'item.updated',
      itemId: this.currentMessageItemId,
      payload: { artifacts: [{ id: a.id, type: a.type, name: a.name, mime: a.mime, uri: a.uri, data: a.data }] },
    })];
  }

  #approval(legacy) {
    const itemType = ['input', 'editor'].includes(legacy.method) ? 'question' : 'approval';
    return this.#event({
      type: 'item.started',
      itemId: this.interactions.get(legacy.requestId),
      nativeRef: legacy.requestId ? { interactionId: String(legacy.nativeRef?.interactionId ?? legacy.requestId) } : undefined,
      payload: {
        type: itemType,
        requestId: legacy.requestId,
        method: legacy.method,
        title: legacy.title,
        message: legacy.message,
        options: legacy.options,
        placeholder: legacy.placeholder,
        interactionStatus: 'pending',
      },
    });
  }

  #notice(legacy) {
    const text = legacy.text;
    if (typeof text !== 'string' || !text) return [];
    const itemId = `item_notice_${this.turnId ?? this.threadId}_${++this.segmentSequence}`;
    return [
      this.#event({ type: 'item.started', itemId, payload: { type: 'notice', level: legacy.level ?? 'info', content: text } }),
      this.#event({ type: 'item.completed', itemId }),
    ];
  }
}

module.exports = { EventNormalizer };
