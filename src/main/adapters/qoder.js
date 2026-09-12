const { nativeAcp } = require('./native-acp');

// Official CLI ACP; native account and tools remain in Qoder.
module.exports = nativeAcp({
  id: 'qoder', name: 'Qoder', args: ['--acp'],
  capabilities: { questions: false, thinkingLevels: false, usage: true, contextUsage: true, attachments: true, fork: false, compaction: false },
});
