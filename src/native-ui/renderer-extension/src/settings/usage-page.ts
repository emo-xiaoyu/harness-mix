import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from './core.js';
import { createHarnessIconElement } from './harness-icons.js';
import type { RendererSettingsMessages } from './localization.js';

// 设置 → 用量中心：跨 Harness 的 token / 费用 / credits 历史聚合。
// 数据全部来自宿主 usage-history（基线去重后的正向增量），页面只读。

export interface RendererUsageModelRow { model: string; totalTokens: number; turns: number }
export interface RendererUsageHarnessRow {
  harnessId: string; name: string;
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  totalTokens: number; totalCostUsd: number; totalCredits: number; turns: number;
  models: RendererUsageModelRow[];
}
export interface RendererUsageHistoryResult {
  days: Array<{ day: string; harnesses: RendererUsageHarnessRow[] }>;
  retainedDays: number;
}
export interface RendererUsageSummaryResult {
  totals: { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; totalCostUsd: number; totalCredits: number; turns: number };
  activeDays: number;
  retainedDays: number;
  byHarness: RendererUsageHarnessRow[];
  byModel: Array<{ harnessId: string; model: string; totalTokens: number; turns: number }>;
}

export interface RendererUsageClient {
  usageHistory(input: { days?: number }): Promise<unknown>;
  usageSummary(): Promise<unknown>;
}

const HARNESS_COLORS = ['#5b8cff', '#22a06b', '#e8833a', '#a259d9', '#d4433b', '#12a5b0', '#8a8f98', '#c9a227'];
const FALLBACK_COLOR = '#8a8f98';

function compactTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 100 ? `$${value.toFixed(1)}` : `$${value.toFixed(3)}`;
}

function formatCredits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 1000 ? compactTokens(value) : String(Math.round(value * 10) / 10);
}

function isUsageHistoryResult(value: unknown): value is RendererUsageHistoryResult {
  const candidate = value as RendererUsageHistoryResult | null;
  return !!candidate && Array.isArray(candidate.days);
}

function isUsageSummaryResult(value: unknown): value is RendererUsageSummaryResult {
  const candidate = value as RendererUsageSummaryResult | null;
  return !!candidate && !!candidate.totals && Array.isArray(candidate.byHarness);
}

function cardTitle(document: Document, text: string): HTMLElement {
  const title = document.createElement('strong');
  title.className = 'settings-update-panel__title';
  title.textContent = text;
  return title;
}

// 右对齐的指标块：上方弱化标签、下方 tabular 数值，聚合页用它拼出仪表盘式的汇总条。
function metricTile(document: Document, label: string, value: string, sub?: string): HTMLElement {
  const tile = document.createElement('div');
  tile.style.display = 'grid';
  tile.style.gap = '2px';
  tile.style.minWidth = '0';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  labelEl.style.color = 'var(--settings-muted)';
  labelEl.style.fontSize = '11px';
  labelEl.style.lineHeight = '16px';
  const valueEl = document.createElement('strong');
  valueEl.textContent = value;
  valueEl.style.color = 'var(--settings-text)';
  valueEl.style.fontSize = '15px';
  valueEl.style.fontWeight = '600';
  valueEl.style.lineHeight = '20px';
  valueEl.style.fontVariantNumeric = 'tabular-nums';
  valueEl.style.textAlign = 'right';
  valueEl.style.overflowWrap = 'anywhere';
  tile.append(labelEl, valueEl);
  if (sub !== undefined) {
    const subEl = document.createElement('small');
    subEl.textContent = sub;
    subEl.style.color = 'var(--settings-muted)';
    subEl.style.fontSize = '11px';
    subEl.style.lineHeight = '15px';
    subEl.style.textAlign = 'right';
    subEl.style.overflowWrap = 'anywhere';
    tile.append(subEl);
  }
  return tile;
}

function colorSwatch(document: Document, color: string, size = 8): HTMLElement {
  const dot = document.createElement('span');
  dot.style.display = 'inline-block';
  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;
  dot.style.borderRadius = '3px';
  dot.style.background = color;
  dot.style.flex = 'none';
  return dot;
}

// 两列行：左侧（色标 + 品牌图标 + 名称）与右侧右对齐指标，分隔线串联成清单卡片。
function listRow(document: Document, left: HTMLElement, right: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = 'minmax(0, 1fr) auto';
  row.style.alignItems = 'center';
  row.style.gap = '12px';
  row.style.padding = '10px 0';
  row.style.borderTop = '1px solid var(--settings-divider)';
  row.append(left, right);
  return row;
}

export function createUsageSettingsPage(messages: RendererSettingsMessages, getClient: () => RendererUsageClient | null): RendererSettingsPageDefinition {
  const zh = messages.locale === 'zh-CN';
  return Object.freeze({
    id: 'usage', label: zh ? '用量中心' : 'Usage center', icon: 'usage',
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement('div');
      heading.className = 'settings-section-label';
      heading.textContent = zh ? '跨 Harness 用量' : 'Cross-Harness usage';

      const description = document.createElement('p');
      description.className = 'settings-page-description';
      description.textContent = zh
        ? '汇总各 Harness 上报的 token、花费与 credits 历史快照，数据只读。'
        : 'Read-only token, spend and credits history aggregated from per-harness usage reports.';

      const panel = document.createElement('section');
      panel.className = 'settings-update-panel';
      panel.setAttribute('aria-live', 'polite');

      const chart = document.createElement('section');
      chart.className = 'settings-update-panel';

      const modelsPanel = document.createElement('section');
      modelsPanel.className = 'settings-update-panel';

      const renderSummary = (summary: RendererUsageSummaryResult): void => {
        panel.replaceChildren();
        panel.append(cardTitle(document, zh ? '累计（近 90 天）' : 'All time (last 90 days)'));
        const totals = summary.totals;
        const metrics = document.createElement('div');
        metrics.style.display = 'grid';
        metrics.style.gridTemplateColumns = 'repeat(auto-fit, minmax(112px, 1fr))';
        metrics.style.gap = '14px 18px';
        metrics.style.paddingBottom = '12px';
        metrics.append(
          metricTile(document, zh ? 'Tokens 总量' : 'Total tokens', compactTokens(totals.totalTokens),
            zh ? `输入 ${compactTokens(totals.inputTokens)} / 输出 ${compactTokens(totals.outputTokens)}` : `in ${compactTokens(totals.inputTokens)} / out ${compactTokens(totals.outputTokens)}`),
          metricTile(document, zh ? '花费' : 'Spend', formatCost(totals.totalCostUsd)),
          metricTile(document, 'Credits', formatCredits(totals.totalCredits)),
          metricTile(document, zh ? '上报次数' : 'Reports', String(totals.turns)),
          metricTile(document, zh ? '活跃天' : 'Active days', String(summary.activeDays),
            zh ? `保留 ${summary.retainedDays} 天` : `retained ${summary.retainedDays} days`),
        );
        panel.append(metrics);
        for (const [index, harness] of summary.byHarness.entries()) {
          const left = document.createElement('div');
          left.style.display = 'flex';
          left.style.alignItems = 'center';
          left.style.gap = '8px';
          left.style.minWidth = '0';
          left.append(colorSwatch(document, HARNESS_COLORS[index % HARNESS_COLORS.length] ?? FALLBACK_COLOR));
          left.append(createHarnessIconElement(document, harness.harnessId, harness.name, 18));
          const name = document.createElement('span');
          name.textContent = harness.name;
          name.title = harness.name;
          name.style.color = 'var(--settings-text)';
          name.style.fontWeight = '600';
          name.style.fontSize = '13px';
          name.style.overflow = 'hidden';
          name.style.whiteSpace = 'nowrap';
          name.style.textOverflow = 'ellipsis';
          left.append(name);
          const right = document.createElement('span');
          right.style.color = 'var(--settings-muted)';
          right.style.fontSize = '13px';
          right.style.fontVariantNumeric = 'tabular-nums';
          right.style.textAlign = 'right';
          right.style.whiteSpace = 'nowrap';
          right.textContent = zh
            ? `${compactTokens(harness.totalTokens)} tokens · ${formatCost(harness.totalCostUsd)} · ${harness.turns} 次上报`
            : `${compactTokens(harness.totalTokens)} tokens · ${formatCost(harness.totalCostUsd)} · ${harness.turns} reports`;
          panel.append(listRow(document, left, right));
        }
      };

      const renderChart = (history: RendererUsageHistoryResult): void => {
        chart.replaceChildren();
        chart.append(cardTitle(document, zh ? '近 14 天每日 tokens' : 'Daily tokens (last 14 days)'));
        if (!history.days.length) {
          const empty = document.createElement('p');
          empty.className = 'settings-update-summary';
          empty.textContent = zh ? '暂无用量记录——收到首个 usage 上报后开始累计。' : 'No usage recorded yet; counting starts with the first usage report.';
          chart.append(empty);
          return;
        }
        const colorFor = new Map<string, string>();
        const nameFor = new Map<string, string>();
        const allHarnesses = new Set<string>();
        for (const day of history.days) for (const harness of day.harnesses) allHarnesses.add(harness.harnessId);
        [...allHarnesses].forEach((id, index) => colorFor.set(id, HARNESS_COLORS[index % HARNESS_COLORS.length] ?? FALLBACK_COLOR));
        for (const day of history.days) for (const harness of day.harnesses) if (!nameFor.has(harness.harnessId)) nameFor.set(harness.harnessId, harness.name);
        const max = Math.max(1, ...history.days.map(day => day.harnesses.reduce((sum, harness) => sum + (harness.totalTokens || 0), 0)));

        // 图表面板：细网格线 + 底部基线轴，柱子在其上堆叠，悬停提示保留在柱列上。
        const plot = document.createElement('div');
        plot.style.position = 'relative';
        plot.style.padding = '8px 0 6px';
        plot.style.borderBottom = '1px solid var(--settings-border)';
        const gridlines = document.createElement('div');
        gridlines.style.position = 'absolute';
        gridlines.style.inset = '0';
        gridlines.style.pointerEvents = 'none';
        gridlines.style.opacity = '0.55';
        gridlines.style.backgroundImage = 'repeating-linear-gradient(to top, var(--settings-divider) 0 1px, transparent 1px 25%)';
        plot.append(gridlines);
        const bars = document.createElement('div');
        bars.style.display = 'flex';
        bars.style.alignItems = 'flex-end';
        bars.style.gap = '6px';
        bars.style.height = '120px';
        const labels = document.createElement('div');
        labels.style.display = 'flex';
        labels.style.gap = '6px';
        labels.style.paddingTop = '6px';
        for (const day of history.days) {
          const column = document.createElement('div');
          column.style.flex = '1';
          column.style.minWidth = '0';
          column.style.display = 'flex';
          column.style.flexDirection = 'column';
          column.style.justifyContent = 'flex-end';
          column.style.alignItems = 'stretch';
          column.style.height = '100%';
          column.title = `${day.day} · ${day.harnesses.map(h => `${h.name} ${compactTokens(h.totalTokens)}`).join(' · ') || '0'}`;
          const stack = document.createElement('div');
          stack.style.display = 'flex';
          stack.style.flexDirection = 'column-reverse';
          stack.style.justifyContent = 'flex-end';
          stack.style.height = `${Math.max(2, Math.round((day.harnesses.reduce((sum, h) => sum + (h.totalTokens || 0), 0) / max) * 100))}%`;
          for (const harness of day.harnesses) {
            const segment = document.createElement('span');
            segment.style.display = 'block';
            segment.style.background = colorFor.get(harness.harnessId) ?? FALLBACK_COLOR;
            const total = day.harnesses.reduce((sum, h) => sum + (h.totalTokens || 0), 0) || 1;
            segment.style.height = `${Math.max(6, Math.round(((harness.totalTokens || 0) / total) * 100))}%`;
            stack.append(segment);
          }
          column.append(stack);
          bars.append(column);
          const label = document.createElement('small');
          label.textContent = day.day.slice(5);
          label.style.flex = '1';
          label.style.minWidth = '0';
          label.style.opacity = '0.6';
          label.style.fontSize = '11px';
          label.style.textAlign = 'center';
          label.style.whiteSpace = 'nowrap';
          label.style.overflow = 'hidden';
          label.style.textOverflow = 'ellipsis';
          labels.append(label);
        }
        plot.append(bars);
        chart.append(plot, labels);

        // 图例：色标 + 品牌图标 + 名称，与柱体分段颜色一一对应。
        const legend = document.createElement('div');
        legend.style.display = 'flex';
        legend.style.flexWrap = 'wrap';
        legend.style.alignItems = 'center';
        legend.style.gap = '6px 16px';
        legend.style.paddingTop = '12px';
        for (const [id, name] of nameFor) {
          const item = document.createElement('span');
          item.style.display = 'inline-flex';
          item.style.alignItems = 'center';
          item.style.gap = '6px';
          item.style.minWidth = '0';
          item.append(colorSwatch(document, colorFor.get(id) ?? FALLBACK_COLOR, 10));
          item.append(createHarnessIconElement(document, id, name, 15));
          const text = document.createElement('span');
          text.textContent = name;
          text.title = name;
          text.style.color = 'var(--settings-muted)';
          text.style.fontSize = '12px';
          text.style.overflow = 'hidden';
          text.style.whiteSpace = 'nowrap';
          text.style.textOverflow = 'ellipsis';
          item.append(text);
          legend.append(item);
        }
        chart.append(legend);
      };

      const renderModels = (summary: RendererUsageSummaryResult): void => {
        modelsPanel.replaceChildren();
        modelsPanel.append(cardTitle(document, zh ? '模型分布（前 12）' : 'Top models (12)'));
        if (!summary.byModel.length) {
          const empty = document.createElement('p');
          empty.className = 'settings-update-summary';
          empty.textContent = zh ? '暂无模型用量记录。' : 'No model usage recorded yet.';
          modelsPanel.append(empty);
          return;
        }
        for (const entry of summary.byModel) {
          const left = document.createElement('span');
          left.textContent = `${entry.harnessId}/${entry.model}`;
          left.style.color = 'var(--settings-text)';
          left.style.fontSize = '12px';
          left.style.overflowWrap = 'anywhere';
          const right = document.createElement('span');
          right.style.color = 'var(--settings-muted)';
          right.style.fontSize = '12px';
          right.style.fontVariantNumeric = 'tabular-nums';
          right.style.textAlign = 'right';
          right.style.whiteSpace = 'nowrap';
          right.textContent = zh
            ? `${compactTokens(entry.totalTokens)} tokens · ${entry.turns} 次上报`
            : `${compactTokens(entry.totalTokens)} tokens · ${entry.turns} reports`;
          modelsPanel.append(listRow(document, left, right));
        }
      };

      const client = getClient();
      if (!client) {
        panel.textContent = zh ? '当前 Host 不支持用量历史。' : 'Usage history is unavailable on this Host.';
        context.content.append(heading, description, panel);
        return undefined;
      }
      const loadingText = zh ? '加载中…' : 'Loading…';
      panel.textContent = loadingText;
      chart.textContent = loadingText;
      modelsPanel.textContent = loadingText;
      void context.runLatest(() => client.usageHistory({ days: 14 }), {
        success(value) {
          if (!isUsageHistoryResult(value)) { chart.textContent = zh ? '用量数据解析失败。' : 'Failed to parse usage data.'; return; }
          renderChart(value);
        },
        failure(error) { chart.textContent = error instanceof Error ? error.message : String(error); },
      });
      void context.runLatest(() => client.usageSummary(), {
        success(value) {
          if (!isUsageSummaryResult(value)) { panel.textContent = zh ? '用量数据解析失败。' : 'Failed to parse usage data.'; return; }
          renderSummary(value);
          renderModels(value);
        },
        failure(error) { panel.textContent = error instanceof Error ? error.message : String(error); },
      });
      const note = document.createElement('p');
      note.className = 'settings-update-summary';
      note.style.opacity = '0.65';
      note.textContent = zh
        ? '统计来自各 Harness 上报的会话用量增量，凭据与额度仍由各 Harness 原生管理。'
        : 'Statistics aggregate per-session usage deltas reported by each Harness; credentials and quotas stay native.';
      context.content.append(heading, description, panel, chart, modelsPanel, note);
      return undefined;
    },
  });
}
