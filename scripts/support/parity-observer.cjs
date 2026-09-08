const { applyLegacyEvent } = require('./legacy-projection.cjs');
const { compareTurn } = require('./shadow-comparator.cjs');

// Independent legacy oracle for acceptance only. Never imported by src/.
class ParityObserver {
  constructor() { this.threads = new Map(); this.mismatches = []; this.errors = []; this.comparisons = 0; }
  turnStarted(thread) {
    const message = thread.messages.at(-1);
    this.threads.set(thread.id, { id: thread.id, usage: structuredClone(thread.usage), tools: [], messages: [{ id: message.id, role: 'assistant', at: message.at, text: '', streaming: true }] });
  }
  event(thread, event, core) {
    this.warnings = [...core.warnings];
    const legacy = this.threads.get(thread.id);
    if (!legacy) return;
    try {
      applyLegacyEvent(legacy, event, { notify() {}, refreshUsage() {}, settleReview() {} });
      if (['completed', 'error'].includes(event.kind)) {
        const turn = core.getTurn(thread.messages.at(-1).coreTurnId);
        const mismatches = compareTurn({ thread: legacy, coreThread: core.getThread(thread.id), coreTurn: turn, coreItems: core.getItemsForTurn(turn.id) });
        this.comparisons++;
        if (mismatches.length) this.mismatches.push({ threadId: thread.id, turnId: turn.id, mismatches });
      }
    } catch (error) { this.errors.push(error.message); }
  }
  report() { return { enabled: true, comparisons: this.comparisons, mismatches: this.mismatches, errors: this.errors, warnings: this.warnings ?? [] }; }
}
module.exports = { ParityObserver };
