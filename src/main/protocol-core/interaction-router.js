// A request is owned by one Core Turn. The native protocol alone accepts answers.
class InteractionRouter {
  constructor(core) { this.core = core; this.inFlight = new Set(); }

  pending(threadId) {
    const thread = this.core.getThread(threadId);
    if (!thread?.activeTurnId) return [];
    return this.core.getItemsForTurn(thread.activeTurnId).filter(item =>
      ['approval', 'question'].includes(item.type) && item.interactionStatus === 'pending'
      && !['completed', 'cancelled', 'error'].includes(item.status));
  }

  async respond(threadId, requestId, response, sendNative) {
    const item = this.pending(threadId).find(item => item.requestId === requestId);
    if (!item) throw new Error('该请求已处理或已过期');
    if (this.inFlight.has(item.id)) throw new Error('该回答正在提交');
    this.inFlight.add(item.id);
    try {
      await sendNative(item, response);
      // Native callbacks may complete/cancel the turn while respond is in flight.
      if (!this.pending(threadId).some(current => current.id === item.id)) return;
      const event = { threadId, turnId: item.turnId, itemId: item.id };
      this.core.dispatch({ ...event, type: 'item.updated', payload: { interactionStatus: 'responded' } });
      this.core.dispatch({ ...event, type: 'item.completed' });
      if (!this.pending(threadId).length) this.core.dispatch({ ...event, type: 'turn.resumed' });
    } finally { this.inFlight.delete(item.id); }
  }
}

module.exports = { InteractionRouter };
