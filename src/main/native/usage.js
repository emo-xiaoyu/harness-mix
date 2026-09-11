const integer = n => Number.isSafeInteger(n) && n >= 0;
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function projectUsage(source = {}) {
  const result = {};
  const fields = {
    inputTokens: ['inputTokens', 'input'], outputTokens: ['outputTokens', 'output'],
    cachedInputTokens: ['cachedInputTokens', 'cacheRead'], cacheWriteInputTokens: ['cacheWriteInputTokens', 'cacheWrite'],
    reasoningOutputTokens: ['reasoningOutputTokens'], totalTokens: ['totalTokens'],
    totalCostUsd: ['totalCostUsd', 'cost'], contextUsagePercent: ['contextUsagePercent', 'contextPercent'],
    cacheHitRatePercent: ['cacheHitRatePercent', 'cacheHitPercent'],
  };
  for (const [target, keys] of Object.entries(fields)) {
    const value = keys.map(key => source[key]).find(number);
    if (value === undefined || target.endsWith('Tokens') && !integer(value)) continue;
    if (target === 'cacheHitRatePercent' && value > 100) continue;
    result[target] = value;
  }
  const used = source.contextUsedTokens ?? source.tokens;
  const window = source.contextWindowTokens ?? source.contextWindow;
  if (integer(used) && integer(window) && window > 0) {
    result.contextUsedTokens = used;
    result.contextWindowTokens = window;
    result.contextUsagePercent = 100 * used / window;
  }
  return Object.keys(result).length ? result : null;
}

module.exports = { projectUsage };
