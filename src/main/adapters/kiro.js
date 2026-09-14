const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'kiro-cli', name: 'Kiro', aliases: ['kiro', 'kiro-cli', 'kirocli'], args: ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'] });
module.exports.manifest.integrations.skills = { global: ['.kiro/skills'], project: ['.kiro/skills'] };
