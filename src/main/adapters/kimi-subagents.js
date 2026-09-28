const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function kimiAgentMessages(rows) {
  const messages = [];
  let parts = [];
  const flush = () => {
    if (!parts.length) return;
    messages.push({ info: { role: 'assistant', time: { created: Date.now(), completed: Date.now() } }, parts });
    parts = [];
  };
  for (const row of rows) {
    if (row?.type === 'context.append_message' && row.message?.role === 'user') {
      flush();
      const content = row.message.content;
      const blocks = Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => ({ type: 'text', text: p.text }))
        : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      if (blocks.length) messages.push({ info: { role: 'user', time: { created: Date.parse(row.time) || Date.now() } }, parts: blocks });
    }
    const event = row?.type === 'context.append_loop_event' ? row.event : null;
    if (event?.type === 'content.part') {
      if (event.part?.type === 'text' && typeof event.part.text === 'string') parts.push({ type: 'text', text: event.part.text });
      if (event.part?.type === 'think' && typeof event.part.think === 'string') parts.push({ type: 'reasoning', text: event.part.think });
    }
    if (event?.type === 'tool.call' && event.toolCallId) parts.push({ type: 'tool', callID: event.toolCallId,
      tool: event.toolName || event.name || '工具', state: { status: 'running', input: event.arguments } });
    if (event?.type === 'step.end') flush();
  }
  flush();
  return messages;
}

async function readWire(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return [];
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).flatMap(line => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

function createKimiSubagentBridge({ parentId, environment = {}, emit, diagnostic = () => {} }) {
  if (!/^session_[\w-]+$/.test(parentId || '')) return null;
  const root = path.join(environment.KIMI_CODE_HOME || process.env.KIMI_CODE_HOME || path.join(environment.USERPROFILE || os.homedir(), '.kimi-code'), 'sessions');
  let closed = false, pending = null, settledStatus = 'success';
  const signatures = new Map();
  async function scan() {
    let workspaces;
    try { workspaces = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const agentsRoot = path.join(root, workspace.name, parentId, 'agents');
      let agents;
      try { agents = await fs.readdir(agentsRoot, { withFileTypes: true }); } catch { continue; }
      for (const agent of agents) {
        if (!agent.isDirectory() || agent.name === 'main' || !/^[\w.-]+$/.test(agent.name)) continue;
        const messages = kimiAgentMessages(await readWire(path.join(agentsRoot, agent.name, 'wire.jsonl')));
        if (!messages.length) continue;
        const status = settledStatus;
        const signature = JSON.stringify([status, messages]);
        if (signatures.get(agent.name) === signature || closed) continue;
        signatures.set(agent.name, signature);
        const task = messages.find(m => m.info.role === 'user')?.parts.find(p => p.type === 'text')?.text || '';
        await emit({ kind: 'native-subagent', nativeSessionId: `${parentId}:kimi:${agent.name}`, title: `Kimi Code · ${agent.name}`,
          task, status, messages });
      }
    }
  }
  const schedule = () => {
    if (closed || pending) return pending;
    pending = scan().catch(error => diagnostic(`Kimi subagent read failed: ${error.message}`)).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void schedule(); }, 1500);
  timer.unref?.();
  return { scan: schedule, resume() { settledStatus = 'running'; }, async settle(status = 'success') { settledStatus = status; await pending; await schedule(); },
    close() { closed = true; clearInterval(timer); } };
}

module.exports = { createKimiSubagentBridge, kimiAgentMessages };
