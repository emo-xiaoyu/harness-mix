const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'cursor-cli', name: 'Cursor', aliases: ['cursor', 'cursor-cli', 'cursorcli'], args: ['acp'] });
module.exports.manifest.integrations.skills = {
  global: ['.cursor/skills', '.agents/skills', '.claude/skills', '.codex/skills'],
  project: ['.cursor/skills', '.agents/skills', '.claude/skills', '.codex/skills'],
};
