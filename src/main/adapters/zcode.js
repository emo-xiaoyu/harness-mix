// ZCode Agent Adapter：智谱 AI ZCode CLI。
// 共享 ACP 家族工厂（见 acp.js）。
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { cliSpawn } = require('../host/jsonl');
const { acpAdapter } = require('./acp');

module.exports = acpAdapter({
  id: 'zcode',
  name: 'ZCode',
  bin: process.env.HARNESS_MIX_ZCODE_EXECUTABLE || 'zcode',
  args: ['acp'],
  executable: false,
  images: false,
  fork: false,
  thinking: true,
  permissions: true,
  questions: true,
  compaction: false,
  usage: true,
  contextUsage: false,
  async inspectCustom() {
    const desktopPath = 'C:\\Program Files\\ZCode';
    const hasDesktop = fs.existsSync(desktopPath);
    const cli = cliSpawn('zcode', ['--version']);
    return new Promise(resolve => {
      execFile(cli.command, cli.args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err) {
          const hint = hasDesktop
            ? '检测到 ZCode 桌面版，但其核心引擎为 ZCode V4 Protocol (app-server) 而非 ACP 协议，需专用协议适配器'
            : '未找到 ZCode CLI';
          return resolve({ available: false, detail: hint });
        }
        resolve({ available: true, detail: `zcode ${String(stdout || '').trim()}` });
      });
    });
  },
});
