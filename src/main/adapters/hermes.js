// Hermes Agent Adapter：`hermes acp`（Nous Research，ACP over stdio）。
// 实现共享自 ACP 家族工厂（见 acp.js）。能力按官方文档声明面逐项标注：
// 已文档化：会话持久化/恢复/Fork、流式回答与思考、工具、审批、模型选择。
// 图片输入：上游 server.py 在 initialize 报告 PromptCapabilities(image=True) 并转发图片块
// （PR #18030、commit 7e2af0c）；acp.js 在发送时按 initialize 实际值动态防护，旧版本会明确报错而非静默丢弃。
// 未文档化（不声明）：提问、压缩、Usage。
const { acpAdapter } = require("./acp");

module.exports = acpAdapter({
  id: "hermes",
  name: "Hermes",
  // Windows 上为 uv/pip 生成的 hermes.exe 启动器；可用 HARNESS_MIX_HERMES_EXECUTABLE 覆盖
  bin: process.env.HARNESS_MIX_HERMES_EXECUTABLE || (process.platform === 'win32' ? 'hermes.exe' : 'hermes'),
  args: ["acp"],
  executable: true,
  images: true,
  fork: true,
  thinking: false,
  permissions: false,
  questions: false,
  compaction: false,
  usage: false,
  contextUsage: false,
});
// ~/.hermes/skills is Hermes' single source of truth (categories become subdirectories);
// it has no documented project-scope skills directory. HERMES_HOME relocates the home.
// https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
module.exports.manifest.integrations.skills = {
  global: ['.hermes/skills'],
  project: [],
  overrides: { '.hermes/skills': { env: 'HERMES_HOME', suffix: 'skills' } },
};
