const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tools } = require('./handoff-tools');

const knownTools = new Set(tools.map(tool => tool.name));

class HandoffAccess {
  constructor(runtime) { this.runtime = runtime; this.keys = new Map(); this.closing = false; }
  async connection(thread) {
    const checkpointId = thread.pendingHandoff?.checkpointId || this.runtime.handoffs.latest(thread.id)?.checkpointId;
    if (!checkpointId || this.runtime.adapters.get(thread.harnessId)?.manifest.integrations?.mcp !== true) return null;
    if (!this.starting) this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    await this.starting;
    const key = randomUUID();
    this.keys.set(key, { threadId: thread.id, checkpointId });
    return { name: 'harness-mix-handoff', command: process.execPath, args: [path.join(__dirname, 'handoff-mcp.cjs')], env: { HARNESS_MIX_HANDOFF_URL: `http://127.0.0.1:${this.server.address().port}`, HARNESS_MIX_HANDOFF_KEY: key } };
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
      reply(200, { result: this.call(scope, name, args) });
    } catch (error) { reply(400, { error: error.message }); }
  }
  call(scope, name, args) {
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
