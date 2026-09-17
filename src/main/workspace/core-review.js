const { diff } = require('./diff');

// 本轮真实触碰的文件路径集合（相对 cwd、小写、正斜杠）：来自文件编辑类工具的
// 结构化 path 与原生 file_change 条目。协作 Lead 回合合并其子线程的触碰路径，
// 让团队卡片展示的是整个团队而非其他会话的改动。
function touchedPaths(runtime, thread, message) {
  const cwd = String(thread.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const turns = [message.coreTurnId];
  for (const child of runtime.threads ?? []) {
    if (child.parentThreadId !== thread.id) continue;
    for (const m of child.messages ?? []) if (m.coreTurnId) turns.push(m.coreTurnId);
  }
  const touched = new Set();
  const add = value => {
    if (typeof value !== 'string' || !value) return;
    let p = value.replace(/\\/g, '/');
    if (/^[a-z]:\//i.test(p)) {
      const lower = p.toLowerCase();
      if (!cwd || !lower.startsWith(cwd + '/')) return;
      p = p.slice(cwd.length + 1);
    }
    p = p.replace(/^\.\//, '');
    if (p) touched.add(p.toLowerCase());
  };
  for (const turnId of turns) {
    for (const item of runtime.core.getItemsForTurn(turnId)) {
      if (item.type === 'file_change') add(item.path);
      else if (item.type === 'tool_call') add(item.path);
    }
  }
  return touched;
}

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
  } else if (!hasNativePatch && record.concurrent) {
    // 无原生 patch 的 Harness（如 Pi）：并发同目录时用本轮工具触碰路径收窄全量快照，
    // 避免同项目其他会话的改动出现在本回合卡片里。本轮没有任何可归因路径时
    // （纯 shell 会话等）保留全量快照，不虚报归属。
    const touched = touchedPaths(runtime, thread, message);
    if (touched.size) changes = changes.filter(change => touched.has(change.path.toLowerCase()));
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
