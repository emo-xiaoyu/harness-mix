const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'codebuddy', name: 'CodeBuddy', aliases: ['workbuddy', 'WorkBuddy'], args: ['--acp'] });
