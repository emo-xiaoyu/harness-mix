// Sequence Validator：去重与顺序基础。
// 规则（§9）：
//   - eventId 已存在 → ignore（重复事件不得二次投影）
//   - sequence 回退 → 开发环境 warn，但不得直接破坏状态（仍接受）
//   - sequence 正常递增 → accept
class SequenceValidator {
  constructor({ strict = false } = {}) {
    this.strict = strict;
    this.seenEventIds = new Set();
    this.lastSequenceByThread = new Map(); // threadId -> number
  }

  /**
   * @returns {{ action: 'accept' | 'ignore', warnings: string[] }}
   */
  check(event) {
    const warnings = [];
    if (!event || typeof event !== 'object') return { action: 'ignore', warnings: ['malformed event'] };
    if (event.eventId && this.seenEventIds.has(event.eventId)) {
      return { action: 'ignore', warnings: [`duplicate eventId ${event.eventId}`] };
    }
    const threadId = event.threadId ?? '__global__';
    if (typeof event.sequence === 'number') {
      const last = this.lastSequenceByThread.get(threadId);
      if (last != null && event.sequence <= last) {
        const message = `sequence regression on thread ${threadId}: last=${last} event=${event.sequence}`;
        warnings.push(message);
        if (this.strict) return { action: 'ignore', warnings };
        // 非严格模式：记录警告但接受，状态不被顺序问题破坏。
      } else {
        this.lastSequenceByThread.set(threadId, event.sequence);
      }
    }
    if (event.eventId) this.seenEventIds.add(event.eventId);
    return { action: 'accept', warnings };
  }

  reset(threadId) {
    if (threadId == null) { this.seenEventIds.clear(); this.lastSequenceByThread.clear(); return; }
    this.lastSequenceByThread.delete(threadId);
  }
}

module.exports = { SequenceValidator };
