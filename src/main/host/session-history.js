const { listNative, readNative } = require('./native-history');
const external = id => ({ codex: 'codex-harness', claude: 'claude-code', dsh: 'deepseek-harness' }[id] || id);
const local = id => ({ workbuddy: 'codebuddy', 'codex-harness': 'codex', 'claude-code': 'claude', 'deepseek-harness': 'dsh' }[id] || id);

// 引用会话读取：发送时的预取信封只带最近一页；MCP 只读工具按 offset 逐页向更早翻
const MAX_PAGE = 50;
const TRANSCRIPT_BUDGET = 24000;

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
  async import(identity) {
    const key = JSON.stringify([identity.harnessId, identity.nativeSessionId]);
    if (this.imports.has(key)) return this.imports.get(key);
    const operation = (async () => {
      const { harnessId, nativeSessionId, row } = await this.#locate(identity);
      if (row.threadId) return { threadId: row.threadId };
      if (row.running) throw new Error('Native session is active');
      const messages = await this.providers.readNative(harnessId, row);
      const thread = await this.runtime.importNativeSession({ ...row, harnessId, messages });
      return { threadId: thread.id };
    })().finally(() => this.imports.delete(key));
    this.imports.set(key, operation);
    return operation;
  }

  /** 解码 harness-mix://session/<id> 引用（all-harnesses 时为 base64url 的 [harnessId, nativeSessionId]）并定位行 */
  async #locate({ harnessId = 'all-harnesses', nativeSessionId }) {
    const sessionRef = nativeSessionId;
    if (harnessId === 'all-harnesses') {
      const decoded = JSON.parse(Buffer.from(nativeSessionId, 'base64url').toString());
      if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every(v => typeof v === 'string')) throw new Error('Invalid history identity');
      [harnessId, nativeSessionId] = decoded;
    }
    harnessId = local(harnessId);
    const row = (await this.rows(harnessId)).find(candidate => candidate.nativeSessionId === nativeSessionId);
    if (!row) throw new Error('Referenced native session no longer exists');
    return { harnessId, nativeSessionId, sessionRef, row };
  }

  #managed(row) { return row.threadId ? this.runtime.threads.find(thread => thread.id === row.threadId) : undefined; }

  #metadata(harnessId, row, messageCount) {
    const managed = this.#managed(row);
    return {
      harnessId: external(harnessId),
      title: row.title || '未命名会话',
      cwd: row.cwd,
      branch: managed?.gitInfo?.branch ?? null,
      model: managed?.model ?? null,
      messageCount: messageCount ?? null,
      usage: managed?.usage ?? null,
      updatedAt: row.updatedAt ?? null,
      running: row.running ?? (managed ? this.runtime.execution.isRunning(managed.id) : null),
    };
  }

  /** 引用会话元数据：保持廉价，不为统计拉取原生全文（无内嵌消息的行 messageCount 为 null） */
  async info(identity) {
    const { harnessId, sessionRef, row } = await this.#locate(identity);
    const messages = this.#managed(row)?.messages ?? row.messages ?? null;
    const count = messages ? messages.filter(m => ['user', 'assistant'].includes(m.role) && m.text).length : null;
    return { sessionRef, ...this.#metadata(harnessId, row, count) };
  }

  /** 引用会话正文：offset 0 为最近一页，按 nextOffset 逐页向更早翻；transcript 受字符预算约束 */
  async context({ offset = 0, limit = 12, ...identity }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error('Invalid history paging');
    const { harnessId, sessionRef, row } = await this.#locate(identity);
    const managed = this.#managed(row);
    const messages = managed ? managed.messages : await this.providers.readNative(harnessId, row);
    const all = messages.filter(message => ['user', 'assistant'].includes(message.role) && message.text);
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    return {
      sessionRef,
      ...this.#metadata(harnessId, row, all.length),
      offset,
      returned: page.length,
      hasMore: start > 0,
      nextOffset: start > 0 ? offset + page.length : null,
      transcript: page.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n').slice(-TRANSCRIPT_BUDGET),
    };
  }
}
module.exports = { SessionHistory };
