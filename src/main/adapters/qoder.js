const { nativeAcp } = require('./native-acp');

// Official CLI ACP; native account and tools remain in Qoder.
// Capabilities measured against qodercli 1.1.58: the effort selector is the
// `reasoning_effort` config option (xhigh/low/medium/none); session/fork takes
// the standard Zed params; usage_update exists only as an input schema, the CLI
// never emits it, so usage displays would be fabricated.
module.exports = nativeAcp({
  id: 'qoder', name: 'Qoder', args: ['--acp'],
  capabilities: { questions: false, thinkingLevels: true, usage: false, contextUsage: false, attachments: true, fork: true, compaction: false },
});
module.exports.manifest.integrations.skills = { global: ['.qoder/skills'], project: ['.qoder/skills'] };
