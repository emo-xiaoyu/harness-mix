const { Buffer } = require('node:buffer');

const DERIVED_THREAD_FIELDS = [
  'tools', 'pendingApprovals', 'interactions', 'currentTurn', 'coreThread',
  'coreUsage', 'usage', 'capabilities', 'coreEnabled',
];
const DERIVED_MESSAGE_FIELDS = [
  'coreTurn', 'coreItems', 'text', 'thinking', 'artifacts', 'at', 'endedAt',
  'streaming', 'stopReason', 'items',
];

function compactThread(thread) {
  // Use structural sharing while serializing. A deep clone here would recreate the
  // same large transient allocation this format is intended to avoid.
  const value = { ...thread };
  if (value.coreState?.version !== 1) return value;
  for (const key of DERIVED_THREAD_FIELDS) delete value[key];
  value.messages = (value.messages ?? []).map((message) => {
    if (message.role !== 'assistant' || !message.coreTurnId) return message;
    const compact = { ...message };
    for (const key of DERIVED_MESSAGE_FIELDS) delete compact[key];
    return compact;
  });
  value.storage = { schemaVersion: 2 };
  return value;
}

function hydrateThread(thread) {
  const value = { ...thread };
  delete value.storage;
  value.messages ??= [];
  value.tools ??= [];
  value.pendingApprovals ??= [];
  return value;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function storageProjection(threads) {
  const rows = threads.map((thread) => {
    if (thread._storageStub) return {
      threadId: thread.id, title: thread.title, updatedAt: thread.updatedAt ?? thread.createdAt ?? 0,
      archived: thread.archived === true, messageCount: thread.messageCount ?? null,
      logicalBytes: null, persistedBytes: thread.recordBytes ?? null, savedBytes: null, loaded: false,
    };
    const logicalBytes = byteLength(thread);
    const persistedBytes = byteLength(compactThread(thread));
    return {
      threadId: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt ?? thread.createdAt ?? 0,
      archived: thread.archived === true,
      messageCount: thread.messages?.length ?? 0,
      logicalBytes,
      persistedBytes,
      savedBytes: Math.max(0, logicalBytes - persistedBytes),
      loaded: true,
    };
  }).sort((a, b) => b.persistedBytes - a.persistedBytes);
  return {
    schemaVersion: 2,
    threadCount: rows.length,
    loadedThreadCount: rows.filter(row => row.loaded).length,
    logicalBytes: rows.reduce((sum, row) => sum + (row.logicalBytes ?? 0), 0),
    persistedBytes: rows.reduce((sum, row) => sum + (row.persistedBytes ?? 0), 0),
    savedBytes: rows.reduce((sum, row) => sum + (row.savedBytes ?? 0), 0),
    largestThreads: rows.filter(row => row.persistedBytes != null).sort((a, b) => b.persistedBytes - a.persistedBytes).slice(0, 20),
  };
}

module.exports = { compactThread, hydrateThread, storageProjection };
