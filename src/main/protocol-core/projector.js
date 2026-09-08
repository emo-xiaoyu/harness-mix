const { projectFileChanges } = require('./file-change-projector');
const { createItem, validateItem, TERMINAL_ITEM_STATUS, TERMINAL_TURN_STATUS } = require('../shared-contracts');

// Projector：CurrentState + CoreEvent → State（§7）。
// 必须是确定性逻辑：同样的 CoreEvent 序列永远投影出同样的 State。
// Projector 不判断任何 Harness 名称；语义全部由事件 payload 携带。
class Projector {
  constructor({ threads, turns }) {
    this.threads = threads; // ThreadManager
    this.turns = turns;     // TurnManager
    this.items = new Map(); // itemId -> Item
  }

  /** 应用一个 CoreEvent，返回 { thread?, turn?, item? }（被改动的实体） */
  apply(event) {
    const existingTurn = event.turnId ? this.turns.get(event.turnId) : null;
    if (existingTurn && existingTurn.threadId !== event.threadId) throw new Error('event belongs to another thread');
    if (existingTurn && TERMINAL_TURN_STATUS.includes(existingTurn.status) && event.type.startsWith('item.')) return {};
    if (existingTurn && typeof event.sequence === 'number') existingTurn.lastSequence = Math.max(existingTurn.lastSequence, event.sequence);
    switch (event.type) {
      case 'thread.created': {
        const thread = this.threads.create({ id: event.threadId, ...event.payload }, event.timestamp);
        return { thread };
      }
      case 'thread.updated': {
        const thread = this.threads.update(event.threadId, event.payload, event.timestamp);
        return { thread };
      }
      case 'turn.started': {
        const turn = this.#ensureTurn(event);
        this.turns.start(turn.id, event.timestamp);
        if (typeof event.sequence === 'number') turn.lastSequence = event.sequence;
        const thread = this.threads.update(turn.threadId, { status: 'running', activeTurnId: turn.id }, event.timestamp);
        return { turn, thread };
      }
      case 'turn.waiting': {
        const turn = this.#ensureTurn(event);
        this.turns.wait(turn.id, event.timestamp);
        const thread = this.threads.update(turn.threadId, { status: 'waiting' }, event.timestamp);
        return { turn, thread };
      }
      case 'turn.resumed': {
        const turn = this.#ensureTurn(event);
        this.turns.resume(turn.id, event.timestamp);
        return { turn, thread: this.threads.update(turn.threadId, { status: 'running' }, event.timestamp) };
      }
      case 'turn.completed':
        return this.#settleTurn(event, 'completed');
      case 'turn.cancelled':
        return this.#settleTurn(event, 'cancelled');
      case 'turn.failed':
        return this.#settleTurn(event, 'failed');
      case 'item.started':
        return { item: this.#startItem(event) };
      case 'item.delta':
        return { item: this.#deltaItem(event) };
      case 'item.updated':
        return { item: this.#updateItem(event) };
      case 'item.completed':
        return { item: this.#completeItem(event) };
      case 'files.updated': return projectFileChanges(this, event);
      case 'plan.updated': {
        if (!existingTurn || TERMINAL_TURN_STATUS.includes(existingTurn.status)) return {};
        const itemId = `plan_${event.turnId}`;
        const item = this.items.get(itemId) ?? this.#startItem({ ...event, itemId, payload: { type: 'plan' } });
        item.entries = structuredClone(event.payload.entries ?? []);
        item.updatedAt = event.timestamp;
        return { item };
      }
      case 'usage.updated': {
        const item = this.#upsertUsageItem(event);
        const thread = this.threads.update(event.threadId, { usage: event.payload }, event.timestamp);
        return { item, thread };
      }
      default:
        return {};
    }
  }

  /* ---------------- 内部 ---------------- */

  #ensureTurn(event) {
    const existing = event.turnId ? this.turns.get(event.turnId) : null;
    if (existing) return existing;
    // 容错：turn 事件先于显式 createTurn 到达时自动建立，不让状态损坏
    return this.turns.create({ id: event.turnId ?? `turn_${event.eventId}`, threadId: event.threadId, nativeTurnRef: event.nativeRef }, event.timestamp);
  }

  #settleTurn(event, kind) {
    const turn = this.#ensureTurn(event);
    if (event.nativeRef) turn.nativeTurnRef = { ...turn.nativeTurnRef, ...event.nativeRef };
    if (typeof event.sequence === 'number') turn.lastSequence = event.sequence;
    // 首次结算生效：Turn 已进入终态后，迟到的重复结算事件为幂等噪声（如 cancel 后
    // 原生流仍送达 agent_settled / result），不改变 Turn 生命周期。
    if (TERMINAL_TURN_STATUS.includes(turn.status)) return { turn };
    const stopReason = event.payload?.stopReason;
    if (kind === 'completed') {
      if (stopReason === 'cancelled') this.turns.cancel(turn.id, {}, event.timestamp);
      else this.turns.complete(turn.id, {}, event.timestamp);
    } else if (kind === 'cancelled') {
      this.turns.cancel(turn.id, {}, event.timestamp);
    } else {
      this.turns.fail(turn.id, event.payload?.message ?? event.payload?.error, {}, event.timestamp);
    }
    // Turn 结算：所有未终态 Item 一并收尾（语义等同 legacy finishMessage）
    this.#finalizeOpenItems(turn, event.timestamp);
    const threadStatus = turn.status === 'error' ? 'error' : 'idle';
    const thread = this.threads.update(turn.threadId, { status: threadStatus, activeTurnId: null }, event.timestamp);
    return { turn, thread };
  }

  #finalizeOpenItems(turn, now) {
    for (const itemId of turn.itemIds) {
      const item = this.items.get(itemId);
      if (!item || TERMINAL_ITEM_STATUS.includes(item.status)) continue;
      if (item.type === 'tool_call') {
        // 与 legacy 一致：已结算的 Turn 不代表工具成功
        item.state = item.state && item.state !== 'running' ? item.state : 'interrupted';
        item.status = item.state === 'error' ? 'error' : 'cancelled';
      } else if (item.type === 'approval' || item.type === 'question') {
        item.status = turn.status === 'completed' ? 'completed' : 'cancelled';
      } else {
        item.status = 'completed';
      }
      item.updatedAt = now;
    }
  }

  #startItem(event) {
    const existing = event.itemId ? this.items.get(event.itemId) : null;
    if (existing) return existing; // 幂等
    const { type, ...rest } = event.payload ?? {};
    const streaming = type === 'agent_message' || type === 'reasoning';
    const item = createItem({
      id: event.itemId ?? `item_${event.eventId}`,
      threadId: event.threadId,
      turnId: event.turnId,
      type,
      status: streaming ? 'streaming' : 'started',
      nativeRef: event.nativeRef,
      ...(streaming ? { content: '' } : {}),
      ...rest,
    }, event.timestamp);
    const errors = validateItem(item);
    if (errors.length) throw new Error(`invalid item: ${errors.join('; ')}`);
    this.items.set(item.id, item);
    const turn = item.turnId ? this.turns.get(item.turnId) : null;
    if (turn && !turn.itemIds.includes(item.id)) turn.itemIds.push(item.id);
    return item;
  }

  #deltaItem(event) {
    const item = this.items.get(event.itemId);
    if (!item || TERMINAL_ITEM_STATUS.includes(item.status)) return item ?? null;
    const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
    item.content = (item.content ?? '') + text;
    item.status = 'streaming';
    item.updatedAt = event.timestamp;
    return item;
  }

  #updateItem(event) {
    const item = this.items.get(event.itemId);
    if (!item) return null;
    for (const [key, value] of Object.entries(event.payload ?? {})) {
      if (['id', 'threadId', 'turnId', 'type', 'createdAt'].includes(key)) continue;
      if (key === 'artifacts' && Array.isArray(value)) item.artifacts = [...(item.artifacts ?? []), ...value];
      else item[key] = value;
    }
    if (event.payload?.state && event.payload.state !== 'running' && item.type === 'tool_call') {
      item.status = event.payload.state === 'error' ? 'error' : 'completed';
    }
    item.updatedAt = event.timestamp;
    return item;
  }

  #completeItem(event) {
    const item = this.items.get(event.itemId);
    if (!item || TERMINAL_ITEM_STATUS.includes(item.status)) return item ?? null;
    const state = event.payload?.state;
    item.status = state === 'error' ? 'error' : 'completed';
    if (state && item.type === 'tool_call') item.state = state;
    item.updatedAt = event.timestamp;
    return item;
  }

  #upsertUsageItem(event) {
    const turn = event.turnId ? this.turns.get(event.turnId) : null;
    const existing = turn
      ? turn.itemIds.map((id) => this.items.get(id)).find((i) => i?.type === 'usage')
      : null;
    if (existing) {
      existing.usage = { ...(existing.usage ?? {}), ...event.payload };
      existing.updatedAt = event.timestamp;
      return existing;
    }
    const item = createItem({
      threadId: event.threadId,
      turnId: event.turnId,
      id: event.itemId ?? `usage_${event.turnId ?? event.threadId}`,
      type: 'usage',
      status: 'completed',
      nativeRef: event.nativeRef,
      usage: { ...event.payload },
    }, event.timestamp);
    this.items.set(item.id, item);
    if (turn) turn.itemIds.push(item.id);
    return item;
  }

  itemsForTurn(turnId) {
    const turn = this.turns.get(turnId);
    if (turn) return turn.itemIds.map((id) => this.items.get(id)).filter(Boolean);
    return [...this.items.values()].filter((i) => i.turnId === turnId);
  }

  clear() {
    this.items.clear();
  }
}

module.exports = { Projector };
