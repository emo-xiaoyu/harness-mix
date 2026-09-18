const { diff } = require('./diff');

// 把工具/文件事件里的路径归一化成「相对 cwd、小写、正斜杠」的形式，
// 绝对路径只接受 cwd 之下的；归一化失败返回 null（忽略该条目）。
function normalizePath(cwd) {
  return value => {
    if (typeof value !== 'string' || !value) return null;
    let p = value.replace(/\\/g, '/');
    if (/^[a-z]:\//i.test(p)) {
      const lower = p.toLowerCase();
      if (!cwd || !lower.startsWith(cwd + '/')) return null;
      p = p.slice(cwd.length + 1);
    }
    p = p.replace(/^\.\//, '');
    return p ? p.toLowerCase() : null;
  };
}

// 收集一组 Core Turn 中可归因的触碰路径（file_change 条目与工具结构化 path）。
function collectTurnPaths(runtime, turnIds, cwd) {
  const add = normalizePath(cwd);
  const touched = new Set();
  for (const turnId of turnIds) {
    for (const item of runtime.core.getItemsForTurn(turnId)) {
      if (item.type !== 'file_change' && item.type !== 'tool_call') continue;
      const p = add(item.path);
      if (p) touched.add(p);
    }
  }
  return touched;
}

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
  return collectTurnPaths(runtime, turns, cwd);
}

// 明确归属于「其他会话」的文件路径集合：同目录并发时，对方 Harness 上报的
// file_change / 工具 path 条目是正向归属证据。本回合快照（目录级 diff）会把
// 这些外来改动一起捕进来，必须按归属剔除，否则 Agent Team / 并发会话的编辑
// 会污染本回合的变更卡片与撤回列表。只处理同 cwd 的线程：不同 cwd（worktree
// 等）的相对路径不可比较，也进不了本目录快照。无归属证据的改动保持原行为。
function foreignPaths(runtime, thread, message) {
  const cwd = String(thread.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const mine = new Set([thread.id]);
  for (const child of runtime.threads ?? []) {
    if (child.parentThreadId === thread.id) mine.add(child.id);
  }
  const foreign = new Set();
  for (const other of runtime.threads ?? []) {
    if (mine.has(other.id)) continue;
    if (String(other.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== cwd) continue;
    const turns = (other.messages ?? []).map(m => m.coreTurnId).filter(Boolean);
    for (const p of collectTurnPaths(runtime, turns, cwd)) foreign.add(p);
  }
  return foreign;
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
  // 本轮触碰路径惰性计算一次：供并发收窄与 foreign 过滤两处共用
  let touched = null;
  const touchedThisTurn = () => (touched ??= touchedPaths(runtime, thread, message));
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
    const touchedSet = touchedThisTurn();
    if (touchedSet.size) changes = changes.filter(change => touchedSet.has(change.path.toLowerCase()));
  }

  // 正向归属于其他会话的改动剔除（不依赖 concurrent 标记：对方可能在本回合开始后
  // 才启动）。但本轮工具已明确触碰的文件属本会话自身的正向事实——foreign 集合扫描的是
  // 其他会话的历史全部轮次，同目录旧会话碰过的路径会永久滞留其中，不得据此误剔本轮编辑，
  // 否则该文件会从审查卡片与撤回列表中消失。无归属证据的改动保持原样，不虚报归属。
  const foreign = foreignPaths(runtime, thread, message);
  if (foreign.size) {
    const touchedSet = touchedThisTurn();
    changes = changes.filter(change => touchedSet.has(change.path.toLowerCase()) || !foreign.has(change.path.toLowerCase()));
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
