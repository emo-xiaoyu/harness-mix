const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const clean = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => valid(v)));

// Same native accounting as codex-host/pi-usage: cache tokens are separate
// from uncached input. Session totals and latest-request cache rate must not mix.
function sessionUsage(data = {}) {
  const t = data.tokens ?? {}, c = data.contextUsage ?? {};
  return { ...clean({ input: t.input, output: t.output, cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite, totalTokens: t.total, cost: data.cost,
  }), tokens: valid(c.tokens) ? c.tokens : null,
    contextWindow: valid(c.contextWindow) && c.contextWindow > 0 ? c.contextWindow : null,
    contextPercent: valid(c.tokens) && valid(c.contextWindow) && c.contextWindow > 0
      ? 100 * c.tokens / c.contextWindow : null };
}

function latestUsage(message) {
  if (message?.role !== 'assistant' || !message.usage) return null;
  const { input, cacheRead, cacheWrite } = message.usage;
  const total = input + cacheRead + cacheWrite;
  return { kind: 'usage', usage: { cacheHitPercent:
    [input, cacheRead, cacheWrite].every(valid) && total > 0 ? 100 * cacheRead / total : null } };
}

module.exports = { sessionUsage, latestUsage };
