const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 1500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function readFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch { return null; }
}

function transcriptMessages(body) {
  if (!body) return [];
  const messages = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { break; } // The final line may still be written.
    if (!Number.isInteger(row.step_index) || row.status !== 'DONE') continue;
    const created = Date.parse(row.created_at);
    const time = Number.isFinite(created) ? created : Date.now();
    const role = row.type === 'USER_INPUT' ? 'user' : 'assistant';
    const parts = [];
    if (typeof row.thinking === 'string' && row.thinking) parts.push({ type: 'reasoning', text: row.thinking });
    if (typeof row.content === 'string' && row.content) parts.push({ type: 'text', text: row.content });
    if (row.type === 'PLANNER_RESPONSE' && Array.isArray(row.tool_calls)) {
      row.tool_calls.forEach((call, index) => {
        if (!call || typeof call.name !== 'string') return;
        parts.push({ type: 'tool', callID: `agy-step:${row.step_index}:${index}`, tool: call.name,
          state: { status: 'completed', input: call.args } });
      });
    }
    if (!parts.length || !['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC'].includes(row.type)) continue;
    messages.push({ info: { role, time: { created: time, ...(role === 'assistant' ? { completed: time } : {}) } }, parts });
  }
  return messages;
}

function subagentStatus(state) {
  return state === 'SUBAGENT_STATE_KILLED' ? 'failed' : 'running';
}

function createAntigravitySubagentBridge({ parentId, home = os.homedir(), emit, diagnostic = () => {} }) {
  if (!validId(parentId)) return null;
  const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain');
  let closed = false;
  let pending = null;
  const signatures = new Map();

  async function scanNow() {
    const directory = path.join(brain, parentId, '.system_generated', 'subagents');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !validId(entry.name.slice(0, -5)) || !entry.name.endsWith('.json')) continue;
      const childId = entry.name.slice(0, -5);
      const raw = await readFile(path.join(directory, entry.name));
      if (!raw) continue;
      let meta;
      try { meta = JSON.parse(raw); } catch { continue; }
      if (meta.conversationId !== childId) continue;
      const logs = path.join(brain, childId, '.system_generated', 'logs');
      const body = await readFile(path.join(logs, 'transcript_full.jsonl'))
        || await readFile(path.join(logs, 'transcript.jsonl'));
      const messages = transcriptMessages(body);
      if (!messages.length || closed) continue;
      const status = subagentStatus(meta.state);
      const signature = JSON.stringify([status, messages.map(item => [item.info.role, item.parts])]);
      if (signatures.get(childId) === signature) continue;
      signatures.set(childId, signature);
      const title = `Antigravity · ${meta.subagentDescriptor?.role || meta.subagentDescriptor?.typeName || '子代理'}`;
      const task = messages.find(item => item.info.role === 'user')?.parts.find(part => part.type === 'text')?.text || '';
      await emit({ kind: 'native-subagent', nativeSessionId: childId, title, task, status, messages });
    }
  }

  function scan() {
    if (closed || pending) return pending;
    pending = scanNow().catch(error => diagnostic(`Antigravity subagent read failed: ${error.message}`))
      .finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void scan(); }, POLL_MS);
  timer.unref?.();
  void scan();
  return { scan, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createAntigravitySubagentBridge, transcriptMessages, subagentStatus };
