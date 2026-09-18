const path = require('node:path');
const { diff } = require('./diff');

// 工作区外的改动（Claude 计划文件、全局配置、其他盘符……）是合法事件：保留展示
// （规范绝对路径 + outsideWorkspace 标记），撤回/预览等磁盘操作仍由既有守卫优雅拒绝。
// 注意：这里绝不能抛错——异常会沿 emit 同步传回 Adapter 事件泵，把原生会话误判为
// 崩溃（crashed），之后所有 send 都报“原生会话不可用”。无路径的改动同样静默丢弃。
function canonicalChanges(cwd, changes = [], previous = []) {
  return changes.filter(change => typeof change?.path === 'string' && change.path.trim()).map(change => {
    const absolute = path.resolve(cwd, change.path);
    const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
    const outside = !relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
    const canonical = outside ? absolute.replace(/\\/g, '/') : relative;
    const old = previous.find(item => item.path === canonical);
    if (old && typeof old.before === 'string' && typeof old.after === 'string') {
      if (change.before === old.after) {
        change = { ...change, before: old.before, changeType: old.changeType === 'added' && change.changeType !== 'deleted' ? 'added' : change.changeType };
      } else if (change.before !== old.before) {
        change = { ...change, complete: false };
      }
    }
    const patch = typeof change.before === 'string' && typeof change.after === 'string' ? diff(change.before, change.after) : change.patch;
    return { ...change, path: canonical, ...(outside ? { outsideWorkspace: true } : {}), ...(patch ? { patch, added: patch.added, removed: patch.removed } : {}) };
  });
}
module.exports = { canonicalChanges };
