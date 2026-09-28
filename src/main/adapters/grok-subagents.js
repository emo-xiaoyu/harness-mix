const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { jsonlFile } = require('./native-file-subagents');

function grokMessages(rows, childId) {
  const messages = [];
  const tools = new Map();
  for (const row of rows) {
    if (row?.params?.sessionId !== childId) continue;
    const u = row.params.update;
    if (!u) continue;
    const time = Number.isFinite(row.timestamp) ? row.timestamp * 1000 : Date.now();
    const content = Array.isArray(u.content) ? u.content.map(part => part.text || '').join('') : u.content?.text || '';
    if (u.sessionUpdate === 'user_message_chunk' && content) {
      messages.push({ info: { role: 'user', time: { created: time } }, parts: [{ type: 'text', text: content }] });
    } else if (u.sessionUpdate === 'agent_message_chunk' && content) {
      // Each persisted chunk gets its own stable row. The Host appends native
      // rows by index, so merging a later chunk into an old row would lose it.
      messages.push({ info: { role: 'assistant', time: { created: time, completed: time } }, parts: [{ type: 'text', text: content }] });
    } else if (u.sessionUpdate === 'agent_thought_chunk' && content) {
      messages.push({ info: { role: 'assistant', time: { created: time, completed: time } }, parts: [{ type: 'reasoning', text: content }] });
    } else if (['tool_call', 'tool_call_update'].includes(u.sessionUpdate) && u.toolCallId) {
      const tool = { ...tools.get(u.toolCallId), ...u };
      tools.set(u.toolCallId, tool);
      messages.push({ info: { role: 'assistant', time: { created: time, completed: time } },
        parts: [{ type: 'tool', callID: u.toolCallId, tool: tool.title || tool.kind || '工具',
          state: { status: tool.status === 'failed' ? 'error' : tool.status === 'completed' ? 'completed' : 'running',
            input: tool.rawInput, output: tool.rawOutput || (Array.isArray(tool.content) ? tool.content.map(part => part.text || '').join('\n') : undefined) } }] });
    }
  }
  return messages;
}

function createGrokSubagentBridge({ cwd, parentId, emit, diagnostic = () => {} }) {
  if (!parentId) return null;
  const root = path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'sessions');
  const parentDir = path.join(root, encodeURIComponent(cwd), parentId);
  let closed = false;
  let pending = null;
  const signatures = new Map();
  const hints = new Map();

  async function scan() {
    if (closed || pending) return pending;
    pending = (async () => {
      let entries;
      try { entries = await fs.readdir(path.join(parentDir, 'subagents'), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let meta;
        try { meta = JSON.parse(await fs.readFile(path.join(parentDir, 'subagents', entry.name, 'meta.json'), 'utf8')); } catch { continue; }
        if (meta.parent_session_id !== parentId || !/^[A-Za-z0-9_-]{1,128}$/.test(meta.child_session_id || '') || !meta.subagent_id) continue;
        const childCwd = meta.child_cwd || cwd;
        const transcript = path.join(root, encodeURIComponent(childCwd), meta.child_session_id, 'updates.jsonl');
        const messages = grokMessages(await jsonlFile(transcript), meta.child_session_id);
        if (!messages.length) continue;
        const id = meta.child_session_id;
        const status = meta.status === 'completed' ? 'success' : ['failed', 'cancelled'].includes(meta.status) ? 'failed' : 'running';
        const title = meta.description || hints.get(meta.subagent_id)?.description || `Grok · ${meta.subagent_type || '子代理'}`;
        const signature = JSON.stringify([status, messages]);
        if (signatures.get(id) === signature || closed) continue;
        signatures.set(id, signature);
        await emit({ kind: 'native-subagent', nativeSessionId: id, title, task: meta.prompt || '', status, messages });
      }
    })().catch(error => diagnostic(`Grok subagent read failed: ${error.message}`)).finally(() => { pending = null; });
    return pending;
  }
  function onEvent(event) {
    const u = event?.params?.update;
    if (event?.params?.sessionId !== parentId || !u) return;
    if (u.sessionUpdate === 'subagent_spawned' && u.subagentId) hints.set(u.subagentId, u);
    if (['subagent_spawned', 'subagent_finished', 'subagent_progress'].includes(u.sessionUpdate)) void scan();
  }
  const timer = setInterval(() => { void scan(); }, 1500);
  timer.unref?.();
  void scan();
  return { onEvent, scan, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createGrokSubagentBridge, grokMessages };
