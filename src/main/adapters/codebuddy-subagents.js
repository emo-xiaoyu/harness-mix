const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 1500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function readRows(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return [];
    const body = await fs.readFile(file, 'utf8');
    const rows = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { break; }
    }
    return rows;
  } catch { return []; }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

function childMessages(rows) {
  return rows.flatMap(row => {
    const role = row?.type === 'message' && row.role === 'user' ? 'user' : 'assistant';
    let part;
    if (row?.type === 'message' && ['user', 'assistant'].includes(row.role)) {
      const text = contentText(row.content);
      if (text) part = { type: 'text', text };
    } else if (row?.type === 'reasoning' && contentText(row.content)) {
      part = { type: 'reasoning', text: contentText(row.content) };
    } else if (row?.type === 'function_call' && row.callId) {
      part = { type: 'tool', callID: row.callId, tool: row.name || '工具',
        state: { status: 'completed', input: row.arguments } };
    } else if (row?.type === 'function_call_result' && row.callId) {
      part = { type: 'tool', callID: row.callId, tool: row.name || '工具结果',
        state: { status: row.status === 'error' ? 'error' : 'completed', output: row.output } };
    }
    if (!part) return [];
    const at = Number.isFinite(row.timestamp) ? row.timestamp : Date.parse(row.timestamp);
    const time = Number.isFinite(at) ? at : Date.now();
    return [{ info: { role, time: { created: time, ...(role === 'assistant' ? { completed: time } : {}) } }, parts: [part] }];
  });
}

function lifecycleStatus(parentRows, parentId, childId) {
  let latest;
  for (const row of parentRows) {
    const nested = row?.subAgent || row?.output?.subAgent || row?.providerData?.subAgent;
    const state = nested?.descriptor || nested?.lifecycle || nested;
    if (state?.sessionId === childId && state?.parentSessionId === parentId) latest = state.status;
  }
  return latest === 'completed' ? 'success' : ['failed', 'cancelled'].includes(latest) ? 'failed' : 'running';
}

function createCodeBuddySubagentBridge({ cwd, parentId, environment = {}, emit, diagnostic = () => {} }) {
  if (!validId(parentId)) return null;
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const root = path.join(environment.CODEBUDDY_CONFIG_DIR || path.join(home, '.codebuddy'), 'projects');
  let closed = false;
  let pending = null;
  const signatures = new Map();

  async function scanNow() {
    let projects;
    try { projects = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const project of projects.filter(item => item.isDirectory() && !item.isSymbolicLink()).slice(0, 2000)) {
      const base = path.join(root, project.name);
      const parentRows = await readRows(path.join(base, `${parentId}.jsonl`));
      if (!parentRows.length || !parentRows.some(row => row.sessionId === parentId && typeof row.cwd === 'string'
        && samePath(path.resolve(row.cwd), path.resolve(cwd)))) continue;
      if (parentRows.some(row => row.sessionId && row.sessionId !== parentId || row.cwd
        && !samePath(path.resolve(row.cwd), path.resolve(cwd)))) continue;
      const directory = path.join(base, parentId, 'subagents');
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) continue;
        const childId = entry.name.slice(6, -6);
        const rows = await readRows(path.join(directory, entry.name));
        const messages = childMessages(rows);
        if (!messages.length || closed) continue;
        const status = lifecycleStatus(parentRows, parentId, childId);
        const signature = JSON.stringify([status, messages.map(item => [item.info.role, item.parts])]);
        if (signatures.get(childId) === signature) continue;
        signatures.set(childId, signature);
        const task = messages.find(item => item.info.role === 'user')?.parts.find(part => part.type === 'text')?.text || '';
        await emit({ kind: 'native-subagent', nativeSessionId: `${parentId}:codebuddy:${childId}`,
          title: `CodeBuddy · ${childId}`, task, status, messages });
      }
    }
  }

  function scan() {
    if (closed || pending) return pending;
    pending = scanNow().catch(error => diagnostic(`CodeBuddy subagent read failed: ${error.message}`))
      .finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void scan(); }, POLL_MS);
  timer.unref?.();
  void scan();
  return { scan, settle: scan, resume() {}, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createCodeBuddySubagentBridge, childMessages, lifecycleStatus };
