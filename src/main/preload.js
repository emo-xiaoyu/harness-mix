const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harnessMix", {
  snapshot: () => ipcRenderer.invoke("runtime:snapshot"),
  listFiles: input => ipcRenderer.invoke('workspace:list', input),
  readFile: input => ipcRenderer.invoke('workspace:read', input),
  review: input => ipcRenderer.invoke('workspace:review', input),
  gitStatus: input => ipcRenderer.invoke('git:status', input),
  gitDiff: input => ipcRenderer.invoke('git:diff', input),
  gitMutate: input => ipcRenderer.invoke('git:mutate', input),
  undoFile: input => ipcRenderer.invoke('workspace:undo', input),
  terminalList: input => ipcRenderer.invoke('terminal:list', input),
  terminalRun: input => ipcRenderer.invoke('terminal:run', input),
  terminalStop: input => ipcRenderer.invoke('terminal:stop', input),
  pickFolder: () => ipcRenderer.invoke("workspace:pick"),
  createThread: (input) => ipcRenderer.invoke("thread:create", input),
  send: (threadId, text) => ipcRenderer.invoke("thread:send", { threadId, text }),
  cancel: (threadId) => ipcRenderer.invoke("thread:cancel", threadId),
  fork: (threadId, messageId) => ipcRenderer.invoke('thread:fork', messageId ? { threadId, messageId } : threadId),
  refreshUsage: threadId => ipcRenderer.invoke('thread:usage', threadId),
  listCommands: input => ipcRenderer.invoke('harness:commands', input),
  executeCommand: (threadId, commandId) => ipcRenderer.invoke('thread:command', { threadId, commandId }),
  openFolder: cwd => ipcRenderer.invoke('workspace:openFolder', cwd),
  listModels: (threadId) => ipcRenderer.invoke("thread:listModels", threadId),
  setModel: (threadId, model) => ipcRenderer.invoke("thread:setModel", { threadId, model }),
  setThinking: (threadId, level) => ipcRenderer.invoke("thread:setThinking", { threadId, level }),
  setOptions: (threadId, options) => ipcRenderer.invoke("thread:setOptions", { threadId, options }),
  removeThread: (threadId) => ipcRenderer.invoke("thread:remove", threadId),
  moveThread: (threadId, cwd) => ipcRenderer.invoke("thread:move", { threadId, cwd }),
  describe: (harnessId) => ipcRenderer.invoke("harness:describe", harnessId),
  respondApproval: (threadId, requestId, response) => ipcRenderer.invoke("approval:respond", { threadId, requestId, response }),
  coreSnapshot: () => ipcRenderer.invoke("core:snapshot"),
  coreShadowReport: () => ipcRenderer.invoke("core:shadowReport"),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("runtime:event", handler);
    return () => ipcRenderer.removeListener("runtime:event", handler);
  },
});
