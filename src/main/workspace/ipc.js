const path = require('node:path');
const fs = require('node:fs/promises');
const files = require('./files');
const { CommandTerminal } = require('./terminal');
const git = require('./git');

function registerWorkspace({ ipcMain, runtime, emit, roots }) {
  const terminal = new CommandTerminal(emit);
  async function root(input) {
    const thread = runtime.threads.find(t => t.id === input.threadId);
    const candidate = thread?.cwd ?? input.cwd;
    const allowed = [...roots, ...runtime.threads.map(t => t.cwd)];
    if (typeof candidate !== 'string' || !allowed.some(p => path.resolve(p).toLowerCase() === path.resolve(candidate).toLowerCase())) throw Error('请先选择项目目录');
    return fs.realpath(candidate);
  }
  ipcMain.handle('workspace:list', async (_, input) => files.list(await root(input), input.path));
  ipcMain.handle('git:status', async (_, input) => git.status(await root(input)));
  ipcMain.handle('git:diff', async (_, input) => git.diff(await root(input), input.path, input.staged === true));
  ipcMain.handle('git:mutate', async (_, input) => {
    const cwd = await root(input);
    if (runtime.threads.some(t => path.resolve(t.cwd).toLowerCase() === cwd.toLowerCase() && ['working', 'opening'].includes(t.status)) || terminal.list(cwd).some(s => s.running)) throw Error('请等待项目任务和终端命令结束后再修改 Git 状态');
    return git.mutate(cwd, input.action, input);
  });
  ipcMain.handle('workspace:read', async (_, input) => ({ path: input.path, ...(await files.readText(await root(input), input.path)) }));
  ipcMain.handle('workspace:review', async (_, input) => {
    const thread = runtime.threads.find(t => t.id === input.threadId);
    const message = thread?.messages.find(m => m.id === input.messageId);
    const id = message?.review?.id ?? message?.reviewId;
    if (!id) throw Error('该轮尚无文件快照');
    return input.path ? runtime.reviews.detail(id, input.path) : runtime.reviews.summary(await runtime.reviews.preview(id));
  });
  ipcMain.handle('workspace:undo', async (_, input) => {
    const cwd = await root(input);
    if (terminal.list(cwd).some(s => s.running)) throw Error('请先停止该项目的终端命令');
    return runtime.undoFile(input.threadId, input.messageId, input.path);
  });
  ipcMain.handle('terminal:list', async (_, input) => terminal.list(await root(input)));
  ipcMain.handle('terminal:run', async (_, input) => {
    const cwd = await root(input);
    if (runtime.threads.some(t => path.resolve(t.cwd).toLowerCase() === cwd.toLowerCase() && t.status === 'working')) throw Error('请等待项目任务结束后再运行手动命令');
    return terminal.run(cwd, input.command);
  });
  ipcMain.handle('terminal:stop', async (_, input) => {
    const list = terminal.list(await root(input));
    if (!list.some(s => s.id === input.id)) throw Error('终端不属于当前项目');
    await terminal.stop(input.id);
  });
  return terminal;
}
module.exports = { registerWorkspace };
