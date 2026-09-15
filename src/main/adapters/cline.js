const { nativeAcp } = require('./native-acp');

// Cline CLI 官方 ACP 入口：`cline --acp`（apps/cli/src/acp/acpAgent.ts）。
// 已核对的协议事实（决定下面的诚实能力声明）：
// - initialize 声明 loadSession: true、promptCapabilities.image: true；
//   session/new 与 session/load 都返回 modes（plan/act）、models 与
//   configOptions（provider/model/mode/autoApprove），并支持 session/set_model、
//   session/set_mode、session/set_config_option → models / permissionModes /
//   resume / attachments 为真。
// - 事件投影只有 agent_message_chunk / agent_thought_chunk / tool_call /
//   tool_call_update（rawOutput），没有 plan 条目、diff 内容块或 usage_update
//   → plan / nativeDiff / usage / contextUsage 不声明。
// - 审批走标准 session/request_permission（allow_once/allow_always/reject_once），
//   没有独立提问请求 → questions 不声明（提问会作为审批选项出现）。
// - configOptions 不含 effortLevel/thought_level → thinkingLevels 不声明。
// - 无 session/fork 与 compact → fork / compaction 不声明。
module.exports = nativeAcp({
  id: 'cline', name: 'Cline', aliases: ['cline-cli'], args: ['--acp'],
  capabilities: { questions: false, thinkingLevels: false, plan: false, nativeDiff: false },
});
// Cline Skills：项目 `.cline/skills/` 与全局 `~/.cline/skills/`（docs/customization/skills）。
module.exports.manifest.integrations.skills = { global: ['.cline/skills'], project: ['.cline/skills'] };
