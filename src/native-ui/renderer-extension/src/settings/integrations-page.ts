import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from './core.js';
import type { RendererSettingsMessages } from './localization.js';
import type { RendererIntegrationsClient, IntegrationSnapshot, IntegrationScope } from '../renderer-integrations-client.js';

export function createIntegrationsSettingsPage(messages: RendererSettingsMessages, getClient: () => RendererIntegrationsClient | null): RendererSettingsPageDefinition {
  const zh = messages.locale === 'zh-CN';
  const tr = (cn: string, en: string) => zh ? cn : en;
  return Object.freeze({
    id: 'integrations', label: 'MCP / Skills', icon: 'connections',
    mount(context: RendererSettingsPageMountContext) {
      const { content } = context;
      const lifecycle = { signal: context.signal, runLatest: context.runLatest, get disposed() { return context.signal.aborted; } };
      const doc = content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = doc.createElement(tag); node.textContent = text; return node; };
      const title = el('h2', 'MCP / Skills');
      const note = el('p', tr('为每个 Harness 配置工具与技能。变更在下次打开原生会话时生效；正在运行的会话保持当前配置。', 'Configure tools and skills per Harness. Changes apply the next time a native session opens; running sessions keep their configuration.'));
      note.className = 'settings-page-description';
      const controls = el('div'); controls.className = 'settings-integrations-controls';
      const harness = el('select'); harness.setAttribute('aria-label', 'Harness');
      const level = el('select'); level.setAttribute('aria-label', tr('作用范围', 'Scope'));
      for (const [value, label] of [['global', tr('全局', 'Global')], ['project', tr('项目', 'Project')]]) { const option = el('option', label); option.value = value!; level.append(option); }
      const cwd = el('input'); cwd.placeholder = tr('项目绝对路径', 'Absolute project path'); cwd.setAttribute('aria-label', cwd.placeholder); cwd.hidden = true;
      const body = el('div'); body.className = 'settings-integrations-body';
      const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      let busy = false;
      const button = (label: string, action: () => void) => { const b = el('button', label); b.type = 'button'; b.className = 'settings-command-button settings-command-button--secondary'; b.addEventListener('click', action, { signal: lifecycle.signal }); return b; };
      const input = (): IntegrationScope => ({ harnessId: harness.value, scope: level.value === 'project' ? 'project' : 'global', ...(level.value === 'project' ? { cwd: cwd.value.trim() } : {}) });
      const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); status.setAttribute('role', 'alert'); };
      const client = () => { const c = getClient(); if (!c) throw new Error(tr('Host 尚未连接，请连接后刷新。', 'Host is not connected. Connect and refresh.')); return c; };
      const setBusy = (value: boolean) => { busy = value; for (const node of content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) node.disabled = value || node.dataset.readonly === 'true'; };
      const refresh = async () => {
        if (busy || lifecycle.disposed) return;
        setBusy(true); status.textContent = tr('正在读取…', 'Loading…');
        await lifecycle.runLatest(() => client().listIntegrations(input()), { success: data => { render(data); status.textContent = ''; }, failure: fail });
        if (!lifecycle.disposed) setBusy(false);
      };
      const mutate = async (operation: (c: RendererIntegrationsClient, selected: IntegrationScope) => Promise<unknown>) => {
        if (busy) return;
        const selected = input(); setBusy(true);
        try { await operation(client(), selected); if (!lifecycle.disposed) { setBusy(false); await refresh(); status.textContent = tr('已保存，下次打开原生会话时生效。', 'Saved. Applies on the next native session open.'); } }
        catch (error) { if (!lifecycle.disposed) { setBusy(false); fail(error); } }
      };
      const field = (form: HTMLElement, label: string, node: HTMLElement) => { const wrap = el('label', label); wrap.className = 'settings-integrations-field'; wrap.append(node); form.append(wrap); };
      const render = (snapshot: IntegrationSnapshot) => {
        body.replaceChildren();
        body.append(el('h3', 'MCP'));
        for (const native of snapshot.native) {
          const row = el('section'); row.className = 'settings-integrations-row';
          row.append(el('strong', `${tr('原生报告', 'Native report')} · ${native.name || native.sessionId} · ${native.status}`), el('code', native.tools.join(', ')));
          body.append(row);
        }
        body.append(el('p', snapshot.mcpSupported ? tr('本页管理的 stdio 服务会传入原生 Harness。保留原有 MCP 配置；认证由原生环境管理。', 'Managed stdio servers are passed to the native Harness. Existing MCP configuration is retained; authentication stays in the native environment.') : tr('此 Harness 尚无已接入的原生 MCP 配置接口。', 'No supported native MCP configuration interface for this Harness.')));
        for (const server of snapshot.servers) {
          const row = el('section'); row.className = 'settings-integrations-row';
          const detail = el('div');
          detail.append(el('strong', server.name), el('p', `${server.scope === 'global' ? tr('全局', 'Global') : tr('项目', 'Project')} · ${!server.effective ? tr('被项目配置覆盖', 'Overridden by project') : !server.enabled ? tr('已停用', 'Disabled') : server.appliedSessions ? tr(`已传入 ${server.appliedSessions} 个会话（连接状态未报告）`, `Passed to ${server.appliedSessions} sessions (connection unreported)`) : tr('已配置，尚未传入会话', 'Configured; not yet passed to a session')}`), el('code', `${server.command} ${JSON.stringify(server.args)}`));
          row.append(detail);
          if (server.editable) {
            row.append(button(server.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable'), () => { void mutate((c, selected) => c.saveMcp({ ...selected, server: { name: server.name, command: server.command, args: server.args, enabled: !server.enabled } })); }),
              button(tr('编辑', 'Edit'), () => { name.value = server.name; command.value = server.command; args.value = JSON.stringify(server.args, null, 2); name.focus(); }),
              button(tr('移除配置', 'Remove'), () => { void mutate((c, selected) => c.removeMcp({ ...selected, id: server.id })); }));
          }
          body.append(row);
        }
        const form = el('form'); form.className = 'settings-integrations-form';
        const name = el('input'); name.required = true; name.pattern = '[a-zA-Z0-9](?:[a-zA-Z0-9_]|-){0,63}';
        const command = el('input'); command.required = true; command.placeholder = tr('可执行文件，如 node', 'Executable, e.g. node');
        const args = el('textarea'); args.value = '[]'; args.rows = 3;
        if (snapshot.mcpSupported) {
          field(form, tr('服务名称（同名保存即更新）', 'Server name (save the same name to update)'), name);
          field(form, tr('可执行文件', 'Executable'), command); field(form, tr('参数（JSON 字符串数组；不要填写密钥）', 'Arguments (JSON string array; no credentials)'), args);
          const save = button(tr('保存 MCP', 'Save MCP'), () => {}); save.type = 'submit'; form.append(save);
          form.addEventListener('submit', event => { event.preventDefault(); try { const parsed: unknown = JSON.parse(args.value); if (!Array.isArray(parsed) || !parsed.every(a => typeof a === 'string')) throw new Error(tr('参数必须是字符串数组', 'Arguments must be a string array')); const server = { name: name.value.trim(), command: command.value.trim(), args: parsed as string[], enabled: true }; void mutate((c, selected) => c.saveMcp({ ...selected, server })); } catch (error) { fail(error); } }, { signal: lifecycle.signal });
          body.append(form);
        }
        body.append(el('h3', 'Skills'), el('p', snapshot.skillsSupported ? tr('从原生技能目录发现，不代表当前会话已加载。停用会保留文件；共享目录的变更会影响所有读取该目录的 Harness。', 'Discovered in native skill directories, not necessarily loaded in the current session. Disabling retains files. Changes to shared directories affect every Harness that reads them.') : tr('此 Harness 的原生技能目录尚未确认，暂不写入。', 'Native skill directories are not yet verified for this Harness.')));
        for (const skill of snapshot.skills) {
          const row = el('section'); row.className = 'settings-integrations-row';
          const detail = el('div'); detail.append(el('strong', skill.name), el('p', skill.enabled ? tr('已发现 · 加载状态未报告', 'Discovered · load status unreported') : tr('已停用 · 文件已保留', 'Disabled · files retained')), el('code', skill.path)); row.append(detail);
          if (skill.writable) row.append(button(skill.enabled ? tr('停用', 'Disable') : tr('恢复', 'Restore'), () => { void mutate((c, selected) => c.changeSkill({ ...selected, name: skill.name, root: skill.root, action: skill.enabled ? 'disable' : 'enable' })); }));
          else row.append(el('span', tr('链接目录，只读', 'Linked directory, read-only')));
          body.append(row);
        }
        if (snapshot.skillsSupported) {
          const install = el('form'); install.className = 'settings-integrations-form';
          const source = el('input'); source.required = true; source.placeholder = tr('包含 SKILL.md 的本地目录', 'Local directory containing SKILL.md');
          const skillName = el('input'); skillName.required = true;
          field(install, tr('技能名称', 'Skill name'), skillName); field(install, tr('源目录绝对路径', 'Absolute source directory'), source);
          const save = button(tr('安装到当前 Harness', 'Install for this Harness'), () => {}); save.type = 'submit'; install.append(save);
          install.addEventListener('submit', event => { event.preventDefault(); const change = { name: skillName.value.trim(), source: source.value.trim(), action: 'install' as const }; void mutate((c, selected) => c.changeSkill({ ...selected, ...change })); }, { signal: lifecycle.signal }); body.append(install);
        }
      };
      const reload = button(tr('刷新', 'Refresh'), () => { void refresh(); });
      controls.append(harness, level, cwd, reload); content.append(title, note, controls, status, body);
      harness.addEventListener('change', () => { void refresh(); }, { signal: lifecycle.signal });
      level.addEventListener('change', () => { cwd.hidden = level.value !== 'project'; body.replaceChildren(); if (!cwd.hidden && !cwd.value) { cwd.focus(); status.textContent = tr('填写项目路径，然后刷新。', 'Enter the project path, then refresh.'); } else void refresh(); }, { signal: lifecycle.signal });
      cwd.addEventListener('change', () => { void refresh(); }, { signal: lifecycle.signal });
      void lifecycle.runLatest(() => client().integrationCatalog(), { success: data => { for (const item of data.harnesses) { const option = el('option', `${item.name}${item.available ? '' : tr(' · 未就绪', ' · not ready')}`); option.value = item.id; harness.append(option); } void refresh(); }, failure: fail });
      return undefined;
    },
  });
}
