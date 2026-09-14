const { nativeAcp } = require('./native-acp');

// Requires an explicitly configured ACP executable; no guessed official command.
module.exports = nativeAcp({
  id: 'zcode', name: 'ZCode', args: [],
  capabilities: { questions: false, thinkingLevels: false, usage: true, contextUsage: true, attachments: false, fork: false, compaction: false },
});
// ZCode scans, per scope: .zcode/skills then .agents/skills (deeper workspace levels win).
// https://zcode.z.ai/en/docs/skill
module.exports.manifest.integrations.skills = { global: ['.zcode/skills', '.agents/skills'], project: ['.zcode/skills', '.agents/skills'] };
