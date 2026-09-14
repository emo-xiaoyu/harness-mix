const { nativeAcp } = require('./native-acp');

// Requires an explicitly configured ACP executable; no guessed official command.
module.exports = nativeAcp({
  id: 'trae', name: 'Trae', args: [],
  capabilities: { questions: false, thinkingLevels: false, usage: true, contextUsage: true, attachments: false, fork: false, compaction: false },
});
// Trae IDE uses .trae/skills; TraeCode CLI uses .traecli/skills. Both are registered so the
// CLI-backed (ACP) session and the IDE share one managed root set.
// https://docs.trae.cn/cli_skills
module.exports.manifest.integrations.skills = { global: ['.trae/skills', '.traecli/skills'], project: ['.trae/skills', '.traecli/skills', '.agents/skills'] };
