const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);

async function git(cwd, args) {
  try {
    return (await run('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
      cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
    })).stdout;
  } catch (e) { throw Error(e.code === 'ENOENT' ? '未找到 Git，请安装 Git for Windows。' : (e.stderr || e.message).trim()); }
}
async function repository(cwd) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (path.resolve(root).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw Error('请将 Git 仓库根目录作为项目打开：' + root);
  return root;
}
function parseStatus(raw) {
  const entries = raw.split('\0'), files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    const x = entry[0], y = entry[1], file = entry.slice(3);
    const from = /[RC]/.test(x + y) ? entries[++i] : undefined;
    files.push({ path: file, from, index: x, worktree: y, untracked: x === '?', staged: ![' ', '?', '!'].includes(x), changed: y !== ' ', conflict: x === 'U' || y === 'U' || ['AA', 'DD'].includes(x + y) });
  }
  return files;
}
async function status(cwd) {
  await repository(cwd);
  const [raw, branch, log] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => git(cwd, ['rev-parse', '--short', 'HEAD'])),
    git(cwd, ['log', '-15', '--format=%h%x00%s%x00%an%x00%ar']).catch(() => ''),
  ]);
  return { root: cwd, branch: branch.trim(), files: parseStatus(raw), log: log.trim().split('\n').filter(Boolean).map(row => { const [hash, subject, author, age] = row.split('\0'); return { hash, subject, author, age }; }) };
}
async function fileEntry(cwd, file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\0') || file.includes(':') || file.split(/[\\/]/).includes('..')) throw Error('无效 Git 文件路径');
  const entry = (await status(cwd)).files.find(f => f.path === file);
  if (!entry) throw Error('文件状态已改变，请刷新 Git 面板');
  return entry;
}
async function diff(cwd, file, staged) {
  const entry = await fileEntry(cwd, file);
  if (entry.untracked) return { text: '新文件尚未暂存。可在文件面板查看内容，暂存后查看 Git 差异。' };
  return { text: await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', file]) };
}
async function mutate(cwd, action, input) {
  if (action === 'init') { await git(cwd, ['init']); return status(cwd); }
  await repository(cwd);
  if (action === 'commit') {
    if (typeof input.message !== 'string' || !input.message.trim()) throw Error('请输入提交说明');
    await git(cwd, ['commit', '-m', input.message]);
  } else {
    const entry = await fileEntry(cwd, input.path);
    const paths = entry.from ? [entry.path, entry.from] : [entry.path];
    if (action === 'stage') await git(cwd, ['add', '--', ...paths]);
    else if (action === 'unstage') {
      const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
      await git(cwd, hasHead ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '--', ...paths]);
    } else throw Error('不支持的 Git 操作');
  }
  return status(cwd);
}
module.exports = { status, diff, mutate, parseStatus };
