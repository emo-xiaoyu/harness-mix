const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Desktop keeps project membership in its local state, separately from the
// app-server thread store. External threads need that membership in both the
// thread projection and project-scoped thread/list filtering.
function stateFile(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json');
}

function normalizeDirectory(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveThreadProjectId(thread, state) {
  if (typeof thread?.projectId === 'string' && thread.projectId) return thread.projectId;
  const assignment = state?.['thread-project-assignments']?.[thread?.id];
  if (assignment?.projectKind === 'local' && typeof assignment.projectId === 'string') {
    return assignment.projectId;
  }
  if (assignment?.projectKind === 'projectless' || state?.['projectless-thread-ids']?.includes(thread?.id)) {
    return null;
  }
  const cwd = normalizeDirectory(thread?.workspace?.mode === 'worktree' ? thread.originalCwd || thread.cwd : thread?.cwd);
  if (!cwd) return null;
  let match = null;
  let matchLength = -1;
  for (const [projectId, project] of Object.entries(state?.['local-projects'] || {})) {
    for (const rootPath of project?.rootPaths || []) {
      const root = normalizeDirectory(rootPath);
      if (root && (cwd === root || cwd.startsWith(`${root}${path.sep}`)) && root.length > matchLength) {
        match = projectId;
        matchLength = root.length;
      }
    }
  }
  return match;
}

let cachedFile = null;
let cachedMtime = -1;
let cachedState = null;

function projectIdForThread(thread) {
  if (typeof thread?.projectId === 'string' && thread.projectId) return thread.projectId;
  const file = stateFile();
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (file !== cachedFile || mtime !== cachedMtime) {
      cachedState = JSON.parse(fs.readFileSync(file, 'utf8'));
      cachedFile = file;
      cachedMtime = mtime;
    }
    return resolveThreadProjectId(thread, cachedState);
  } catch {
    // A missing or partially written Desktop state file must not affect the
    // thread itself; Desktop can still list it outside a saved project.
    cachedFile = null;
    cachedMtime = -1;
    cachedState = null;
    return null;
  }
}

function projectIdsForThread(thread) {
  if (typeof thread?.projectId === 'string' && thread.projectId) return [thread.projectId];
  const projectId = projectIdForThread(thread);
  if (projectId === null) return [null];
  const ids = new Set([projectId]);
  // Current Desktop builds can query project-scoped app-server pages with
  // their migrated ID while the sidebar still stores the local project ID.
  for (const mappings of Object.values(cachedState?.['app-server-project-id-by-legacy-project-id-by-host'] || {})) {
    if (typeof mappings?.[projectId] === 'string') ids.add(mappings[projectId]);
  }
  return [...ids];
}

module.exports = { projectIdForThread, projectIdsForThread, resolveThreadProjectId };
