const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'cursor-cli', name: 'Cursor CLI', aliases: ['cursor'], args: ['acp'] });
