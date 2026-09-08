const { InteractionRouter } = require('./interaction-router');
const contracts = require('../shared-contracts');
const { ThreadManager } = require('./thread-manager');
const { TurnManager } = require('./turn-manager');
const { Projector } = require('./projector');
const { EventRouter } = require('./event-router');
const { SequenceValidator } = require('./sequence-validator');

/**
 * ProtocolCore：Harness Mix 新内核 facade（§6）。
 * 第一阶段仅内存状态。API 保持简单：
 *   createThread / getThread / createTurn / getTurn / dispatch
 *   getItem / getItemsForTurn / snapshot / reset / subscribe
 */
class ProtocolCore {
  constructor({ strictSequence = true } = {}) {
    this.interactions = new InteractionRouter(this);
    this.threads = new ThreadManager();
    this.turns = new TurnManager();
    this.projector = new Projector({ threads: this.threads, turns: this.turns });
    this.validator = new SequenceValidator({ strict: strictSequence });
    this.router = new EventRouter({ projector: this.projector, validator: this.validator });
    this.sequenceByThread = new Map(); // threadId -> 自动分配的下一个 sequence
  }

  /** 建立 Core Thread（走事件投影，保证一切状态都来自 CoreEvent） */
  createThread({ id, workspaceId, harnessId, nativeSessionRef, metadata } = {}) {
    const existing = id ? this.threads.get(id) : null;
    if (existing) return existing;
    const thread = contracts.createThread({ id, workspaceId, harnessId, nativeSessionRef, metadata });
    this.dispatch({
      threadId: thread.id,
      type: 'thread.created',
      payload: {
        workspaceId: thread.workspaceId,
        harnessId: thread.harnessId,
        nativeSessionRef: thread.nativeSessionRef,
        metadata: thread.metadata,
      },
    });
    return this.threads.get(thread.id);
  }

  getThread(threadId) {
    return this.threads.get(threadId);
  }

  // Validate the entire checkpoint before mutating state. Hydration executes no effects.
  restore({ version, thread, turns, items }) {
    if (version !== 1) throw new Error('unsupported Core checkpoint');
    const errors = contracts.validateThread(thread);
    const ids = new Set(items.map(i => i.id));
    if (ids.size !== items.length || new Set(turns.map(t => t.id)).size !== turns.length) errors.push('duplicate checkpoint IDs');
    for (const turn of turns) {
      errors.push(...contracts.validateTurn(turn));
      if (turn.threadId !== thread.id || turn.itemIds.some(id => !ids.has(id))) errors.push('invalid checkpoint turn ownership');
      if (this.getTurn(turn.id) && this.getTurn(turn.id).threadId !== thread.id) errors.push('checkpoint turn ID collision');
    }
    for (const item of items) {
      errors.push(...contracts.validateItem(item));
      if (item.threadId !== thread.id || (item.turnId && !turns.some(t => t.id === item.turnId && t.itemIds.includes(item.id)))) errors.push('invalid checkpoint item ownership');
      if (this.getItem(item.id) && this.getItem(item.id).threadId !== thread.id) errors.push('checkpoint item ID collision');
    }
    if (errors.length) throw new Error(errors.join('; '));
    this.threads.threads.set(thread.id, structuredClone(thread));
    for (const turn of turns) this.turns.turns.set(turn.id, structuredClone(turn));
    for (const item of items) this.projector.items.set(item.id, structuredClone(item));
    this.sequenceByThread.set(thread.id, Math.max(this.sequenceByThread.get(thread.id) ?? 0, ...turns.map(t => t.lastSequence)));
    this.validator.lastSequenceByThread.set(thread.id, this.sequenceByThread.get(thread.id));
  }

  /** 先创建 Core Turn，再调用 Harness（§26 的目标形态；Shadow 阶段由 Runtime 触发） */
  createTurn({ threadId, nativeTurnRef } = {}) {
    return this.turns.create({ threadId, nativeTurnRef });
  }

  getTurn(turnId) {
    return this.turns.get(turnId);
  }

  /** 统一事件入口：补全 eventId / timestamp / sequence 后经 Router → Projector */
  dispatch(event) {
    const full = contracts.createCoreEvent(event);
    if (full.sequence == null) {
      const next = (this.sequenceByThread.get(full.threadId) ?? 0) + 1;
      this.sequenceByThread.set(full.threadId, next);
      full.sequence = next;
    } else {
      const known = this.sequenceByThread.get(full.threadId) ?? 0;
      if (full.sequence > known) this.sequenceByThread.set(full.threadId, full.sequence);
    }
    const errors = contracts.validateCoreEvent(full);
    if (errors.length) throw new Error(`invalid core event: ${errors.join('; ')}`);
    return this.router.route(full);
  }

  getItem(itemId) {
    return this.projector.items.get(itemId) ?? null;
  }

  getItemsForTurn(turnId) {
    return this.projector.itemsForTurn(turnId);
  }

  subscribe(listener) {
    return this.router.subscribe(listener);
  }

  get warnings() {
    return this.router.warnings;
  }

  snapshot() {
    return {
      threads: this.threads.all(),
      turns: [...this.turns.turns.values()],
      items: [...this.projector.items.values()],
      warnings: [...this.router.warnings],
    };
  }

  reset() {
    this.threads.clear();
    this.turns.clear();
    this.projector.clear();
    this.validator.reset();
    this.router.clear();
    this.sequenceByThread.clear();
  }
}

module.exports = { ProtocolCore };
