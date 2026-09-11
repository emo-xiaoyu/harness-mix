// Workbuddy Agent Adapter：腾讯 Workbuddy / CodeBuddy CLI（通过 ACP 协议或 stdio 桥接）。
// 共享 ACP 家族工厂（见 acp.js）。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { cliSpawn } = require('../host/jsonl');
const { acpAdapter } = require('./acp');

function findWorkbuddyCli() {
  if (process.env.HARNESS_MIX_WORKBUDDY_EXECUTABLE) {
    return { type: 'exe', path: process.env.HARNESS_MIX_WORKBUDDY_EXECUTABLE };
  }
  const candidates = [
    'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { type: 'script', path: candidate };
    }
  }
  return null;
}

module.exports = acpAdapter({
  id: 'workbuddy',
  name: 'Workbuddy',
  bin: 'codebuddy',
  args: ['--acp'],
  executable: false,
  images: false,
  fork: false,
  thinking: true,
  permissions: true,
  questions: true,
  compaction: false,
  usage: true,
  contextUsage: false,
  resolveCommand(argv) {
    const found = findWorkbuddyCli();
    if (found?.type === 'script') {
      return { command: process.execPath, args: [found.path, ...argv] };
    }
    if (found?.type === 'exe') {
      return { command: found.path, args: argv };
    }
    return null;
  },
  async inspectCustom() {
    const found = findWorkbuddyCli();
    if (found?.type === 'script') {
      return new Promise(resolve => {
        execFile(process.execPath, [found.path, '--version'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          if (err) return resolve({ available: false, detail: 'WorkBuddy CLI 启动失败' });
          resolve({ available: true, detail: `codebuddy ${stdout.trim()} · WorkBuddy 桌面版内置` });
        });
      });
    }
    const cli = cliSpawn('codebuddy', ['--version']);
    return new Promise(resolve => {
      execFile(cli.command, cli.args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ available: false, detail: '未找到 WorkBuddy / CodeBuddy CLI（未在 PATH 或默认目录）' });
        resolve({ available: true, detail: `codebuddy ${stdout.trim()}` });
      });
    });
  },
});
