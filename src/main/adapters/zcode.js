const { nativeAcp } = require('./native-acp');

// Requires an explicitly configured ACP executable; no guessed official command.
module.exports = nativeAcp({
  id: 'zcode', name: 'ZCode', args: [],
  capabilities: { questions: false, thinkingLevels: false, usage: true, contextUsage: true, attachments: false, fork: false, compaction: false },
});
