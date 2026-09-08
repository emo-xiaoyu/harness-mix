const path = require('node:path');
const { diff } = require('./diff');

function canonicalChanges(cwd, changes = [], previous = []) {
  return changes.map(change => {
    const absolute = path.resolve(cwd, change.path);
    const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('FileChange is outside the workspace');
    const old = previous.find(item => item.path === relative);
    if (old && typeof old.before === 'string' && typeof old.after === 'string') {
      if (change.before === old.after) {
        change = { ...change, before: old.before, changeType: old.changeType === 'added' && change.changeType !== 'deleted' ? 'added' : change.changeType };
      } else if (change.before !== old.before) {
        change = { ...change, complete: false };
      }
    }
    const patch = typeof change.before === 'string' && typeof change.after === 'string' ? diff(change.before, change.after) : change.patch;
    return { ...change, path: relative, ...(patch ? { patch, added: patch.added, removed: patch.removed } : {}) };
  });
}
module.exports = { canonicalChanges };
