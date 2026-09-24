// Match Desktop queries before merging local threads into an official page.
function includesThread(thread, query = {}, threads = [], projectIdsForThread = t => t.projectId ?? null) {
  if (thread.ephemeral || Boolean(thread.archived) !== Boolean(query.archived)) return false;
  // 父子归属查询（协作子任务/子代理列表）：按 parentThreadId 链匹配
  if (query.parentThreadId != null) return thread.parentThreadId === query.parentThreadId;
  if (query.ancestorThreadId != null) {
    const byId = new Map(threads.map(entry => [entry.id, entry]));
    for (let current = thread; current?.parentThreadId; current = byId.get(current.parentThreadId)) {
      if (current.parentThreadId === query.ancestorThreadId) return true;
    }
    return false;
  }
  if (Object.hasOwn(query, 'sectionId') && (thread.section?.id ?? null) !== query.sectionId) return false;
  if (Object.hasOwn(query, 'projectId')) {
    const projectIds = projectIdsForThread(thread);
    if (Array.isArray(projectIds) ? !projectIds.includes(query.projectId) : projectIds !== query.projectId) return false;
  }
  if (query.isPinned === true && !thread.isPinned) return false;
  if (query.isPinned === false && thread.isPinned) return false;
  if (query.cwd != null && !(Array.isArray(query.cwd) ? query.cwd : [query.cwd]).includes(thread.cwd)) return false;
  if (query.modelProviders?.length && !query.modelProviders.includes('harnessmix')) return false;
  if (query.sourceKinds?.length) {
    // 协作子任务线程投影为 subAgentThreadSpawn（Desktop 子代理入口按此 sourceKind 查询）；
    // 其余外部线程保持 vscode 来源。
    const sourceKind = thread.parentThreadId ? 'subAgentThreadSpawn' : 'vscode';
    if (!query.sourceKinds.includes(sourceKind)) return false;
  }
  if (query.searchTerm && !(thread.title || '').toLowerCase().includes(query.searchTerm.toLowerCase())) return false;
  return true;
}

function mergeThreadPage(page, threads, query, project, projectIdsForThread) {
  if (query.cursor) return page;
  const local = threads.filter(thread => includesThread(thread, query, threads, projectIdsForThread));
  if (query.sortKey === 'section_position') local.sort((a, b) => (a.sectionPosition || 0) - (b.sectionPosition || 0));
  const byId = new Map(page.data.map(thread => [thread.id, thread]));
  for (const thread of threads) {
    if (!includesThread(thread, query, threads, projectIdsForThread)) byId.delete(thread.id);
  }
  for (const thread of local) byId.set(thread.id, project(thread));
  const data = [...byId.values()];
  if (query.sortKey !== 'section_position') {
    const key = { updated_at: 'updatedAt', recency_at: 'recencyAt' }[query.sortKey] || 'createdAt';
    data.sort((a, b) => (query.sortDirection === 'asc' ? 1 : -1) * ((a[key] || 0) - (b[key] || 0)));
  }
  return { ...page, data };
}

module.exports = { includesThread, mergeThreadPage };
