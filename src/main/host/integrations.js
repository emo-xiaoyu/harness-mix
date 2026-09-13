const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');

const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

// This store contains only user-managed launch declarations. Native account,
// authentication and MCP configuration files are never read or rewritten.
class Integrations {
  constructor(runtime, { home = os.homedir(), environment = process.env } = {}) {
    this.runtime = runtime;
    this.home = home;
    this.environment = environment;
    this.file = path.join(runtime.store.directory, 'integrations.json');
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.servers)) throw new Error('Invalid integration store; original file preserved');
      return data;
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, servers: [] }; throw e; }
  }
  serial(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  adapter(id) {
    const adapter = this.runtime.adapters.get(this.runtime.resolveHarnessId(id));
    if (!adapter) throw new Error('Unknown Harness');
    return adapter;
  }
  async scope(input) {
    if (input.scope === 'global') return { scope: 'global', cwd: null };
    if (input.scope !== 'project' || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('Choose an absolute project directory');
    const cwd = await fs.realpath(input.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Project directory is unavailable');
    return { scope: 'project', cwd };
  }
  async catalog() {
    return { harnesses: [...this.runtime.adapters.values()].map(a => ({ id: a.manifest.id, name: a.manifest.name,
      available: this.runtime.status[a.manifest.id]?.available === true,
      mcp: a.manifest.integrations?.mcp === true, skills: !!a.manifest.integrations?.skills,
    })) };
  }
  async list(input) {
    await this.queue;
    const adapter = this.adapter(input.harnessId), scope = await this.scope(input);
    const data = await this.read();
    const rows = data.servers.filter(s => s.harnessId === adapter.manifest.id && (s.scope === 'global' || (scope.cwd && s.cwd === scope.cwd)));
    const effective = new Map();
    for (const row of [...rows].sort((a, b) => (a.scope === 'project') - (b.scope === 'project'))) effective.set(row.name, row);
    const sessions = [...this.runtime.sessions.values()].filter(s => s.adapter.manifest.id === adapter.manifest.id && (!scope.cwd || s.integrationCwd === scope.cwd));
    const servers = rows.map(row => ({ ...row, editable: row.scope === scope.scope && row.cwd === scope.cwd,
      effective: effective.get(row.name) === row, appliedSessions: sessions.filter(s => s.integrationServers?.some(r => r.id === row.id && r.digest === digest(row))).length }));
    const native = (await Promise.all(sessions.slice(0, 8).map(async session => {
      if (!adapter.inspectIntegrations) return [];
      let timer;
      try {
        const rows = await Promise.race([adapter.inspectIntegrations(session), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })]);
        return rows.map(row => ({ sessionId: session.nativeSessionId, name: String(row.name).slice(0, 150), status: ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(row.status) ? row.status : 'unknown', tools: (row.tools || []).slice(0, 200).map(t => String(t).slice(0, 150)) }));
      } catch { return [{ sessionId: session.nativeSessionId, name: '', status: 'unavailable', tools: [] }]; }
      finally { clearTimeout(timer); }
    }))).flat();
    return { harnessId: adapter.manifest.id, ...scope, mcpSupported: adapter.manifest.integrations?.mcp === true,
      skillsSupported: !!adapter.manifest.integrations?.skills, servers, native, skills: await this.skills(adapter, scope),
      note: 'Managed MCP declarations only; native configuration is retained. Applied means passed to a native session, not connected. Changes take effect on the next session open.' };
  }
  async save(input) {
    return this.serial(async () => {
      const adapter = this.adapter(input.harnessId), scope = await this.scope(input);
      if (!adapter.manifest.integrations?.mcp) throw new Error('This Harness has no supported native MCP injection interface');
      const s = input.server;
      if (!s || !slug(s.name) || s.name === 'harness-mix' || typeof s.command !== 'string' || !s.command.trim() || s.command.length > 2048 || /[\r\n\0]/.test(s.command)) throw new Error('Invalid MCP name or executable');
      if (!Array.isArray(s.args) || s.args.length > 100 || s.args.some(a => typeof a !== 'string' || a.length > 4096 || /[\r\n\0]/.test(a))) throw new Error('Arguments must be a JSON array of strings');
      if (Object.keys(s).some(k => !['name', 'command', 'args', 'enabled'].includes(k))) throw new Error('Only executable and arguments are supported; configure credentials in the native environment');
      if (typeof s.enabled !== 'boolean') throw new Error('enabled must be boolean');
      if (/(?:api[_-]?key|token|password|secret|authorization)(?:=|\s)|:\/\/[^/\s]+@/i.test([s.command, ...s.args].join(' '))) throw new Error('Use the native environment for credentials, not MCP arguments');
      const data = await this.read();
      const index = data.servers.findIndex(r => r.harnessId === adapter.manifest.id && r.scope === scope.scope && r.cwd === scope.cwd && r.name === s.name);
      const row = { id: index < 0 ? randomUUID() : data.servers[index].id, harnessId: adapter.manifest.id, ...scope, name: s.name, command: s.command.trim(), args: s.args, enabled: s.enabled };
      if (index < 0) data.servers.push(row); else data.servers[index] = row;
      await this.write(data);
      return { saved: true };
    });
  }
  async remove(input) {
    return this.serial(async () => {
      const adapter = this.adapter(input.harnessId), scope = await this.scope(input), data = await this.read();
      const index = data.servers.findIndex(r => r.id === input.id && r.harnessId === adapter.manifest.id && r.scope === scope.scope && r.cwd === scope.cwd);
      if (index < 0) throw new Error('Managed MCP entry no longer exists in this scope');
      data.servers.splice(index, 1); await this.write(data); return { removed: true };
    });
  }
  async write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, this.file); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async forSession(thread, adapter) {
    await this.queue;
    if (!adapter.manifest.integrations?.mcp) return { servers: [], records: [] };
    const cwd = await fs.realpath(thread.cwd), data = await this.read(), selected = new Map();
    for (const scope of ['global', 'project']) for (const s of data.servers) {
      if (s.harnessId === adapter.manifest.id && s.scope === scope && (scope === 'global' || s.cwd === cwd)) selected.set(s.name, s);
    }
    const rows = [...selected.values()].filter(s => s.enabled);
    return { servers: rows.map(s => ({ name: `hm-user-${s.name}`, command: s.command, args: s.args, env: {} })), records: rows.map(s => ({ id: s.id, digest: digest(s) })), cwd };
  }
  roots(adapter, scope) {
    const spec = adapter.manifest.integrations?.skills;
    if (!spec) return [];
    return (spec[scope.scope] || []).map(relative => {
      const override = scope.scope === 'global' && spec.overrides?.[relative];
      const value = override && this.environment[override.env];
      return value && path.isAbsolute(value) ? path.resolve(value, override.suffix) : path.resolve(scope.cwd || this.home, relative);
    });
  }
  async safeRoot(root) {
    // Reject junctions/symlinks at every existing component before writes.
    let cursor = path.parse(root).root;
    for (const part of path.relative(cursor, root).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Linked skill directories are read-only'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  async skills(adapter, scope) {
    const result = [];
    for (const root of this.roots(adapter, scope)) for (const enabled of [true, false]) {
      const directory = enabled ? root : `${root}.harness-mix-disabled`;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const entry of entries.slice(0, 1000)) {
        if (!slug(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        const file = path.join(directory, entry.name, 'SKILL.md');
        if (!await exists(file)) continue;
        let writable = !entry.isSymbolicLink();
        try { await this.safeRoot(path.dirname(file)); } catch { writable = false; }
        result.push({ name: entry.name, path: file, root, enabled, writable, scope: scope.scope, status: 'discovered' });
      }
    }
    return result;
  }
  async skillChange(input) {
    return this.serial(async () => {
      const adapter = this.adapter(input.harnessId), scope = await this.scope(input), roots = this.roots(adapter, scope);
      if (!roots.length) throw new Error('Native Skills management is not supported for this Harness');
      if (!slug(input.name)) throw new Error('Invalid skill directory name');
      const root = input.root || roots[0];
      if (!roots.includes(root)) throw new Error('Unknown native skill root');
      await this.safeRoot(root); await this.safeRoot(`${root}.harness-mix-disabled`);
      const active = path.join(root, input.name), inactive = path.join(`${root}.harness-mix-disabled`, input.name);
      if (input.action === 'install') {
        if (await exists(active) || await exists(inactive)) throw new Error('Skill already exists; existing files were preserved');
        if (typeof input.source !== 'string' || !path.isAbsolute(input.source)) throw new Error('Choose an absolute local skill directory');
        await this.safeRoot(input.source);
        const source = await fs.realpath(input.source);
        if (within(source, active)) throw new Error('Skill source must not contain the destination');
        const files = []; let bytes = 0;
        const walk = async dir => {
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Skill installation does not follow symbolic links');
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) {
              bytes += (await fs.stat(file)).size; files.push(path.relative(source, file));
              if (bytes > 10 * 1024 * 1024 || files.length > 500) throw new Error('Skill exceeds 10 MB or 500 files');
            } else throw new Error('Unsupported skill file type');
          }
        };
        await walk(source);
        if (!files.includes('SKILL.md')) throw new Error('Source must contain SKILL.md');
        const staging = path.join(path.dirname(root), `.hm-skill-${randomUUID()}`);
        try {
          await fs.mkdir(staging, { recursive: true });
          for (const relative of files) {
            const target = path.join(staging, relative);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(path.join(source, relative), target);
          }
          await fs.mkdir(root, { recursive: true }); await fs.rename(staging, active);
        } finally { if (within(path.dirname(root), staging)) await fs.rm(staging, { recursive: true, force: true }); }
      } else if (input.action === 'enable' || input.action === 'disable') {
        const from = input.action === 'enable' ? inactive : active, to = input.action === 'enable' ? active : inactive;
        await this.safeRoot(from);
        if (!await exists(path.join(from, 'SKILL.md'))) throw new Error('Skill no longer exists');
        if (await exists(to)) throw new Error('Destination already exists; existing files were preserved');
        await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to);
      } else throw new Error('Unknown skill action');
      return { saved: true, effective: 'next-session' };
    });
  }
}
module.exports = { Integrations };
