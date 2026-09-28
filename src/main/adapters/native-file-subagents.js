const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 1500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

async function jsonFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

async function jsonlFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    const data = await fs.readFile(file, 'utf8');
    const rows = [];
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); }
      catch { break; } // A writer may still be appending the last line.
    }
    return rows;
  } catch { return []; }
}

function blocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const values = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  return values.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if ((block.type === 'thinking' || block.type === 'reasoning') && (block.thinking || block.text)) {
      return [{ type: 'reasoning', text: block.thinking || block.text }];
    }
    if (block.type === 'tool_use' && block.id) return [{ type: 'tool', callID: block.id,
      tool: block.name || '工具', state: { status: 'completed', input: block.input } }];
    if (block.type === 'tool_result' && block.tool_use_id) return [{ type: 'tool', callID: block.tool_use_id,
      tool: '工具结果', state: { status: block.is_error ? 'error' : 'completed', output: block.content } }];
    return [];
  });
}

function message(role, content, timestamp) {
  const parts = blocks(content);
  if (!parts.length) return null;
  const created = timestamp ? Date.parse(timestamp) : NaN;
  return { info: { role, time: { created: Number.isFinite(created) ? created : Date.now(),
    ...(role === 'assistant' ? { completed: Number.isFinite(created) ? created : Date.now() } : {}) } }, parts };
}

function qoderMessages(rows, parentId, agentId) {
  const verified = rows.filter(row => row?.sessionId === parentId && row?.agentId === agentId && row.isSidechain === true);
  if (!verified.length) return null;
  const messages = verified.flatMap(row => {
    if (!['user', 'assistant'].includes(row.type) || row.message?.role !== row.type) return [];
    // Tool results belong to the assistant tool stream, not to a new user prompt.
    const toolResult = row.type === 'user' && Array.isArray(row.message.content)
      && row.message.content.length && row.message.content.every(part => part?.type === 'tool_result');
    const item = message(toolResult ? 'assistant' : row.type, row.message.content, row.timestamp);
    return item ? [item] : [];
  });
  const lastAssistant = verified.filter(row => row.type === 'assistant').at(-1);
  const prompt = verified.find(row => row.type === 'user' && typeof row.message?.content === 'string')?.message.content || '';
  return { messages, task: prompt, status: lastAssistant?.message?.stop_reason === 'end_turn' ? 'success' : 'running' };
}

function cursorMessages(rows) {
  const messages = rows.flatMap(row => {
    if (!['user', 'assistant'].includes(row?.role)) return [];
    const item = message(row.role, row.message?.content, row.timestamp);
    return item ? [item] : [];
  });
  return { messages, task: messages.find(row => row.info.role === 'user')?.parts.find(part => part.type === 'text')?.text || '' };
}

async function projectDirectory(root, cwd, vendor) {
  const target = (vendor === 'cursor-cli' ? cwd.replace(/:/g, '') : cwd.replace(/:/g, '-'))
    .replace(/[\\/]/g, '-').toLowerCase();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const entry = entries.find(item => item.isDirectory() && item.name.toLowerCase() === target);
    return entry ? path.join(root, entry.name) : null;
  } catch { return null; }
}

function createNativeFileSubagentBridge({ vendor, cwd, parentId, environment = {}, emit, diagnostic = () => {} }) {
  if (!['qoder', 'cursor-cli', 'cline'].includes(vendor) || !parentId) return null;
  let closed = false;
  let pending = null;
  let parentSettled = true;
  let everTurn = false;
  const signatures = new Map();
  const cursorTerminal = new Map();
  const cursorThisTurn = new Set();
  const nativeHome = environment.HOME || environment.USERPROFILE || os.homedir();

  async function publish(id, title, task, status, messages) {
    if (!messages.length) return;
    const signature = JSON.stringify([status, messages.map(item => [item.info.role, item.parts])]);
    if (signatures.get(id) === signature || closed) return;
    signatures.set(id, signature);
    await emit({ kind: 'native-subagent', nativeSessionId: id, title, task, status, messages });
  }

  async function scanQoder() {
    const project = await projectDirectory(path.join(nativeHome, '.qoder', 'projects'), cwd, vendor);
    if (!project) return;
    const dir = path.join(project, parentId, 'subagents');
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^agent-[\w.-]+\.jsonl$/.test(entry.name)) continue;
      const agentId = entry.name.slice(6, -6);
      const result = qoderMessages(await jsonlFile(path.join(dir, entry.name)), parentId, agentId);
      if (result) await publish(`${parentId}:qoder:${agentId}`, `Qoder · ${agentId}`, result.task,
        result.status, result.messages);
    }
  }

  async function scanCursor() {
    const project = await projectDirectory(path.join(nativeHome, '.cursor', 'projects'), cwd, vendor);
    if (!project) return;
    const dir = path.join(project, 'agent-transcripts', parentId, 'subagents');
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[\w-]+\.jsonl$/.test(entry.name)) continue;
      const id = entry.name.slice(0, -6);
      const result = cursorMessages(await jsonlFile(path.join(dir, entry.name)));
      if (!everTurn && parentSettled) cursorTerminal.set(id, 'success'); // historical transcript on resume
      if (!cursorTerminal.has(id) && !parentSettled) cursorThisTurn.add(id);
      await publish(`${parentId}:cursor:${id}`, 'Cursor 子代理', result.task,
        cursorTerminal.get(id) || 'running', result.messages);
    }
  }

  async function scanCline() {
    const root = environment.CLINE_SESSION_DATA_DIR || path.join(environment.CLINE_DATA_DIR || path.join(nativeHome, '.cline', 'data'), 'sessions');
    const index = await jsonFile(path.join(root, 'sessions.index.json'));
    if (index?.version !== 1 || !index.sessions || typeof index.sessions !== 'object') return;
    for (const row of Object.values(index.sessions)) {
      if (row?.parentSessionId !== parentId || row.isSubagent !== true || row.metadata?.sessionHistoryOrigin?.mode !== 'subagent') continue;
      if (typeof row.cwd === 'string' && path.resolve(row.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) continue;
      if (!row.sessionId || !row.messagesPath || !path.isAbsolute(row.messagesPath)) continue;
      const relative = path.relative(root, row.messagesPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const payload = await jsonFile(row.messagesPath);
      if (!Array.isArray(payload?.messages)) continue;
      const messages = payload.messages.flatMap(item => {
        if (!['user', 'assistant'].includes(item?.role)) return [];
        const result = message(item.role, item.content, item.createdAt);
        return result ? [result] : [];
      });
      const status = row.status === 'completed' ? 'success' : ['failed', 'cancelled', 'stopped'].includes(row.status) ? 'failed' : 'running';
      // Cline rewrites its JSON message snapshot while a turn streams. Show
      // the stable prompt while running; import the full snapshot at terminal.
      const visible = status === 'running' ? messages.slice(0, 1).filter(item => item.info.role === 'user') : messages;
      await publish(row.sessionId, row.metadata?.title || `Cline · ${row.agentId || '子代理'}`, row.prompt || '', status, visible);
    }
  }

  function scan() {
    if (closed || pending) return pending;
    pending = (vendor === 'qoder' ? scanQoder() : vendor === 'cursor-cli' ? scanCursor() : scanCline())
      .catch(error => diagnostic(`${vendor} subagent read failed: ${error.message}`))
      .finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void scan(); }, POLL_MS);
  timer.unref?.();
  void scan();
  return { scan, async settle(status = 'success') {
    parentSettled = true;
    if (pending) await pending;
    for (const id of cursorThisTurn) cursorTerminal.set(id, status);
    cursorThisTurn.clear();
    return scan();
  }, resume() {
    everTurn = true;
    parentSettled = false;
    cursorThisTurn.clear();
  }, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createNativeFileSubagentBridge, qoderMessages, cursorMessages, jsonlFile };
