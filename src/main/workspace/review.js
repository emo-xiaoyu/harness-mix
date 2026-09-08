const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { snapshot, resolveFile, readText } = require('./files');
const { diff } = require('./diff');

class ReviewStore {
  constructor(directory) { this.directory = path.join(directory, 'reviews'); this.locks = new Set(); }
  file(id) { if (!/^[\da-f-]{36}$/.test(id)) throw Error('无效审查 ID'); return path.join(this.directory, id + '.json'); }
  async save(record) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(record.id);
    await fs.writeFile(file + '.tmp', JSON.stringify(record));
    await fs.rename(file + '.tmp', file);
  }
  async load(id) {
    const record = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    for (const change of record.changes) change.path = change.path.replace(/\\/g, '/');
    return record;
  }
  async begin(root) {
    const baseline = await snapshot(root);
    const record = { id: randomUUID(), root: await fs.realpath(root), baseline, at: Date.now(), changes: [] };
    await this.save(record);
    return record.id;
  }
  async preview(id) {
    const record = await this.load(id);
    if (!record.baseline) return record;
    const after = await snapshot(record.root);
    record.changes = [];
    const previousNames = new Set(record.baseline.names), currentNames = new Set(after.names);
    for (const file of new Set([...record.baseline.names, ...after.names])) {
      const before = record.baseline.files[file], next = after.files[file];
      // A skipped/binary/oversized file is not a deletion or an addition.
      if ((!before && previousNames.has(file)) || (!next && currentNames.has(file))) continue;
      if (before?.hash === next?.hash) continue;
      const delta = diff(before?.text, next?.text);
      record.changes.push({ path: file.replace(/\\/g, '/'), before: before ?? null, after: next ?? null, added: delta.added, removed: delta.removed, coarse: delta.coarse });
    }
    record.skipped = record.baseline.skipped.length + after.skipped.length;
    return record;
  }
  async finish(id) {
    const record = await this.preview(id);
    delete record.baseline;
    record.endedAt = Date.now();
    await this.save(record);
    return this.summary(record);
  }
  summary(record) {
    return { id: record.id, at: record.at, endedAt: record.endedAt, live: !record.endedAt, skipped: record.skipped,
      files: record.changes.map(c => ({ path: c.path, added: c.added, removed: c.removed, undone: c.undone, kind: !c.before ? 'added' : !c.after ? 'deleted' : 'modified' })) };
  }
  async detail(id, file) {
    const record = await this.preview(id), change = record.changes.find(c => c.path === file);
    if (!change) throw Error('文件不在本轮审查记录中');
    return { path: file, undone: change.undone, ...diff(change.before?.text, change.after?.text) };
  }
  async undo(id, file) {
    if (this.locks.has(id)) throw Error('撤回正在进行');
    this.locks.add(id);
    try {
      const record = await this.load(id), change = record.changes.find(c => c.path === file);
      if (!record.endedAt || !change || change.undone) throw Error('该文件不可撤回');
      const target = await resolveFile(record.root, file);
      let current = null;
      try { current = await readText(record.root, file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (current?.hash !== change.after?.hash) throw Error('文件在任务结束后已发生变化，拒绝覆盖。请先手动处理冲突。');
      // The review journal retains both revisions even for a removed new file.
      if (change.before) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await resolveFile(record.root, file);
        await fs.writeFile(target, change.before.text, { flag: current ? 'w' : 'wx', mode: change.before.mode });
      } else await fs.unlink(target);
      change.undone = true;
      await this.save(record);
      return this.summary(record);
    } finally { this.locks.delete(id); }
  }
}
module.exports = { ReviewStore };
