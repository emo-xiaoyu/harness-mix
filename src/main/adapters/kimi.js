const { nativeAcp } = require('./native-acp');

// Kimi Code 0.26.0 exposes its own sessions, models, thinking, modes, image
// prompts and MCP through ACP. Its initialize response advertises load/list/
// resume but no session/fork; never synthesize a fork by copying native files.
module.exports = nativeAcp({
  id: 'kimi-code', name: 'Kimi Code', aliases: ['kimi', 'kimicode'], args: ['acp'],
  capabilities: { thinkingLevels: true, permissionModes: true, resume: true, fork: false,
    compaction: true, usage: false, contextUsage: false, attachments: true },
});
module.exports.manifest.icon = 'kimi-code-moonshot.svg';
module.exports.manifest.integrations.skills = {
  global: ['.agents/skills'], project: ['.agents/skills'],
};
