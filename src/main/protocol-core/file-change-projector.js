const { createItem } = require('../shared-contracts');
const priority = { git: 1, snapshot: 2, native: 3 };

function projectFileChanges(projector, event) {
  const turn = projector.turns.get(event.turnId);
  if (!turn || turn.threadId !== event.threadId) throw new Error('file changes require a matching turn');
  const { changes = [], source = 'snapshot', replace = false } = event.payload;
  if (!Object.hasOwn(priority, source)) throw new Error('unknown file change source');
  const paths = new Set(changes.map(change => change.path));
  if (replace) {
    for (const id of [...turn.itemIds]) {
      const item = projector.items.get(id);
      if (item?.type === 'file_change' && item.source === source && !paths.has(item.path)) {
        projector.items.delete(id); turn.itemIds = turn.itemIds.filter(value => value !== id);
      }
    }
  }
  for (const change of changes) {
    if (typeof change.path !== 'string' || !change.path) throw new Error('file path required');
    const id = `file_${turn.id}_${change.path}`;
    const old = projector.items.get(id);
    if (change.complete === true && typeof change.before === 'string' && change.before === change.after && !change.undone
      && (change.changeType === 'modified' || old?.changeType === 'added' && change.changeType === 'deleted')) {
      projector.items.delete(id); turn.itemIds = turn.itemIds.filter(value => value !== id);
      continue;
    }
    // Only a complete native patch supersedes a workspace snapshot.
    const snapshotDisagrees = source === 'snapshot' && change.complete === true && change.undone !== true
      && typeof old?.before === 'string' && typeof old?.after === 'string'
      && (old.before !== change.before || old.after !== change.after);
    if (old && old.complete !== false && priority[old.source] > priority[source] && !snapshotDisagrees) {
      if (source === 'snapshot' && change.undone === true) { old.undone = true; old.updatedAt = event.timestamp; }
      continue;
    }
    if (old && source === 'native' && change.complete === false) continue;
    const item = createItem({ ...change, id, threadId: event.threadId, turnId: turn.id,
      type: 'file_change', source, status: 'completed', nativeRef: { ...old?.nativeRef, ...event.nativeRef, ...change.nativeRef },
      createdAt: old?.createdAt ?? event.timestamp, updatedAt: event.timestamp }, event.timestamp);
    projector.items.set(id, item);
    if (!turn.itemIds.includes(id)) turn.itemIds.push(id);
  }
  return { turn, items: projector.itemsForTurn(turn.id).filter(item => item.type === 'file_change') };
}

module.exports = { projectFileChanges };
