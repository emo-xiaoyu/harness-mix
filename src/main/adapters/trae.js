// Trae Agent Adapter：字节跳动 Trae CLI / Agent（通过 ACP 协议或 stdio 桥接）。
// 共享 ACP 家族工厂（见 acp.js）。
const { acpAdapter } = require('./acp');

module.exports = acpAdapter({
  id: 'trae',
  name: 'Trae',
  bin: process.env.HARNESS_MIX_TRAE_EXECUTABLE || 'traecli',
  args: ['acp', 'serve'],
  executable: false,
  images: false,
  fork: false,
  thinking: true,
  permissions: true,
  questions: true,
  compaction: false,
  usage: true,
  contextUsage: false,
});
