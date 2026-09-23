import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from './core.js';
import { createHarnessIconElement } from './harness-icons.js';
import { createRendererSettingsIcon } from './icons.js';
import type { RendererSettingsMessages } from './localization.js';

// 设置 → 健康中心：宿主运行状态、各 Harness 握手结果、存储摘要与崩溃报告。
// 只读快照 + 手动重新握手；凭据与原生会话始终不经过这里。

export interface RendererHealthHarness {
  id: string; name: string; available: boolean; detail: string | null;
  collaborationLead: boolean; mcp: boolean; skills: boolean; openThreads: number;
}
export interface RendererHealthSnapshot {
  runtime: {
    startedAt: number; uptimeMs: number; platform: string; arch: string; nodeVersion: string; pid: number;
    instance: { pid: number | null; version: string | null; startedAt: number | null; beatAt: number | null; heartbeatAgeMs: number | null } | null;
  };
  harnesses: RendererHealthHarness[];
  threads: { total: number; working: number; interrupted: number; ready: number };
  sessions: number;
  storage: unknown;
  collaboration: { collaboration: boolean; agentTeam: boolean };
  crashReports: Array<{ file: string; kind: string; at: number | null; version: string | null; message: string; stack: string }>;
  generatedAt: number;
}

export interface RendererHealthClient {
  healthSnapshot(): Promise<unknown>;
  healthRefresh(): Promise<unknown>;
}

function isHealthSnapshot(value: unknown): value is RendererHealthSnapshot {
  const candidate = value as RendererHealthSnapshot | null;
  return !!candidate && !!candidate.runtime && Array.isArray(candidate.harnesses);
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function cardTitle(document: Document, text: string): HTMLElement {
  const title = document.createElement('strong');
  title.className = 'settings-update-panel__title';
  title.textContent = text;
  return title;
}

// 右对齐的指标块：上方弱化标签、下方 tabular 数值（可按状态着色）。
function metricTile(document: Document, label: string, value: string, sub?: string, valueColor?: string): HTMLElement {
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
  valueEl.style.color = valueColor ?? 'var(--settings-text)';
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

// 两列行：左侧（图标 + 名称 + 标签）、右侧右对齐状态，分隔线串联成清单卡片。
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

export function createHealthSettingsPage(messages: RendererSettingsMessages, getClient: () => RendererHealthClient | null): RendererSettingsPageDefinition {
  const zh = messages.locale === 'zh-CN';
  return Object.freeze({
    id: 'health', label: zh ? '健康中心' : 'Health center', icon: 'health',
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement('div');
      heading.className = 'settings-section-label';
      heading.textContent = zh ? '宿主健康' : 'Host health';

      const description = document.createElement('p');
      description.className = 'settings-page-description';
      description.textContent = zh
        ? '只读的宿主运行快照：各 Harness 握手结果、任务与会话计数、崩溃报告；可手动重新握手。'
        : 'Read-only host snapshot: harness handshake results, task and session counts, and crash reports; re-probe on demand.';

      const panel = document.createElement('section');
      panel.className = 'settings-update-panel';
      panel.setAttribute('aria-live', 'polite');

      const actions = document.createElement('div');
      actions.className = 'settings-update-actions';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'settings-command-button settings-command-button--secondary';
      refresh.append(createRendererSettingsIcon('refresh', 15));
      refresh.append(document.createTextNode(zh ? '重新握手全部 Harness' : 'Re-probe all Harnesses'));
      actions.append(refresh);

      const harnessList = document.createElement('section');
      harnessList.className = 'settings-update-panel';

      const crashPanel = document.createElement('section');
      crashPanel.className = 'settings-update-panel';

      const render = (snapshot: RendererHealthSnapshot): void => {
        const runtime = snapshot.runtime;
        const instance = runtime.instance;
        const heartbeatOk = instance?.heartbeatAgeMs != null && instance.heartbeatAgeMs < 30000;

        panel.replaceChildren();
        panel.append(cardTitle(document, zh ? '运行时' : 'Runtime'));
        const meta = document.createElement('p');
        meta.className = 'settings-update-summary';
        meta.textContent = `${runtime.platform}/${runtime.arch} · Node ${runtime.nodeVersion} · PID ${runtime.pid}${instance?.version ? ` · v${instance.version}` : ''}`;
        panel.append(meta);
        const metrics = document.createElement('div');
        metrics.style.display = 'grid';
        metrics.style.gridTemplateColumns = 'repeat(auto-fit, minmax(112px, 1fr))';
        metrics.style.gap = '14px 18px';
        metrics.style.paddingBottom = '12px';
        const heartbeatAge = instance?.heartbeatAgeMs;
        metrics.append(
          metricTile(document, zh ? '已运行' : 'Uptime', formatUptime(runtime.uptimeMs)),
          metricTile(document, zh ? '任务' : 'Tasks', String(snapshot.threads.total),
            zh ? `${snapshot.threads.working} 执行中 / ${snapshot.threads.interrupted} 中断` : `${snapshot.threads.working} running / ${snapshot.threads.interrupted} interrupted`),
          metricTile(document, zh ? '原生会话' : 'Native sessions', String(snapshot.sessions)),
          metricTile(document, zh ? '版本' : 'Version', instance?.version ? `v${instance.version}` : '—'),
          metricTile(document, zh ? '心跳' : 'Heartbeat',
            heartbeatOk ? (zh ? '正常' : 'OK') : zh ? '超时' : 'Stale',
            heartbeatAge != null ? (zh ? `${Math.round(heartbeatAge / 1000)} 秒前` : `${Math.round(heartbeatAge / 1000)}s ago`) : undefined,
            heartbeatOk ? 'var(--settings-success, #22a06b)' : 'var(--settings-danger, #d4433b)'),
        );
        panel.append(metrics);

        harnessList.replaceChildren();
        harnessList.append(cardTitle(document, zh ? 'Harness 握手状态' : 'Harness handshake status'));
        for (const harness of snapshot.harnesses) {
          const left = document.createElement('div');
          left.style.display = 'flex';
          left.style.alignItems = 'center';
          left.style.gap = '8px';
          left.style.minWidth = '0';
          const dot = document.createElement('span');
          dot.style.display = 'inline-block';
          dot.style.width = '8px';
          dot.style.height = '8px';
          dot.style.borderRadius = '50%';
          dot.style.flex = 'none';
          dot.style.background = harness.available ? '#22a06b' : '#d4433b';
          dot.title = harness.available ? (zh ? '握手成功' : 'Handshake succeeded') : (zh ? '握手失败' : 'Handshake failed');
          left.append(dot, createHarnessIconElement(document, harness.id, harness.name, 18));
          const identity = document.createElement('div');
          identity.style.display = 'grid';
          identity.style.gap = '2px';
          identity.style.minWidth = '0';
          const name = document.createElement('span');
          name.textContent = harness.name;
          name.title = harness.name;
          name.style.color = 'var(--settings-text)';
          name.style.fontWeight = '600';
          name.style.fontSize = '13px';
          name.style.overflow = 'hidden';
          name.style.whiteSpace = 'nowrap';
          name.style.textOverflow = 'ellipsis';
          const tags = [
            harness.openThreads ? (zh ? `${harness.openThreads} 任务` : `${harness.openThreads} tasks`) : null,
            harness.collaborationLead ? 'Lead' : null,
            harness.mcp ? 'MCP' : null,
            harness.skills ? (zh ? '技能' : 'Skills') : null,
          ].filter(Boolean).join(' · ');
          const tagLine = document.createElement('small');
          tagLine.style.color = 'var(--settings-muted)';
          tagLine.style.fontSize = '11px';
          tagLine.style.lineHeight = '15px';
          tagLine.style.overflow = 'hidden';
          tagLine.style.whiteSpace = 'nowrap';
          tagLine.style.textOverflow = 'ellipsis';
          if (tags) tagLine.textContent = tags;
          identity.append(name);
          if (tags) identity.append(tagLine);
          if (!harness.available) {
            const detail = harness.detail || (zh ? '未安装或握手失败' : 'not installed or handshake failed');
            const detailLine = document.createElement('small');
            detailLine.textContent = detail;
            detailLine.title = detail;
            detailLine.style.color = 'var(--settings-danger, #d4433b)';
            detailLine.style.fontSize = '11px';
            detailLine.style.lineHeight = '15px';
            detailLine.style.overflow = 'hidden';
            detailLine.style.whiteSpace = 'nowrap';
            detailLine.style.textOverflow = 'ellipsis';
            identity.append(detailLine);
          }
          left.append(identity);
          const status = document.createElement('span');
          status.textContent = harness.available ? (zh ? '可用' : 'Ready') : (zh ? '不可用' : 'Unavailable');
          status.style.fontSize = '13px';
          status.style.fontWeight = '600';
          status.style.whiteSpace = 'nowrap';
          status.style.textAlign = 'right';
          status.style.color = harness.available
            ? 'var(--settings-success, #22a06b)'
            : 'var(--settings-danger, #d4433b)';
          harnessList.append(listRow(document, left, status));
        }

        crashPanel.replaceChildren();
        crashPanel.append(cardTitle(document, zh ? '崩溃报告（最近 10 条）' : 'Crash reports (latest 10)'));
        if (!snapshot.crashReports.length) {
          const empty = document.createElement('p');
          empty.className = 'settings-update-summary';
          empty.textContent = zh ? '无崩溃记录。' : 'No crash reports.';
          crashPanel.append(empty);
        } else {
          for (const report of snapshot.crashReports) {
            const left = document.createElement('span');
            const at = report.at ? new Date(report.at).toLocaleString() : '?';
            left.textContent = `${report.kind} · ${at}`;
            left.style.color = 'var(--settings-muted)';
            left.style.fontSize = '12px';
            left.style.whiteSpace = 'nowrap';
            const right = document.createElement('span');
            right.textContent = report.message;
            right.style.color = 'var(--settings-text)';
            right.style.fontSize = '12px';
            right.style.overflow = 'hidden';
            right.style.whiteSpace = 'nowrap';
            right.style.textOverflow = 'ellipsis';
            const row = listRow(document, left, right);
            if (report.stack) row.title = report.stack;
            crashPanel.append(row);
          }
        }
      };

      const client = getClient();
      if (!client) {
        panel.textContent = zh ? '当前 Host 不支持健康中心。' : 'Health center is unavailable on this Host.';
        refresh.disabled = true;
        context.content.append(heading, description, panel, actions);
        return undefined;
      }
      const loadingText = zh ? '加载中…' : 'Loading…';
      panel.textContent = loadingText;
      harnessList.textContent = loadingText;
      crashPanel.textContent = loadingText;
      void context.runLatest(() => client.healthSnapshot(), {
        success(value) { if (isHealthSnapshot(value)) render(value); else panel.textContent = zh ? '健康数据解析失败。' : 'Failed to parse health data.'; },
        failure(error) { panel.textContent = error instanceof Error ? error.message : String(error); },
      });
      refresh.addEventListener('click', () => {
        refresh.disabled = true;
        void context.runLatest(() => client.healthRefresh(), {
          success(value) { refresh.disabled = false; if (isHealthSnapshot(value)) render(value); },
          failure(error) { refresh.disabled = false; panel.textContent = error instanceof Error ? error.message : String(error); },
        });
      });
      context.content.append(heading, description, panel, actions, harnessList, crashPanel);
      return undefined;
    },
  });
}
