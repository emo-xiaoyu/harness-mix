const { diff } = require('./diff');

// Snapshot acquisition/undo stay in Workspace. Core stores their presentation.
async function projectReview(runtime, thread, message, record) {
  const core = runtime.core;
  if (!core?.getTurn(message.coreTurnId)) throw new Error('审查记录缺少 Core Turn，请重新加载任务完成历史迁移');

  const hasNativePatch = Boolean(
    runtime.getCapabilities?.(thread.harnessId)?.workspace?.nativePatch ||
    runtime.adapters?.get(thread.harnessId)?.manifest?.capabilities?.nativePatch
  );

  let changes = record.changes;
  if (hasNativePatch && record.concurrent) {
    // 同目录并发时，原生 patch 是唯一能归属到本轮的边界。无并发时始终
    // 保留 Host 最终快照，补齐原生 Harness 没有上报或漏报的文件。
    const nativeItems = core.getItemsForTurn(message.coreTurnId).filter(item => item.type === 'file_change' && item.source === 'native');
    const nativePaths = new Set(nativeItems.map(item => item.path));
    changes = changes.filter(change => nativePaths.has(change.path));
  }

  core.dispatch({ threadId: thread.id, turnId: message.coreTurnId, type: 'files.updated', payload: {
    source: 'snapshot', replace: true,
    changes: changes.map(change => ({
      path: change.path, changeType: !change.before ? 'added' : !change.after ? 'deleted' : 'modified',
      before: change.before?.text ?? '', after: change.after?.text ?? '',
      patch: diff(change.before?.text, change.after?.text), complete: true,
      added: change.added, removed: change.removed, undone: change.undone === true,
    })),
  } });
  message.coreItems = structuredClone(core.getItemsForTurn(message.coreTurnId));
  const summaryRecord = { ...record, changes };
  const summary = { ...runtime.reviews.summary(summaryRecord), files: message.coreItems.filter(item => item.type === 'file_change') };
  message.coreReview = structuredClone(summary);
  return summary;
}

async function readReview(runtime, thread, message, file) {
  const id = message.review?.id ?? message.reviewId;
  let record;
  for (let attempt = 0; ; attempt++) {
    const revision = thread.fileRevision;
    record = await runtime.reviews.preview(id);
    if (revision === thread.fileRevision) break;
    if (attempt === 4) throw new Error('文件仍在变化，请稍后刷新审查');
  }
  const summary = await projectReview(runtime, thread, message, record);
  if (!file) return summary;
  const item = summary.files.find(item => item.path === file);
  if (!item) throw new Error('文件不在本轮审查记录中');
  return { path: item.path, undone: item.undone, ...(item.patch?.rows ? item.patch : diff(item.before, item.after)) };
}

module.exports = { projectReview, readReview };
