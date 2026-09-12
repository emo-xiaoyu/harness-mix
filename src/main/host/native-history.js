const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexAppServer } = require('../adapters/codex-app-server');

const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => v.type === 'text' || v.type === 'input_text').map(v => v.text || '').join('\n') : '';
const message = (role, value, at) => ({ id: randomUUID(), role, text: text(value), at: at || 0 });

async function piRows(directory) {
  const rows = [];
  async function visit(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await visit(file, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stat = await fs.stat(file);
      if (stat.size > 32 * 1024 * 1024) continue;
      const lines = (await fs.readFile(file, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const header = lines.find(e => e.type === 'session');
      if (!header?.id || !path.isAbsolute(header.cwd || '')) continue;
      const byId = new Map(lines.filter(e => e.id).map(e => [e.id, e]));
      const branch = [], visited = new Set();
      let leaf = lines.findLast(e => e.id && e.type !== 'session');
      while (leaf && !visited.has(leaf.id)) { visited.add(leaf.id); branch.unshift(leaf); leaf = byId.get(leaf.parentId); }
      const messages = branch.filter(e => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role)).map(e => message(e.message.role, e.message.content, Date.parse(e.timestamp)));
      rows.push({ nativeSessionId: header.id, cwd: header.cwd, updatedAt: Math.floor(stat.mtimeMs), title: lines.findLast(e => e.type === 'session_info')?.name || messages.find(m => m.role === 'user')?.text.slice(0, 120) || null, running: null, messages, nativeSessionFile: file });
    }
  }
  await visit(directory, 0);
  return rows;
}

async function listNative(harnessId) {
  if (harnessId === 'codebuddy') return require('../adapters/codebuddy-history').listCodeBuddyHistory();
  if (harnessId === 'pi') return piRows(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions'));
  if (harnessId === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return (await sdk.listSessions()).filter(s => path.isAbsolute(s.cwd || '')).map(s => ({ nativeSessionId: s.sessionId, title: s.customTitle || s.summary || null, cwd: s.cwd, updatedAt: s.lastModified, running: null }));
  }
  if (harnessId === 'codex') {
    const host = await CodexAppServer.acquire();
    try {
      const rows = []; let cursor;
      do {
        const page = await host.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        rows.push(...page.data.filter(s => path.isAbsolute(s.cwd || '')).map(s => ({ nativeSessionId: s.id, title: s.name || s.preview || null, cwd: s.cwd, updatedAt: s.updatedAt * 1000, running: s.status?.type === 'active' ? true : null })));
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    } finally { host.release(); }
  }
  return [];
}

async function readNative(harnessId, candidate) {
  if (harnessId === 'codebuddy') {
    const history = require('../adapters/codebuddy-history');
    return history.messages(await history.readCodeBuddyHistory(candidate.cwd, candidate.nativeSessionId));
  }
  if (candidate.messages) return candidate.messages;
  if (harnessId === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return (await sdk.getSessionMessages(candidate.nativeSessionId, { dir: candidate.cwd })).filter(m => ['user', 'assistant'].includes(m.type) && !m.parent_tool_use_id).map(m => message(m.type, m.message?.content, candidate.updatedAt));
  }
  if (harnessId === 'codex') {
    const host = await CodexAppServer.acquire();
    try {
      const { thread } = await host.request('thread/read', { threadId: candidate.nativeSessionId, includeTurns: true });
      return (thread.turns || []).flatMap(t => (t.items || []).flatMap(i => i.type === 'userMessage' ? [message('user', i.content, candidate.updatedAt)] : i.type === 'agentMessage' ? [message('assistant', i.text, candidate.updatedAt)] : []));
    } finally { host.release(); }
  }
  return [];
}

module.exports = { listNative, readNative, piRows };
