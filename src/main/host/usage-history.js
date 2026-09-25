const path = require('node:path');
const { Store } = require('./store');

// 用量中心的历史层：把各 Harness 适配器上报的 usage 事件按「天 × Harness × 模型」
// 聚合成持久化行。适配器上报的是会话累计值，这里按 thread+harness+model 基线取
// 正向增量，避免重复计数；切换 Harness / 模型后基线自动归零重置。
const RETAINED_DAYS = 90;
const SAVE_DEBOUNCE_MS = 3000;

function utcDay(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// 适配器原始 usage 可能用多种字段名（见 native/usage.js 的 projectUsage 映射）
function normalizeUsage(usage = {}) {
  const pick = keys => {
    for (const key of keys) { const value = numberOrNull(usage[key]); if (value !== null) return value; }
    return null;
  };
  return {
    inputTokens: pick(['inputTokens', 'input']),
    outputTokens: pick(['outputTokens', 'output']),
    cachedInputTokens: pick(['cachedInputTokens', 'cacheRead']),
    totalTokens: pick(['totalTokens']),
    totalCostUsd: pick(['totalCostUsd', 'cost']),
    totalCredits: pick(['totalCredits']),
  };
}

function emptyBucket(day, harnessId, model) {
  return { day, harnessId, model, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalCredits: 0, turns: 0 };
}

class UsageHistory {
  constructor(runtime) {
    this.runtime = runtime;
    this.store = new Store(path.join(runtime.store.directory, 'usage'), 'history.json');
    this.rows = [];
    // threadId|harnessId|model -> 上次见到的累计值；只累计正向差值
    this.lastTotals = new Map();
    this.dirty = false;
  }

  async initialize() {
    if (!this.loading) this.loading = this.store.load().then(rows => {
      this.rows = Array.isArray(rows) ? rows.filter(row => row && typeof row.day === 'string' && typeof row.harnessId === 'string') : [];
      this.prune();
    });
    return this.loading;
  }

  prune(now = Date.now()) {
    const cutoff = utcDay(now - RETAINED_DAYS * 24 * 60 * 60 * 1000);
    const kept = this.rows.filter(row => row.day >= cutoff);
    if (kept.length !== this.rows.length) {
      this.rows = kept;
      this.dirty = true;
    }
  }

  modelLabel(thread) {
    const model = thread.options?.model;
    if (!model) return 'default';
    return String(model.name ?? model.id ?? 'default');
  }

  /** 记录一次 usage 事件（会话累计值），按正向增量聚合到当天桶 */
  record(thread, usage) {
    const normalized = normalizeUsage(usage);
    const hasSignal = normalized.totalTokens !== null || normalized.inputTokens !== null || normalized.outputTokens !== null;
    if (!thread || !hasSignal) return;
    const harnessId = thread.harnessId;
    const model = this.modelLabel(thread);
    const key = `${thread.id}|${harnessId}|${model}`;
    const last = this.lastTotals.get(key) ?? {};
    const delta = field => {
      const current = normalized[field];
      if (current === null) return 0;
      const previous = last[field];
      if (previous === undefined) return 0; // 首次见到基线，不计入，避免把历史累计一次性灌入当天
      return Math.max(0, Math.round(current - previous));
    };
    this.lastTotals.set(key, { ...last, ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null)) });
    const inputTokens = delta('inputTokens');
    const outputTokens = delta('outputTokens');
    const cachedInputTokens = delta('cachedInputTokens');
    let totalTokens = delta('totalTokens');
    if (!totalTokens && (inputTokens || outputTokens)) totalTokens = inputTokens + outputTokens;
    const totalCostUsd = normalized.totalCostUsd !== null && last.totalCostUsd !== undefined ? Math.max(0, Math.round((normalized.totalCostUsd - last.totalCostUsd) * 1e6) / 1e6) : 0;
    const totalCredits = normalized.totalCredits !== null && last.totalCredits !== undefined ? Math.max(0, normalized.totalCredits - last.totalCredits) : 0;
    if (!totalTokens && !totalCostUsd && !totalCredits) return;
    const day = utcDay();
    let bucket = this.rows.find(row => row.day === day && row.harnessId === harnessId && row.model === model);
    if (!bucket) { bucket = emptyBucket(day, harnessId, model); this.rows.push(bucket); }
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.cachedInputTokens += cachedInputTokens;
    bucket.totalTokens += totalTokens;
    bucket.totalCostUsd = Math.round((bucket.totalCostUsd + totalCostUsd) * 1e6) / 1e6;
    bucket.totalCredits += totalCredits;
    bucket.turns += 1;
    this.prune();
    this.saveSoon();
  }

  saveSoon() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush().catch(() => {}); }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.store.save(this.rows);
  }

  harnessNames() {
    const names = new Map();
    for (const adapter of this.runtime.adapters.values()) names.set(adapter.manifest.id, adapter.manifest.name);
    return names;
  }

  /** 最近 N 天的逐日聚合（按 Harness，再按模型） */
  history({ days = 14 } = {}) {
    const count = Number.isSafeInteger(days) && days > 0 && days <= RETAINED_DAYS ? days : 14;
    const cutoff = utcDay(Date.now() - (count - 1) * 24 * 60 * 60 * 1000);
    const names = this.harnessNames();
    const byDay = new Map();
    for (const row of this.rows) {
      if (row.day < cutoff) continue;
      let day = byDay.get(row.day);
      if (!day) { day = { day: row.day, harnesses: new Map() }; byDay.set(row.day, day); }
      let harness = day.harnesses.get(row.harnessId);
      if (!harness) {
        harness = { harnessId: row.harnessId, name: names.get(row.harnessId) ?? row.harnessId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalCredits: 0, turns: 0, models: new Map() };
        day.harnesses.set(row.harnessId, harness);
      }
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'turns']) harness[field] += row[field] ?? 0;
      harness.totalCostUsd = Math.round((harness.totalCostUsd + (row.totalCostUsd ?? 0)) * 1e6) / 1e6;
      harness.totalCredits += row.totalCredits ?? 0;
      let model = harness.models.get(row.model);
      if (!model) { model = { model: row.model, totalTokens: 0, turns: 0 }; harness.models.set(row.model, model); }
      model.totalTokens += row.totalTokens ?? 0;
      model.turns += row.turns ?? 0;
    }
    return {
      days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(day => ({
        day: day.day,
        harnesses: [...day.harnesses.values()].map(harness => ({ ...harness, models: [...harness.models.values()].sort((a, b) => b.totalTokens - a.totalTokens) })),
      })),
      retainedDays: RETAINED_DAYS,
    };
  }

  /** 全量汇总：总览、按 Harness、按模型（前 12） */
  summary() {
    const names = this.harnessNames();
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalCredits: 0, turns: 0 };
    const byHarness = new Map();
    const byModel = new Map();
    const daysSeen = new Set();
    for (const row of this.rows) {
      daysSeen.add(row.day);
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'turns']) totals[field] += row[field] ?? 0;
      totals.totalCostUsd = Math.round((totals.totalCostUsd + (row.totalCostUsd ?? 0)) * 1e6) / 1e6;
      totals.totalCredits += row.totalCredits ?? 0;
      let harness = byHarness.get(row.harnessId);
      if (!harness) {
        harness = { harnessId: row.harnessId, name: names.get(row.harnessId) ?? row.harnessId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalCredits: 0, turns: 0 };
        byHarness.set(row.harnessId, harness);
      }
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens', 'turns']) harness[field] += row[field] ?? 0;
      harness.totalCostUsd = Math.round((harness.totalCostUsd + (row.totalCostUsd ?? 0)) * 1e6) / 1e6;
      harness.totalCredits += row.totalCredits ?? 0;
      const modelKey = `${row.harnessId}/${row.model}`;
      let model = byModel.get(modelKey);
      if (!model) { model = { harnessId: row.harnessId, model: row.model, totalTokens: 0, turns: 0 }; byModel.set(modelKey, model); }
      model.totalTokens += row.totalTokens ?? 0;
      model.turns += row.turns ?? 0;
    }
    return {
      totals,
      activeDays: daysSeen.size,
      retainedDays: RETAINED_DAYS,
      byHarness: [...byHarness.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12),
    };
  }
}

module.exports = { UsageHistory, utcDay };
