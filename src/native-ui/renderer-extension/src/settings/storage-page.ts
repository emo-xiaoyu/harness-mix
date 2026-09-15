import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from './core.js';
import type { RendererSettingsMessages } from './localization.js';
import { createRendererSettingsIcon } from './icons.js';

export interface RendererStorageInspection {
  readonly storageSchemaVersion: number;
  readonly threadCount: number;
  readonly loadedThreadCount: number;
  readonly indexBytes: number;
  readonly recordBytes: number;
  readonly recordCount: number;
  readonly legacyBytes: number;
}

export interface RendererStorageClient {
  inspectStorage(): Promise<RendererStorageInspection>;
  optimizeStorage(): Promise<{ before: RendererStorageInspection; after: RendererStorageInspection }>;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value;
  let unit = 'B';
  for (const next of units) { scaled /= 1024; unit = next; if (scaled < 1024) break; }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${unit}`;
}

export function createStorageSettingsPage(messages: RendererSettingsMessages, getClient: () => RendererStorageClient | null): RendererSettingsPageDefinition {
  const zh = messages.locale === 'zh-CN';
  return Object.freeze({
    id: 'storage', label: zh ? '存储与验证' : 'Storage & verification', icon: 'storage',
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement('div'); heading.className = 'settings-section-label'; heading.textContent = zh ? '会话存储' : 'Session storage';
      const storage = document.createElement('section'); storage.className = 'settings-storage-block';
      const panel = document.createElement('section'); panel.className = 'settings-update-panel'; panel.setAttribute('aria-live', 'polite');
      const actions = document.createElement('div'); actions.className = 'settings-update-actions';
      const optimize = document.createElement('button'); optimize.type = 'button'; optimize.className = 'settings-command-button';
      optimize.append(createRendererSettingsIcon('storage', 16), zh ? '优化存储' : 'Optimize storage');
      actions.append(optimize);
      const render = (value: RendererStorageInspection): void => {
        panel.replaceChildren();
        const title = document.createElement('strong'); title.className = 'settings-update-panel__title'; title.textContent = `Schema v${value.storageSchemaVersion}`;
        const copy = document.createElement('p'); copy.className = 'settings-update-summary';
        copy.textContent = zh
          ? `${value.threadCount} 个任务，冷启动仅载入 ${value.loadedThreadCount} 个完整任务；索引 ${bytes(value.indexBytes)}，分片 ${bytes(value.recordBytes)}。`
          : `${value.threadCount} tasks; ${value.loadedThreadCount} full tasks loaded at cold start. Index ${bytes(value.indexBytes)}, shards ${bytes(value.recordBytes)}.`;
        panel.append(title, copy);
      };
      const client = getClient();
      if (!client) { panel.textContent = zh ? '当前 Host 不支持存储治理。' : 'Storage governance is unavailable on this Host.'; optimize.disabled = true; }
      else {
        void context.runLatest(() => client.inspectStorage(), { success: render, failure(error) { panel.textContent = error instanceof Error ? error.message : String(error); } });
        optimize.addEventListener('click', () => {
          optimize.disabled = true;
          void context.runLatest(() => client.optimizeStorage(), {
            success(result) { optimize.disabled = false; render(result.after); },
            failure(error) { optimize.disabled = false; panel.textContent = error instanceof Error ? error.message : String(error); },
          });
        });
      }
      const gate = document.createElement('section'); gate.className = 'settings-about-panel';
      const gateTitle = document.createElement('strong'); gateTitle.textContent = zh ? '任务验证门禁' : 'Task verification gates';
      const gateCopy = document.createElement('p'); gateCopy.textContent = zh
        ? '在任务命令面板使用 /gate 配置策略，使用 /verify 立即运行。验证报告会显示在对应回合并随接力证据传递。'
        : 'Use /gate in a task command palette to configure policy and /verify to run it. Reports appear on the Turn and travel with handoff evidence.';
      gate.append(gateTitle, gateCopy);
      storage.append(panel, actions);
      context.content.append(heading, storage, gate);
      return undefined;
    },
  });
}
