const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'kiro-cli', name: 'Kiro CLI', aliases: ['kiro'], args: ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'] });
