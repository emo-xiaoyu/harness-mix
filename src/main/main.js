const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("node:path");
const { HostRuntime } = require("./host/runtime");
const { registerWorkspace } = require('./workspace/ipc');

let runtime;
let terminal;
const workspaceRoots = new Set([path.resolve(__dirname, '../..')]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#edf5fa",
    title: "Harness Mix",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  window.setMenuBarVisibility(true);
  const unsubscribe = runtime.subscribe((event) => { if (!window.isDestroyed()) window.webContents.send("runtime:event", event); });
  window.on("closed", unsubscribe);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "文件", submenu: [{ role: "close", label: "关闭窗口" }] },
    { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }] },
    { label: "视图", submenu: [{ role: "reload", label: "刷新" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" }, { role: "toggleDevTools", label: "开发者工具" }] },
    { label: "帮助", submenu: [{ label: "关于 Harness Mix", click: () => dialog.showMessageBox({ message: "Harness Mix", detail: "独立 Harness 桌面 · 开发预览版\n统一呈现 Pi / Claude Code / DSH 等原生 Harness 的会话、流式输出、工具与审批。" }) }] },
  ]));
  runtime = new HostRuntime({ dataDirectory: path.join(app.getPath("userData"), "harness-mix") });
  await runtime.initialize();
  terminal = registerWorkspace({ ipcMain, runtime, roots: workspaceRoots, emit: event => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('runtime:event', event);
  } });

  ipcMain.handle("runtime:snapshot", () => runtime.snapshot());
  ipcMain.handle("workspace:pick", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (!result.canceled) result.filePaths.forEach(p => workspaceRoots.add(p));
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("thread:create", (_event, input) => runtime.createThread(input));
  ipcMain.handle("thread:send", async (_event, { threadId, text }) => {
    const thread = runtime.threads.find(t => t.id === threadId);
    if (thread) {
      const root = await require('node:fs/promises').realpath(thread.cwd);
      if (terminal.list(root).some(s => s.running)) throw Error('请先停止该项目的终端命令再发送任务');
    }
    return runtime.send(threadId, text);
  });
  ipcMain.handle("thread:cancel", (_event, threadId) => runtime.cancel(threadId));
  ipcMain.handle('thread:fork', (_event, input) => runtime.forkThread(typeof input === 'string' ? input : input.threadId, input.messageId));
  ipcMain.handle('thread:usage', (_event, threadId) => runtime.refreshUsage(threadId));
  ipcMain.handle('harness:commands', (_event, input) => runtime.listCommands(input));
  ipcMain.handle('thread:command', (_event, { threadId, commandId }) => runtime.executeCommand(threadId, commandId));
  ipcMain.handle('workspace:openFolder', async (_event, cwd) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await require('node:fs/promises').stat(cwd)).isDirectory()) throw new Error('项目目录不存在');
    const error = await require('electron').shell.openPath(cwd);
    if (error) throw new Error(error);
  });
  ipcMain.handle("thread:listModels", (_event, threadId) => runtime.listModels(threadId));
  ipcMain.handle("thread:setModel", (_event, { threadId, model }) => runtime.setModel(threadId, model));
  ipcMain.handle("thread:setThinking", (_event, { threadId, level }) => runtime.setThinking(threadId, level));
  ipcMain.handle("thread:setOptions", (_event, { threadId, options }) => runtime.setOptions(threadId, options));
  ipcMain.handle("thread:remove", (_event, threadId) => runtime.removeThread(threadId));
  ipcMain.handle("thread:move", (_event, { threadId, cwd }) => runtime.moveThread(threadId, cwd));
  ipcMain.handle("harness:describe", (_event, harnessId) => runtime.describe(harnessId));
  ipcMain.handle("approval:respond", (_event, { threadId, requestId, response }) => runtime.respondApproval(threadId, requestId, response));
  // Core diagnostics. Execution UI receives projected turns/items through runtime:snapshot.
  ipcMain.handle("core:snapshot", () => runtime.coreSnapshot());
  ipcMain.handle("core:shadowReport", () => runtime.shadowReport());

  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
let shutdownStarted = false, shutdownComplete = false;
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void Promise.allSettled([terminal?.close(), runtime?.close()]).then(results => {
    for (const result of results) if (result.status === 'rejected') console.error('Shutdown failed:', result.reason);
    shutdownComplete = true;
    app.quit();
  });
});
