const { listNative, readNative } = require('./native-history');
const external = id => ({ codex: 'codex-harness', claude: 'claude-code', dsh: 'deepseek-harness' }[id] || id);
const local = id => ({ workbuddy: 'codebuddy', 'codex-harness': 'codex', 'claude-code': 'claude', 'deepseek-harness': 'dsh' }[id] || id);

class SessionHistory {
  constructor(runtime, providers = { listNative, readNative }) { this.runtime = runtime; this.providers = providers; this.imports = new Map(); }
  sources() { return { harnesses: [{ harnessId: 'all-harnesses', name: '全部历史' }, ...[...this.runtime.adapters.values()].map(a => ({ harnessId: external(a.manifest.id), name: a.manifest.name + (['pi', 'claude', 'codex', 'codebuddy'].includes(a.manifest.id) ? '' : '（Host 历史）') }))] }; }
  async rows(id) {
    if (id === 'all-harnesses') return (await Promise.all([...this.runtime.adapters.keys()].map(key => this.rows(key)))).flat().map(row => ({ ...row, nativeSessionId: Buffer.from(JSON.stringify([row.harnessId, row.nativeSessionId])).toString('base64url'), title: `[${row.harnessId}] ${row.title || '未命名会话'}` }));
    id = local(id);
    if (!this.runtime.adapters.has(id)) throw new Error('Unknown history source');
    const managed = this.runtime.threads.filter(t => t.harnessId === id && !t.ephemeral).map(t => ({ harnessId: id, nativeSessionId: t.nativeSessionId, threadId: t.id, title: t.title || null, cwd: t.cwd, updatedAt: t.updatedAt || t.createdAt, running: this.runtime.execution.isRunning(t.id) }));
    const native = await this.providers.listNative(id);
    const seen = new Set(managed.map(r => r.nativeSessionId));
    return [...managed, ...native.filter(r => !seen.has(r.nativeSessionId)).map(r => ({ ...r, harnessId: id }))];
  }
  async list({ harnessId, query = '', offset = 0, limit = 20 }) {
    if (typeof query !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid history query');
    const needle = query.toLowerCase();
    const rows = (await this.rows(harnessId)).filter(r => `${r.title} ${r.cwd} ${r.nativeSessionId}`.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt || a.nativeSessionId.localeCompare(b.nativeSessionId));
    return { total: rows.length, candidates: rows.slice(offset, offset + limit).map(({ nativeSessionId, title, cwd, updatedAt, running }) => ({ nativeSessionId, title: title?.slice(0, 4096) || null, cwd, updatedAt, running })) };
  }
  async import({ harnessId, nativeSessionId }) {
    if (harnessId === 'all-harnesses') {
      const decoded = JSON.parse(Buffer.from(nativeSessionId, 'base64url').toString());
      if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every(v => typeof v === 'string')) throw new Error('Invalid history identity');
      [harnessId, nativeSessionId] = decoded;
    }
    harnessId = local(harnessId);
    const key = JSON.stringify([harnessId, nativeSessionId]);
    if (this.imports.has(key)) return this.imports.get(key);
    const operation = (async () => {
      const row = (await this.rows(harnessId)).find(r => r.nativeSessionId === nativeSessionId);
      if (!row) throw new Error('Native session no longer exists');
      if (row.threadId) return { threadId: row.threadId };
      if (row.running) throw new Error('Native session is active');
      const messages = await this.providers.readNative(harnessId, row);
      const thread = await this.runtime.importNativeSession({ ...row, harnessId, messages });
      return { threadId: thread.id };
    })().finally(() => this.imports.delete(key));
    this.imports.set(key, operation);
    return operation;
  }

  async context({ harnessId = 'all-harnesses', nativeSessionId }) {
    if (harnessId === 'all-harnesses') {
      const decoded = JSON.parse(Buffer.from(nativeSessionId, 'base64url').toString());
      if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every(v => typeof v === 'string')) throw new Error('Invalid history identity');
      [harnessId, nativeSessionId] = decoded;
    }
    harnessId = local(harnessId);
    const row = (await this.rows(harnessId)).find(candidate => candidate.nativeSessionId === nativeSessionId);
    if (!row) throw new Error('Referenced native session no longer exists');
    const managed = row.threadId && this.runtime.threads.find(thread => thread.id === row.threadId);
    const messages = managed ? managed.messages : await this.providers.readNative(harnessId, row);
    const selected = messages.filter(message => ['user', 'assistant'].includes(message.role) && message.text).slice(-12);
    return {
      harnessId: external(harnessId), title: row.title || '未命名会话', cwd: row.cwd,
      transcript: selected.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n').slice(-24000),
    };
  }
}
module.exports = { SessionHistory };
