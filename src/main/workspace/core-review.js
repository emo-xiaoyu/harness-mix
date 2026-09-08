const { diff } = require('./diff');

// Snapshot acquisition/undo stay in Workspace. Core stores their presentation.
async function projectReview(runtime, thread, message, record) {
  const core = runtime.core;
  if (!core?.getTurn(message.coreTurnId)) throw new Error('审查记录缺少 Core Turn，请重新加载任务完成历史迁移');
  core.dispatch({ threadId: thread.id, turnId: message.coreTurnId, type: 'files.updated', payload: {
    source: 'snapshot', replace: true,
    changes: record.changes.map(change => ({
      path: change.path, changeType: !change.before ? 'added' : !change.after ? 'deleted' : 'modified',
      before: change.before?.text ?? '', after: change.after?.text ?? '',
      patch: diff(change.before?.text, change.after?.text), complete: true,
      added: change.added, removed: change.removed, undone: change.undone === true,
    })),
  } });
  message.coreItems = structuredClone(core.getItemsForTurn(message.coreTurnId));
  const summary = { ...runtime.reviews.summary(record), files: message.coreItems.filter(item => item.type === 'file_change') };
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
