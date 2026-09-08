const { ProtocolCore } = require('../protocol-core/protocol-core');
const { EventNormalizer } = require('../harness-adapter/event-normalizer');
const { importHistory } = require('./history-import');
const { canonicalChanges } = require('../workspace/file-changes');

const active = turn => turn && ['created', 'starting', 'running', 'waiting_interaction'].includes(turn.status);

// Execution lives in Core. Messages below are disposable views for the existing UI.
class CoreSession {
  constructor() {
    this.core = new ProtocolCore();
    this.normalizers = new Map();
    this.lastTurns = new Map();
  }
  threadCreated(thread) {
    importHistory(this.core, thread);
    const turns = this.core.turns.turnsForThread(thread.id);
    if (turns.length) this.lastTurns.set(thread.id, turns.at(-1).id);
    this.sync(thread);
  }
  lastTurn(id) { return this.core.getTurn(this.lastTurns.get(id)); }
  isRunning(id) { return Boolean(active(this.lastTurn(id))); }
  normalizer(thread) {
    if (!this.normalizers.has(thread.id)) this.normalizers.set(thread.id, new EventNormalizer({ threadId: thread.id, source: thread.harnessId }));
    return this.normalizers.get(thread.id);
  }
  turnStarted(thread, text, timestamp = Date.now()) {
    const turn = this.core.turns.create({ threadId: thread.id, nativeTurnRef: { sessionId: thread.nativeSessionId } }, timestamp);
    this.lastTurns.set(thread.id, turn.id);
    const normalizer = this.normalizer(thread);
    this.core.dispatch({ threadId: thread.id, turnId: turn.id, type: 'turn.started', timestamp });
    for (const event of normalizer.beginTurn(turn.id, text)) this.core.dispatch({ ...event, timestamp });
    thread.messages.push({ id: turn.id, role: 'assistant', coreTurnId: turn.id });
    this.sync(thread);
    return turn;
  }
  apply(thread, event) {
    if (!this.isRunning(thread.id) && ['text-delta', 'thinking-delta', 'tool', 'artifact', 'approval', 'completed', 'error', 'plan', 'file-change'].includes(event.kind)) return { settled: false, ignored: true };
    if (event.kind === 'file-change') event = { ...event, changes: canonicalChanges(thread.cwd, event.changes,
      this.core.getItemsForTurn(this.lastTurn(thread.id)?.id).filter(item => item.type === 'file_change')) };
    const before = this.isRunning(thread.id);
    for (const normalized of this.normalizer(thread).normalize(event)) this.core.dispatch({ ...normalized, timestamp: event.timestamp });
    if (event.kind === 'file-change') thread.fileRevision = (thread.fileRevision ?? 0) + 1;
    this.sync(thread);
    return { settled: before && !this.isRunning(thread.id) };
  }
  sync(thread) {
    const coreThread = this.core.getThread(thread.id);
    if (!coreThread) return;
    thread.interactions = structuredClone(this.core.interactions.pending(thread.id));
    thread.pendingApprovals = thread.interactions;
    thread.coreUsage = structuredClone(coreThread.usage ?? {});
    thread.usage = thread.coreUsage;
    const last = this.lastTurn(thread.id);
    thread.currentTurn = last ? structuredClone(last) : null;
    thread.coreThread = structuredClone(coreThread);
    if (last && thread.connectionStatus !== 'opening' && thread.connectionStatus !== 'error') {
      thread.status = active(last) ? 'working' : last.status === 'error' ? 'error' : 'ready';
      if (last.error) thread.error = last.error;
    }
    thread.tools = [];
    for (const message of thread.messages ?? []) {
      const turn = this.core.getTurn(message.coreTurnId);
      if (!turn) continue;
      const items = this.core.getItemsForTurn(turn.id);
      Object.assign(message, {
        coreTurn: structuredClone(turn), coreItems: structuredClone(items),
        at: turn.startedAt ?? turn.createdAt, endedAt: turn.completedAt, streaming: Boolean(active(turn)), stopReason: turn.status,
        text: items.filter(i => i.type === 'agent_message').map(i => i.content ?? '').join(''),
        thinking: items.filter(i => i.type === 'reasoning').map(i => i.content ?? '').join(''),
        artifacts: items.flatMap(i => i.artifacts ?? []),
      });
      delete message.items;
      thread.tools.push(...items.filter(i => i.type === 'tool_call').map(i => ({ ...i, id: i.nativeRef?.toolCallId ?? i.id, messageId: message.id, at: i.createdAt, endedAt: i.updatedAt })));
    }
    thread.coreState = { version: 1, thread: structuredClone(coreThread), turns: structuredClone(this.core.turns.turnsForThread(thread.id)), items: structuredClone([...this.core.projector.items.values()].filter(i => i.threadId === thread.id)) };
  }
  snapshot() { return this.core.snapshot(); }
}

module.exports = { CoreSession };
