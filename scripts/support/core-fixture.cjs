const { createThread, createTurn, createItem } = require('../../src/main/shared-contracts');
// Renderer mocks speak the same Core contract as production. This is not a migrator.
function coreFixture(input) {
  const thread = structuredClone(input);
  const turns = [], items = [];
  thread.coreUsage = thread.usage ?? {};
  thread.interactions = thread.pendingApprovals ?? [];
  for (const [index, message] of thread.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const id = `fixture_${thread.id}_${message.id ?? index}`;
    const turn = createTurn({ id, threadId: thread.id }, message.at ?? 1000);
    Object.assign(turn, { status: message.streaming ? 'running' : 'completed', startedAt: message.at ?? 1000, completedAt: message.streaming ? null : message.endedAt ?? 2000 });
    const ordered = message.items ?? [{ kind: 'text', text: message.text }];
    const result = ordered.map((part, n) => {
      const tool = part.kind === 'tool' ? thread.tools.find(t => t.id === part.toolId) : {};
      return createItem({ ...tool, id: `${id}_${n}`, threadId: thread.id, turnId: id,
        type: ({ tool: 'tool_call', text: 'agent_message', thinking: 'reasoning' })[part.kind],
        status: message.streaming && !part.endedAt ? 'streaming' : 'completed',
        content: part.text, phase: part.phase ?? (n === ordered.length - 1 && !message.streaming ? 'final' : 'progress'),
        updatedAt: part.endedAt ?? part.at ?? 1000,
      }, part.at ?? 1000);
    });
    turn.itemIds = result.map(i => i.id);
    Object.assign(message, { coreTurnId: id, coreTurn: turn, coreItems: result });
    turns.push(turn); items.push(...result);
  }
  thread.coreState = { version: 1, thread: createThread({ id: thread.id, workspaceId: thread.cwd, harnessId: thread.harnessId }), turns, items };
  thread.currentTurn = turns.at(-1) ?? null;
  return thread;
}
module.exports = { coreFixture };
