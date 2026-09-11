// Qoder Agent Adapter：阿里 Qoder CLI（通过 ACP 协议或 stdio 桥接）。
// 共享 ACP 家族工厂（见 acp.js）。
const { execFile } = require('node:child_process');
const { cliSpawn } = require('../host/jsonl');
const { acpAdapter } = require('./acp');

module.exports = acpAdapter({
  id: 'qoder',
  name: 'Qoder',
  bin: process.env.HARNESS_MIX_QODER_EXECUTABLE || 'qodercli',
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
  async inspectCustom() {
    const cli = cliSpawn(process.env.HARNESS_MIX_QODER_EXECUTABLE || 'qodercli', ['--version']);
    return new Promise(resolve => {
      execFile(cli.command, cli.args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err) {
          return resolve({
            available: false,
            detail: '未找到 Qoder CLI（请运行 npm i -g @qoder-ai/qodercli 并登录）',
          });
        }
        resolve({ available: true, detail: `qodercli ${String(stdout || '').trim()}` });
      });
    });
  },
});
