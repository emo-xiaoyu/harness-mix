const { createThread, validateThread } = require('../shared-contracts');

// ThreadManager：Core 侧 Thread 的存储与字段级更新。
// 第一阶段仅内存状态，不设计数据库（§6）。
class ThreadManager {
  constructor() {
    this.threads = new Map(); // threadId -> Thread
  }

  create(input, now = Date.now()) {
    const existing = input?.id ? this.threads.get(input.id) : null;
    if (existing) return existing;
    const thread = createThread(input, now);
    const errors = validateThread(thread);
    if (errors.length) throw new Error(`invalid thread: ${errors.join('; ')}`);
    this.threads.set(thread.id, thread);
    return thread;
  }

  get(threadId) {
    return this.threads.get(threadId) ?? null;
  }

  /** 白名单字段更新；unknown 字段直接拒绝，防止协议外状态混入 */
  update(threadId, patch = {}, now = Date.now()) {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const allowed = ['status', 'activeTurnId', 'metadata', 'nativeSessionRef', 'usage', 'workspaceId'];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) continue;
      if (key === 'metadata' || key === 'nativeSessionRef' || key === 'usage') {
        thread[key] = { ...(thread[key] ?? {}), ...patch[key] };
      } else {
        thread[key] = patch[key];
      }
    }
    thread.updatedAt = now;
    return thread;
  }

  all() {
    return [...this.threads.values()];
  }

  clear() {
    this.threads.clear();
  }
}

module.exports = { ThreadManager };
