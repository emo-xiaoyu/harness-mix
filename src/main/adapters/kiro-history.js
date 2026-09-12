const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// Only an intact completed native turn is a supported fork boundary. Compacted
// or rewritten histories require a separate lineage implementation.
async function latestKiroCheckpoint(cwd, sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId || '')) throw new Error('Invalid Kiro session identity');
  const root = path.resolve(process.env.KIRO_HOME || path.join(os.homedir(), '.kiro'), 'sessions');
  const dirs = await fs.readdir(root, { withFileTypes: true });
  const found = [];
  for (const dir of dirs.filter(d => d.isDirectory() && !d.isSymbolicLink() && d.name !== 'cli').slice(0, 2000)) {
    const location = path.join(root, dir.name, sessionId);
    try { await fs.access(path.join(location, 'session.json')); found.push(location); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (found.length !== 1) throw new Error('Kiro native history missing or ambiguous');
  async function read(name) {
    const file = path.join(found[0], name), real = await fs.realpath(file);
    if (!same(real, file)) throw new Error('Kiro history path redirected');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Kiro history oversized');
    const body = await fs.readFile(file, 'utf8'), after = await fs.stat(file);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Kiro history changed during inspection');
    return body;
  }
  const meta = JSON.parse(await read('session.json'));
  if (meta.id !== sessionId || !Array.isArray(meta.workspacePaths) || !meta.workspacePaths.length) throw new Error('Kiro history identity missing');
  const canonical = await fs.realpath(cwd);
  if (!same(await fs.realpath(meta.workspacePaths[0]), canonical)) throw new Error('Kiro history workspace mismatch');
  const rows = (await read('messages.jsonl')).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  const seen = new Set(); let checkpoint = null;
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row.payload?.type !== 'string') throw new Error('Invalid Kiro history record');
    seen.add(row.id);
    if (row.payload.type === 'tombstone' || row.payload.operationType === 'Summary') throw new Error('Compacted Kiro fork history is not supported');
    if (row.payload.type === 'user') checkpoint = null;
    if (row.payload.type === 'turn_end') checkpoint = row.id;
  }
  if (!checkpoint) throw new Error('Kiro has no completed native fork checkpoint');
  return checkpoint;
}
module.exports = { latestKiroCheckpoint };
