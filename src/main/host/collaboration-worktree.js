const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const run = promisify(execFile);

async function git(cwd, args, env = {}) {
  return (await run('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
    cwd, windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  })).stdout;
}

// A private index snapshots tracked and non-ignored files without staging the user's index.
async function tree(cwd) {
  const index = path.join(os.tmpdir(), `harness-mix-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(cwd, ['read-tree', 'HEAD'], env);
    await git(cwd, ['add', '-A', '--', '.'], env);
    return (await git(cwd, ['write-tree'], env)).trim();
  } finally { await fs.rm(index, { force: true }); await fs.rm(`${index}.lock`, { force: true }); }
}

async function createWorkspace(cwd, id, mode = 'auto') {
  if (mode === 'shared') return { mode: 'shared', cwd };
  let source;
  try { source = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (error) {
    if (mode === 'auto' && /not a git repository/i.test(error.stderr || '')) return { mode: 'shared', cwd };
    throw new Error(`无法建立隔离工作区：${error.stderr || error.message}`);
  }
  // Git for Windows may return the repository root using a different spelling
  // (for example a long path) than Node's original cwd (for example RUNNER~1).
  // Canonicalize both paths before computing the nested cwd, otherwise
  // path.relative() can escape the new worktree and point back at the source.
  source = await fs.realpath(source);
  const canonicalCwd = await fs.realpath(cwd);
  const baseCommit = (await git(source, ['rev-parse', '--verify', 'HEAD'])).trim();
  const baseTree = await tree(source);
  // Keep the snapshot reachable across git gc, independently of the mutable worker index.
  const seed = (await git(source, ['-c', 'user.name=Harness Mix', '-c', 'user.email=harness-mix@localhost', 'commit-tree', baseTree, '-p', baseCommit, '-m', `Harness Mix isolated snapshot ${id}`])).trim();
  await git(source, ['update-ref', `refs/harness-mix/collaboration/${id}`, seed]);
  const root = path.join(path.dirname(source), `${path.basename(source)}-harness-worktrees`, id);
  const branch = `codex/collab-${id}`;
  await fs.mkdir(path.dirname(root), { recursive: true });
  await git(source, ['worktree', 'add', '-b', branch, root, baseCommit]);
  // Keep failed checkouts for inspection; never delete a workspace containing user/agent work.
  await git(root, ['read-tree', '--reset', '-u', baseTree]);
  await git(root, ['reset', '--mixed', 'HEAD']);
  const relative = path.relative(source, canonicalCwd);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`无法建立隔离工作区：工作目录不在 Git 根目录内 (${cwd})`);
  }
  const worktreeCwd = relative ? path.join(root, relative) : root;
  return { mode: 'worktree', root, cwd: worktreeCwd, source, branch, baseCommit, baseTree };
}

async function reviewWorkspace(workspace) {
  if (workspace?.mode !== 'worktree') throw new Error('此任务使用共享目录，请在任务文件变更中审查');
  const currentTree = await tree(workspace.root);
  const patch = await git(workspace.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', workspace.baseTree, currentTree, '--']);
  return { patch, digest: createHash('sha256').update(patch).digest('hex'), branch: workspace.branch, cwd: workspace.cwd };
}

async function applyWorkspace(workspace, expectedDigest) {
  const review = await reviewWorkspace(workspace);
  if (!expectedDigest || review.digest !== expectedDigest) throw new Error('子任务改动已变化，请重新审查');
  if (!review.patch) return review;
  const file = path.join(os.tmpdir(), `harness-mix-patch-${randomUUID()}`);
  try {
    await fs.writeFile(file, review.patch);
    await git(workspace.source, ['apply', '--check', '--binary', file]);
    await git(workspace.source, ['apply', '--binary', file]);
  } finally { await fs.rm(file, { force: true }); }
  return review;
}

async function removeWorkspace(workspace) {
  if (!workspace || workspace.mode !== 'worktree') return;
  try {
    await git(workspace.source, ['worktree', 'remove', '--force', workspace.root]);
  } catch {}
  try {
    if (workspace.branch) await git(workspace.source, ['branch', '-D', workspace.branch]);
  } catch {}
  await fs.rm(workspace.root, { recursive: true, force: true }).catch(() => {});
}

module.exports = { createWorkspace, reviewWorkspace, applyWorkspace, removeWorkspace, git, tree };
