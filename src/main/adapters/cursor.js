const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'cursor-cli', name: 'Cursor', aliases: ['cursor', 'cursor-cli', 'cursorcli'], args: ['acp'] });
