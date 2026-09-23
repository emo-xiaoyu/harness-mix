import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "./core.js";
import { createHarnessIconElement } from "./harness-icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCollaborationPreferences {
  collaboration: boolean;
  agentTeam: boolean;
}

export interface RendererTeamTemplateMember {
  name: string;
  role: string;
  agent: string;
}

export interface RendererTeamTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  builtin?: boolean;
  members: Array<RendererTeamTemplateMember & { available: boolean }>;
}

export interface RendererCollaborationClient {
  getCollaborationPreferences(): Promise<RendererCollaborationPreferences>;
  saveCollaborationPreferences(
    input: Partial<RendererCollaborationPreferences>,
  ): Promise<RendererCollaborationPreferences>;
  listTeamTemplates?: (() => Promise<unknown>) | undefined;
  saveTeamTemplate?: ((input: { id?: string; name: string; description?: string; members: RendererTeamTemplateMember[] }) => Promise<unknown>) | undefined;
  deleteTeamTemplate?: ((id: string) => Promise<unknown>) | undefined;
  restoreTeamTemplates?: (() => Promise<unknown>) | undefined;
  listAgents?: (() => Promise<Array<{ id: string; name: string; available: boolean }>>) | undefined;
}

interface ToggleSpec {
  readonly key: keyof RendererCollaborationPreferences;
  readonly title: string;
  readonly description: string;
}

interface MemberDraft {
  name: string;
  role: string;
  agent: string;
}

interface TemplateDraft {
  id?: string;
  name: string;
  description: string;
  members: MemberDraft[];
}

const MAX_TEMPLATE_MEMBERS = 6;

function templateDraftFrom(template: RendererTeamTemplate): TemplateDraft {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    members: template.members.map(member => ({ name: member.name, role: member.role, agent: member.agent })),
  };
}

function emptyTemplateDraft(): TemplateDraft {
  return { name: '', description: '', members: [{ name: '', role: '', agent: '' }] };
}

// 设置 → 协作：多 Agent 协作与 Agent Team 是两个独立开关，默认都开启。
// 关闭多 Agent 协作会一并停用 Agent Team（团队建立在协作运行时之上），
// 界面通过禁用联动明确表达这层依赖。页面下半部是团队模板管理器：
// 为每个成员自定义 Harness 与角色职责，输入框 # 菜单的「团队」页签一键按编成拉起团队。
export function createCollaborationSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCollaborationClient | null,
): RendererSettingsPageDefinition {
  const zh = messages.locale === "zh-CN";
  return Object.freeze({
    id: "collaboration",
    label: messages.pageLabels.collaboration,
    icon: "collaboration",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.collaboration;

      const panel = document.createElement("section");
      panel.className = "settings-about-panel";
      panel.setAttribute("aria-live", "polite");

      const specs: readonly ToggleSpec[] = [
        {
          key: "collaboration",
          title: zh ? "多 Agent 协作" : "Multi-Agent collaboration",
          description: zh
            ? "在输入框输入 # 选择协同 Harness，主任务可将子任务委派给它们并行执行。"
            : "Type # in the composer to pick collaborator Harnesses; the lead task can delegate subtasks to them.",
        },
        {
          key: "agentTeam",
          title: zh ? "Agent Team" : "Agent Team",
          description: zh
            ? "允许主任务创建持久的多成员团队：共享任务图、成员邮箱与 Team Workbench。依赖多 Agent 协作。"
            : "Let the lead create a persistent named team with a shared task graph, member mailboxes and the Team Workbench. Requires Multi-Agent collaboration.",
        },
      ];

      const inputs = new Map<keyof RendererCollaborationPreferences, HTMLInputElement>();
      for (const spec of specs) {
        const row = document.createElement("label");
        row.className = "settings-collab-toggle";
        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = spec.title;
        const description = document.createElement("small");
        description.textContent = spec.description;
        text.append(title, description);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.disabled = true;
        input.setAttribute("aria-label", spec.title);
        inputs.set(spec.key, input);
        row.append(text, input);
        panel.append(row);
      }

      const status = document.createElement("p");
      status.className = "settings-update-summary";
      panel.append(status);
      context.content.append(heading, panel);

      let current: RendererCollaborationPreferences = { collaboration: true, agentTeam: true };
      const syncInputs = () => {
        for (const [key, input] of inputs) input.checked = current[key];
        // Agent Team 依附于协作运行时：协作关闭时团队开关一并禁用
        const team = inputs.get("agentTeam");
        if (team) team.disabled = !current.collaboration;
      };

      const client = getClient();
      if (!client) {
        status.textContent = zh ? "当前 Host 不支持协作开关。" : "Collaboration preferences are unavailable on this Host.";
        return undefined;
      }

      const saving = new Set<keyof RendererCollaborationPreferences>();
      for (const spec of specs) {
        const input = inputs.get(spec.key)!;
        input.addEventListener("change", () => {
          if (saving.has(spec.key)) return;
          saving.add(spec.key);
          input.disabled = true;
          const patch = { [spec.key]: input.checked };
          void context.runLatest(() => client.saveCollaborationPreferences(patch), {
            success(value) {
              saving.delete(spec.key);
              current = value;
              syncInputs();
              status.textContent = "";
            },
            failure(error) {
              saving.delete(spec.key);
              syncInputs();
              status.textContent = error instanceof Error ? error.message : String(error);
            },
          });
        });
      }

      // 偏好读取独占本页唯一的 runLatest 通道（latest-wins 只用于偏好本身）。
      // 团队模板与 Harness 目录改用直连 Promise（见 mountTeamTemplatesSection），
      // 否则挂载期的三次 runLatest 互相踩踏，最后的调用会中止前面所有在途请求，
      // 导致模板列表或 Harness 下拉随机变为空白。
      void context.runLatest(() => client.getCollaborationPreferences(), {
        success(value) {
          current = value;
          syncInputs();
        },
        failure(error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        },
      });

      mountTeamTemplatesSection(context, client, zh);
      return undefined;
    },
  });
}

function mountTeamTemplatesSection(
  context: RendererSettingsPageMountContext,
  client: RendererCollaborationClient,
  zh: boolean,
): void {
  if (!client.listTeamTemplates || !client.saveTeamTemplate || !client.deleteTeamTemplate) return;
  const document = context.content.ownerDocument;
  const section = document.createElement('section');
  section.className = 'settings-about-panel';
  section.style.marginTop = '18px';
  const title = document.createElement('strong');
  title.style.display = 'block';
  title.style.fontSize = '15px';
  title.textContent = zh ? '团队模板' : 'Team templates';
  const intro = document.createElement('p');
  intro.className = 'settings-update-summary';
  intro.textContent = zh
    ? '为常见协作预先定义成员编成（每个成员可指定任意 Harness 与自定义职责）。已内置 6 套通用模板：点「编辑」为成员换上你安装的 Harness 即可使用。在任务输入框输入 #，切到「团队」页签选择模板，追加一句目标后发送，即可按编成创建 Agent Team。'
    : 'Pre-define member rosters (any Harness with a custom role per member). Six universal rosters are built in: open one and assign your installed Harnesses. Type # in the composer, pick the roster from the Team tab, append a goal, and send to create the Agent Team.';
  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '10px';
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  error.style.color = 'var(--settings-danger, #ef6666)';
  error.style.margin = '0';
  error.style.fontSize = '12px';
  const actions = document.createElement('div');
  actions.className = 'settings-update-actions';
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'settings-command-button';
  create.textContent = zh ? '新建模板' : 'New template';
  // Harness 目录异常的行内提示 + 重试：宁可显式报错，也不给一个沉默空白的下拉框
  const agentsNotice = document.createElement('span');
  agentsNotice.style.fontSize = '12px';
  agentsNotice.style.color = 'var(--settings-danger, #ef6666)';
  agentsNotice.hidden = true;
  const retryAgents = document.createElement('button');
  retryAgents.type = 'button';
  retryAgents.className = 'settings-command-button settings-command-button--secondary';
  retryAgents.textContent = zh ? '重试' : 'Retry';
  retryAgents.hidden = true;
  const restoreBuiltins = document.createElement('button');
  restoreBuiltins.type = 'button';
  restoreBuiltins.className = 'settings-command-button settings-command-button--secondary';
  restoreBuiltins.textContent = zh ? '恢复内置模板' : 'Restore built-ins';
  restoreBuiltins.title = zh ? '补回被删除的内置通用模板（你改造过的同名模板保持原样）' : 'Re-add deleted built-in templates (customized ones are left untouched)';
  restoreBuiltins.hidden = !client.restoreTeamTemplates;
  restoreBuiltins.addEventListener('click', () => {
    if (busy || !client.restoreTeamTemplates) return;
    busy = true;
    void client.restoreTeamTemplates().then(
      () => { busy = false; if (!context.signal.aborted) void reload(); },
      failure => { busy = false; if (!context.signal.aborted) showError(failure instanceof Error ? failure.message : String(failure)); },
    );
  });
  actions.append(create, agentsNotice, retryAgents, restoreBuiltins);
  const editor = document.createElement('div');
  section.append(title, intro, list, error, actions, editor);
  context.content.append(section);

  let agents: Array<{ id: string; name: string; available: boolean }> = [];
  let agentsIssue: string | null = null;
  let templates: RendererTeamTemplate[] = [];
  let draft: TemplateDraft | null = null;
  let busy = false;

  const showError = (message: string) => { error.hidden = false; error.textContent = message; };
  const agentById = (id: string) => agents.find(agent => agent.id === id);
  const agentDisplayName = (id: string) => agentById(id)?.name ?? id;

  const renderAgentsNotice = () => {
    agentsNotice.hidden = !agentsIssue;
    retryAgents.hidden = !agentsIssue;
    if (agentsIssue) agentsNotice.textContent = agentsIssue;
  };

  // 模板与 Harness 目录加载不走 runLatest（那是 latest-wins，会中止同页其它在途请求），
  // 而是直连 Promise + 页面关闭守卫（context.signal.aborted），与 pet-market 的
  // selection() 旁路加载同一模式：模板与目录互不踩踏，各自可靠落地。
  const loadAgents = () => {
    if (!client.listAgents) {
      agentsIssue = zh
        ? '当前 Host 未提供 Harness 目录，成员只能沿用已保存的 Harness。'
        : 'This Host does not expose a Harness catalog; members keep stored Harness ids.';
      renderAgentsNotice();
      return;
    }
    agentsIssue = null;
    renderAgentsNotice();
    void client.listAgents!().then(
      value => {
        if (context.signal.aborted) return;
        agents = Array.isArray(value) ? value.filter(agent => agent && typeof agent.id === 'string') : [];
        if (!agents.length) {
          agentsIssue = zh
            ? '没有可选的 Harness，请重试或检查 Harness 安装状态。'
            : 'No selectable Harnesses. Retry or check Harness installation.';
        }
        renderAgentsNotice();
        if (draft) renderEditor(); // 编辑器先于目录打开时，补齐下拉选项
      },
      failure => {
        if (context.signal.aborted) return;
        agents = [];
        agentsIssue = `${zh ? 'Harness 目录加载失败：' : 'Failed to load the Harness catalog: '}${failure instanceof Error ? failure.message : String(failure)}`;
        renderAgentsNotice();
      },
    );
  };

  const renderList = () => {
    list.replaceChildren();
    if (!templates.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-update-summary';
      empty.textContent = zh ? '暂无模板，点击「新建模板」定义第一套编成。' : 'No templates yet. Create one to define your first roster.';
      list.append(empty);
      return;
    }
    for (const template of templates) {
      const card = document.createElement('article');
      card.style.display = 'flex';
      card.style.alignItems = 'flex-start';
      card.style.justifyContent = 'space-between';
      card.style.gap = '14px';
      card.style.padding = '12px 14px';
      card.style.border = '1px solid var(--settings-border, color-mix(in srgb, CanvasText 14%, transparent))';
      card.style.borderRadius = '10px';
      card.style.background = 'color-mix(in srgb, CanvasText 3%, transparent)';
      const text = document.createElement('div');
      text.style.display = 'grid';
      text.style.gap = '5px';
      text.style.minWidth = '0';
      const nameRow = document.createElement('div');
      nameRow.style.display = 'flex';
      nameRow.style.alignItems = 'center';
      nameRow.style.gap = '8px';
      nameRow.style.flexWrap = 'wrap';
      const name = document.createElement('strong');
      name.style.fontSize = '13px';
      name.textContent = template.name;
      nameRow.append(name);
      if (template.builtin) {
        const builtinBadge = document.createElement('span');
        builtinBadge.textContent = zh ? '内置' : 'Built-in';
        builtinBadge.style.fontSize = '10px';
        builtinBadge.style.padding = '1px 6px';
        builtinBadge.style.borderRadius = '999px';
        builtinBadge.style.border = '1px solid color-mix(in srgb, CanvasText 18%, transparent)';
        builtinBadge.style.color = 'var(--settings-muted, inherit)';
        builtinBadge.style.whiteSpace = 'nowrap';
        nameRow.append(builtinBadge);
      }
      const usage = document.createElement('code');
      usage.textContent = `# ${template.name} [目标]`;
      usage.style.fontSize = '11px';
      usage.style.padding = '1px 6px';
      usage.style.borderRadius = '5px';
      usage.style.background = 'color-mix(in srgb, CanvasText 8%, transparent)';
      usage.style.whiteSpace = 'nowrap';
      nameRow.append(name, usage);
      text.append(nameRow);
      if (template.description) {
        const description = document.createElement('small');
        description.style.color = 'var(--settings-muted, inherit)';
        description.style.fontSize = '12px';
        description.style.lineHeight = '18px';
        description.textContent = template.description;
        text.append(description);
      }
      for (const member of template.members) {
        const memberLine = document.createElement('small');
        memberLine.style.display = 'flex';
        memberLine.style.alignItems = 'center';
        memberLine.style.gap = '6px';
        memberLine.style.flexWrap = 'wrap';
        memberLine.style.fontSize = '12px';
        memberLine.style.lineHeight = '18px';
        memberLine.style.color = 'var(--settings-muted, inherit)';
        const icon = createHarnessIconElement(document, member.agent, agentDisplayName(member.agent), 14);
        icon.style.flex = 'none';
        if (member.agent) icon.title = agentDisplayName(member.agent);
        const label = document.createElement('span');
        // 内置模板成员可以暂不指定 Harness（待用户换上自己安装的 Harness），此时
        // 显式标注「待指定」而不是展示一个空的未知 id
        label.textContent = !member.agent
          ? `${member.name} · ${zh ? '待指定 Harness' : 'no harness yet'} — ${member.role}`
          : `${member.name} · ${agentDisplayName(member.agent)}${member.available ? '' : zh ? '（当前不可用）' : ' (unavailable)'} — ${member.role}`;
        memberLine.append(icon, label);
        text.append(memberLine);
      }
      const buttons = document.createElement('span');
      buttons.style.display = 'flex';
      buttons.style.gap = '6px';
      buttons.style.flexShrink = '0';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'settings-command-button settings-command-button--secondary';
      edit.textContent = zh ? '编辑' : 'Edit';
      edit.addEventListener('click', () => { draft = templateDraftFrom(template); renderEditor(); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-command-button settings-command-button--secondary';
      remove.textContent = zh ? '删除' : 'Delete';
      remove.addEventListener('click', () => {
        if (busy) return;
        const confirmText = template.builtin && client.restoreTeamTemplates
          ? (zh ? `删除内置模板「${template.name}」？之后可通过「恢复内置模板」找回。` : `Delete built-in template "${template.name}"? It can be restored later via "Restore built-ins".`)
          : (zh ? `删除团队模板「${template.name}」？` : `Delete team template "${template.name}"?`);
        if (!window.confirm(confirmText)) return;
        busy = true;
        void client.deleteTeamTemplate!(template.id).then(
          () => { busy = false; if (!context.signal.aborted) void reload(); },
          failure => { busy = false; if (!context.signal.aborted) showError(failure instanceof Error ? failure.message : String(failure)); },
        );
      });
      buttons.append(edit, remove);
      card.append(text, buttons);
      list.append(card);
    }
  };

  const inputChrome = 'height: 32px; padding: 0 10px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 6px; background: Canvas; color: CanvasText;';

  // <option> 内不能放图片：Harness 品牌图标渲染在 select 旁的独立徽标位，
  // 并随选择变化即时刷新（createHarnessIconElement 自带未知 id 的首字母回退）。
  const renderHarnessBadge = (badge: HTMLElement, agentId: string) => {
    badge.replaceChildren(createHarnessIconElement(document, agentId, agentDisplayName(agentId), 16));
  };

  const renderEditor = () => {
    editor.replaceChildren();
    error.hidden = true;
    if (!draft) return;
    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '10px';
    form.style.padding = '14px';
    form.style.border = '1px solid var(--settings-border, color-mix(in srgb, CanvasText 14%, transparent))';
    form.style.borderRadius = '10px';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = zh ? '模板名称（必填，1-80 字符）' : 'Template name (required, 1-80 chars)';
    nameInput.value = draft.name;
    nameInput.style.cssText = inputChrome;
    nameInput.addEventListener('input', () => { draft!.name = nameInput.value; });

    const descriptionInput = document.createElement('input');
    descriptionInput.type = 'text';
    descriptionInput.placeholder = zh ? '描述 / 缺省团队目标（可选）' : 'Description / default goal (optional)';
    descriptionInput.value = draft.description;
    descriptionInput.style.cssText = inputChrome;
    descriptionInput.addEventListener('input', () => { draft!.description = descriptionInput.value; });

    const membersBox = document.createElement('div');
    membersBox.style.display = 'flex';
    membersBox.style.flexDirection = 'column';
    membersBox.style.gap = '8px';

    const renderMembers = () => {
      membersBox.replaceChildren();
      const current = draft!;
      current.members.forEach((member, index) => {
        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = 'minmax(170px, 1.4fr) minmax(96px, 1fr) minmax(150px, 2fr) auto';
        row.style.gap = '6px';
        row.style.alignItems = 'center';
        const harnessField = document.createElement('div');
        harnessField.style.display = 'flex';
        harnessField.style.alignItems = 'center';
        harnessField.style.gap = '6px';
        harnessField.style.minWidth = '0';
        const select = document.createElement('select');
        select.style.cssText = inputChrome;
        select.style.flex = '1';
        select.style.minWidth = '0';
        select.appendChild(new Option(zh ? '选择 Harness…' : 'Harness…', '', true, !member.agent));
        for (const agent of agents) {
          select.appendChild(new Option(agent.available ? agent.name : `${agent.name} (${zh ? '不可用' : 'unavailable'})`, agent.id, false, member.agent === agent.id));
        }
        if (member.agent && !agents.some(agent => agent.id === member.agent)) {
          // 自由回退：目录里不存在的 Harness id 仍保留为选项（老 Host / 已卸载的 Harness）
          select.appendChild(new Option(member.agent, member.agent, true, true));
        }
        const badge = document.createElement('span');
        badge.style.display = 'inline-flex';
        badge.style.alignItems = 'center';
        badge.style.justifyContent = 'center';
        badge.style.width = '26px';
        badge.style.height = '26px';
        badge.style.flex = 'none';
        badge.style.borderRadius = '6px';
        badge.style.border = '1px solid color-mix(in srgb, CanvasText 12%, transparent)';
        badge.style.background = 'color-mix(in srgb, CanvasText 4%, transparent)';
        badge.title = member.agent ? agentDisplayName(member.agent) : (zh ? '待指定 Harness' : 'No harness selected');
        const syncBadge = () => { renderHarnessBadge(badge, select.value); };
        select.addEventListener('change', () => { draft!.members[index]!.agent = select.value; syncBadge(); });
        syncBadge();
        harnessField.append(select, badge);
        const nameField = document.createElement('input');
        nameField.type = 'text';
        nameField.placeholder = zh ? '成员名称' : 'Member name';
        nameField.value = member.name;
        nameField.style.cssText = inputChrome;
        nameField.addEventListener('input', () => { draft!.members[index]!.name = nameField.value; });
        const roleField = document.createElement('input');
        roleField.type = 'text';
        roleField.placeholder = zh ? '角色职责（自定义，进入团队指令）' : 'Role (custom, enters the team instruction)';
        roleField.value = member.role;
        roleField.style.cssText = inputChrome;
        roleField.addEventListener('input', () => { draft!.members[index]!.role = roleField.value; });
        const removeMember = document.createElement('button');
        removeMember.type = 'button';
        removeMember.className = 'settings-command-button settings-command-button--secondary';
        removeMember.textContent = '×';
        removeMember.title = zh ? '移除成员' : 'Remove member';
        removeMember.disabled = current.members.length <= 1;
        removeMember.addEventListener('click', () => { draft!.members.splice(index, 1); renderMembers(); });
        row.append(harnessField, nameField, roleField, removeMember);
        membersBox.append(row);
      });
    };
    renderMembers();

    const addMember = document.createElement('button');
    addMember.type = 'button';
    addMember.className = 'settings-command-button settings-command-button--secondary';
    addMember.textContent = zh ? `添加成员（最多 ${MAX_TEMPLATE_MEMBERS} 个）` : `Add member (max ${MAX_TEMPLATE_MEMBERS})`;
    addMember.disabled = draft.members.length >= MAX_TEMPLATE_MEMBERS;
    addMember.addEventListener('click', () => {
      if (draft!.members.length >= MAX_TEMPLATE_MEMBERS) return;
      draft!.members.push({ name: '', role: '', agent: agents[0]?.id ?? '' });
      addMember.disabled = draft!.members.length >= MAX_TEMPLATE_MEMBERS;
      renderMembers();
    });

    const editorActions = document.createElement('div');
    editorActions.className = 'settings-update-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'settings-command-button';
    save.textContent = zh ? '保存模板' : 'Save template';
    save.addEventListener('click', () => {
      if (busy || !draft) return;
      busy = true;
      const payload = { ...(draft.id ? { id: draft.id } : {}), name: draft.name, description: draft.description, members: draft.members.map(m => ({ name: m.name, role: m.role, agent: m.agent })) };
      void client.saveTeamTemplate!(payload).then(
        () => {
          busy = false;
          if (context.signal.aborted) return;
          draft = null;
          renderEditor();
          void reload();
        },
        failure => {
          busy = false;
          if (!context.signal.aborted) showError(failure instanceof Error ? failure.message : String(failure));
        },
      );
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'settings-command-button settings-command-button--secondary';
    cancel.textContent = zh ? '取消' : 'Cancel';
    cancel.addEventListener('click', () => { draft = null; renderEditor(); });
    editorActions.append(save, cancel);

    form.append(nameInput, descriptionInput, membersBox, addMember, editorActions);
    editor.append(form);
  };

  const reload = () => {
    error.hidden = true;
    void client.listTeamTemplates!().then(
      value => {
        if (context.signal.aborted) return;
        templates = Array.isArray((value as { templates?: RendererTeamTemplate[] })?.templates) ? (value as { templates: RendererTeamTemplate[] }).templates : [];
        renderList();
      },
      failure => {
        if (context.signal.aborted) return;
        showError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  retryAgents.addEventListener('click', () => loadAgents());
  create.addEventListener('click', () => { draft = emptyTemplateDraft(); renderEditor(); });
  reload();
  loadAgents();
}
