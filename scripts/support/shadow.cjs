const { EventNormalizer } = require('../../src/main/harness-adapter/event-normalizer');
const { compareTurn } = require('./shadow-comparator.cjs');

/**
 * Shadow Mirror（§11）：Adapter → Runtime → ┬→ Legacy Transcript（现状不变）
 *                                           └→ Normalizer → Protocol Core（影子）
 * 所有方法永不抛出：Shadow 的任何失败只记录，绝不影响旧系统（§13/约束#14）。
 */
class ShadowMirror {
  constructor({ core }) {
    this.core = core;
    this.normalizers = new Map();  // threadId -> EventNormalizer
    this.activeTurns = new Map();  // threadId -> core turnId
    this.mismatchLog = [];         // { threadId, turnId, mismatches[] }
    this.lastTurns = new Map();
    this.errorLog = [];            // { phase, message }
  }

  /** Legacy 任务建立 → Core Thread（复用同一 threadId，便于对照） */
  threadCreated(thread) {
    this.#guard('threadCreated', () => {
      this.core.createThread({
        id: thread.id,
        workspaceId: thread.cwd,
        harnessId: thread.harnessId,
        nativeSessionRef: thread.nativeSessionId ? { sessionId: String(thread.nativeSessionId) } : undefined,
        metadata: { title: thread.title },
      });
      if (thread.usage) this.core.dispatch({ threadId: thread.id, type: 'thread.updated', payload: { usage: thread.usage } });
    });
  }

  /** 用户发送 → 先创建 Core Turn 并启动，再随 Harness 事件推进（§26 的 Shadow 版） */
  turnStarted(thread, userText) {
    this.#guard('turnStarted', () => {
      const turn = this.core.createTurn({
        threadId: thread.id,
        nativeTurnRef: thread.nativeSessionId ? { sessionId: String(thread.nativeSessionId) } : undefined,
      });
      this.activeTurns.set(thread.id, turn.id);
      this.lastTurns.set(thread.id, turn.id);
      const message = thread.messages?.findLast(m => m.role === 'assistant');
      if (message) message.coreTurnId = turn.id;
      const normalizer = this.#normalizer(thread);
      const beginEvents = normalizer.beginTurn(turn.id, userText);
      const timestamp = thread.messages?.findLast(m => m.role === 'assistant')?.at ?? Date.now();
      this.core.dispatch({ timestamp, threadId: thread.id, turnId: turn.id, type: 'turn.started', payload: {} });
      for (const event of beginEvents) this.core.dispatch({ ...event, timestamp });
    });
  }

  /** Legacy 统一事件 → Normalizer → Core dispatch；completed/error 时跑 Comparator */
  applyLegacyEvent(thread, legacyEvent) {
    this.#guard('applyLegacyEvent', () => {
      const normalizer = this.#normalizer(thread);
      const events = normalizer.normalize(legacyEvent);
      const message = thread.messages?.findLast(m => m.role === 'assistant');
      const timestamp = legacyEvent.timestamp ?? (['completed', 'error'].includes(legacyEvent.kind) ? message?.endedAt ?? Date.now() : Date.now());
      for (const event of events) this.core.dispatch({ ...event, timestamp });
      if (legacyEvent.kind === 'completed' || legacyEvent.kind === 'error') {
        const turnId = this.activeTurns.get(thread.id);
        this.activeTurns.delete(thread.id);
        if (!turnId) return; // 迟到结算：首次结算已对照过，不再重复比较
        const coreTurn = this.core.getTurn(turnId);
        const mismatches = compareTurn({
          thread,
          coreThread: this.core.getThread(thread.id),
          coreTurn,
          coreItems: coreTurn ? this.core.getItemsForTurn(coreTurn.id) : [],
        });
        if (mismatches.length) this.mismatchLog.push({ threadId: thread.id, turnId, mismatches });
      }
    });
  }

  lastTurn(threadId) {
    return this.core.getTurn(this.lastTurns.get(threadId));
  }

  snapshot() {
    return this.core.snapshot();
  }

  report() {
    return {
      enabled: true,
      threads: this.core.snapshot().threads.length,
      mismatches: this.mismatchLog,
      errors: this.errorLog,
      warnings: this.core.warnings,
    };
  }

  /* ---------------- 内部 ---------------- */

  #normalizer(thread) {
    let normalizer = this.normalizers.get(thread.id);
    if (!normalizer) {
      normalizer = new EventNormalizer({ threadId: thread.id, source: thread.harnessId });
      this.normalizers.set(thread.id, normalizer);
    }
    return normalizer;
  }

  #guard(phase, fn) {
    try {
      fn();
    } catch (error) {
      this.errorLog.push({ phase, message: String(error?.message ?? error) });
    }
  }
}

module.exports = { ShadowMirror };
