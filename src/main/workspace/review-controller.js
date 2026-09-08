const fs = require('node:fs/promises');
const { projectReview, readReview } = require('./core-review');

// Owns workspace review settlement, live refresh and undo. It never decides Turn state.
class ReviewController {
  constructor(runtime, { save, broadcast }) {
    this.runtime = runtime; this.save = save; this.broadcast = broadcast;
  }
  get threads() { return this.runtime.threads; }
  get reviews() { return this.runtime.reviews; }
  get listeners() { return this.runtime.listeners; }
  get settlements() { return this.runtime.settlements; }
  get reviewMonitors() { return this.runtime.reviewMonitors; }
  async settle(thread, message) {
    if (this.settlements.has(thread.id)) return;
    this.settlements.add(thread.id);
    const monitor = this.reviewMonitors.get(thread.id);
    if (monitor) { monitor.closed = true; clearInterval(monitor.timer); this.reviewMonitors.delete(thread.id); }
    thread.reviewPending = true;
    try {
      if (message?.reviewId) message.review = await this.reviews.finish(message.reviewId);
      if (message?.review) {
        const summary = await projectReview(this.runtime, thread, message, await this.reviews.load(message.reviewId));
        this.emitReviewUpdate(thread, message, summary);
      }
    } catch (e) { if (message) message.reviewError = '文件审查暂不可用：' + e.message; }
    finally {
      thread.reviewPending = false;
      this.settlements.delete(thread.id);
      await this.save(); this.broadcast();
    }
  }

  readReview(thread, message, file) { return readReview(this.runtime, thread, message, file); }

  reviewMessage(threadId, messageId) {
    const thread = this.threads.find(t => t.id === threadId);
    const message = thread.messages.find(m => m.id === messageId);
    if (!message?.review) throw Error('该轮没有可审查的文件快照（旧历史无法补建）');
    return { thread, message };
  }

  // The UI subscribes to a turn-scoped event; workspace snapshots stay in Main.
  startReviewUpdates(thread, message) {
    if (!message.reviewId || this.reviewMonitors.has(thread.id)) return;
    const monitor = { busy: false, closed: false };
    const tick = async () => {
      if (monitor.closed || monitor.busy || !message.streaming) return;
      monitor.busy = true;
      try {
        const fileRevision = thread.fileRevision;
        const record = await this.reviews.preview(message.reviewId);
        if (!monitor.closed && message.streaming && fileRevision === thread.fileRevision) {
          const review = await projectReview(this.runtime, thread, message, record);
          message.liveReview = review;
          this.emitReviewUpdate(thread, message, review);
        }
      } catch (e) {
        if (!monitor.closed) for (const listener of this.listeners) listener({ type: 'turn/diff/updated', threadId: thread.id, turnId: message.id, error: e.message });
      } finally { monitor.busy = false; }
    };
    monitor.timer = setInterval(() => void tick(), 2000);
    monitor.timer.unref?.();
    this.reviewMonitors.set(thread.id, monitor);
    void tick();
  }

  emitReviewUpdate(thread, message, review) {
    for (const listener of this.listeners) listener({ type: 'turn/diff/updated', threadId: thread.id, turnId: message.id, review });
  }

  async undoFile(threadId, messageId, file) {
    const { thread, message } = this.reviewMessage(threadId, messageId);
    const record = await this.reviews.load(message.review.id);
    if ((await fs.realpath(thread.cwd)).toLowerCase() !== record.root.toLowerCase()) throw Error('任务目录已移动，禁止从新目录撤回旧项目文件');
    if (this.threads.some(t => t.cwd.toLowerCase() === thread.cwd.toLowerCase() && t.status === 'working')) throw Error('项目任务执行中，不能撤回');
    message.review = await this.reviews.undo(message.review.id, file);
    await projectReview(this.runtime, thread, message, await this.reviews.load(message.review.id));
    await this.save(); this.broadcast();
    return message.review;
  }

}
module.exports = { ReviewController };
