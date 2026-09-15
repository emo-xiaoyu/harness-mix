const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tools } = require('./handoff-tools');

const knownTools = new Set(tools.map(tool => tool.name));
const sessionTools = new Set(['get_session_info', 'list_session_messages']);

class HandoffAccess {
  constructor(runtime) { this.runtime = runtime; this.keys = new Map(); this.closing = false; }
  async connection(thread) {
    if (this.runtime.adapters.get(thread.harnessId)?.manifest.integrations?.mcp !== true) return null;
    const latest = this.runtime.handoffs.latest(thread.id);
    const checkpointId = thread.pendingHandoff?.checkpointId || (latest?.status === 'active' ? latest.checkpointId : null);
    if (!this.starting) this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    await this.starting;
    // 原生会话重开会产生新 key：清掉同线程旧 key，避免悬空授权累积
    for (const [key, scope] of this.keys) if (scope.threadId === thread.id) this.keys.delete(key);
    const key = randomUUID();
    this.keys.set(key, { threadId: thread.id, checkpointId });
    return { name: 'harness-mix-handoff', command: process.execPath, args: [path.join(__dirname, 'handoff-mcp.cjs')], env: { HARNESS_MIX_HANDOFF_URL: `http://127.0.0.1:${this.server.address().port}`, HARNESS_MIX_HANDOFF_KEY: key } };
  }
  /** 该线程的原生会话是否已挂接 handoff MCP（决定预取信封是否提示可用只读工具） */
  attached(threadId) { for (const scope of this.keys.values()) if (scope.threadId === threadId) return true; return false; }
  /** 引用会话工具的授权依据：用户必须在本线程消息里显式给出 harness-mix://session/<id> 链接 */
  assertSessionReferenced(scope, sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session reference');
    const thread = this.runtime.threads.find(t => t.id === scope.threadId);
    const referenced = thread?.messages?.some(m => m.role === 'user' && typeof m.text === 'string' && m.text.includes(`harness-mix://session/${sessionId}`));
    if (!referenced) throw new Error('Session was not referenced by the user in this native session');
  }
  async handle(req, res) {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const key = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '')?.[1];
    const scope = key ? this.keys.get(key) : null;
    if (!scope || this.closing || req.method !== 'POST' || req.url !== '/' || req.headers.origin) return reply(403, { error: 'Forbidden' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 32_000) throw new Error('Request too large'); }
      const { name, arguments: args = {} } = JSON.parse(body);
      if (!knownTools.has(name)) throw new Error('Unknown handoff tool');
      if (args.checkpoint_id && args.checkpoint_id !== scope.checkpointId) throw new Error('Checkpoint is outside this native session scope');
      reply(200, { result: await this.call(scope, name, args) });
    } catch (error) { reply(400, { error: error.message }); }
  }
  async call(scope, name, args) {
    if (sessionTools.has(name)) {
      this.assertSessionReferenced(scope, args.session_id);
      const identity = { harnessId: 'all-harnesses', nativeSessionId: args.session_id };
      return name === 'get_session_info' ? this.runtime.history.info(identity) : this.runtime.history.context({ ...identity, offset: args.offset ?? 0, limit: args.limit ?? 12 });
    }
    if (!scope.checkpointId) throw new Error('No handoff checkpoint in this native session scope');
    const id = scope.checkpointId;
    if (name === 'get_handoff_checkpoint') return this.runtime.handoffs.get(scope.threadId, id);
    if (name === 'list_handoff_conversation') return this.runtime.handoffs.conversation(scope.threadId, id, args);
    if (name === 'list_handoff_evidence') return this.runtime.handoffs.evidence(scope.threadId, id);
    if (name === 'read_handoff_evidence') return this.runtime.handoffs.readEvidence(scope.threadId, id, args.evidence_id);
    if (name === 'list_handoff_files') return this.runtime.handoffs.files(scope.threadId, id);
    if (name === 'read_handoff_plan') return this.runtime.handoffs.plan(scope.threadId, id);
    throw new Error('Unknown handoff tool');
  }
  async close() {
    this.closing = true; this.keys.clear();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = { HandoffAccess };
