const { nativeAcp } = require('./native-acp');
module.exports = nativeAcp({ id: 'codebuddy', name: 'CodeBuddy', aliases: ['workbuddy', 'WorkBuddy'], args: ['--acp'] });
module.exports.manifest.integrations.skills = { global: ['.codebuddy/skills'], project: ['.codebuddy/skills'] };
