// One-time data migration, never an execution projector. Unordered old tools stay labelled.
function importHistory(core, thread) {
  if (core.getThread(thread.id)) return;
  const checkpoint = thread.coreState;
  if (checkpoint?.version === 1 && checkpoint.thread.id === thread.id) {
    core.restore(checkpoint);
  } else {
    core.createThread({ id: thread.id, workspaceId: thread.cwd, harnessId: thread.harnessId, nativeSessionRef: { sessionId: thread.nativeSessionId }, metadata: { title: thread.title } });
    if (thread.usage) core.dispatch({ threadId: thread.id, type: 'usage.updated', payload: thread.usage });
    for (const [index, message] of (thread.messages ?? []).entries()) {
      if (message.role !== 'assistant') continue;
      const now = message.at ?? thread.createdAt ?? 0;
      // Re-key on Fork: Core IDs are globally unique; native identities remain intact.
      const turnId = message.coreTurn?.threadId === thread.id ? message.coreTurn.id : `history_${thread.id}_${message.id ?? index}`;
      message.coreTurnId = turnId;
      if (message.coreTurn && message.coreItems) {
        const ids = new Map(message.coreItems.map(i => [i.id, message.coreTurn.threadId === thread.id ? i.id : `${turnId}_${i.id}`]));
        const turn = { ...structuredClone(message.coreTurn), id: turnId, threadId: thread.id, itemIds: message.coreTurn.itemIds.map(id => ids.get(id)) };
        const items = message.coreItems.map(i => ({ ...structuredClone(i), id: ids.get(i.id), threadId: thread.id, turnId }));
        core.restore({ version: 1, thread: core.getThread(thread.id), turns: [turn], items });
        continue;
      }
      core.dispatch({ threadId: thread.id, turnId, type: 'turn.started', timestamp: now });
      const add = (type, payload, at = now) => {
        const id = `${turnId}_${core.getTurn(turnId).itemIds.length}`;
        core.dispatch({ threadId: thread.id, turnId, itemId: id, type: 'item.started', payload: { type, ...payload }, timestamp: at });
        core.dispatch({ threadId: thread.id, turnId, itemId: id, type: 'item.completed', timestamp: message.endedAt ?? at });
      };
      const user = thread.messages[index - 1];
      if (user?.role === 'user') add('user_message', { content: user.text });
      const ordered = message.items;
      if (ordered?.length) for (const item of ordered) {
        if (item.kind === 'tool') {
          const tool = thread.tools?.find(t => t.id === item.toolId && t.messageId === message.id);
          if (tool) add('tool_call', { title: tool.title, input: tool.input, output: tool.output ?? tool.detail, state: tool.state === 'running' ? 'interrupted' : tool.state, nativeRef: { toolCallId: tool.id } }, item.at);
        } else add(item.kind === 'thinking' ? 'reasoning' : 'agent_message', { content: item.text, phase: item.phase ?? 'progress' }, item.at);
      } else {
        if (message.thinking) add('reasoning', { content: message.thinking });
        if (message.text || message.artifacts?.length) add('agent_message', { content: message.text ?? '', artifacts: message.artifacts, phase: 'progress' });
      }
      // Legacy did not record final-answer semantics. Preserve content without inventing it.
      const orphan = (thread.tools ?? []).filter(t => !t.messageId);
      if (orphan.length && index === thread.messages.findLastIndex(m => m.role === 'assistant')) {
        add('notice', { content: '旧记录未保存事件顺序，以下为历史工具列表。' });
        for (const tool of orphan) add('tool_call', { title: tool.title, input: tool.input, output: tool.output ?? tool.detail, nativeRef: { toolCallId: tool.id }, state: tool.state === 'running' ? 'interrupted' : tool.state });
      }
      core.dispatch({ threadId: thread.id, turnId, type: message.streaming || message.stopReason === 'interrupted' || message.stopReason === 'cancelled' ? 'turn.cancelled' : message.stopReason === 'error' ? 'turn.failed' : 'turn.completed', payload: { message: thread.error }, timestamp: message.endedAt ?? thread.updatedAt ?? now });
    }
  }
  for (const turn of core.turns.turnsForThread(thread.id)) {
    if (['created', 'starting', 'running', 'waiting_interaction'].includes(turn.status)) core.dispatch({ threadId: thread.id, turnId: turn.id, type: 'turn.cancelled', timestamp: thread.updatedAt ?? turn.updatedAt, payload: { stopReason: 'interrupted' } });
  }
}

module.exports = { importHistory };
