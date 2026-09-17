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

async function inspectWorkspace(cwd, workspace = null) {
  const result = {
    hostManaged: true,
    git: { available: false },
    worktree: { available: false, active: workspace?.mode === 'worktree' },
    finalDiff: { available: true, source: 'snapshot' },
  };
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
    let branch = null;
    try { branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null; } catch {}
    const dirty = Boolean((await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])).trim());
    result.git = { available: true, root, head, branch, dirty };
    result.worktree = {
      available: true,
      active: workspace?.mode === 'worktree',
      ...(workspace?.branch ? { branch: workspace.branch } : {}),
      ...(workspace?.root ? { root: workspace.root } : {}),
    };
  } catch (error) {
    result.git.reason = /not a git repository/i.test(error.stderr || '') ? 'not-a-git-repository' : 'git-unavailable';
  }
  return result;
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
  const digest = createHash('sha256').update(patch).digest('hex');
  const result = { patch, digest, branch: workspace.branch, cwd: workspace.cwd, hasConflict: false, conflictingFiles: [] };
  if (patch) {
    const file = path.join(os.tmpdir(), `harness-mix-check-${randomUUID()}`);
    try {
      await fs.writeFile(file, patch);
      await git(workspace.source, ['apply', '--check', '--binary', file]);
    } catch (checkErr) {
      result.hasConflict = true;
      const stderr = String(checkErr.stderr || checkErr.message || '');
      const files = [...stderr.matchAll(/error:\s*patch failed:\s*([^:\r\n]+)/g)].map(m => m[1].trim());
      result.conflictingFiles = files.length ? [...new Set(files)] : [];
      result.conflictReason = stderr.slice(0, 500);
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return result;
}

async function applyWorkspace(workspace, expectedDigest) {
  const review = await reviewWorkspace(workspace);
  if (!expectedDigest || review.digest !== expectedDigest) throw new Error('子任务改动已变化，请重新审查');
  if (!review.patch) return review;
  if (review.hasConflict) {
    const fileList = review.conflictingFiles.length
      ? review.conflictingFiles.map(f => `  - ${f}`).join('\n')
      : '  (主工作区当前状态与补丁不兼容)';
    throw new Error(
      `无法应用工作区改动：检测到文件合并冲突。\n冲突文件：\n${fileList}\n` +
      `建议操作：\n1. 可在子任务独立工作区 (${workspace.cwd}) 中手动合并或解决冲突；\n` +
      `2. 使用 pushWorkspace 将隔离分支 (${workspace.branch}) 推送至 Git 远程仓库以发起 PR；\n` +
      `3. 或使用 discardWorkspace 放弃并删除该分支。`
    );
  }
  const file = path.join(os.tmpdir(), `harness-mix-patch-${randomUUID()}`);
  try {
    await fs.writeFile(file, review.patch);
    await git(workspace.source, ['apply', '--binary', file]);
  } catch (error) {
    throw new Error(`应用改动失败：${error.stderr || error.message}`);
  } finally { await fs.rm(file, { force: true }).catch(() => {}); }
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

async function discardWorkspace(workspace) {
  if (!workspace || workspace.mode !== 'worktree') return { discarded: false };
  await removeWorkspace(workspace);
  return { discarded: true, branch: workspace.branch };
}

async function pushWorkspace(workspace, remote = 'origin', remoteBranch = workspace.branch) {
  if (!workspace || workspace.mode !== 'worktree') throw new Error('仅隔离工作区支持推送远程分支');
  const currentTree = await tree(workspace.root);
  let parentCommit = workspace.baseCommit;
  try {
    parentCommit = (await git(workspace.source, ['rev-parse', workspace.branch])).trim();
  } catch {}
  const commitMsg = `Harness Mix collaboration: ${workspace.branch}`;
  const newCommit = (await git(workspace.source, [
    '-c', 'user.name=Harness Mix',
    '-c', 'user.email=harness-mix@localhost',
    'commit-tree', currentTree,
    '-p', parentCommit,
    '-m', commitMsg,
  ])).trim();
  await git(workspace.source, ['update-ref', `refs/heads/${workspace.branch}`, newCommit]);
  const remotes = (await git(workspace.source, ['remote'])).split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Git 远程 '${remote}' 不存在。可用远程：${remotes.join(', ') || '无'}`);
  }
  await git(workspace.source, ['push', remote, `${workspace.branch}:${remoteBranch}`]);
  return { remote, branch: remoteBranch, commit: newCommit, pushed: true };
}

module.exports = { createWorkspace, inspectWorkspace, reviewWorkspace, applyWorkspace, removeWorkspace, discardWorkspace, pushWorkspace, git, tree };
