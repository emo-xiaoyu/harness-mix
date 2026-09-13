const integer = n => Number.isSafeInteger(n) && n >= 0;
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

function projectUsage(source = {}) {
  if (!source || typeof source !== 'object') return null;
  const result = {};
  const fields = {
    inputTokens: ['inputTokens', 'input'],
    outputTokens: ['outputTokens', 'output'],
    cachedInputTokens: ['cachedInputTokens', 'cacheRead'],
    cacheWriteInputTokens: ['cacheWriteInputTokens', 'cacheWrite'],
    reasoningOutputTokens: ['reasoningOutputTokens', 'thinkingTokens'],
    totalTokens: ['totalTokens'],
    outputTokensPerSecond: ['outputTokensPerSecond'],
    totalCostUsd: ['totalCostUsd', 'cost'],
    totalCredits: ['totalCredits'],
    contextUsagePercent: ['contextUsagePercent', 'contextPercent'],
    cacheHitRatePercent: ['cacheHitRatePercent', 'cacheHitPercent'],
    planFiveHourUsedPercent: ['planFiveHourUsedPercent'],
    planFiveHourResetsAtUnix: ['planFiveHourResetsAtUnix'],
    planSevenDayUsedPercent: ['planSevenDayUsedPercent'],
    planSevenDayResetsAtUnix: ['planSevenDayResetsAtUnix'],
  };
  for (const [target, keys] of Object.entries(fields)) {
    const value = keys.map(key => source[key]).find(number);
    if (value === undefined) continue;
    if (target.endsWith('Tokens') && !integer(value)) continue;
    if (target.endsWith('Unix') && !integer(value)) continue;
    if ((target === 'cacheHitRatePercent' || target.endsWith('UsedPercent')) && value > 100) continue;
    result[target] = value;
  }
  const used = source.contextUsedTokens ?? source.tokens;
  const window = source.contextWindowTokens ?? source.contextWindow;
  if (integer(used) && integer(window) && window > 0) {
    result.contextUsedTokens = used;
    result.contextWindowTokens = window;
    if (result.contextUsagePercent === undefined) {
      result.contextUsagePercent = Math.round((100 * used / window) * 100) / 100;
    }
  }
  if ((result.contextUsedTokens !== undefined) !== (result.contextWindowTokens !== undefined)) {
    delete result.contextUsedTokens;
    delete result.contextWindowTokens;
  }
  if (result.planFiveHourResetsAtUnix !== undefined && result.planFiveHourUsedPercent === undefined) {
    delete result.planFiveHourResetsAtUnix;
  }
  if (result.planSevenDayResetsAtUnix !== undefined && result.planSevenDayUsedPercent === undefined) {
    delete result.planSevenDayResetsAtUnix;
  }
  return Object.keys(result).length ? result : null;
}

const VALID_PERIODS = new Set(['weekly', 'monthly', 'five_hour', 'seven_day', 'unknown']);

function projectAccountCredits(source) {
  if (!source || typeof source !== 'object') return null;
  const rawUsed = source.usedPercent ?? source.usagePercent;
  if (!percent(rawUsed)) return null;
  const usedPercent = Math.round(rawUsed * 100) / 100;
  const periodType = typeof source.periodType === 'string' && VALID_PERIODS.has(source.periodType.toLowerCase())
    ? source.periodType.toLowerCase()
    : 'unknown';
  const out = { usedPercent, periodType };
  if (typeof source.label === 'string' && source.label.trim()) {
    out.label = source.label.trim();
  }
  if (typeof source.resetsAt === 'string' && source.resetsAt.trim()) {
    out.resetsAt = source.resetsAt.trim();
  }
  if (Array.isArray(source.productUsage) && source.productUsage.length > 0) {
    const products = [];
    for (const item of source.productUsage) {
      if (!item || typeof item !== 'object') continue;
      const product = typeof item.product === 'string' ? item.product.trim() : '';
      const pUsed = item.usagePercent ?? item.usedPercent;
      if (!product || !percent(pUsed)) continue;
      const entry = { product, usagePercent: Math.round(pUsed * 100) / 100 };
      if (typeof item.resetsAt === 'string' && item.resetsAt.trim()) {
        entry.resetsAt = item.resetsAt.trim();
      }
      products.push(entry);
    }
    if (products.length > 0) out.productUsage = products;
  }
  if (source.resetCredits && typeof source.resetCredits === 'object') {
    const count = source.resetCredits.availableCount;
    if (integer(count) && count > 0) {
      const reset = { availableCount: count };
      if (typeof source.resetCredits.nextExpiresAt === 'string' && source.resetCredits.nextExpiresAt.trim()) {
        reset.nextExpiresAt = source.resetCredits.nextExpiresAt.trim();
      }
      if (Array.isArray(source.resetCredits.expiresAt) && source.resetCredits.expiresAt.length > 0) {
        const exp = source.resetCredits.expiresAt.filter(e => typeof e === 'string' && e.trim());
        if (exp.length > 0) reset.expiresAt = exp.slice(0, 32);
      }
      out.resetCredits = reset;
    }
  }
  return out;
}

module.exports = { projectUsage, projectAccountCredits };

