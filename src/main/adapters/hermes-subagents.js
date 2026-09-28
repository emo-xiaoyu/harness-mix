const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function decodeContent(value) {
  if (typeof value !== 'string' || !value.startsWith('\0json:')) return value;
  try { return JSON.parse(value.slice(6)); } catch { return value; }
}

function contentParts(value) {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(part => part?.type === 'text' && part.text ? [{ type: 'text', text: part.text }]
    : part?.type === 'image_url' ? [] : []);
}

function hermesMessages(rows) {
  return rows.flatMap(row => {
    const role = row.role;
    if (!['user', 'assistant', 'tool'].includes(role)) return [];
    const parts = contentParts(decodeContent(row.content));
    if (role === 'assistant' && row.tool_calls) {
      let calls;
      try { calls = JSON.parse(row.tool_calls); } catch { calls = []; }
      for (const call of Array.isArray(calls) ? calls : []) {
        if (!call?.id) continue;
        parts.push({ type: 'tool', callID: call.id, tool: call.function?.name || '工具',
          state: { status: 'completed', input: call.function?.arguments } });
      }
    }
    if (role === 'tool' && row.tool_call_id) parts.push({ type: 'tool', callID: row.tool_call_id,
      tool: '工具结果', state: { status: 'completed', output: decodeContent(row.content) } });
    if (!parts.length) return [];
    const projectedRole = role === 'tool' ? 'assistant' : role;
    return [{ info: { role: projectedRole, time: { completed: projectedRole === 'assistant' ? Date.now() : undefined } }, parts }];
  });
}

function createHermesSubagentBridge({ parentId, emit, environment = {}, diagnostic = () => {} }) {
  if (!parentId) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { diagnostic('Hermes subagent projection unavailable: node:sqlite missing'); return null; }
  const dbPath = path.join(environment.HERMES_HOME || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), 'state.db');
  const signatures = new Map();
  let pending = null;
  let closed = false;

  function scan() {
    if (closed || pending) return pending;
    pending = (async () => {
      if (!fs.existsSync(dbPath)) return;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      let children;
      try {
        children = db.prepare('SELECT id, title, ended_at, end_reason, model_config FROM sessions WHERE parent_session_id = ?').all(parentId);
        for (const child of children) {
          let config;
          try { config = JSON.parse(child.model_config || '{}'); } catch { continue; }
          if (config._delegate_from !== parentId) continue;
          const rows = db.prepare('SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? AND active = 1 ORDER BY id').all(child.id);
          const messages = hermesMessages(rows);
          if (!messages.length) continue;
          const status = child.ended_at == null ? 'running' : ['failed', 'error', 'cancelled'].includes(child.end_reason) ? 'failed' : 'success';
          const signature = JSON.stringify([status, rows]);
          if (signatures.get(child.id) === signature || closed) continue;
          signatures.set(child.id, signature);
          await emit({ kind: 'native-subagent', nativeSessionId: child.id,
            title: child.title || 'Hermes 子代理', task: messages.find(item => item.info.role === 'user')?.parts.find(part => part.type === 'text')?.text || '',
            status, messages });
        }
      } finally { db.close(); }
    })().catch(error => diagnostic(`Hermes subagent read failed: ${error.message}`)).finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void scan(); }, 1500);
  timer.unref?.();
  void scan();
  return { scan, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createHermesSubagentBridge, hermesMessages };
