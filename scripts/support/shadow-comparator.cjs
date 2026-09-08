const { isDeepStrictEqual } = require('node:util');
// Shadow Comparator（§14）：Turn 完成后比较 Legacy Transcript 与 Core 投影。
// 不要求内部结构完全相同，要求语义一致。差异只记录，绝不影响用户执行（§15/约束#14）。
function compareTurn({ thread, coreThread, coreTurn, coreItems }) {
  const mismatches = [];
  if (!thread || !coreTurn) return ['missing thread or core turn'];

  const message = [...(thread.messages ?? [])].reverse().find((m) => m.role === 'assistant');
  const tools = (thread.tools ?? []).filter((t) => message && t.messageId === message.id);
  const items = coreItems ?? [];
  const agentMessages = items.filter((i) => i.type === 'agent_message');
  const reasoning = items.filter((i) => i.type === 'reasoning');
  const toolCalls = items.filter((i) => i.type === 'tool_call');
  const usageItems = items.filter((i) => i.type === 'usage');

  // Turn 状态：legacy stopReason ↔ core status
  const expectedStatus = message?.stopReason === 'cancelled' ? 'cancelled'
    : message?.stopReason === 'error' || thread.error ? 'error'
    : 'completed';
  if (coreTurn.status !== expectedStatus) {
    mismatches.push(`turn status: legacy=${expectedStatus} core=${coreTurn.status}`);
  }

  // 最终回答全文
  const legacyText = message?.text ?? '';
  const coreText = agentMessages.map((i) => i.content ?? '').join('');
  if (legacyText !== coreText) {
    mismatches.push(`final answer: legacy ${legacyText.length} chars vs core ${coreText.length} chars`);
  }

  // Reasoning 是否存在
  const legacyThinking = Boolean(message?.thinking);
  const coreThinking = reasoning.some((i) => (i.content ?? '').length > 0);
  if (legacyThinking !== coreThinking) {
    mismatches.push(`reasoning presence: legacy=${legacyThinking} core=${coreThinking}`);
  }

  // 工具数量与状态
  if (tools.length !== toolCalls.length) {
    mismatches.push(`tool count: legacy=${tools.length} core=${toolCalls.length}`);
  } else {
    for (let i = 0; i < tools.length; i++) {
      const legacyState = tools[i].state ?? 'done';
      const coreState = toolCalls[i].state === 'interrupted' ? 'interrupted'
        : toolCalls[i].status === 'error' ? 'error'
        : toolCalls[i].state ?? 'done';
      if (legacyState !== coreState) {
        mismatches.push(`tool[${i}] state: legacy=${legacyState} core=${coreState}`);
      }
    }
  }

  // Compare the same normalized usage values; units stay owned by the adapter.
  const coreUsage = coreThread?.usage ?? Object.assign({}, ...usageItems.map(i => i.usage));
  if (!isDeepStrictEqual(thread.usage ?? {}, coreUsage)) mismatches.push('usage values differ');
  if (coreTurn.startedAt !== message?.at) mismatches.push(`start time: legacy=${message?.at} core=${coreTurn.startedAt}`);
  if (coreTurn.completedAt !== message?.endedAt) mismatches.push(`end time: legacy=${message?.endedAt} core=${coreTurn.completedAt}`);

  return mismatches;
}

module.exports = { compareTurn };
