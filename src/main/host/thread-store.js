const fsSync = require('node:fs');
const { promises: fs } = fsSync;
const path = require('node:path');
const { compactThread, hydrateThread } = require('./thread-storage');

const SCHEMA_VERSION = 3;

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const contents = JSON.stringify(value, null, 2);
  await fs.writeFile(tmp, contents);
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(tmp, file); return Buffer.byteLength(contents); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 9) { await fs.unlink(tmp).catch(() => {}); throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

function recordName(id) { return `${encodeURIComponent(id)}.json`; }

function summarize(thread) {
  const firstUser = (thread.messages ?? []).find(message => message.role === 'user');
  const fields = ['id', 'harnessId', 'title', 'titleLocked', 'cwd', 'originalCwd', 'nativeSessionId', 'status', 'connectionStatus', 'createdAt', 'updatedAt', 'archived', 'section', 'sectionEnteredAt', 'projectId', 'parentThreadId', 'ephemeral', 'gitInfo', 'workspace', 'isolation', 'harnessChain', 'pendingHandoff', 'options', 'model'];
  const summary = Object.fromEntries(fields.filter(key => thread[key] !== undefined).map(key => [key, thread[key]]));
  summary.preview = firstUser?.text || thread.preview || thread.title || '';
  summary.messageCount = thread.messages?.length ?? thread.messageCount ?? 0;
  if (thread.recordBytes != null) summary.recordBytes = thread.recordBytes;
  return summary;
}

class ThreadStore {
  constructor(directory) {
    this.directory = directory;
    this.legacyFile = path.join(directory, 'threads.json');
    this.shardDirectory = path.join(directory, 'threads');
    this.recordsDirectory = path.join(this.shardDirectory, 'records');
    this.indexFile = path.join(this.shardDirectory, 'index.json');
    this.file = this.indexFile;
    this.writing = false;
    this.pending = null;
    this.waiters = [];
  }
  async #readIndex() {
    try {
      const value = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
      if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.threads)) throw new Error('Unsupported sharded thread store; original files preserved');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async #readLegacy() {
    try {
      const value = JSON.parse(await fs.readFile(this.legacyFile, 'utf8'));
      const threads = Array.isArray(value) ? value : value?.threads;
      if (!Array.isArray(threads)) throw new Error('Invalid legacy thread store; original file preserved');
      return threads.map(hydrateThread);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async loadIndex() {
    const index = await this.#readIndex();
    if (!index) return this.#readLegacy();
    return index.threads.map(summary => ({
      ...summary,
      status: summary.status === 'working' ? 'interrupted' : summary.status === 'opening' ? 'ready' : summary.status,
      connectionStatus: 'ready',
      messages: [], tools: [], pendingApprovals: [], _storageStub: true,
    }));
  }
  async load() {
    const index = await this.#readIndex();
    if (!index) return this.#readLegacy();
    return Promise.all(index.threads.map(async summary => hydrateThread(JSON.parse(await fs.readFile(path.join(this.recordsDirectory, recordName(summary.id)), 'utf8')))));
  }
  hydrateInto(thread) {
    if (!thread?._storageStub) return thread;
    const record = hydrateThread(JSON.parse(fsSync.readFileSync(path.join(this.recordsDirectory, recordName(thread.id)), 'utf8')));
    for (const key of Object.keys(thread)) delete thread[key];
    Object.assign(thread, record);
    return thread;
  }
  save(threads) {
    this.pending = {
      index: { schemaVersion: SCHEMA_VERSION, savedAt: Date.now(), threads: threads.map(summarize) },
      records: threads.filter(thread => !thread._storageStub).map(thread => ({ id: thread.id, value: compactThread(thread) })),
    };
    const promise = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    void this.#drain();
    return promise;
  }
  async #drain() {
    if (this.writing) return;
    this.writing = true;
    while (this.pending) {
      const snapshot = this.pending; this.pending = null;
      const waiters = this.waiters; this.waiters = [];
      try {
        await fs.mkdir(this.recordsDirectory, { recursive: true });
        if (snapshot.records.length && !fsSync.existsSync(`${this.legacyFile}.bak`)) await fs.copyFile(this.legacyFile, `${this.legacyFile}.bak`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        for (const record of snapshot.records) {
          const bytes = await writeAtomic(path.join(this.recordsDirectory, recordName(record.id)), record.value);
          const summary = snapshot.index.threads.find(thread => thread.id === record.id);
          if (summary) summary.recordBytes = bytes;
        }
        await writeAtomic(this.indexFile, snapshot.index);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) { for (const waiter of waiters) waiter.reject(error); }
    }
    this.writing = false;
  }
  remove(threadId) { return fs.unlink(path.join(this.recordsDirectory, recordName(threadId))).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async inspectFiles() {
    const index = await fs.stat(this.indexFile).catch(() => null);
    const legacy = await fs.stat(this.legacyFile).catch(() => null);
    const records = await fs.readdir(this.recordsDirectory, { withFileTypes: true }).catch(() => []);
    let recordBytes = 0;
    for (const entry of records) if (entry.isFile() && entry.name.endsWith('.json')) recordBytes += (await fs.stat(path.join(this.recordsDirectory, entry.name))).size;
    return { storageSchemaVersion: SCHEMA_VERSION, indexFile: this.indexFile, indexBytes: index?.size ?? 0, recordsDirectory: this.recordsDirectory, recordCount: records.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length, recordBytes, legacyFile: this.legacyFile, legacyBytes: legacy?.size ?? 0 };
  }
}

module.exports = { ThreadStore, summarize, SCHEMA_VERSION };
