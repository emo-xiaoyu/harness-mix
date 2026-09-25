// Integrations settings pages: one factory builds both the MCP page and the
// Skills page. Both share scope controls (Harness / global / project), a
// shared client, and — in "All Harnesses" mode — an overview with cross-
// harness sync and distribution actions.

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from './core.js';
import type { RendererSettingsMessages } from './localization.js';
import type { DroppedSkillFile, RendererIntegrationsClient, IntegrationSnapshot, IntegrationScope, ManagedServer } from '../renderer-integrations-client.js';

type IntegrationPageKind = 'mcp' | 'skills';

type WebkitEntry = {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader?(): { readEntries(success: (entries: WebkitEntry[]) => void, failure?: (error: DOMException) => void): void };
};

// File-system entries only expose their reader through repeated batch reads
// that must be drained until an empty batch comes back.
async function readAllDirectoryEntries(entry: WebkitEntry): Promise<WebkitEntry[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const all: WebkitEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}

async function walkWebkitEntry(entry: WebkitEntry, prefix: string, output: Array<{ path: string; file: File }>): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    output.push({ path: `${prefix}${entry.name}`, file });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readAllDirectoryEntries(entry)) await walkWebkitEntry(child, `${prefix}${entry.name}/`, output);
  }
}

// Reads files out of a drop/pick gesture, preferring the webkit directory
// entry API so folders arrive with their relative paths; falls back to the
// plain FileList (with webkitRelativePath when the picker provides it).
async function collectDroppedFiles(transfer: DataTransfer | FileList): Promise<Array<{ path: string; file: File }>> {
  const collected: Array<{ path: string; file: File }> = [];
  const entries: WebkitEntry[] = 'items' in transfer && transfer.items.length
    ? [...transfer.items]
      .map(item => (item.webkitGetAsEntry?.() ?? null) as WebkitEntry | null)
      .filter((entry): entry is WebkitEntry => entry !== null)
    : [];
  if (entries.length) {
    for (const entry of entries) await walkWebkitEntry(entry, '', collected);
  }
  if (!collected.length) {
    const fileList = 'files' in transfer ? transfer.files : transfer;
    collected.push(...[...fileList].map(file => ({ path: file.webkitRelativePath || file.name, file })));
  }
  return collected;
}

function createIntegrationSettingsPage(kind: IntegrationPageKind, messages: RendererSettingsMessages, getClient: () => RendererIntegrationsClient | null): RendererSettingsPageDefinition {
  const zh = messages.locale === 'zh-CN';
  const tr = (cn: string, en: string) => zh ? cn : en;
  return Object.freeze({
    id: kind,
    label: kind === 'mcp' ? 'MCP' : 'Skills',
    icon: kind === 'mcp' ? 'connections' : 'session-import',
    mount(context: RendererSettingsPageMountContext) {
      const { content } = context;
      const lifecycle = { signal: context.signal, runLatest: context.runLatest, get disposed() { return context.signal.aborted; } };
      const doc = content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = doc.createElement(tag); node.textContent = text; return node; };

      // Page scaffold: title, description, scope controls, status line, body.
      const title = el('h2', kind === 'mcp' ? 'MCP' : 'Skills');
      const note = el('p', kind === 'mcp'
        ? tr('按 Harness 管理 MCP 服务器。配置会在下次打开原生会话时传入。', 'Manage MCP servers per Harness. Configuration is passed to the next native session.')
        : tr('把技能文件或完整技能文件夹拖到这里，直接安装到原生技能目录。', 'Drop a skill file or a complete skill folder here to install it in the native skill directory.'));
      note.className = 'settings-page-description';
      const controls = el('div'); controls.className = 'settings-integrations-controls';
      const harness = el('select'); harness.setAttribute('aria-label', 'Harness');
      const level = el('select'); level.setAttribute('aria-label', tr('作用范围', 'Scope'));
      const scopeOptions: Array<[string, string]> = [['global', tr('全局', 'Global')], ['project', tr('项目', 'Project')]];
      for (const [value, label] of scopeOptions) { const option = el('option', label); option.value = value; level.append(option); }
      const cwd = el('input'); cwd.placeholder = tr('项目绝对路径', 'Absolute project path'); cwd.setAttribute('aria-label', cwd.placeholder); cwd.hidden = true;
      const refreshButton = el('button', tr('刷新', 'Refresh')); refreshButton.type = 'button'; refreshButton.className = 'settings-command-button settings-command-button--secondary';
      const status = el('p'); status.className = 'settings-integrations-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const body = el('div'); body.className = 'settings-integrations-body';

      let busy = false;

      const selectedScope = (): IntegrationScope => ({ harnessId: harness.value, scope: level.value === 'project' ? 'project' : 'global', ...(level.value === 'project' ? { cwd: cwd.value.trim() } : {}) });
      const currentScopeChoice = (): { scopeType: 'global' | 'project'; currentCwd: string | undefined } => ({
        scopeType: level.value === 'project' ? 'project' : 'global',
        currentCwd: level.value === 'project' ? cwd.value.trim() : undefined,
      });
      const client = () => { const value = getClient(); if (!value) throw new Error(tr('Host 尚未连接，请连接后刷新。', 'Host is not connected. Connect and refresh.')); return value; };
      const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); status.setAttribute('role', 'alert'); };
      const setBusy = (value: boolean) => {
        busy = value;
        content.dataset.integrationBusy = String(value);
        for (const node of content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) node.disabled = value || node.dataset.readonly === 'true';
      };
      const button = (label: string, action: () => void, primary = false) => {
        const node = el('button', label); node.type = 'button'; node.className = `settings-command-button ${primary ? 'settings-command-button--primary' : 'settings-command-button--secondary'}`;
        node.addEventListener('click', action, { signal: lifecycle.signal }); return node;
      };

      // Every write goes through one of these two runners so busy state,
      // refresh and the saved toast stay consistent.
      const mutate = async (operation: (value: RendererIntegrationsClient, selected: IntegrationScope) => Promise<unknown>) => {
        if (busy) return;
        const selected = selectedScope(); setBusy(true); status.textContent = tr('正在保存…', 'Saving…'); status.setAttribute('role', 'status');
        try {
          await operation(client(), selected);
          if (!lifecycle.disposed) { setBusy(false); await refresh(); status.textContent = tr('已保存，下次打开原生会话时生效。', 'Saved. Applies on the next native session open.'); }
        } catch (error) { if (!lifecycle.disposed) { setBusy(false); fail(error); } }
      };
      const mutateCustom = async (operation: (value: RendererIntegrationsClient) => Promise<string | void>) => {
        if (busy) return;
        setBusy(true); status.textContent = tr('正在保存…', 'Saving…'); status.setAttribute('role', 'status');
        try {
          const message = await operation(client());
          if (!lifecycle.disposed) { setBusy(false); await refresh(); status.textContent = message || tr('已保存，下次打开原生会话时生效。', 'Saved. Applies on the next native session open.'); }
        } catch (error) { if (!lifecycle.disposed) { setBusy(false); fail(error); } }
      };

      const bytesToBase64 = (buffer: ArrayBuffer) => {
        const bytes = new Uint8Array(buffer); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return btoa(binary);
      };

      // Validates and normalizes a dropped skill into { name, files }.
      const parseDroppedSkills = async (incoming: Array<{ path: string; file: File }>) => {
        if (!incoming.length) throw new Error(tr('没有读取到文件。', 'No files were read.'));
        if (incoming.length > 500 || incoming.reduce((sum, item) => sum + item.file.size, 0) > 10 * 1024 * 1024) throw new Error(tr('技能超过 10 MB 或 500 个文件。', 'Skill exceeds 10 MB or 500 files.'));
        let normalized = incoming;
        if (incoming.length === 1) {
          if (!/\.md$/i.test(incoming[0]!.file.name)) throw new Error(tr('单文件技能必须是 Markdown 文件。', 'A single-file skill must be a Markdown file.'));
          normalized = [{ path: 'SKILL.md', file: incoming[0]!.file }];
        } else {
          const paths = incoming.map(item => item.path.replaceAll('\\', '/'));
          const first = paths[0]!.split('/')[0];
          if (first && paths.every(value => value.startsWith(`${first}/`))) normalized = incoming.map((item, index) => ({ ...item, path: paths[index]!.slice(first.length + 1) }));
          if (!normalized.some(item => item.path === 'SKILL.md')) throw new Error(tr('技能文件夹根目录必须包含 SKILL.md。', 'The skill folder root must contain SKILL.md.'));
        }
        const skillFile = normalized.find(item => item.path === 'SKILL.md')!;
        const markdown = await skillFile.file.text();
        const declared = markdown.match(/^---[\s\S]*?^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
        const fallback = incoming.length === 1 ? incoming[0]!.file.name.replace(/\.md$/i, '') : incoming[0]!.path.split(/[\\/]/)[0];
        const name = (declared || fallback || 'skill').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        if (!name) throw new Error(tr('无法从文件中确定有效的技能名称。', 'Could not determine a valid skill name from the files.'));
        const files: DroppedSkillFile[] = [];
        for (const item of normalized) files.push({ path: item.path.replaceAll('\\', '/'), contentBase64: bytesToBase64(await item.file.arrayBuffer()) });
        return { name, files };
      };

      const field = (form: HTMLElement, label: string, node: HTMLElement) => { const wrap = el('label', label); wrap.className = 'settings-integrations-field'; wrap.append(node); form.append(wrap); };

      // When the overview sends the user into a specific harness editor.
      let targetEditServerName: string | undefined = undefined;
      const editInHarness = (harnessId: string, serverName?: string) => {
        harness.value = harnessId;
        targetEditServerName = serverName;
        void refresh();
      };

      // Copies a server definition to other harnesses: id stripped, transport
      // fields normalized by type.
      const toManagedForCopy = (s: Partial<ManagedServer> & { name: string; enabled?: boolean }, newEnabled?: boolean): ManagedServer => {
        const isHttp = s.transportType === 'streamable_http' || (typeof s.url === 'string' && s.url.trim().length > 0);
        if (isHttp) {
          return {
            name: s.name,
            transportType: 'streamable_http',
            enabled: newEnabled !== undefined ? newEnabled : (s.enabled ?? true),
            url: s.url || '',
            ...(s.bearer_token_env_var?.trim() ? { bearer_token_env_var: s.bearer_token_env_var.trim() } : {}),
            ...(s.http_headers && Object.keys(s.http_headers).length ? { http_headers: s.http_headers } : {}),
            ...(s.env_http_headers && Object.keys(s.env_http_headers).length ? { env_http_headers: s.env_http_headers } : {}),
          };
        }
        return {
          name: s.name,
          transportType: 'stdio',
          enabled: newEnabled !== undefined ? newEnabled : (s.enabled ?? true),
          command: s.command || '',
          ...(s.args?.length ? { args: s.args } : {}),
          ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
          ...(s.env_vars?.length ? { env_vars: s.env_vars } : {}),
          ...(s.cwd?.trim() ? { cwd: s.cwd.trim() } : {}),
        };
      };

      const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

      const renderMcp = (snapshot: IntegrationSnapshot) => {
        const toolbar = el('div'); toolbar.className = 'settings-integrations-toolbar';
        const search = el('input'); search.type = 'search'; search.placeholder = tr('搜索 MCP 服务器', 'Search MCP servers'); search.setAttribute('aria-label', search.placeholder);
        const list = el('div'); list.className = 'settings-integrations-list';
        const editor = el('div'); editor.className = 'settings-mcp-editor'; editor.hidden = true;
        const showList = () => { editor.hidden = true; list.hidden = false; toolbar.hidden = false; };

        const showEditor = (server?: IntegrationSnapshot['servers'][number]) => {
          editor.replaceChildren(); editor.hidden = false; list.hidden = true; toolbar.hidden = true;
          const heading = el('div'); heading.className = 'settings-integrations-editor-head';
          const backBtn = button(tr('‹ 返回', '‹ Back'), showList);
          const title = el('h3', server ? tr(`更新 ${server.name} MCP`, `Update ${server.name} MCP`) : tr('连接至自定义 MCP', 'Connect to a custom MCP'));
          const docsLink = el('a', tr('文档 ↗', 'Docs ↗'));
          docsLink.href = 'https://modelcontextprotocol.io/introduction';
          docsLink.target = '_blank';
          docsLink.rel = 'noreferrer noopener';
          docsLink.className = 'settings-mcp-docs-link';
          heading.append(backBtn, title, docsLink);
          if (server?.editable) {
            const uninstallBtn = button(tr('卸载', 'Uninstall'), () => {
              void mutate(async (value, selected) => {
                await value.removeMcp({ ...selected, id: server.id });
                if (!lifecycle.disposed) showList();
              });
            });
            uninstallBtn.className = 'settings-command-button settings-command-button--secondary settings-command-button--danger';
            heading.append(uninstallBtn);
          }

          // Small trash button used by every removable row below.
          const createTrashBtn = (onRemove: () => void) => {
            const btn = el('button'); btn.type = 'button'; btn.className = 'settings-mcp-icon-btn';
            btn.setAttribute('aria-label', tr('移除', 'Remove')); btn.title = tr('移除', 'Remove');
            btn.innerHTML = TRASH_SVG;
            btn.addEventListener('click', onRemove);
            return btn;
          };

          let transportType: 'stdio' | 'streamable_http' = (server?.transportType === 'streamable_http' || !!server?.url) ? 'streamable_http' : 'stdio';

          const form = el('form'); form.className = 'settings-integrations-form';
          const basicCard = el('div'); basicCard.className = 'settings-integrations-form--card';
          const name = el('input'); name.required = true; name.pattern = '[a-zA-Z0-9](?:[a-zA-Z0-9_]|-){0,63}';
          name.placeholder = 'MCP server name'; name.value = server?.name ?? '';
          field(basicCard, tr('名称', 'Name'), name);

          // Type switch: locked for existing servers (they must uninstall
          // first, since transports are not convertible).
          const typeField = el('div'); typeField.className = 'settings-integrations-field';
          typeField.append(el('span', tr('类型', 'Type')));
          const toggle = el('div'); toggle.className = 'settings-mcp-type-toggle';
          const stdioBtn = el('button', 'STDIO'); stdioBtn.type = 'button'; stdioBtn.className = 'settings-mcp-type-btn';
          const httpBtn = el('button', tr('流式 HTTP', 'Streamable HTTP')); httpBtn.type = 'button'; httpBtn.className = 'settings-mcp-type-btn';
          toggle.append(stdioBtn, httpBtn);
          typeField.append(toggle);
          basicCard.append(typeField);
          if (server) {
            const switchNotice = el('p', tr('如需切换 MCP 服务器类型，请先卸载当前配置。', 'If you would like to switch MCP server type, please uninstall first.'));
            switchNotice.className = 'settings-mcp-notice';
            basicCard.append(switchNotice);
          }

          const transportCard = el('div'); transportCard.className = 'settings-integrations-form--card settings-mcp-transport-card';
          const stdioSection = el('div'); stdioSection.className = 'settings-mcp-section';
          const command = el('input'); command.placeholder = 'openai-dev-mcp serve-sqlite'; command.value = server?.command ?? '';
          field(stdioSection, tr('启动命令', 'Command to launch'), command);

          const argsField = el('div'); argsField.className = 'settings-integrations-field'; argsField.append(el('span', tr('参数', 'Arguments')));
          const argsList = el('div'); argsList.className = 'settings-mcp-args';
          const addArg = (value = '') => {
            const row = el('div'); row.className = 'settings-mcp-arg';
            const input = el('input'); input.value = value; input.placeholder = tr('命令参数', 'Command argument');
            row.append(input, createTrashBtn(() => row.remove())); argsList.append(row);
          };
          for (const value of (server?.args?.length ? server.args : (transportType === 'stdio' ? [''] : []))) addArg(value);
          const addArgBtn = button(tr('＋ 添加参数', '+ Add argument'), () => addArg()); addArgBtn.className = 'settings-command-button settings-command-button--secondary settings-mcp-add-arg';
          argsField.append(argsList, addArgBtn); stdioSection.append(argsField);

          const envField = el('div'); envField.className = 'settings-integrations-field'; envField.append(el('span', tr('环境变量', 'Environment variables')));
          const envList = el('div'); envList.className = 'settings-mcp-args';
          const addEnv = (key = '', val = '') => {
            const row = el('div'); row.className = 'settings-mcp-kv-row';
            const keyInput = el('input'); keyInput.value = key; keyInput.placeholder = tr('键', 'Key');
            const valInput = el('input'); valInput.value = val; valInput.placeholder = tr('值', 'Value');
            row.append(keyInput, valInput, createTrashBtn(() => row.remove())); envList.append(row);
          };
          if (server?.env) { for (const [k, v] of Object.entries(server.env)) addEnv(k, String(v ?? '')); }
          const addEnvBtn = button(tr('＋ 添加环境变量', '+ Add environment variable'), () => addEnv()); addEnvBtn.className = 'settings-command-button settings-command-button--secondary settings-mcp-add-arg';
          envField.append(envList, addEnvBtn); stdioSection.append(envField);

          const envPassField = el('div'); envPassField.className = 'settings-integrations-field'; envPassField.append(el('span', tr('环境变量传递', 'Environment variable passthrough')));
          const envPassList = el('div'); envPassList.className = 'settings-mcp-args';
          const addEnvPass = (value = '') => {
            const row = el('div'); row.className = 'settings-mcp-arg';
            const input = el('input'); input.value = value; input.placeholder = tr('变量名，例如：GITHUB_TOKEN', 'Variable name, e.g. GITHUB_TOKEN');
            row.append(input, createTrashBtn(() => row.remove())); envPassList.append(row);
          };
          if (server?.env_vars) { for (const v of server.env_vars) addEnvPass(v); }
          const addEnvPassBtn = button(tr('＋ 添加变量', '+ Add variable'), () => addEnvPass()); addEnvPassBtn.className = 'settings-command-button settings-command-button--secondary settings-mcp-add-arg';
          envPassField.append(envPassList, addEnvPassBtn); stdioSection.append(envPassField);

          const cwd = el('input'); cwd.placeholder = '~/code'; cwd.value = server?.cwd ?? '';
          field(stdioSection, tr('工作目录', 'Working directory'), cwd);

          const httpSection = el('div'); httpSection.className = 'settings-mcp-section';
          const url = el('input'); url.placeholder = 'https://mcp.example.com/mcp'; url.value = server?.url ?? '';
          field(httpSection, 'URL', url);

          const bearerToken = el('input'); bearerToken.placeholder = 'MCP_BEARER_TOKEN'; bearerToken.value = server?.bearer_token_env_var ?? '';
          field(httpSection, tr('Bearer 令牌环境变量', 'Bearer token env var'), bearerToken);

          const headersField = el('div'); headersField.className = 'settings-integrations-field'; headersField.append(el('span', tr('标头', 'Headers')));
          const headersList = el('div'); headersList.className = 'settings-mcp-args';
          const addHeader = (key = '', val = '') => {
            const row = el('div'); row.className = 'settings-mcp-kv-row';
            const keyInput = el('input'); keyInput.value = key; keyInput.placeholder = tr('键', 'Key');
            const valInput = el('input'); valInput.value = val; valInput.placeholder = tr('值', 'Value');
            row.append(keyInput, valInput, createTrashBtn(() => row.remove())); headersList.append(row);
          };
          if (server?.http_headers) { for (const [k, v] of Object.entries(server.http_headers)) addHeader(k, String(v ?? '')); }
          const addHeaderBtn = button(tr('＋ 添加标头', '+ Add header'), () => addHeader()); addHeaderBtn.className = 'settings-command-button settings-command-button--secondary settings-mcp-add-arg';
          headersField.append(headersList, addHeaderBtn); httpSection.append(headersField);

          const envHeadersField = el('div'); envHeadersField.className = 'settings-integrations-field'; envHeadersField.append(el('span', tr('来自环境变量的标头', 'Headers from environment variables')));
          const envHeadersList = el('div'); envHeadersList.className = 'settings-mcp-args';
          const addEnvHeader = (key = '', val = '') => {
            const row = el('div'); row.className = 'settings-mcp-kv-row';
            const keyInput = el('input'); keyInput.value = key; keyInput.placeholder = tr('标头名称', 'Header name');
            const valInput = el('input'); valInput.value = val; valInput.placeholder = tr('环境变量名称', 'Environment variable name');
            row.append(keyInput, valInput, createTrashBtn(() => row.remove())); envHeadersList.append(row);
          };
          if (server?.env_http_headers) { for (const [k, v] of Object.entries(server.env_http_headers)) addEnvHeader(k, String(v ?? '')); }
          const addEnvHeaderBtn = button(tr('＋ 添加变量', '+ Add variable'), () => addEnvHeader()); addEnvHeaderBtn.className = 'settings-command-button settings-command-button--secondary settings-mcp-add-arg';
          envHeadersField.append(envHeadersList, addEnvHeaderBtn); httpSection.append(envHeadersField);

          const updateTypeView = () => {
            stdioBtn.dataset.active = String(transportType === 'stdio');
            httpBtn.dataset.active = String(transportType === 'streamable_http');
            stdioSection.hidden = transportType !== 'stdio';
            httpSection.hidden = transportType !== 'streamable_http';
            command.required = transportType === 'stdio';
            url.required = transportType === 'streamable_http';
          };
          stdioBtn.addEventListener('click', () => { transportType = 'stdio'; updateTypeView(); });
          httpBtn.addEventListener('click', () => { transportType = 'streamable_http'; updateTypeView(); });
          updateTypeView();
          transportCard.append(stdioSection, httpSection);

          const security = el('p', tr('凭据和环境变量将在原生 Harness 运行环境中解析与注入，不会泄露在宿主进程中。', 'Credentials and environment variables are resolved and injected within the native Harness environment.'));
          security.className = 'settings-integrations-callout';

          const save = button(tr('保存 MCP', 'Save MCP'), () => {}, true); save.type = 'submit';
          form.append(basicCard, transportCard, security, save);

          form.addEventListener('submit', event => {
            event.preventDefault();
            if (transportType === 'stdio') {
              const args = [...argsList.querySelectorAll<HTMLInputElement>('input')].map(input => input.value.trim()).filter(value => value.length > 0);
              const env: Record<string, string> = {};
              for (const row of envList.querySelectorAll<HTMLElement>('.settings-mcp-kv-row')) {
                const [k, v] = row.querySelectorAll<HTMLInputElement>('input');
                if (k?.value.trim() && v?.value) env[k.value.trim()] = v.value;
              }
              const env_vars = [...envPassList.querySelectorAll<HTMLInputElement>('input')].map(input => input.value.trim()).filter(v => v.length > 0);
              const cwdVal = cwd.value.trim();
              void mutate((value, selected) => value.saveMcp({
                ...selected,
                server: {
                  ...(server?.id ? { id: server.id } : {}),
                  name: name.value.trim(),
                  transportType: 'stdio',
                  command: command.value.trim(),
                  args,
                  ...(Object.keys(env).length ? { env } : {}),
                  ...(env_vars.length ? { env_vars } : {}),
                  ...(cwdVal ? { cwd: cwdVal } : {}),
                  enabled: server?.enabled ?? true,
                },
              }));
            } else {
              const http_headers: Record<string, string> = {};
              for (const row of headersList.querySelectorAll<HTMLElement>('.settings-mcp-kv-row')) {
                const [k, v] = row.querySelectorAll<HTMLInputElement>('input');
                if (k?.value.trim() && v?.value) http_headers[k.value.trim()] = v.value;
              }
              const env_http_headers: Record<string, string> = {};
              for (const row of envHeadersList.querySelectorAll<HTMLElement>('.settings-mcp-kv-row')) {
                const [k, v] = row.querySelectorAll<HTMLInputElement>('input');
                if (k?.value.trim() && v?.value.trim()) env_http_headers[k.value.trim()] = v.value.trim();
              }
              const token = bearerToken.value.trim();
              void mutate((value, selected) => value.saveMcp({
                ...selected,
                server: {
                  ...(server?.id ? { id: server.id } : {}),
                  name: name.value.trim(),
                  transportType: 'streamable_http',
                  url: url.value.trim(),
                  ...(token ? { bearer_token_env_var: token } : {}),
                  ...(Object.keys(http_headers).length ? { http_headers } : {}),
                  ...(Object.keys(env_http_headers).length ? { env_http_headers } : {}),
                  enabled: server?.enabled ?? true,
                },
              }));
            }
          }, { signal: lifecycle.signal });
          editor.append(heading, form); name.focus();
        };

        // Deep link from the overview into this harness's editor.
        if (targetEditServerName) {
          const target = targetEditServerName === '__new__' ? undefined : snapshot.servers.find(s => s.name === targetEditServerName);
          targetEditServerName = undefined;
          showEditor(target);
          body.append(toolbar, list, editor);
          return;
        }
        const addButton = button(tr('＋ 添加 MCP', '+ Add MCP'), () => showEditor(), true); toolbar.append(search, addButton);
        for (const native of snapshot.native) {
          const row = el('section'); row.className = 'settings-integrations-row settings-integrations-row--native';
          row.append(el('strong', `${tr('原生状态', 'Native status')} · ${native.name || native.sessionId}`), el('span', native.status), el('code', native.tools.join(', '))); list.append(row);
        }
        const toManaged = (s: IntegrationSnapshot['servers'][number], newEnabled: boolean): ManagedServer => ({
          id: s.id,
          name: s.name,
          enabled: newEnabled,
          ...(s.transportType ? { transportType: s.transportType } : {}),
          ...(s.command ? { command: s.command } : {}),
          ...(s.args?.length ? { args: s.args } : {}),
          ...(s.env ? { env: s.env } : {}),
          ...(s.env_vars?.length ? { env_vars: s.env_vars } : {}),
          ...(s.cwd ? { cwd: s.cwd } : {}),
          ...(s.url ? { url: s.url } : {}),
          ...(s.bearer_token_env_var ? { bearer_token_env_var: s.bearer_token_env_var } : {}),
          ...(s.http_headers ? { http_headers: s.http_headers } : {}),
          ...(s.env_http_headers ? { env_http_headers: s.env_http_headers } : {}),
        });
        const serverRows: HTMLElement[] = [];
        for (const server of snapshot.servers) {
          const row = el('section'); row.className = 'settings-integrations-row';
          const isHttp = server.transportType === 'streamable_http' || !!server.url;
          row.dataset.search = `${server.name} ${server.command || ''} ${server.url || ''}`.toLowerCase();
          const detail = el('div');
          const state = !server.effective ? tr('被项目配置覆盖', 'Overridden by project') : !server.enabled ? tr('已停用', 'Disabled') : server.appliedSessions ? tr(`已传入 ${server.appliedSessions} 个会话`, `Passed to ${server.appliedSessions} sessions`) : tr('已配置', 'Configured');
          const typeTag = isHttp ? ' [HTTP]' : '';
          const summary = isHttp ? (server.url || '') : [server.command, ...(server.args || [])].filter(Boolean).join(' ');
          detail.append(el('strong', `${server.name}${typeTag}`), el('p', `${server.scope === 'global' ? tr('全局', 'Global') : tr('项目', 'Project')} · ${state}`), el('code', summary));
          row.append(detail);
          if (server.editable) {
            const editBtn = button(tr('编辑', 'Edit'), () => showEditor(server));
            const toggleBtn = button(server.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable'), () => {
              void mutate((value, selected) => value.saveMcp({ ...selected, server: toManaged(server, !server.enabled) }));
            });
            const syncBtn = button(tr('同步…', 'Sync…'), () => {
              void client().integrationCatalog().then(catalog => {
                const targets = catalog.harnesses.filter(h => h.mcp && h.id !== harness.value);
                showMcpSyncDialog(server, { id: harness.value, name: harness.selectedOptions[0]?.text || harness.value }, targets);
              });
            });
            const delBtn = button(tr('删除', 'Delete'), () => {
              void mutate((value, selected) => value.removeMcp({ ...selected, id: server.id }));
            });
            row.append(editBtn, toggleBtn, syncBtn, delBtn);
          }
          list.append(row); serverRows.push(row);
        }
        if (!snapshot.servers.length) { const empty = el('div', tr('还没有 MCP 服务器，点击“添加 MCP”开始配置。', 'No MCP servers yet. Select “Add MCP” to configure one.')); empty.className = 'settings-integrations-empty'; list.append(empty); }
        search.addEventListener('input', () => { const query = search.value.trim().toLowerCase(); for (const row of serverRows) row.hidden = !!query && !row.dataset.search!.includes(query); }, { signal: lifecycle.signal });
        if (!snapshot.mcpSupported) { addButton.disabled = true; const unavailable = el('div', tr('此 Harness 尚无已确认的 MCP 配置接口。', 'This Harness has no verified MCP configuration interface.')); unavailable.className = 'settings-integrations-callout'; list.prepend(unavailable); }
        body.append(toolbar, list, editor);
      };

      type HarnessCatalogItem = {
        id: string;
        name: string;
        available: boolean;
        mcp: boolean;
        skills: boolean;
      };

      type OverviewItem = {
        harness: HarnessCatalogItem;
        snapshot: IntegrationSnapshot | null;
        error: string | null;
      };

      const showMcpSyncDialog = (
        server: ManagedServer | IntegrationSnapshot['servers'][number],
        sourceHarness: { id: string; name: string },
        targetHarnesses: Array<HarnessCatalogItem>
      ) => {
        if (!targetHarnesses.length) {
          fail(new Error(tr('没有其他支持 MCP 的原生 Harness 可供同步。', 'No other native Harnesses support MCP for sync.')));
          return;
        }
        const modal = el('dialog');
        modal.className = 'settings-skills-sync-modal settings-mcp-sync-modal';
        const mTitle = el('h3', tr(`同步 MCP【${server.name}】`, `Sync MCP [${server.name}]`));
        const isHttp = server.transportType === 'streamable_http' || !!server.url;
        const summary = isHttp ? (server.url || '') : [server.command, ...(server.args || [])].filter(Boolean).join(' ');
        const mDesc = el('p', tr(
          `从 ${sourceHarness.name} 复制该 MCP 配置（${isHttp ? 'HTTP' : 'stdio'}：${summary}）到选中的 Harness：`,
          `Copy MCP configuration (${isHttp ? 'HTTP' : 'stdio'}: ${summary}) from ${sourceHarness.name} to selected Harnesses:`
        ));
        const form = el('form');
        const checkList = el('div');
        checkList.style.display = 'grid';
        checkList.style.gap = '8px';
        checkList.style.margin = '12px 0';
        checkList.style.maxHeight = '240px';
        checkList.style.overflowY = 'auto';
        const checkboxes: HTMLInputElement[] = [];
        for (const h of targetHarnesses) {
          const label = el('label');
          label.style.display = 'flex';
          label.style.gap = '8px';
          label.style.alignItems = 'center';
          label.style.cursor = 'pointer';
          const cb = el('input');
          cb.type = 'checkbox';
          cb.value = h.id;
          cb.checked = true;
          checkboxes.push(cb);
          label.append(cb, el('span', h.name));
          checkList.append(label);
        }
        const btnRow = el('div');
        btnRow.style.display = 'flex';
        btnRow.style.gap = '8px';
        btnRow.style.justifyContent = 'flex-end';
        btnRow.style.marginTop = '14px';
        const cancelBtn = button(tr('取消', 'Cancel'), () => { modal.close(); modal.remove(); });
        const confirmBtn = button(tr('确认同步', 'Confirm Sync'), () => {
          const selectedHarnesses = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
          modal.close();
          modal.remove();
          if (!selectedHarnesses.length) return;
          void mutateCustom(async c => {
            const { scopeType, currentCwd } = currentScopeChoice();
            const successes: string[] = [];
            const errors: string[] = [];
            const cleanConfig = toManagedForCopy(server);
            for (const targetId of selectedHarnesses) {
              const targetH = targetHarnesses.find(h => h.id === targetId);
              try {
                await c.saveMcp({
                  harnessId: targetId,
                  scope: scopeType,
                  ...(currentCwd ? { cwd: currentCwd } : {}),
                  server: cleanConfig,
                });
                if (targetH) successes.push(targetH.name);
              } catch (err) {
                errors.push(`${targetH?.name || targetId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (!successes.length && errors.length) throw new Error(errors.join('; '));
            return tr(`同步完成！已配置到：${successes.join('、')}${errors.length ? `（跳过: ${errors.join('; ')}）` : ''}`,
                      `Sync complete! Configured on: ${successes.join(', ')}${errors.length ? ` (Skipped: ${errors.join('; ')})` : ''}`);
          });
        }, true);
        btnRow.append(cancelBtn, confirmBtn);
        form.append(checkList, btnRow);
        modal.append(mTitle, mDesc, form);
        content.append(modal);
        modal.showModal();
      };

      const showMcpDistributeDialog = (targetHarnesses: Array<HarnessCatalogItem>) => {
        if (!targetHarnesses.length) {
          fail(new Error(tr('没有支持 MCP 注入的原生 Harness。', 'No native Harnesses support MCP injection.')));
          return;
        }
        const modal = el('dialog');
        modal.className = 'settings-mcp-distribute-modal';
        const mTitle = el('h3', tr('新建并批量分发 MCP', 'Create & Distribute MCP'));
        const mDesc = el('p', tr('配置 MCP 服务器，并一次性保存分发至选中的所有 Harness。', 'Configure MCP server once and distribute to all selected Harnesses.'));

        const form = el('form');
        form.className = 'settings-integrations-form';

        let transportType: 'stdio' | 'streamable_http' = 'stdio';
        const typeToggle = el('div'); typeToggle.className = 'settings-mcp-type-toggle';
        const stdioBtn = el('button', tr('标准输入输出 (stdio)', 'Standard I/O (stdio)'));
        stdioBtn.type = 'button'; stdioBtn.className = 'settings-mcp-type-btn'; stdioBtn.dataset.active = 'true';
        const httpBtn = el('button', tr('流式 HTTP (SSE)', 'Streamable HTTP (SSE)'));
        httpBtn.type = 'button'; httpBtn.className = 'settings-mcp-type-btn';
        typeToggle.append(stdioBtn, httpBtn);

        const nameInput = el('input'); nameInput.required = true; nameInput.placeholder = 'my-mcp-server';
        nameInput.pattern = '[a-zA-Z0-9](?:[a-zA-Z0-9_]|-){0,63}';
        field(form, tr('MCP 服务器名称（必填）', 'MCP server name (required)'), nameInput);

        const typeField = el('div'); typeField.className = 'settings-integrations-field';
        typeField.append(el('span', tr('传输协议', 'Transport Protocol')), typeToggle);
        form.append(typeField);

        const stdioCard = el('div'); stdioCard.className = 'settings-integrations-form--card';
        const cmdInput = el('input'); cmdInput.placeholder = 'npx / uvx / node / ...';
        field(stdioCard, tr('可执行命令 (Command)', 'Executable Command'), cmdInput);
        const argsInput = el('input'); argsInput.placeholder = '-y @modelcontextprotocol/server-filesystem D:/data';
        field(stdioCard, tr('参数（空格分隔，支持引号）', 'Arguments (space separated, quotes supported)'), argsInput);
        const envInput = el('input'); envInput.placeholder = 'KEY1=val1, KEY2=val2';
        field(stdioCard, tr('环境变量（可选，KEY=VAL 逗号或换行分隔）', 'Environment variables (optional, KEY=VAL separated)'), envInput);

        const httpCard = el('div'); httpCard.className = 'settings-integrations-form--card';
        httpCard.hidden = true;
        const urlInput = el('input'); urlInput.type = 'url'; urlInput.placeholder = 'https://mcp.example.com/sse';
        field(httpCard, tr('MCP 服务器 URL', 'MCP Server URL'), urlInput);
        const tokenInput = el('input'); tokenInput.placeholder = 'API_KEY_ENV_NAME';
        field(httpCard, tr('Bearer Token 环境变量名（可选）', 'Bearer token env var name (optional)'), tokenInput);

        stdioBtn.addEventListener('click', () => {
          transportType = 'stdio'; stdioBtn.dataset.active = 'true'; delete httpBtn.dataset.active;
          stdioCard.hidden = false; httpCard.hidden = true;
        });
        httpBtn.addEventListener('click', () => {
          transportType = 'streamable_http'; httpBtn.dataset.active = 'true'; delete stdioBtn.dataset.active;
          stdioCard.hidden = true; httpCard.hidden = false;
        });

        form.append(stdioCard, httpCard);

        // Harness checklist with a select-all shortcut.
        const targetSection = el('div'); targetSection.className = 'settings-integrations-form--card';
        const targetHead = el('div');
        targetHead.style.display = 'flex'; targetHead.style.justifyContent = 'space-between'; targetHead.style.alignItems = 'center'; targetHead.style.marginBottom = '8px';
        const targetTitle = el('strong', tr('分发目标 Harness：', 'Target Harnesses:'));
        targetTitle.style.fontSize = '12px';
        const toggleAllBtn = el('button', tr('全选 / 取消全选', 'Select / Deselect All'));
        toggleAllBtn.type = 'button'; toggleAllBtn.className = 'settings-command-button settings-command-button--secondary';
        toggleAllBtn.style.fontSize = '11px'; toggleAllBtn.style.padding = '3px 8px';
        targetHead.append(targetTitle, toggleAllBtn);
        targetSection.append(targetHead);

        const checkList = el('div');
        checkList.style.display = 'grid'; checkList.style.gridTemplateColumns = 'repeat(auto-fill, minmax(130px, 1fr))'; checkList.style.gap = '8px';
        const checkboxes: HTMLInputElement[] = [];
        for (const h of targetHarnesses) {
          const label = el('label'); label.style.display = 'flex'; label.style.gap = '6px'; label.style.alignItems = 'center'; label.style.cursor = 'pointer'; label.style.fontSize = '12px';
          const cb = el('input'); cb.type = 'checkbox'; cb.value = h.id; cb.checked = true;
          checkboxes.push(cb);
          label.append(cb, el('span', h.name));
          checkList.append(label);
        }
        targetSection.append(checkList);
        form.append(targetSection);

        toggleAllBtn.addEventListener('click', () => {
          const anyChecked = checkboxes.some(cb => cb.checked);
          for (const cb of checkboxes) cb.checked = !anyChecked;
        });

        const btnRow = el('div'); btnRow.style.display = 'flex'; btnRow.style.gap = '8px'; btnRow.style.justifyContent = 'flex-end'; btnRow.style.marginTop = '14px';
        const cancelBtn = button(tr('取消', 'Cancel'), () => { modal.close(); modal.remove(); });
        const submitBtn = el('button', tr('确认并分发', 'Confirm & Distribute'));
        submitBtn.type = 'submit'; submitBtn.className = 'settings-command-button settings-command-button--primary';
        btnRow.append(cancelBtn, submitBtn);
        form.append(btnRow);

        form.addEventListener('submit', event => {
          event.preventDefault();
          const serverName = nameInput.value.trim();
          if (!serverName) return;
          const selectedHarnesses = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
          if (!selectedHarnesses.length) {
            fail(new Error(tr('请至少选择一个目标 Harness。', 'Please select at least one target Harness.')));
            return;
          }

          let serverConfig: ManagedServer;
          if (transportType === 'streamable_http') {
            const url = urlInput.value.trim();
            if (!url) { fail(new Error(tr('流式 HTTP 模式必须填写 URL。', 'URL is required for streamable HTTP.'))); return; }
            serverConfig = {
              name: serverName,
              transportType: 'streamable_http',
              enabled: true,
              url,
              ...(tokenInput.value.trim() ? { bearer_token_env_var: tokenInput.value.trim() } : {}),
            };
          } else {
            const cmd = cmdInput.value.trim();
            if (!cmd) { fail(new Error(tr('stdio 模式必须填写命令。', 'Command is required for stdio mode.'))); return; }
            const rawArgs = argsInput.value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(s => s.replace(/^['"]|['"]$/g, '')) || [];
            const envMap: Record<string, string> = {};
            for (const part of envInput.value.split(/[,;\n]/)) {
              const eq = part.indexOf('=');
              if (eq > 0) {
                const k = part.slice(0, eq).trim();
                const v = part.slice(eq + 1).trim();
                if (k) envMap[k] = v;
              }
            }
            serverConfig = {
              name: serverName,
              transportType: 'stdio',
              enabled: true,
              command: cmd,
              ...(rawArgs.length ? { args: rawArgs } : {}),
              ...(Object.keys(envMap).length ? { env: envMap } : {}),
            };
          }

          modal.close();
          modal.remove();

          void mutateCustom(async c => {
            const { scopeType, currentCwd } = currentScopeChoice();
            const successes: string[] = [];
            const errors: string[] = [];
            for (const targetId of selectedHarnesses) {
              const targetH = targetHarnesses.find(h => h.id === targetId);
              try {
                await c.saveMcp({
                  harnessId: targetId,
                  scope: scopeType,
                  ...(currentCwd ? { cwd: currentCwd } : {}),
                  server: serverConfig,
                });
                if (targetH) successes.push(targetH.name);
              } catch (err) {
                errors.push(`${targetH?.name || targetId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (!successes.length && errors.length) throw new Error(errors.join('; '));
            return tr(`已成功分发【${serverName}】至：${successes.join('、')}${errors.length ? `（跳过: ${errors.join('; ')}）` : ''}`,
                      `Distributed [${serverName}] to: ${successes.join(', ')}${errors.length ? ` (Skipped: ${errors.join('; ')})` : ''}`);
          });
        });

        modal.append(mTitle, mDesc, form);
        content.append(modal);
        modal.showModal();
      };

      const renderMcpOverview = (
        _catalog: Awaited<ReturnType<RendererIntegrationsClient['integrationCatalog']>>,
        items: OverviewItem[]
      ) => {
        const supported = items.filter(i => i.harness.mcp);
        const uniqueServers = new Map<string, Array<{ harness: HarnessCatalogItem; server: IntegrationSnapshot['servers'][number] }>>();
        let totalServersCount = 0;
        let totalNativeCount = 0;

        for (const item of items) {
          if (item.snapshot?.servers) {
            totalServersCount += item.snapshot.servers.length;
            for (const s of item.snapshot.servers) {
              const list = uniqueServers.get(s.name) || [];
              list.push({ harness: item.harness, server: s });
              uniqueServers.set(s.name, list);
            }
          }
          if (item.snapshot?.native) {
            totalNativeCount += item.snapshot.native.length;
          }
        }

        const statsBar = el('div'); statsBar.className = 'settings-skills-overview-stats settings-mcp-overview-stats';
        const statsSummary = el('span', tr(
          `📊 共 ${items.length} 个 Harness · ${supported.length} 个支持原生 MCP 注入 · 已配置 ${uniqueServers.size} 种独立 MCP（共 ${totalServersCount} 个实例）${totalNativeCount ? ` · ${totalNativeCount} 个活跃原生连接` : ''}`,
          `📊 ${items.length} Harnesses · ${supported.length} with native MCP injection · ${uniqueServers.size} unique MCPs (${totalServersCount} instances)${totalNativeCount ? ` · ${totalNativeCount} active native connections` : ''}`
        ));
        statsBar.append(statsSummary);

        const toolbar = el('div'); toolbar.className = 'settings-integrations-toolbar';
        const searchInput = el('input'); searchInput.type = 'search';
        searchInput.placeholder = tr('按名称、命令或 URL 过滤 MCP 服务器…', 'Filter MCP servers by name, command, or URL…');
        searchInput.setAttribute('aria-label', searchInput.placeholder);

        const tabsWrap = el('div'); tabsWrap.className = 'settings-skills-tabs settings-mcp-tabs';
        const btnByHarness = el('button', tr('按 Harness 查看', 'By Harness'));
        btnByHarness.type = 'button'; btnByHarness.className = 'settings-skills-tab-btn';
        btnByHarness.dataset.active = 'true';
        const btnByServer = el('button', tr('按 Server 汇总', 'By Server'));
        btnByServer.type = 'button'; btnByServer.className = 'settings-skills-tab-btn';
        tabsWrap.append(btnByHarness, btnByServer);

        const distributeBtn = button(tr('＋ 新建并分发 MCP', '＋ New & Distribute MCP'), () => {
          showMcpDistributeDialog(supported.map(i => i.harness));
        }, true);

        toolbar.append(searchInput, tabsWrap, distributeBtn);

        const viewsContainer = el('div'); viewsContainer.className = 'settings-skills-views settings-mcp-views';
        let activeTab: 'harness' | 'server' = 'harness';

        const updateView = () => {
          viewsContainer.replaceChildren();
          const query = searchInput.value.trim().toLowerCase();

          if (activeTab === 'harness') {
            const grid = el('div'); grid.className = 'settings-skills-overview-grid settings-mcp-overview-grid';
            for (const item of items) {
              const allServers = item.snapshot?.servers || [];
              const allNative = item.snapshot?.native || [];
              const matchingServers = query
                ? allServers.filter(s =>
                    s.name.toLowerCase().includes(query) ||
                    (s.command && s.command.toLowerCase().includes(query)) ||
                    (s.url && s.url.toLowerCase().includes(query)) ||
                    (s.args && s.args.some(a => a.toLowerCase().includes(query)))
                  )
                : allServers;
              const matchingNative = query
                ? allNative.filter(n =>
                    (n.name && n.name.toLowerCase().includes(query)) ||
                    (n.sessionId && n.sessionId.toLowerCase().includes(query)) ||
                    (n.tools && n.tools.some(t => t.toLowerCase().includes(query)))
                  )
                : allNative;

              if (query && !item.harness.name.toLowerCase().includes(query) && matchingServers.length === 0 && matchingNative.length === 0) {
                continue;
              }

              const card = el('section'); card.className = 'settings-skills-harness-card settings-mcp-harness-card';
              const head = el('div'); head.className = 'settings-skills-harness-head settings-mcp-harness-head';
              const hTitle = el('strong', item.harness.name);
              const badge = el('span');
              badge.className = `settings-skills-badge ${item.harness.mcp ? 'settings-skills-badge--active' : ''}`;
              badge.textContent = item.harness.mcp
                ? tr(`${allServers.length} 个 MCP`, `${allServers.length} MCPs`)
                : tr('未提供 MCP 接口', 'No native MCP interface');
              head.append(hTitle, badge);
              card.append(head);

              if (!item.harness.mcp) {
                const note = el('p', tr('此 Harness 尚无已确认的 MCP 配置接口。', 'This Harness has no verified MCP configuration interface.'));
                note.className = 'settings-mcp-notice';
                card.append(note);
              } else if (item.error) {
                const errNote = el('p', item.error);
                errNote.className = 'settings-mcp-notice';
                errNote.style.color = '#ef4444';
                card.append(errNote);
              } else {
                if (matchingNative.length > 0) {
                  const nativeBox = el('div'); nativeBox.className = 'settings-mcp-native-box';
                  const nativeTitle = el('div'); nativeTitle.className = 'settings-mcp-native-title';
                  nativeTitle.textContent = tr(`🟢 原生运行时活跃 (${matchingNative.length})`, `🟢 Active Native Sessions (${matchingNative.length})`);
                  nativeBox.append(nativeTitle);
                  for (const n of matchingNative) {
                    const nRow = el('div'); nRow.className = 'settings-mcp-native-item';
                    const nHeader = el('div');
                    nHeader.append(
                      el('strong', n.name || n.sessionId),
                      el('span', ` · ${n.status}${n.tools?.length ? ` · ${n.tools.length} ${tr('工具', 'tools')}` : ''}`)
                    );
                    nRow.append(nHeader);
                    if (n.tools?.length) {
                      const toolPreview = n.tools.slice(0, 4).join(', ') + (n.tools.length > 4 ? ` +${n.tools.length - 4}` : '');
                      nRow.append(el('code', toolPreview));
                    }
                    nativeBox.append(nRow);
                  }
                  card.append(nativeBox);
                }

                if (matchingServers.length === 0) {
                  const empty = el('p', query ? tr('无匹配 MCP 服务器', 'No matching MCP servers') : tr('暂未配置 MCP 服务器', 'No MCP servers configured'));
                  empty.className = 'settings-mcp-notice';
                  card.append(empty);
                } else {
                  const list = el('div'); list.className = 'settings-skills-list-compact settings-mcp-list-compact';
                  for (const s of matchingServers) {
                    const row = el('div'); row.className = 'settings-skills-item-row settings-mcp-item-row';
                    const isHttp = s.transportType === 'streamable_http' || !!s.url;
                    const summary = isHttp ? (s.url || '') : [s.command, ...(s.args || [])].filter(Boolean).join(' ');
                    const stateText = !s.effective ? tr(' · 被项目覆盖', ' · Overridden') : !s.enabled ? tr(' · 已停用', ' · Disabled') : s.appliedSessions ? tr(` · 传入 ${s.appliedSessions} 会话`, ` · ${s.appliedSessions} sessions`) : tr(' · 已配置', ' · Configured');
                    const info = el('div');
                    info.append(
                      el('strong', `${s.name}${isHttp ? ' [HTTP]' : ' [stdio]'}`),
                      el('span', stateText),
                      el('code', summary)
                    );
                    const actions = el('div'); actions.className = 'settings-skills-item-actions settings-mcp-item-actions';
                    actions.append(button(s.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable'), () => {
                      void mutateCustom(async c => {
                        const { scopeType, currentCwd } = currentScopeChoice();
                        await c.saveMcp({
                          harnessId: item.harness.id,
                          scope: scopeType,
                          ...(currentCwd ? { cwd: currentCwd } : {}),
                          server: toManagedForCopy(s, !s.enabled),
                        });
                        return tr(`已${s.enabled ? '停用' : '启用'}【${s.name}】（${item.harness.name}）。`,
                                  `${s.enabled ? 'Disabled' : 'Enabled'} [${s.name}] (${item.harness.name}).`);
                      });
                    }));
                    const otherSupported = supported.filter(h => h.harness.id !== item.harness.id);
                    if (otherSupported.length > 0) {
                      actions.append(button(tr('同步…', 'Sync…'), () => {
                        showMcpSyncDialog(s, item.harness, otherSupported.map(h => h.harness));
                      }));
                    }
                    actions.append(button(tr('编辑', 'Edit'), () => {
                      editInHarness(item.harness.id, s.name);
                    }));
                    row.append(info, actions);
                    list.append(row);
                  }
                  card.append(list);
                }

                const cardFooter = el('div'); cardFooter.className = 'settings-mcp-card-footer';
                const addBtn = button(tr('＋ 添加 MCP', '＋ Add MCP'), () => {
                  editInHarness(item.harness.id, '__new__');
                });
                cardFooter.append(addBtn);
                card.append(cardFooter);
              }
              grid.append(card);
            }
            viewsContainer.append(grid);
          } else {
            const matrixList = el('div'); matrixList.className = 'settings-skills-matrix-list settings-mcp-matrix-list';
            let matchedCount = 0;
            for (const [serverName, installations] of uniqueServers.entries()) {
              const firstServer = installations[0]!.server;
              const isHttp = firstServer.transportType === 'streamable_http' || !!firstServer.url;
              const summary = isHttp ? (firstServer.url || '') : [firstServer.command, ...(firstServer.args || [])].filter(Boolean).join(' ');

              if (query && !serverName.toLowerCase().includes(query) && !summary.toLowerCase().includes(query) && !installations.some(i => i.harness.name.toLowerCase().includes(query))) {
                continue;
              }
              matchedCount++;
              const card = el('section'); card.className = 'settings-skills-matrix-card settings-mcp-matrix-card';
              const head = el('div'); head.className = 'settings-skills-matrix-head settings-mcp-matrix-head';
              const titleWrap = el('div');
              titleWrap.style.display = 'flex'; titleWrap.style.alignItems = 'center'; titleWrap.style.gap = '8px';
              titleWrap.append(el('strong', serverName), el('span', `[${isHttp ? 'HTTP' : 'stdio'}]`));
              head.append(
                titleWrap,
                el('span', tr(`已在 ${installations.length} 个 Harness 配置`, `Configured in ${installations.length} harnesses`))
              );

              const codeSummary = el('code');
              codeSummary.style.fontSize = '11px'; codeSummary.style.color = 'var(--settings-muted)'; codeSummary.style.overflowWrap = 'anywhere';
              codeSummary.textContent = summary;

              const tags = el('div'); tags.className = 'settings-skills-tags settings-mcp-tags';
              for (const inst of installations) {
                const tag = el('span');
                tag.className = `settings-skills-tag settings-mcp-tag ${inst.server.enabled ? '' : 'settings-mcp-tag--disabled'}`;
                tag.textContent = `✓ ${inst.harness.name}${inst.server.enabled ? '' : tr(' (已停用)', ' (disabled)')}`;
                tags.append(tag);
              }

              const installedIds = new Set(installations.map(i => i.harness.id));
              const missingHarnesses = supported.filter(h => !installedIds.has(h.harness.id));

              const syncRow = el('div'); syncRow.className = 'settings-skills-sync-actions settings-mcp-sync-actions';
              if (missingHarnesses.length > 0) {
                const label = el('span', tr('未配置于：', 'Not configured in: '));
                label.style.fontSize = '11px'; label.style.color = 'var(--settings-muted)';
                syncRow.append(label);

                for (const missing of missingHarnesses) {
                  const installBtn = button(`+ ${missing.harness.name}`, () => {
                    void mutateCustom(async c => {
                      const { scopeType, currentCwd } = currentScopeChoice();
                      await c.saveMcp({
                        harnessId: missing.harness.id,
                        scope: scopeType,
                        ...(currentCwd ? { cwd: currentCwd } : {}),
                        server: toManagedForCopy(firstServer),
                      });
                      return tr(`已将 MCP【${serverName}】同步到 ${missing.harness.name}。`, `Configured [${serverName}] to ${missing.harness.name}.`);
                    });
                  });
                  syncRow.append(installBtn);
                }

                if (missingHarnesses.length > 1) {
                  const installAllBtn = button(tr('一键同步到全部支持的 Harness', 'Sync to all supported'), () => {
                    void mutateCustom(async c => {
                      const { scopeType, currentCwd } = currentScopeChoice();
                      const successes: string[] = [];
                      for (const missing of missingHarnesses) {
                        try {
                          await c.saveMcp({
                            harnessId: missing.harness.id,
                            scope: scopeType,
                            ...(currentCwd ? { cwd: currentCwd } : {}),
                            server: toManagedForCopy(firstServer),
                          });
                          successes.push(missing.harness.name);
                        } catch { /* skip unreachable harnesses */ }
                      }
                      return tr(`已将 MCP【${serverName}】同步到：${successes.join('、')}。`, `Synced [${serverName}] to: ${successes.join(', ')}.`);
                    });
                  }, true);
                  syncRow.append(installAllBtn);
                }
              } else {
                const complete = el('span', tr('✓ 已在所有支持的 Harness 中配置就绪', '✓ Ready across all supported Harnesses'));
                complete.style.fontSize = '11px'; complete.style.color = '#10a37f';
                syncRow.append(complete);
              }

              card.append(head, codeSummary, tags, syncRow);
              matrixList.append(card);
            }
            if (matchedCount === 0) {
              const empty = el('div', tr('未匹配到任何 MCP 服务器。', 'No MCP servers matched the search.'));
              empty.className = 'settings-integrations-empty';
              matrixList.append(empty);
            }
            viewsContainer.append(matrixList);
          }
        };

        btnByHarness.addEventListener('click', () => {
          activeTab = 'harness';
          btnByHarness.dataset.active = 'true';
          delete btnByServer.dataset.active;
          updateView();
        }, { signal: lifecycle.signal });

        btnByServer.addEventListener('click', () => {
          activeTab = 'server';
          btnByServer.dataset.active = 'true';
          delete btnByHarness.dataset.active;
          updateView();
        }, { signal: lifecycle.signal });

        searchInput.addEventListener('input', () => {
          updateView();
        }, { signal: lifecycle.signal });

        updateView();
        body.append(statsBar, toolbar, viewsContainer);
      };

      const showSyncDialog = (
        skill: { name: string; path: string },
        sourceHarness: { id: string; name: string },
        targetHarnesses: Array<{ id: string; name: string }>
      ) => {
        const sourceDir = skill.path.replace(/[/\\][^/\\]+$/, '');
        if (!targetHarnesses.length) {
          fail(new Error(tr('没有其他支持技能的原生 Harness 可供同步。', 'No other native Harnesses support skills for sync.')));
          return;
        }
        const modal = el('dialog');
        modal.className = 'settings-skills-sync-modal';
        const mTitle = el('h3', tr(`同步技能【${skill.name}】`, `Sync skill [${skill.name}]`));
        const mDesc = el('p', tr(`从 ${sourceHarness.name} 复制该技能到以下选中的 Harness：`, `Copy skill from ${sourceHarness.name} to selected Harnesses:`));
        const form = el('form');
        const checkList = el('div');
        checkList.style.display = 'grid';
        checkList.style.gap = '8px';
        checkList.style.margin = '12px 0';
        const checkboxes: HTMLInputElement[] = [];
        for (const h of targetHarnesses) {
          const label = el('label');
          label.style.display = 'flex';
          label.style.gap = '8px';
          label.style.alignItems = 'center';
          label.style.cursor = 'pointer';
          const cb = el('input');
          cb.type = 'checkbox';
          cb.value = h.id;
          cb.checked = true;
          checkboxes.push(cb);
          label.append(cb, el('span', h.name));
          checkList.append(label);
        }
        const btnRow = el('div');
        btnRow.style.display = 'flex';
        btnRow.style.gap = '8px';
        btnRow.style.justifyContent = 'flex-end';
        btnRow.style.marginTop = '14px';
        const cancelBtn = button(tr('取消', 'Cancel'), () => { modal.close(); modal.remove(); });
        const confirmBtn = button(tr('确认同步', 'Confirm Sync'), () => {
          const selectedHarnesses = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
          modal.close();
          modal.remove();
          if (!selectedHarnesses.length) return;
          void mutateCustom(async c => {
            const { scopeType, currentCwd } = currentScopeChoice();
            const successes: string[] = [];
            const errors: string[] = [];
            for (const targetId of selectedHarnesses) {
              const targetH = targetHarnesses.find(h => h.id === targetId);
              try {
                await c.changeSkill({
                  harnessId: targetId,
                  scope: scopeType,
                  ...(currentCwd ? { cwd: currentCwd } : {}),
                  name: skill.name,
                  source: sourceDir,
                  action: 'install',
                });
                if (targetH) successes.push(targetH.name);
              } catch (err) {
                errors.push(`${targetH?.name || targetId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            return tr(`同步完成！已安装到：${successes.join('、')}${errors.length ? `（跳过: ${errors.join('; ')}）` : ''}`,
                      `Sync complete! Installed to: ${successes.join(', ')}${errors.length ? ` (Skipped: ${errors.join('; ')})` : ''}`);
          });
        }, true);
        btnRow.append(cancelBtn, confirmBtn);
        form.append(checkList, btnRow);
        modal.append(mTitle, mDesc, form);
        content.append(modal);
        modal.showModal();
      };

      const renderSkills = (snapshot: IntegrationSnapshot) => {
        const drop = el('div'); drop.className = 'settings-skill-dropzone'; drop.tabIndex = 0; drop.setAttribute('role', 'button');
        const dropTitle = el('strong', tr('拖拽技能到这里', 'Drop a skill here'));
        const dropHint = el('span', tr('支持单个 Markdown 文件或包含 SKILL.md 的文件夹 · 最大 10 MB / 500 个文件', 'Supports one Markdown file or a folder containing SKILL.md · up to 10 MB / 500 files'));
        const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.setAttribute('webkitdirectory', '');
        const choose = button(tr('选择技能文件夹', 'Choose skill folder'), () => picker.click());
        drop.append(dropTitle, dropHint, choose, picker);
        const list = el('div'); list.className = 'settings-integrations-list';

        const installFiles = async (incoming: Array<{ path: string; file: File }>) => {
          const parsed = await parseDroppedSkills(incoming);
          await mutate((value, selected) => value.changeSkill({ ...selected, name: parsed.name, files: parsed.files, action: 'install' }));
        };

        const receiveFiles = async (transfer: DataTransfer | FileList) => {
          try {
            await installFiles(await collectDroppedFiles(transfer));
          } catch (error) { fail(error); }
        };

        for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => { event.preventDefault(); if (!busy) drop.dataset.dragOver = 'true'; }, { signal: lifecycle.signal });
        drop.addEventListener('dragleave', () => { delete drop.dataset.dragOver; }, { signal: lifecycle.signal });
        drop.addEventListener('drop', event => { event.preventDefault(); delete drop.dataset.dragOver; if (!busy && event.dataTransfer) void receiveFiles(event.dataTransfer); }, { signal: lifecycle.signal });
        picker.addEventListener('change', () => { if (picker.files?.length) void receiveFiles(picker.files); picker.value = ''; }, { signal: lifecycle.signal });
        if (!snapshot.skillsSupported) { drop.dataset.disabled = 'true'; choose.disabled = true; dropHint.textContent = tr('此 Harness 的原生技能目录尚未确认。', 'This Harness has no verified native skill directory.'); }
        for (const skill of snapshot.skills) {
          const row = el('section'); row.className = 'settings-integrations-row';
          const detail = el('div'); detail.append(el('strong', skill.name), el('p', skill.enabled ? tr('已安装 · 加载状态未报告', 'Installed · load status unreported') : tr('已停用 · 文件已保留', 'Disabled · files retained')), el('code', skill.path)); row.append(detail);
          if (skill.writable) {
            row.append(button(skill.enabled ? tr('停用', 'Disable') : tr('恢复', 'Restore'), () => { void mutate((value, selected) => value.changeSkill({ ...selected, name: skill.name, root: skill.root, action: skill.enabled ? 'disable' : 'enable' })); }));
          } else {
            row.append(el('span', tr('链接目录，只读', 'Linked directory, read-only')));
          }
          const syncBtn = button(tr('同步到…', 'Sync to…'), () => {
            void lifecycle.runLatest(() => client().integrationCatalog(), {
              success: cat => {
                const targetHarnesses = cat.harnesses.filter(h => h.skills && h.id !== snapshot.harnessId);
                showSyncDialog(skill, { id: snapshot.harnessId, name: snapshot.harnessId }, targetHarnesses);
              },
              failure: fail,
            });
          });
          row.append(syncBtn);
          list.append(row);
        }
        if (!snapshot.skills.length) { const empty = el('div', tr('还没有发现技能。拖入文件即可安装。', 'No skills found. Drop files above to install one.')); empty.className = 'settings-integrations-empty'; list.append(empty); }
        body.append(drop, list);
      };

      const renderSkillsOverview = (catalog: { harnesses: Array<{ id: string; name: string; available: boolean; skills: boolean }> }, items: OverviewItem[]) => {
        const drop = el('div'); drop.className = 'settings-skill-dropzone'; drop.tabIndex = 0; drop.setAttribute('role', 'button');
        const dropTitle = el('strong', tr('拖拽技能到这里，一键分发安装', 'Drop a skill here to distribute and install'));
        const dropHint = el('span', tr('支持单个 Markdown 文件或包含 SKILL.md 的文件夹 · 自动安装至所选 Harness', 'Supports one Markdown file or folder with SKILL.md · Installs to target Harnesses'));

        // Distribution target selector pinned into the dropzone.
        const targetRow = el('div'); targetRow.className = 'settings-skills-target-row';
        const targetLabel = el('span', tr('安装目标：', 'Target: '));
        const targetSelect = el('select'); targetSelect.setAttribute('aria-label', tr('选择目标 Harness', 'Select target Harness'));
        const allOption = el('option', tr('全部支持的 Harness', 'All supported Harnesses'));
        allOption.value = '__all__';
        targetSelect.append(allOption);
        for (const item of items) {
          if (item.harness.skills) {
            const opt = el('option', item.harness.name);
            opt.value = item.harness.id;
            targetSelect.append(opt);
          }
        }
        const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.setAttribute('webkitdirectory', '');
        const choose = button(tr('选择技能文件夹', 'Choose skill folder'), () => picker.click());
        targetRow.append(targetLabel, targetSelect, choose, picker);
        drop.append(dropTitle, dropHint, targetRow);

        const receiveOverviewFiles = async (transfer: DataTransfer | FileList) => {
          try {
            const incoming = await collectDroppedFiles(transfer);
            const parsed = await parseDroppedSkills(incoming);
            await mutateCustom(async c => {
              const { scopeType, currentCwd } = currentScopeChoice();
              const targets = targetSelect.value === '__all__'
                ? items.filter(i => i.harness.skills).map(i => i.harness)
                : items.filter(i => i.harness.id === targetSelect.value).map(i => i.harness);
              if (!targets.length) throw new Error(tr('没有可安装的目标 Harness。', 'No available target Harnesses.'));

              const successNames: string[] = [];
              const errors: string[] = [];
              for (const target of targets) {
                try {
                  await c.changeSkill({
                    harnessId: target.id,
                    scope: scopeType,
                    ...(currentCwd ? { cwd: currentCwd } : {}),
                    name: parsed.name,
                    files: parsed.files,
                    action: 'install',
                  });
                  successNames.push(target.name);
                } catch (err) {
                  errors.push(`${target.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              if (!successNames.length && errors.length) throw new Error(errors.join('; '));
              return tr(`已成功将技能【${parsed.name}】安装到：${successNames.join('、')}${errors.length ? `（跳过: ${errors.join('; ')}）` : ''}`,
                        `Successfully installed skill [${parsed.name}] to: ${successNames.join(', ')}${errors.length ? ` (Skipped: ${errors.join('; ')})` : ''}`);
            });
          } catch (error) { fail(error); }
        };

        for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => { event.preventDefault(); if (!busy) drop.dataset.dragOver = 'true'; }, { signal: lifecycle.signal });
        drop.addEventListener('dragleave', () => { delete drop.dataset.dragOver; }, { signal: lifecycle.signal });
        drop.addEventListener('drop', event => { event.preventDefault(); delete drop.dataset.dragOver; if (!busy && event.dataTransfer) void receiveOverviewFiles(event.dataTransfer); }, { signal: lifecycle.signal });
        picker.addEventListener('change', () => { if (picker.files?.length) void receiveOverviewFiles(picker.files); picker.value = ''; }, { signal: lifecycle.signal });

        const supported = items.filter(i => i.harness.skills);
        const uniqueSkills = new Map<string, Array<{ harness: { id: string; name: string }; skill: IntegrationSnapshot['skills'][number] }>>();
        for (const item of items) {
          if (!item.snapshot?.skills) continue;
          for (const s of item.snapshot.skills) {
            const list = uniqueSkills.get(s.name) || [];
            list.push({ harness: item.harness, skill: s });
            uniqueSkills.set(s.name, list);
          }
        }

        const statsBar = el('div'); statsBar.className = 'settings-skills-overview-stats';
        const statsSummary = el('span', tr(
          `📊 共 ${items.length} 个 Harness · ${supported.length} 个已配置原生技能目录 · 发现 ${uniqueSkills.size} 个去重技能`,
          `📊 ${items.length} Harnesses · ${supported.length} with native skills · ${uniqueSkills.size} unique skills found`
        ));
        statsBar.append(statsSummary);

        const toolbar = el('div'); toolbar.className = 'settings-integrations-toolbar';
        const searchInput = el('input'); searchInput.type = 'search';
        searchInput.placeholder = tr('按名称过滤技能…', 'Filter skills by name…');
        searchInput.setAttribute('aria-label', searchInput.placeholder);

        const tabsWrap = el('div'); tabsWrap.className = 'settings-skills-tabs';
        const btnByHarness = el('button', tr('按 Harness 查看', 'By Harness'));
        btnByHarness.type = 'button'; btnByHarness.className = 'settings-skills-tab-btn';
        btnByHarness.dataset.active = 'true';
        const btnBySkill = el('button', tr('按 Skill 汇总', 'By Skill'));
        btnBySkill.type = 'button'; btnBySkill.className = 'settings-skills-tab-btn';
        tabsWrap.append(btnByHarness, btnBySkill);
        toolbar.append(searchInput, tabsWrap);

        const viewsContainer = el('div'); viewsContainer.className = 'settings-skills-views';
        let activeTab: 'harness' | 'skill' = 'harness';

        const updateView = () => {
          viewsContainer.replaceChildren();
          const query = searchInput.value.trim().toLowerCase();

          if (activeTab === 'harness') {
            const grid = el('div'); grid.className = 'settings-skills-overview-grid';
            for (const item of items) {
              const allSkills = item.snapshot?.skills || [];
              const matchingSkills = query
                ? allSkills.filter(s => s.name.toLowerCase().includes(query) || s.path.toLowerCase().includes(query))
                : allSkills;

              if (query && !item.harness.name.toLowerCase().includes(query) && matchingSkills.length === 0) {
                continue;
              }

              const card = el('section'); card.className = 'settings-skills-harness-card';
              const head = el('div'); head.className = 'settings-skills-harness-head';
              const hTitle = el('strong', item.harness.name);
              const badge = el('span');
              badge.className = `settings-skills-badge ${item.harness.skills ? 'settings-skills-badge--active' : ''}`;
              badge.textContent = item.harness.skills
                ? tr(`${allSkills.length} 个技能`, `${allSkills.length} skills`)
                : tr('未配置目录', 'No native directory');
              head.append(hTitle, badge);
              card.append(head);

              if (!item.harness.skills) {
                const note = el('p', tr('此 Harness 暂未配置原生技能目录。', 'This Harness has no verified native skill directory.'));
                note.className = 'settings-mcp-notice';
                card.append(note);
              } else if (matchingSkills.length === 0) {
                const empty = el('p', query ? tr('无匹配技能', 'No matching skills') : tr('暂未安装技能', 'No skills installed'));
                empty.className = 'settings-mcp-notice';
                card.append(empty);
              } else {
                const list = el('div'); list.className = 'settings-skills-list-compact';
                for (const s of matchingSkills) {
                  const row = el('div'); row.className = 'settings-skills-item-row';
                  const info = el('div');
                  info.append(
                    el('strong', s.name),
                    el('span', s.enabled ? tr(' · 已安装', ' · Installed') : tr(' · 已停用', ' · Disabled')),
                    el('code', s.path)
                  );
                  const actions = el('div'); actions.className = 'settings-skills-item-actions';
                  if (s.writable) {
                    actions.append(button(s.enabled ? tr('停用', 'Disable') : tr('恢复', 'Restore'), () => {
                      void mutateCustom(async c => {
                        const { scopeType, currentCwd } = currentScopeChoice();
                        await c.changeSkill({
                          harnessId: item.harness.id,
                          scope: scopeType,
                          ...(currentCwd ? { cwd: currentCwd } : {}),
                          name: s.name,
                          root: s.root,
                          action: s.enabled ? 'disable' : 'enable',
                        });
                      });
                    }));
                  }
                  const otherSupported = supported.filter(h => h.harness.id !== item.harness.id);
                  if (otherSupported.length > 0) {
                    const syncBtn = button(tr('同步…', 'Sync…'), () => {
                      showSyncDialog(s, item.harness, otherSupported.map(h => h.harness));
                    });
                    actions.append(syncBtn);
                  }
                  row.append(info, actions);
                  list.append(row);
                }
                card.append(list);
              }
              grid.append(card);
            }
            viewsContainer.append(grid);
          } else {
            const matrixList = el('div'); matrixList.className = 'settings-skills-matrix-list';
            let matchedCount = 0;
            for (const [skillName, installations] of uniqueSkills.entries()) {
              if (query && !skillName.toLowerCase().includes(query) && !installations.some(i => i.skill.path.toLowerCase().includes(query))) {
                continue;
              }
              matchedCount++;
              const card = el('section'); card.className = 'settings-skills-matrix-card';
              const head = el('div'); head.className = 'settings-skills-matrix-head';
              head.append(
                el('strong', skillName),
                el('span', tr(`已在 ${installations.length} 个 Harness 安装`, `Installed in ${installations.length} harnesses`))
              );

              const tags = el('div'); tags.className = 'settings-skills-tags';
              for (const inst of installations) {
                const tag = el('span'); tag.className = 'settings-skills-tag';
                tag.textContent = `✓ ${inst.harness.name}${inst.skill.enabled ? '' : tr(' (已停用)', ' (disabled)')}`;
                tags.append(tag);
              }

              const installedIds = new Set(installations.map(i => i.harness.id));
              const missingHarnesses = supported.filter(h => !installedIds.has(h.harness.id));

              const syncRow = el('div'); syncRow.className = 'settings-skills-sync-actions';
              if (missingHarnesses.length > 0) {
                const label = el('span', tr('未安装于：', 'Not installed in: '));
                label.style.fontSize = '11px'; label.style.color = 'var(--settings-muted)';
                syncRow.append(label);

                const sourceSkill = installations[0]!.skill;
                const sourceDir = sourceSkill.path.replace(/[/\\][^/\\]+$/, '');

                for (const missing of missingHarnesses) {
                  const installBtn = button(`+ ${missing.harness.name}`, () => {
                    void mutateCustom(async c => {
                      const { scopeType, currentCwd } = currentScopeChoice();
                      await c.changeSkill({
                        harnessId: missing.harness.id,
                        scope: scopeType,
                        ...(currentCwd ? { cwd: currentCwd } : {}),
                        name: skillName,
                        source: sourceDir,
                        action: 'install',
                      });
                      return tr(`已将【${skillName}】同步安装到 ${missing.harness.name}。`, `Installed [${skillName}] to ${missing.harness.name}.`);
                    });
                  });
                  syncRow.append(installBtn);
                }

                if (missingHarnesses.length > 1) {
                  const installAllBtn = button(tr('一键同步到全部', 'Sync to all'), () => {
                    void mutateCustom(async c => {
                      const { scopeType, currentCwd } = currentScopeChoice();
                      const successes: string[] = [];
                      for (const missing of missingHarnesses) {
                        try {
                          await c.changeSkill({
                            harnessId: missing.harness.id,
                            scope: scopeType,
                            ...(currentCwd ? { cwd: currentCwd } : {}),
                            name: skillName,
                            source: sourceDir,
                            action: 'install',
                          });
                          successes.push(missing.harness.name);
                        } catch { /* skip unreachable harnesses */ }
                      }
                      return tr(`已将【${skillName}】同步安装到：${successes.join('、')}。`, `Synced [${skillName}] to: ${successes.join(', ')}.`);
                    });
                  }, true);
                  syncRow.append(installAllBtn);
                }
              } else {
                const complete = el('span', tr('已在所有支持的 Harness 中就绪', 'Ready across all supported Harnesses'));
                complete.style.fontSize = '11px'; complete.style.color = '#10a37f';
                syncRow.append(complete);
              }

              card.append(head, tags, syncRow);
              matrixList.append(card);
            }
            if (matchedCount === 0) {
              const empty = el('div', tr('未匹配到任何技能。', 'No skills matched the search.'));
              empty.className = 'settings-integrations-empty';
              matrixList.append(empty);
            }
            viewsContainer.append(matrixList);
          }
        };

        btnByHarness.addEventListener('click', () => {
          activeTab = 'harness';
          btnByHarness.dataset.active = 'true';
          delete btnBySkill.dataset.active;
          updateView();
        }, { signal: lifecycle.signal });

        btnBySkill.addEventListener('click', () => {
          activeTab = 'skill';
          btnBySkill.dataset.active = 'true';
          delete btnByHarness.dataset.active;
          updateView();
        }, { signal: lifecycle.signal });

        searchInput.addEventListener('input', () => {
          updateView();
        }, { signal: lifecycle.signal });

        updateView();
        body.append(drop, statsBar, toolbar, viewsContainer);
      };

      const render = (snapshot: IntegrationSnapshot) => { body.replaceChildren(); if (kind === 'mcp') renderMcp(snapshot); else renderSkills(snapshot); };

      const refresh = async () => {
        if (busy || lifecycle.disposed) return;
        if (level.value === 'project' && !cwd.value.trim()) { body.replaceChildren(); status.textContent = tr('填写项目路径后即可读取。', 'Enter the project path to continue.'); cwd.focus(); return; }
        setBusy(true); status.textContent = tr('正在读取…', 'Loading…'); status.setAttribute('role', 'status');
        if (harness.value === '__all__') {
          // Overview mode: gather every harness's snapshot, tolerating
          // individual failures so one broken harness doesn't blank the page.
          await lifecycle.runLatest(async () => {
            const catalog = await client().integrationCatalog();
            const { scopeType, currentCwd } = currentScopeChoice();
            const items = await Promise.all(
              catalog.harnesses.map(async h => {
                try {
                  const snap = await client().listIntegrations({
                    harnessId: h.id,
                    scope: scopeType,
                    ...(currentCwd ? { cwd: currentCwd } : {}),
                  });
                  return { harness: h, snapshot: snap, error: null };
                } catch (err) {
                  return { harness: h, snapshot: null, error: err instanceof Error ? err.message : String(err) };
                }
              })
            );
            return { catalog, items };
          }, {
            success: data => {
              body.replaceChildren();
              if (kind === 'mcp') {
                renderMcpOverview(data.catalog, data.items);
              } else {
                renderSkillsOverview(data.catalog, data.items);
              }
              status.textContent = '';
            },
            failure: fail,
          });
        } else {
          await lifecycle.runLatest(() => client().listIntegrations(selectedScope()), { success: data => { render(data); status.textContent = ''; }, failure: fail });
        }
        if (!lifecycle.disposed) setBusy(false);
      };

      refreshButton.addEventListener('click', () => { void refresh(); }, { signal: lifecycle.signal });
      controls.append(harness, level, cwd, refreshButton); content.append(title, note, controls, status, body);
      harness.addEventListener('change', () => { void refresh(); }, { signal: lifecycle.signal });
      level.addEventListener('change', () => { cwd.hidden = level.value !== 'project'; void refresh(); }, { signal: lifecycle.signal });
      cwd.addEventListener('change', () => { void refresh(); }, { signal: lifecycle.signal });

      // Populate the harness selector, then run the first load.
      void lifecycle.runLatest(() => client().integrationCatalog(), { success: data => {
        const allOption = el('option', tr('全部 Harness（总览）', 'All Harnesses (Overview)'));
        allOption.value = '__all__';
        harness.append(allOption);
        for (const item of data.harnesses) {
          const option = el('option', `${item.name}${item.available ? '' : tr(' · 未就绪', ' · not ready')}`);
          option.value = item.id;
          harness.append(option);
        }
        void refresh();
      }, failure: fail });
      return undefined;
    },
  });
}

export const createMcpSettingsPage = (messages: RendererSettingsMessages, getClient: () => RendererIntegrationsClient | null) => createIntegrationSettingsPage('mcp', messages, getClient);
export const createSkillsSettingsPage = (messages: RendererSettingsMessages, getClient: () => RendererIntegrationsClient | null) => createIntegrationSettingsPage('skills', messages, getClient);
