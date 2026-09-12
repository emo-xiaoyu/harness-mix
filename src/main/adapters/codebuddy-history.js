const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);
const root = () => path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects');
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function readFile(file) {
  const base = await fs.realpath(root());
  const real = await fs.realpath(file);
  const relative = path.relative(base, real);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !equal(path.resolve(file), real)) throw new Error('Native history path was redirected');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Native history file is unsafe or oversized');
  const body = await fs.readFile(file, 'utf8');
  const after = await fs.stat(file);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Native history changed while reading');
  return body.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
}
function branch(rows) {
  const byId = new Map(); let leaf;
  for (const row of rows) {
    if (!['message', 'reasoning', 'function_call', 'function_call_result'].includes(row.type)) continue;
    if (typeof row.id !== 'string' || !row.id) throw new Error('Native history has no stable item ID');
    byId.set(row.id, row); leaf = row.id;
  }
  const chain = [], seen = new Set();
  while (leaf) {
    if (seen.has(leaf) || !byId.has(leaf)) throw new Error('Native history parent chain is invalid');
    seen.add(leaf); const row = byId.get(leaf); chain.unshift(row); leaf = row.parentId;
  }
  return chain;
}
async function readCodeBuddyHistory(cwd, id) {
  if (!validId(id)) throw new Error('Invalid CodeBuddy native session ID');
  const dirs = await fs.readdir(root(), { withFileTypes: true });
  const found = [];
  for (const dir of dirs.filter(d => d.isDirectory() && !d.isSymbolicLink()).slice(0, 2000)) {
    const file = path.join(root(), dir.name, id + '.jsonl');
    try { await fs.access(file); found.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (found.length !== 1) throw new Error('Native CodeBuddy history missing or ambiguous');
  const rows = await readFile(found[0]);
  const currentCwd = await fs.realpath(cwd);
  const nativeCwds = [...new Set(rows.map(r => r.cwd).filter(v => typeof v === 'string'))];
  if (!nativeCwds.length) throw new Error('Native history has no workspace identity');
  for (const nativeCwd of nativeCwds) if (!equal(await fs.realpath(nativeCwd), currentCwd)) throw new Error('Native history belongs to another workspace');
  if (rows.some(r => r.sessionId && r.sessionId !== id)) throw new Error('Native history session mismatch');
  return branch(rows);
}
function historyUsage(rows) {
  const requests = new Map();
  for (const row of rows) if (row.providerData?.messageId && row.providerData.rawUsage) requests.set(row.providerData.messageId, row.providerData.rawUsage);
  const result = {};
  for (const [host, native] of Object.entries({ inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens', reasoningOutputTokens: 'completion_thinking_tokens', totalCredits: 'credit' })) {
    const values = [...requests.values()].map(r => r[native]);
    if (values.length && values.every(n => Number.isFinite(n) && n >= 0)) result[host] = values.reduce((a, b) => a + b, 0);
  }
  return result;
}
function messages(rows) {
  return rows.filter(r => r.type === 'message' && ['user', 'assistant'].includes(r.role)).map(r => ({ id: r.id, role: r.role,
    text: typeof r.content === 'string' ? r.content : (r.content || []).filter(c => ['text', 'input_text', 'output_text'].includes(c?.type) && typeof c.text === 'string').map(c => c.text).join('\n'),
    at: Number.isFinite(r.timestamp) ? r.timestamp : Date.parse(r.timestamp) || 0 }));
}
function latestAssistantAfterUser(rows, userMessageId) {
  const transcript = messages(rows);
  const exact = userMessageId ? transcript.findIndex(row => row.role === 'user' && row.id === userMessageId) : -1;
  const lastUser = exact >= 0 ? exact : transcript.findLastIndex(row => row.role === 'user');
  return transcript.slice(lastUser + 1).findLast(row => row.role === 'assistant')?.text || '';
}
async function listCodeBuddyHistory() {
  let dirs;
  try { dirs = await fs.readdir(root(), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const found = [];
  for (const dir of dirs.filter(d => d.isDirectory() && !d.isSymbolicLink()).slice(0, 2000)) {
    for (const entry of (await fs.readdir(path.join(root(), dir.name), { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith('.jsonl')).slice(0, 2000)) {
      const id = entry.name.slice(0, -6);
      if (!validId(id)) continue;
      const rows = await readFile(path.join(root(), dir.name, entry.name));
      const cwd = rows.find(r => typeof r.cwd === 'string')?.cwd;
      if (!cwd || !path.isAbsolute(cwd)) continue;
      // Validate before offering a writable import; never trust a filename alone.
      const chain = await readCodeBuddyHistory(cwd, id), transcript = messages(chain);
      found.push({ nativeSessionId: id, cwd, title: transcript.find(r => r.role === 'user')?.text.slice(0, 120) || null,
        updatedAt: (await fs.stat(path.join(root(), dir.name, entry.name))).mtimeMs, running: null });
    }
  }
  return found;
}
module.exports = { readCodeBuddyHistory, historyUsage, branch, messages, latestAssistantAfterUser, listCodeBuddyHistory };
