const http = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tools } = require('./collaboration-tools');
const { z } = require('zod');
const { Store } = require('./store');
const { createWorkspace, reviewWorkspace, applyWorkspace, discardWorkspace, pushWorkspace } = require('./collaboration-worktree');
const { loadProjectTeamTemplates, validateTemplateMembers: validateMembers } = require('./team-template-files');
const { parseScript, validateScript, executeScript, settledTaskHandle, ScriptInterrupted } = require('./team-script');
const { createHash } = require('node:crypto');
const validators = new Map(tools.map(tool => [tool.name, z.fromJSONSchema(tool.inputSchema)]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_CONCURRENT_SUBTASKS = 6;
const MAX_SUBTASKS_PER_TURN = 16;

// Settings → Collaboration 开关：两者默认开启。collaboration 关闭时不再注入协作
// MCP、不解析 # 提及、拒绝一切协作工具调用；agentTeam 关闭时保留一次性委派，
// 但隐藏并拒绝 create_agent_team 等团队工具。
const DEFAULT_PREFERENCES = Object.freeze({ collaboration: true, agentTeam: true });
const TEAM_TOOL_NAMES = new Set(['create_agent_team', 'assign_team_task', 'get_team_state', 'update_team_task', 'send_team_message', 'run_team_script']);

// 内置通用团队模板：角色职责按「管什么 + 产出什么 + 不管什么」预写好，Harness 一律
// 留空（agent: ''），用户在 设置 → 协作 里为成员换上自己安装的 Harness 即可使用。
// builtin 标记只表示来源：用户编辑保存后降级为普通模板；删除进入 removedBuiltinIds
// 墓碑避免每次启动复活，「恢复内置模板」清掉墓碑重新补种。
const BUILT_IN_TEAM_TEMPLATES = Object.freeze([
  {
    id: 'builtin-bug-review', name: '缺陷评审组',
    description: '对指定范围代码完成一轮缺陷评审并修复确认的问题：先输出可疑缺陷清单，再逐条验证、修复并回归确认，最后给出修复说明。',
    builtin: true,
    members: [
      { name: '缺陷审查员', role: '通读目标模块与调用链，梳理关键逻辑与边界条件；输出可疑缺陷清单，每条注明位置、触发条件、影响与风险等级；只审查，不改动代码。', agent: '' },
      { name: '缺陷修复员', role: '复核审查员提交的缺陷清单，逐条验证真伪；修复确认的缺陷并运行相关测试确认无回归；输出每条的处理结论（已修复 / 误报 / 暂缓及原因）。', agent: '' },
    ],
  },
  {
    id: 'builtin-feature-squad', name: '功能开发小队',
    description: '把一个明确的功能需求从方案设计推进到实现、测试与评审合入：先产出实现方案，再编码实现并自测，最后评审代码并输出合入结论。',
    builtin: true,
    members: [
      { name: '方案设计', role: '拆解需求与约束，梳理涉及的模块与改动面；产出实现方案（数据结构、接口、分步计划与风险点）；方案确认前不写实现代码。', agent: '' },
      { name: '功能实现', role: '按方案完成编码实现与单元自测，遵循仓库现有风格与约定；不擅自扩大改动范围，偏离方案处先说明再动手。', agent: '' },
      { name: '评审测试', role: '审查实现代码的正确性与边界条件，补充必要的自动化测试并跑通；输出评审意见与测试结论，发现问题退回实现修改。', agent: '' },
    ],
  },
  {
    id: 'builtin-code-review', name: '代码评审组',
    description: '对一次代码改动（diff / PR）做完整评审：正确性、边界与回归风险逐条过，安全与性能专项把关，输出分级评审意见与合入结论。',
    builtin: true,
    members: [
      { name: '主评审', role: '逐行审查改动的正确性与边界条件，核对调用方影响与回归风险；按阻断 / 建议 / 可选分级输出意见，每条注明位置与理由；只评审，不改动代码。', agent: '' },
      { name: '专项评审', role: '对改动做安全（注入、越权、敏感信息）与性能（复杂度、IO、内存）专项审查；输出专项意见清单，与主评审意见合并汇总。', agent: '' },
    ],
  },
  {
    id: 'builtin-refactor', name: '重构小队',
    description: '在不改变外部行为的前提下重构指定模块：先诊断现状并产出重构计划，再分步执行重构，最后回归验证并输出重构说明。',
    builtin: true,
    members: [
      { name: '重构规划', role: '梳理目标模块的现状与耦合点，定位坏味道与风险区；产出分步重构计划（每步可独立验证）；计划确认前不动代码。', agent: '' },
      { name: '重构执行', role: '按计划分步执行重构，保持外部行为不变，每步跑通相关测试；遇到计划外情况先反馈再调整，不私自扩大范围。', agent: '' },
      { name: '回归验证', role: '在每步重构后运行相关测试与冒烟验证，确认外部行为未变；输出回归结论与残留风险清单。', agent: '' },
    ],
  },
  {
    id: 'builtin-test-hardening', name: '测试加固小队',
    description: '为指定模块补齐自动化测试：先梳理用例设计，再编写并跑通测试，最后评审覆盖与质量，输出覆盖结论。',
    builtin: true,
    members: [
      { name: '用例设计', role: '梳理模块的功能点、边界与异常路径，设计测试用例清单并标注优先级与预期结果；只设计，不编写。', agent: '' },
      { name: '测试编写', role: '按用例清单编写自动化测试并在本地跑通，遵循仓库现有测试框架与风格；无法覆盖的用例标注原因。', agent: '' },
      { name: '覆盖评审', role: '审查测试的有效性（断言强度、隔离性、互不依赖），核对用例覆盖情况；输出覆盖结论与补充建议。', agent: '' },
    ],
  },
  {
    id: 'builtin-research', name: '技术调研组',
    description: '对一个技术问题完成对比调研并给出决策建议：多角度独立调研，交叉复核，输出带结论与依据的调研报告。',
    builtin: true,
    members: [
      { name: '方案调研', role: '围绕问题独立完成方案调研（实现路径、依赖、成本与风险），产出带依据的调研纪要；不做最终决策。', agent: '' },
      { name: '交叉复核', role: '复核对方调研的事实与结论，补充遗漏角度与反例；汇总双方材料，输出带倾向性结论与理由的决策建议。', agent: '' },
    ],
  },
]);
const BUILT_IN_TEMPLATE_IDS = new Set(BUILT_IN_TEAM_TEMPLATES.map(template => template.id));

// Dependency depth of each task: the longest chain of prerequisites, used to
// lay the team board out in lanes.
// Missing dependency ids are ignored (the runtime already rejects unknown ids at
// assign time); the cycle back-edge returns 0 so corrupted graphs terminate.
function teamTaskDepths(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const depths = new Map();
  const visiting = new Set();
  const depthOf = id => {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    const task = byId.get(id);
    if (!task) return 0;
    visiting.add(id);
    const deps = (task.dependsOn || []).filter(dep => byId.has(dep));
    const depth = deps.length ? 1 + Math.max(...deps.map(depthOf)) : 0;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const task of tasks) depthOf(task.id);
  return depths;
}

// Coarse team phase: forming (no tasks yet),
// running (at least one task in flight), waiting (unfinished work but nothing
// running — the lead still has to delegate or unblock it), completed.
function teamPhase(team) {
  if (!team.tasks.length) return 'forming';
  if (team.tasks.every(task => task.status === 'completed')) return 'completed';
  return team.tasks.some(task => task.status === 'in_progress') ? 'running' : 'waiting';
}

// Per-status task counters plus completion percent, so a reader can reconstruct
// the workbench progress bar without walking the task list itself.
function teamProgress(tasks) {
  const progress = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0, interrupted: 0 };
  for (const task of tasks) if (progress[task.status] !== undefined) progress[task.status] += 1;
  progress.percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return progress;
}

// 协作 / Agent Team / 委派子会话的免打扰权限：映射到各 Harness 原生自有的
// “免询问/完全访问”档位（等价于用户手动选择该档，不伪造任何审批决定）。
// ACP 系（CodeBuddy/Qoder/Trae/Cursor/Cline/Grok）的档位 id 由原生会话握手
// 动态声明，交给适配器在 open 时按会话实际目录挑选（workerPermissions 标记）；
// 没有免询问档位的 Harness（DSH/Kiro/OpenCode/OpenClaw/Hermes 等）保持原生
// 默认，审批仍经 respond() 走 Desktop 权限卡。
function workerSessionOptions(agent) {
  switch (agent) {
    case 'claude':
    case 'claude-code':
      return { permissionMode: 'bypassPermissions' };
    case 'antigravity':
    case 'agy':
      return { permissionMode: 'skip' };
    case 'pi':
      return { permissionMode: 'no-approve' };
    case 'omp':
      // OMP 的权限模型已与 Pi 分叉：--approval-mode yolo 才是免询问档
      return { permissionMode: 'yolo' };
    case 'zcode':
      // Worker threads run in kernel-isolated workspaces with nobody watching
      // approval cards; yolo is the ZCode selector's no-prompts mode.
      return { permissionMode: 'yolo' };
    case 'codex':
    case 'codex-harness':
      return { turnPermissions: { approvalPolicy: 'never', sandboxPolicy: 'dangerFullAccess' } };
    case 'codebuddy':
    case 'workbuddy':
    case 'qoder':
    case 'trae':
    case 'cursor-cli':
    case 'cursor':
    case 'cline':
    case 'grok':
      return { workerPermissions: 'full' };
    default:
      return {};
  }
}

// A session-scoped local bridge. Native models/credentials and approvals stay in adapters.
class Collaboration {
  constructor(runtime) {
    this.runtime = runtime;
    this.keys = new Map();
    this.jobs = new Map();
    this.cancelling = new Set();
    this.interruptOwners = new Set();
    this.closing = false;
    this.store = new Store(path.join(runtime.store.directory, 'collaboration'));
    this.teamStore = new Store(path.join(runtime.store.directory, 'collaboration'), 'teams.json');
    this.teams = new Map();
    // Agent Team 模板：预置成员构成（Harness + 自定义角色职责），供 /team 指令与
    // 设置页管理；模板只描述编成，不持有任何会话或任务状态
    this.templateStore = new Store(path.join(runtime.store.directory, 'collaboration'), 'team-templates.json');
    this.teamTemplates = [];
    this.projectTemplateWarnings = [];
    this.removedBuiltinFile = path.join(runtime.store.directory, 'collaboration', 'team-templates-removed.json');
    this.removedBuiltinTemplateIds = new Set();
    this.prefFile = path.join(runtime.store.directory, 'collaboration', 'preferences.json');
    this.prefs = { ...DEFAULT_PREFERENCES };
  }

  async loadPreferences() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.prefFile, 'utf8'));
      // 只认显式的 false：缺失字段/旧文件一律回落到默认开启
      this.prefs = {
        collaboration: parsed?.collaboration !== false,
        agentTeam: parsed?.agentTeam !== false,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  getPreferences() {
    return { ...this.prefs };
  }

  async setPreferences(patch = {}) {
    await this.initialize();
    if (typeof patch.collaboration === 'boolean') this.prefs.collaboration = patch.collaboration;
    if (typeof patch.agentTeam === 'boolean') this.prefs.agentTeam = patch.agentTeam;
    await fs.promises.mkdir(path.dirname(this.prefFile), { recursive: true });
    const tmp = `${this.prefFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.prefs, null, 2));
    await fs.promises.rename(tmp, this.prefFile);
    return this.getPreferences();
  }

  async initialize() {
    if (!this.loading) this.loading = this.loadPreferences().then(() => Promise.all([this.store.load(), this.teamStore.load(), this.templateStore.load()])).then(async ([rows, teams, templates]) => {
      for (const row of rows) {
        if (!row.id || !row.owner || !row.agent) throw new Error('Invalid collaboration history');
        this.jobs.set(row.id, { ...row, ...(row.status === 'running' ? { status: 'interrupted', error: 'Host restarted; resume this native session explicitly.' } : {}) });
      }
      for (const team of teams) {
        if (!team.id || !team.owner || !Array.isArray(team.members) || !Array.isArray(team.tasks) || !Array.isArray(team.messages)) throw new Error('Invalid Agent Team history');
        if (!Array.isArray(team.history)) team.history = [];
        // 重启时在跑的编排脚本转为 interrupted(与作业/成员同语义),journal 保留,
        // 「继续协作」按 seq 从头重放:已结算任务零成本落定,未结算任务活跑
        if (team.driver?.status === 'running') { team.driver.status = 'interrupted'; team.driver.stop = false; team.driver.seq = 0; delete team.driver.ast; }
        if (team.driver) { team.driver.pending = new Set(); team.driver.inFlight = 0; }
        this.teams.set(team.id, team);
      }
      // 已收尾团队在 Host 重启后同样清一次滞留未读（历史版本写入的 mailbox 消息
      // 会让成员卡片永久显示未读且无法消除）
      for (const team of this.teams.values()) {
        if (team.status === 'completed') this.acknowledgeMemberMail(team);
      }
      this.teamTemplates = (Array.isArray(templates) ? templates : []).filter(template => template && template.id && Array.isArray(template.members)
        && template.members.every(member => member && typeof member.name === 'string' && typeof member.role === 'string' && typeof member.agent === 'string'));
      await this.loadRemovedBuiltinTemplateIds();
      this.seedBuiltInTeamTemplates();
      for (const job of this.jobs.values()) {
        if (job.status !== 'interrupted' || !job.teamId) continue;
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const task = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member) member.status = 'interrupted';
        if (task?.status === 'in_progress') task.status = 'interrupted';
        if (team) this.refreshTeamStatus(team);
      }
      await this.save();
      await this.saveTeams();
      await this.saveTeamTemplates();
    });
    return this.loading;
  }

  save() {
    return this.store.save([...this.jobs.values()].map(({ done, cancelling, followupPending, applying, handshaking, ...job }) => job));
  }

  saveTeams() {
    // driver 的 ast/瞬态字段不持久化（ast 可由 script 确定性重解析），journal/seq 原样落盘
    return this.teamStore.save([...this.teams.values()].map(team => team.driver
      ? { ...team, driver: (({ ast, pending, stop, inFlight, ...rest }) => rest)(team.driver) }
      : team));
  }

  saveTeamTemplates() { return this.templateStore.save(this.teamTemplates); }

  async loadRemovedBuiltinTemplateIds() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.removedBuiltinFile, 'utf8'));
      this.removedBuiltinTemplateIds = new Set((Array.isArray(parsed) ? parsed : [])
        .filter(id => typeof id === 'string' && BUILT_IN_TEMPLATE_IDS.has(id)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.removedBuiltinTemplateIds = new Set();
    }
  }

  async saveRemovedBuiltinTemplateIds() {
    await fs.promises.mkdir(path.dirname(this.removedBuiltinFile), { recursive: true });
    const tmp = `${this.removedBuiltinFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify([...this.removedBuiltinTemplateIds], null, 2));
    await fs.promises.rename(tmp, this.removedBuiltinFile);
  }

  /** 补种缺失的内置模板：跳过已存在（含用户改造过的同名 id）与已删除（墓碑）的 */
  seedBuiltInTeamTemplates() {
    let seeded = 0;
    for (const builtin of BUILT_IN_TEAM_TEMPLATES) {
      if (this.removedBuiltinTemplateIds.has(builtin.id)) continue;
      if (this.teamTemplates.some(template => template.id === builtin.id)) continue;
      this.teamTemplates.push(JSON.parse(JSON.stringify(builtin)));
      seeded += 1;
    }
    return seeded;
  }

  /** 恢复内置模板：清空删除墓碑并补回缺失项；用户改造过的模板（同名 id 已存在）保持原样 */
  async restoreBuiltInTeamTemplates() {
    await this.initialize();
    this.removedBuiltinTemplateIds.clear();
    await this.saveRemovedBuiltinTemplateIds();
    const restored = this.seedBuiltInTeamTemplates();
    await this.saveTeamTemplates();
    return { restored };
  }

  // ---- Agent Team 模板：成员编成的持久化定义（自定义 Harness 角色） ----

  /**
   * 模板清单：可选按 cwd 合并项目作用域文件模板（.harness-mix/teams/*.md）。
   * 解析顺序为 项目 > 用户/内置——同名时文件版就近覆盖存储版。坏文件被跳过并
   * 记录到 projectTemplateWarnings，不影响其余模板与调用方。
   */
  async listTeamTemplates(cwd) {
    await this.initialize();
    const withAvailability = template => ({
      ...template,
      members: template.members.map(member => ({ ...member, available: this.runtime.status[member.agent]?.available === true })),
    });
    const stored = this.teamTemplates.map(withAvailability);
    if (!cwd || typeof cwd !== 'string') return stored;
    const { templates, warnings } = await loadProjectTeamTemplates(cwd, { resolveHarnessId: input => this.runtime.resolveHarnessId(input) });
    this.projectTemplateWarnings = warnings;
    const projectNames = new Set(templates.map(template => template.name.toLowerCase()));
    return [...templates.map(withAvailability), ...stored.filter(template => !projectNames.has(template.name.toLowerCase()))];
  }

  validateTemplateMembers(members) {
    return validateMembers(members, input => this.runtime.resolveHarnessId(input));
  }

  async saveTeamTemplate({ id, name, description, members }) {
    await this.initialize();
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName || trimmedName.length > 80) throw new Error('模板名称需为 1-80 个字符');
    const trimmedDescription = String(description ?? '').trim().slice(0, 240);
    const validated = this.validateTemplateMembers(members);
    const now = Date.now();
    let template = id ? this.teamTemplates.find(entry => entry.id === id) : null;
    if (id && !template) throw new Error('未找到要更新的团队模板');
    if (!template) { template = { id: randomUUID(), createdAt: now }; this.teamTemplates.push(template); }
    template.name = trimmedName;
    template.description = trimmedDescription;
    template.members = validated;
    template.updatedAt = now;
    // 用户改动过的内置模板不再是原版：降级为普通模板，恢复内置也不会覆盖它
    if (template.builtin) template.builtin = false;
    await this.saveTeamTemplates();
    return { ...template };
  }

  async deleteTeamTemplate(id) {
    await this.initialize();
    const index = this.teamTemplates.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('未找到团队模板');
    const [removed] = this.teamTemplates.splice(index, 1);
    if (removed?.builtin && BUILT_IN_TEMPLATE_IDS.has(removed.id)) {
      this.removedBuiltinTemplateIds.add(removed.id);
      await this.saveRemovedBuiltinTemplateIds();
    }
    await this.saveTeamTemplates();
    return { deleted: true };
  }

  /** 把一个现存 Agent Team 的成员编成保存为模板（名称/职责/Harness 原样提取） */
  async teamTemplateFromTeam(teamId, { name, description } = {}) {
    await this.initialize();
    const team = this.teams.get(teamId);
    if (!team) throw new Error('未找到该 Agent Team');
    return this.saveTeamTemplate({
      name,
      description,
      members: team.members.map(member => ({ name: member.name, role: member.role, agent: member.agent })),
    });
  }

  findTeamTemplate(token) {
    const needle = String(token ?? '').trim().toLowerCase();
    if (!needle) return null;
    return this.teamTemplates.find(template => template.name.toLowerCase() === needle)
      ?? this.teamTemplates.find(template => template.id.toLowerCase() === needle)
      ?? (needle.length >= 2 ? this.teamTemplates.find(template => template.name.toLowerCase().startsWith(needle)) : null);
  }

  // 模板查找的项目优先版：先在 <cwd>/.harness-mix/teams/ 的文件模板里按
  // id/名称/前缀匹配，再回落用户与内置存储——同一名称项目版胜出
  async findTeamTemplateFor(id, label, cwd) {
    if (cwd && typeof cwd === 'string') {
      const { templates } = await loadProjectTeamTemplates(cwd, { resolveHarnessId: input => this.runtime.resolveHarnessId(input) });
      const match = needle => {
        const key = String(needle ?? '').trim().toLowerCase();
        if (!key) return null;
        return templates.find(template => template.id.toLowerCase() === key)
          ?? templates.find(template => template.name.toLowerCase() === key)
          ?? (key.length >= 2 ? templates.find(template => template.name.toLowerCase().startsWith(key)) : null);
      };
      const found = match(id) ?? match(label);
      if (found) return found;
    }
    return this.teamTemplates.find(template => template.id.toLowerCase() === String(id ?? '').toLowerCase()) ?? this.findTeamTemplate(label);
  }

  templateUsageHint() {
    const names = this.teamTemplates.map(template => template.name);
    return names.length ? `可用模板：${names.join('、')}` : '暂无模板，可在 设置 → 协作 中创建团队模板';
  }

  /**
   * # 提及的团队模板展开：把 #[名称](harness-mix://team-template/<id>) 连同剩余
   * 文本（作为团队目标）展开为一条带 # 授权的普通用户指令。走既有 Lead 编排
   * 路径（提及解析 → 协作 MCP 注入 → create_agent_team），模板成员的自定义
   * 职责逐字进入团队创建指令。查找先项目文件、后用户/内置存储。文本中无模板
   * 提及时返回 null（不影响普通发送）。
   */
  async expandTeamTemplateMention(text, thread) {
    const source = String(text ?? '');
    // 吃掉可选的前导 # 及各特殊字符前的 Markdown 转义反斜杠：渲染端 # 菜单插入
    // #[名称](harness-mix://team-template/<id>)，但 Desktop 输入框会把未成链的纯文本
    // 序列化成 \#[名称]\(…\)，不容忍转义会让提及匹配失败、消息原样透传（团队永不创建）
    const pattern = /(?:\\)?#?(?:\\)?\[([^\]]*)\](?:\\)?\(harness-mix:\/\/team-template\/([^)\s\\]+)(?:\\)?\)/g;
    const first = pattern.exec(source);
    if (!first) return null;
    const template = await this.findTeamTemplateFor(first[2], first[1], thread?.cwd);
    if (!template) throw new Error(`未找到团队模板「${first[1] || first[2]}」。${this.templateUsageHint()}`);
    pattern.lastIndex = 0;
    const goal = source.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
    return this.composeTeamInstruction(template, goal, thread);
  }

  /** 校验编成可用性并组装带 # 授权的团队创建指令（模板的唯一展开核心） */
  composeTeamInstruction(template, goal, thread) {
    if (!this.prefs.collaboration || !this.prefs.agentTeam) throw new Error('协作或 Agent Team 已在 设置 → 协作 中关闭，无法按模板创建团队');
    const rt = this.runtime;
    if (thread.parentThreadId) throw new Error('子任务不能创建 Agent Team，请在主任务中选择团队模板');
    if (!rt.adapters.get(thread.harnessId)?.manifest?.capabilities?.collaborationTools) throw new Error('当前 Harness 不具备 Lead 协作能力，无法创建 Agent Team');
    const names = new Map([...rt.adapters.values()].map(adapter => [adapter.manifest.id, adapter.manifest.name]));
    const agents = [];
    for (const member of template.members) {
      if (!String(member.agent ?? '').trim()) throw new Error(`模板成员 ${member.name} 未指定 Harness，请在 设置 → 协作 中编辑模板`);
      const agent = rt.resolveHarnessId(member.agent) || member.agent;
      if (!rt.adapters.has(agent)) throw new Error(`模板成员 ${member.name} 引用了未注册的 Harness：${member.agent}`);
      if (!rt.status[agent]?.available) throw new Error(`模板成员 ${member.name} 使用的 Harness 当前不可用：${names.get(agent) ?? agent}`);
      if (!agents.includes(agent)) agents.push(agent);
    }
    const roster = template.members.map(member => {
      const agent = rt.resolveHarnessId(member.agent) || member.agent;
      return `- ${member.name}（${names.get(agent) ?? agent}）：${member.role}`;
    });
    const instruction = [
      '请立即调用 create_agent_team 创建 Agent Team。',
      `团队名称：${template.name}`,
      `团队目标：${goal || template.description || template.name}`,
      '成员构成（名称与职责必须与下列完全一致，不得增删成员或改写职责）：',
      ...roster,
      '创建团队后，按成员职责把目标拆解为共享任务图（assign_team_task），再用 delegate_to_agent 启动各成员的原生会话并推进到完成。',
    ].join('\n');
    return `${agents.map(agent => `#${agent}`).join(' ')} [Harness Mix 团队模板 · ${template.name}]
${instruction}`;
  }

  recordTeamSnapshot(team, action) {
    if (!Array.isArray(team.history)) team.history = [];
    team.history.push({ id: randomUUID(), action, at: Date.now(), team: this.teamView(team) });
    if (team.history.length > 200) team.history.splice(0, team.history.length - 200);
  }

  async publishTeam(team, action) {
    this.recordTeamSnapshot(team, action);
    await this.saveTeams();
    this.emitTeam(team, action);
  }

  async inspectTeam(threadId, teamId) {
    await this.initialize();
    const participant = this.participant(threadId, teamId);
    if (!participant) {
      // An explicit teamId is an ownership check: outsiders are denied. Without
      // one the caller only asks "does this thread belong to a team?" — the
      // renderer polls exactly that for every active thread, so answer benignly
      // instead of failing an internal error on every poll.
      if (teamId) throw new Error('Unknown team or caller is not a team participant');
      return { team: null, snapshots: [] };
    }
    return {
      team: this.teamView(participant.team),
      snapshots: (participant.team.history || []).map(snapshot => ({ ...snapshot, team: { ...snapshot.team } })),
    };
  }

  refreshTeamStatus(team) {
    team.status = team.tasks.length && team.tasks.every(task => task.status === 'completed') ? 'completed'
      : team.tasks.some(task => task.status === 'interrupted') && !team.tasks.some(task => task.status === 'in_progress') ? 'interrupted' : 'active';
    // 团队收尾即清未读：收尾后成员会话不再轮询邮箱，滞留消息若不落终态
    // 会永久显示“N 条未读”。幂等，重复调用无副作用。
    if (team.status === 'completed') this.acknowledgeMemberMail(team);
    team.updatedAt = Date.now();
  }

  list(owner) { return [...this.jobs.values()].filter(j => !owner || j.owner === owner).map(j => this.view(j)); }

  participant(threadId, teamId) {
    for (const team of this.teams.values()) {
      if (teamId && team.id !== teamId) continue;
      if (team.owner === threadId) return { team, kind: 'lead', id: 'lead', name: 'Lead' };
      const member = team.members.find(entry => entry.childId === threadId);
      if (member) return { team, kind: 'member', id: member.id, name: member.name, member };
    }
    return null;
  }

  isTeamParticipantThread(threadId) { return !!this.participant(threadId); }

  teamFor(principal, teamId) {
    const participant = this.participant(principal, teamId);
    if (!participant) throw new Error('Unknown team or caller is not a team participant');
    return participant;
  }

  resolveMember(team, value) {
    const normalized = String(value).toLowerCase();
    const matches = team.members.filter(member => member.id === value || member.name.toLowerCase() === normalized);
    if (matches.length !== 1) throw new Error(matches.length ? 'Team member name is ambiguous; use member_id' : 'Unknown team member');
    return matches[0];
  }

  // 成员未读数：发给该成员（定向或广播）且尚未经原生会话送达的消息条数，
  // 让轮询 get_team_state 的成员一眼看到“有 N 条未读”，无需遍历邮箱。
  // acknowledged 是终态：消息确实没进原生会话（历史保留 delivery 事实），但
  // 用户已确认或团队已收尾，不再当作未读提示。
  memberUnread(team, member) {
    return team.messages.filter(message => {
      if (message.from === member.id) return false;
      if (message.to !== member.id && message.to !== '*') return false;
      const state = message.deliveryBy?.[member.id] ?? (message.to === member.id ? message.delivery : 'mailbox');
      return state !== 'native_session' && state !== 'acknowledged';
    }).length;
  }

  // 未读清理：把成员名下仍滞留（mailbox/queued）的消息标记为 acknowledged。
  // 团队收尾（refreshTeamStatus 判定 completed）时自动清一次；用户也可在
  // 看板上手动清（message/ack）。deliveryBy 缺失的旧消息按聚合 delivery 判定。
  acknowledgeMemberMail(team, memberId = null) {
    let cleared = 0;
    for (const message of team.messages) {
      for (const member of team.members) {
        if (memberId && member.id !== memberId) continue;
        if (message.from === member.id) continue;
        if (message.to !== member.id && message.to !== '*') continue;
        const state = message.deliveryBy?.[member.id] ?? (message.to === member.id ? message.delivery : 'mailbox');
        if (state === 'mailbox' || state === 'queued') {
          (message.deliveryBy ??= {})[member.id] = 'acknowledged';
          cleared += 1;
        }
      }
    }
    return cleared;
  }

  teamView(team) {
    const leadThread = this.runtime.threads.find(thread => thread.id === team.owner);
    const leadAgent = leadThread?.harnessId ?? 'codex';
    const leadName = this.runtime.adapters.get(leadAgent)?.manifest?.name ?? leadAgent;
    const depths = teamTaskDepths(team.tasks);
    return {
      team_id: team.id, name: team.name, goal: team.goal, status: team.status, lead_thread_id: team.owner,
      phase: teamPhase(team), progress: teamProgress(team.tasks),
      lead: { id: 'lead', name: 'Team Lead', role: `${leadName} · 协调与验收`, agent: leadAgent, display_status: this.runtime.execution.isRunning(team.owner) ? 'working' : 'ready' },
      members: team.members.map(member => ({ ...member, display_status: member.childId && this.runtime.execution.isRunning(member.childId) ? 'working' : member.status, unread: this.memberUnread(team, member) })),
      tasks: team.tasks.map(task => ({ ...task, depth: depths.get(task.id) ?? 0 })), messages: team.messages.slice(-40).map(message => ({ ...message })),
      ...(team.driver ? { driver: { script_id: team.driver.id, status: team.driver.status, phase: team.driver.phase, error: team.driver.error ?? null, result: team.driver.result ?? null, tasks: team.tasks.filter(task => task.scriptId === team.driver.id).map(task => ({ task_id: task.id, title: task.title, status: task.status })) } } : {}),
      updated_at: team.updatedAt,
    };
  }

  emitTeam(team, action) {
    if (!this.runtime.execution.isRunning(team.owner)) return;
    // 团队全部完成时把团队卡片结算为 done——否则它会作为未终态 tool_call
    // 一直挂到回合结束，被投影成「执行中」。完成后若再 reopen，会以 running 复更。
    const done = team.status === 'completed';
    this.runtime.emitCollaboration(team.owner, {
      kind: 'tool', toolCallId: `agent-team:${team.id}`, title: `Agent Team · ${team.name}`,
      state: done ? 'done' : 'running', input: team.goal, output: JSON.stringify({ action, ...this.teamView(team) }),
    });
  }

  async review(id) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running') throw new Error('子任务尚未完成');
    return reviewWorkspace(job.workspace);
  }

  async apply(id, digest) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'completed') throw new Error('仅可应用已完成子任务的改动');
    if (job.applying) throw new Error('正在应用改动');
    if (job.appliedDigest) throw new Error('此任务已应用；后续修改请创建新任务');
    const parent = this.runtime.threads.find(t => t.id === job.owner);
    // lead 回合在等待本 MCP 工具返回时必然处于运行态（call() 的前置条件），子线程由下方
    // verification gates 单独校验，因此同目录并发扫描必须排除这两者，否则条件恒真、apply 永远失败
    if (!parent || this.runtime.threads.some(t => t.id !== job.owner && t.id !== job.childId
      && (this.runtime.execution.isRunning(t.id) || t.reviewPending)
      && [parent.cwd, job.workspace?.cwd].some(cwd => String(cwd).toLowerCase() === String(t.cwd).toLowerCase()))) throw new Error('其他任务正在同一目录运行或待审查，请等待其结算后再应用');
    // 子线程已删除时无从查询其门禁策略：review+digest+用户显式授权仍是硬前置，这里跳过
    const childThread = job.childId ? this.runtime.threads.find(t => t.id === job.childId) : null;
    if (childThread) this.runtime.verificationGates.assertSatisfied(childThread, '应用子任务改动');
    job.applying = true;
    try {
      const result = await applyWorkspace(job.workspace, digest);
      job.appliedDigest = result.digest;
      // off 策略下的零配置安全网：apply 结果附一次 advisory 验证（不阻断、不改门禁语义）
      const childForVerify = job.childId ? this.runtime.threads.find(t => t.id === job.childId) : null;
      if (childForVerify) {
        const report = await this.runtime.verificationGates.advisory(childForVerify).catch(() => null);
        if (report) { job.verification = { mode: 'advisory', status: report.status, checks: report.checks }; result.verification = job.verification; }
      }
      await this.save();
      return result;
    } finally { delete job.applying; }
  }

  async discard(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('子任务不存在');
    if (job.status === 'running') throw new Error('子任务正在运行，请先取消');
    const result = await discardWorkspace(job.workspace);
    job.status = 'cancelled';
    delete job.workspace;
    await this.save();
    return result;
  }

  async push(id, { remote = 'origin', branch } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('子任务不存在');
    if (job.status === 'running') throw new Error('请等待子任务完成后再推送分支');
    if (job.childId) this.runtime.verificationGates.assertSatisfied(this.runtime.getThread(job.childId), '推送子任务分支');
    return pushWorkspace(job.workspace, remote, branch);
  }

  async connection(thread) {
    await this.initialize();
    if (!this.starting) this.starting = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    await this.starting;
    let key = this.keys.get(thread.id);
    if (!key) { key = randomUUID(); this.keys.set(thread.id, key); }
    return { command: process.execPath, args: [path.join(__dirname, 'collaboration-mcp.cjs')],
      env: { HARNESS_MIX_COLLAB_URL: `http://127.0.0.1:${this.server.address().port}`, HARNESS_MIX_COLLAB_KEY: key, HARNESS_MIX_COLLAB_TEAM: this.prefs.agentTeam ? '1' : '0' } };
  }

  async handle(req, res) {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const owner = [...this.keys].find(([, key]) => req.headers.authorization === `Bearer ${key}`)?.[0];
    if (!owner || req.method !== 'POST' || req.url !== '/' || req.headers.origin) return reply(403, { error: 'Forbidden' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 64000) throw new Error('Request too large'); }
      const { name, arguments: args } = JSON.parse(body);
      reply(200, { result: await this.call(owner, name, args ?? {}) });
    } catch (error) { reply(400, { error: error.message }); }
  }

  owned(owner, id) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('Unknown task or task belongs to another lead');
    return job;
  }

  async teamCall(principal, name, args) {
    const rt = this.runtime;
    if (name === 'create_agent_team') {
      const lead = rt.threads.find(thread => thread.id === principal);
      if (!lead || lead.parentThreadId) throw new Error('Only a lead task can create an Agent Team');
      const names = new Set();
      const members = args.members.map(entry => {
        const agent = rt.resolveHarnessId(entry.agent_type);
        if (!agent || !rt.status[agent]?.available) throw new Error(`Target Harness unavailable: ${entry.agent_type}`);
        if (!rt.adapters.get(agent)?.manifest?.capabilities?.collaborationTools) throw new Error(`Harness cannot participate in Agent Team messaging: ${agent}`);
        if (!lead.activeMentions?.includes(agent)) throw new Error(`Agent Team member ${entry.name} uses unselected Harness "${agent}"`);
        const key = entry.name.trim().toLowerCase();
        if (names.has(key)) throw new Error('Agent Team member names must be unique');
        names.add(key);
        return { id: randomUUID(), name: entry.name.trim(), role: entry.role.trim(), agent, status: 'ready' };
      });
      const team = { id: randomUUID(), owner: principal, name: args.name.trim(), goal: args.goal, status: 'active', members, tasks: [], messages: [], history: [], createdAt: Date.now(), updatedAt: Date.now() };
      this.teams.set(team.id, team);
      await this.publishTeam(team, 'team_created');
      return this.teamView(team);
    }

    const participant = this.teamFor(principal, args.team_id);
    const { team } = participant;
    if (name === 'get_team_state') return this.teamView(team);
    if (name === 'run_team_script') {
      if (participant.kind !== 'lead') throw new Error('Only the Team Lead can run an orchestration script');
      return this.startTeamScript(principal, team, args);
    }
    if (name === 'assign_team_task') {
      if (participant.kind !== 'lead') throw new Error('Only the Team Lead can assign team tasks');
      const assignee = this.resolveMember(team, args.assignee);
      const dependencies = [...new Set(args.depends_on ?? [])];
      if (dependencies.some(id => !team.tasks.some(task => task.id === id))) throw new Error('Unknown dependency task');
      const taskEntry = { id: randomUUID(), title: args.title.trim(), description: args.description, assignee: assignee.id, dependsOn: dependencies, status: dependencies.length ? 'blocked' : 'pending', createdAt: Date.now(), updatedAt: Date.now(), ...(args.retry ? { retry: { max: args.retry.max, used: 0 } } : {}) };
      team.tasks.push(taskEntry);
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_assigned');
      return { task: taskEntry, team: this.teamView(team) };
    }
    if (name === 'update_team_task') {
      const taskEntry = team.tasks.find(task => task.id === args.task_id);
      if (!taskEntry) throw new Error('Unknown team task');
      if (participant.kind === 'member' && taskEntry.assignee !== participant.id) throw new Error('A teammate can update only its assigned tasks');
      if (participant.kind === 'member' && !['in_progress', 'completed', 'failed'].includes(args.status)) throw new Error('A teammate can only start, complete, or fail its assigned task');
      if (participant.kind === 'member' && taskEntry.status === 'completed') throw new Error('A completed task can only be reopened by the Team Lead');
      if (['in_progress', 'completed'].includes(args.status) && taskEntry.dependsOn.some(id => team.tasks.find(task => task.id === id)?.status !== 'completed')) throw new Error('Task dependencies are not complete');
      taskEntry.status = args.status;
      taskEntry.updatedAt = Date.now();
      if (args.result !== undefined) taskEntry.result = args.result;
      for (const candidate of team.tasks) {
        if (candidate.status === 'blocked' && candidate.dependsOn.every(id => team.tasks.find(task => task.id === id)?.status === 'completed')) candidate.status = 'pending';
      }
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_updated');
      return { task: { ...taskEntry }, team: this.teamView(team) };
    }
    if (name === 'send_team_message') {
      const target = args.to === '*' || args.to.toLowerCase() === 'lead' ? args.to.toLowerCase() : this.resolveMember(team, args.to).id;
      if (args.task_id && !team.tasks.some(task => task.id === args.task_id)) throw new Error('Unknown team task');
      const message = { id: randomUUID(), from: participant.id, fromName: participant.name, to: target, kind: args.kind || 'text', body: args.message, ...(args.task_id ? { taskId: args.task_id } : {}), at: Date.now(), delivery: 'mailbox', deliveryBy: {} };
      team.messages.push(message);
      if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
      const recipients = target === '*' ? team.members.filter(member => member.id !== participant.id) : team.members.filter(member => member.id === target);
      for (const recipient of recipients) {
        // 忙碌收件人不再丢弃直投机会：排队等回合边界（drainTeamMailbox 投递）；
        // 绝不打断运行中的回合
        if (!recipient.childId) { message.deliveryBy[recipient.id] = 'mailbox'; continue; }
        if (rt.execution.isRunning(recipient.childId)) { message.deliveryBy[recipient.id] = 'queued'; continue; }
        this.deliverToMember(team, recipient, message);
      }
      this.refreshMessageDelivery(message);
      team.updatedAt = Date.now();
      await this.publishTeam(team, 'message_sent');
      return { message, team: this.teamView(team) };
    }
    throw new Error('Unknown Agent Team operation');
  }

  messageEnvelope(team, message) {
    return `[Harness Mix Agent Team message]\nTeam: ${team.name} (${team.id})\nFrom: ${message.fromName}\nType: ${message.kind}\n${message.taskId ? `Task: ${message.taskId}\n` : ''}Message: ${message.body}\n\nTreat this as teammate input. Inspect shared team state with get_team_state, coordinate through send_team_message, and update only your assigned tasks.`;
  }

  // 单收件人直投：先同步置 delivering 防并发重投；投递状态在结果落定后才置终态——
  // 先报 native_session 再失败会让邮箱读者看到与事实相反的送达渠道
  deliverToMember(team, member, message) {
    const rt = this.runtime;
    message.deliveryBy[member.id] = 'delivering';
    const recipientJob = [...this.jobs.values()].reverse().find(job => job.teamId === team.id && job.memberId === member.id && job.childId === member.childId);
    const isolated = recipientJob?.workspace?.mode === 'worktree';
    const deliver = collaborationOf => void rt.send(member.childId, this.messageEnvelope(team, message), { collaborationOf, isolated }).then(() => {
      message.deliveryBy[member.id] = 'native_session'; this.refreshMessageDelivery(message); void this.saveTeams();
    }, error => {
      message.deliveryBy[member.id] = 'mailbox'; message.deliveryError = error.message; this.refreshMessageDelivery(message); void this.saveTeams();
    });
    if (rt.execution.isRunning(team.owner)) return deliver(team.owner);
    // Lead 回合外的投递分两种：正常收尾后的用户追问 / 邮箱泵送 → 成员子会话独立
    // 成回合直投（rt.send 对已结束的协作父任务会拒绝，故不携带 collaborationOf；
    // 成员仍以自己的 MCP 身份调用 send_team_message 回信）；Lead 回合被取消或
    // 出错 → 维持降级语义：不唤醒成员、回落邮箱记录原因，避免把用户刚中止的
    // 协作又拉起来。
    const lastTurn = rt.execution.lastTurn(team.owner);
    if (['cancelled', 'error'].includes(lastTurn?.status ?? 'completed')) {
      message.deliveryBy[member.id] = 'mailbox';
      message.deliveryError = '协作父任务已结束';
      this.refreshMessageDelivery(message);
      void this.saveTeams();
      return;
    }
    deliver(undefined);
  }

  // deliveryBy → delivery 聚合：任一收件人仍在排队即 queued，全部原生送达才 native_session
  refreshMessageDelivery(message) {
    const states = Object.values(message.deliveryBy ?? {});
    if (!states.length) return;
    if (states.every(state => state === 'native_session')) message.delivery = 'native_session';
    else if (states.includes('queued') || states.includes('delivering')) message.delivery = 'queued';
    else message.delivery = 'mailbox';
  }

  // 回合边界投递泵：把排队消息投给已空闲的收件人。由作业轮询循环与各结算路径
  // 触发；delivering 标记同步置位，天然防并发重投。lead 已空闲时 rt.send 拒绝，
  // 消息按既有语义降级回邮箱并记录 deliveryError。
  drainTeamMailbox(team) {
    if (!team || this.closing) return;
    const rt = this.runtime;
    for (const message of team.messages) {
      for (const [memberId, state] of Object.entries(message.deliveryBy ?? {})) {
        if (state !== 'queued') continue;
        const member = team.members.find(entry => entry.id === memberId);
        if (!member?.childId || rt.execution.isRunning(member.childId)) continue;
        this.deliverToMember(team, member, message);
      }
    }
  }

  // 用户在团队看板/协作卡上的操作入口。principal 是用户：权限高于 lead 模型，
  // 因此允许 lead-only 语义（改派/以 lead 身份发消息）。安全边界不变——改派目标
  // 只能是团队既有成员（创建时已过 # 提及门控），派发类操作以「向 lead 线程注入
  // 指令回合」实现：run() 把 worker 作业监管在运行中的 lead 回合上，绕过 lead
  // 直接派发会被立刻结算为 cancelled。指令文本自带目标成员的 #提及，走与用户
  // 手打提及完全相同的授权路径（activeMentions 按回合重算，见 runtime #send）。
  async userAction(threadId, action, args = {}) {
    await this.initialize();
    if (this.closing) throw new Error('Host is closing');
    if (!this.prefs.collaboration) throw new Error('多 Agent 协作已在设置中停用（设置 → 协作）。');
    const rt = this.runtime;
    const thread = rt.threads.find(t => t.id === threadId);
    if (!thread || thread.parentThreadId) throw new Error('团队操作仅限主导者线程');
    const dispatch = text => {
      // 不等待回合完成（可能长达整个协作周期）；回合级失败由线程自身呈现
      void rt.send(threadId, text, {}).catch(() => {});
    };
    if (action === 'continue') {
      const team = args.teamId ? this.teamFor(threadId, args.teamId).team : null;
      // 编排脚本优先：恢复的是 driver（journal 重放，不重放已完成任务），不是 Lead 回合
      if (team?.driver?.status === 'interrupted') {
        if (rt.execution.isRunning(threadId)) throw new Error('主导者回合进行中，请在回合结束后继续协作');
        team.driver.stop = false;
        team.driver.status = 'running';
        team.driver.seq = 0;
        team.driver.steps = 0;
        team.driver.inFlight = 0;
        team.driver.pending = new Set();
        delete team.driver.ast;
        await this.publishTeam(team, 'script_resumed');
        void this.runTeamDriver(team, team.driver).catch(error => {
          team.driver.status = 'failed';
          team.driver.error = error?.message ?? String(error);
          void this.saveTeams();
        });
        return {
          dispatched: true, driver: { script_id: team.driver.id, status: 'running' },
          interrupted: this.list(threadId).filter(job => job.status === 'interrupted' && job.team_id === team.id),
          pending: team.tasks.filter(task => task.status === 'pending').map(task => task.id),
        };
      }
      const interrupted = this.list(threadId).filter(job => job.status === 'interrupted' && (!team || job.team_id === team.id));
      const pending = team?.tasks.filter(task => task.status === 'pending') ?? [];
      if (!interrupted.length && !pending.length) throw new Error('没有可恢复的中断委派或待派发的团队任务');
      if (args.taskId && !interrupted.some(job => job.task_id === args.taskId)) throw new Error('仅中断的委派可以恢复，且必须属于指定团队');
      if (rt.execution.isRunning(threadId)) throw new Error('主导者回合进行中，请在回合结束后继续协作');
      // list() 返回 view 投影：agent 字段名是 agent_type
      const mentions = [...new Set([...interrupted.map(job => job.agent_type), ...(team ? pending.map(task => this.resolveMember(team, task.assignee).agent) : [])])].map(agent => `#${agent}`).join(' ');
      dispatch(team && !args.taskId
        ? `[Harness Mix collaboration · 用户操作]\n用户要求继续 Agent Team「${team.name}」（team_id=${team.id}，涉及 ${mentions}）。请调用 get_team_state 检查共享任务图，并调用 list_delegations 检查中断委派。对中断委派先核对已有进展，再用 resume_delegation 恢复；对 pending 的任务按依赖和成员分配调用 delegate_to_agent（team_id、member_id、team_task_id），不要重放已完成的写入或外部副作用。${this.teamHandoffBrief(team)}`
        : args.taskId
        ? `[Harness Mix collaboration · 用户操作]\n用户要求恢复中断的委派 ${args.taskId}（${mentions}）。请调用 list_delegations 确认状态后，用 resume_delegation 恢复该任务；不要重放已完成的写入或外部副作用。`
        : `[Harness Mix collaboration · 用户操作]\n用户要求继续之前中断的协作（涉及 ${mentions}）。请先调用 list_delegations 查看全部中断项，逐项判断能否安全继续：用户明确要求继续的用 resume_delegation 恢复，其余报告 task_id 与不恢复的原因；不要重放已完成的写入或外部副作用。`);
      // list() 已返回 view 投影，不可再包一层 this.view（字段名会错位）
      return { dispatched: true, interrupted, pending: pending.map(task => task.id) };
    }
    const participant = this.teamFor(threadId, args.teamId);
    if (participant.kind !== 'lead') throw new Error('团队操作仅限主导者线程');
    const { team } = participant;
    if (action === 'interrupt') {
      await rt.cancel(threadId, { interrupt: true });
      // 编排脚本随中断落 interrupted（jobs 已被级联取消，driver 在下一个 tick 停）；
      // journal 保留，「继续协作」按 seq 重放
      if (team.driver?.status === 'running') team.driver.stop = true;
      return this.teamView(team);
    }
    if (action === 'task/insert') {
      const input = validators.get('assign_team_task').parse({ team_id: team.id, title: args.title, description: args.description, assignee: args.memberId, depends_on: args.dependsOn ?? [] });
      if (!input.title.trim() || !input.description.trim()) throw new Error('任务标题和描述不能为空');
      const assignee = this.resolveMember(team, input.assignee);
      const dependencies = [...new Set(input.depends_on ?? [])];
      if (dependencies.some(id => !team.tasks.some(task => task.id === id))) throw new Error('未知的依赖任务');
      const task = { id: randomUUID(), title: input.title.trim(), description: input.description, assignee: assignee.id, dependsOn: dependencies, status: dependencies.every(id => team.tasks.find(entry => entry.id === id)?.status === 'completed') ? 'pending' : 'blocked', createdAt: Date.now(), updatedAt: Date.now() };
      team.tasks.push(task);
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_assigned');
      return { task, team: this.teamView(team) };
    }
    if (action === 'task/cancel') {
      const task = team.tasks.find(entry => entry.id === args.taskId);
      if (!task) throw new Error('未知的团队任务');
      const job = [...this.jobs.values()].find(entry => entry.teamId === team.id && entry.teamTaskId === task.id && entry.status === 'running');
      if (job) await this.cancel(job);
      else if (task.status === 'in_progress') {
        // 防御：in_progress 但无运行作业（状态簿记损坏）——直接归位并广播，
        // 不让任务永久卡在进行中
        task.status = 'pending'; task.updatedAt = Date.now();
        const member = team.members.find(entry => entry.id === task.assignee);
        if (member?.status === 'working') member.status = 'ready';
        this.refreshTeamStatus(team);
        await this.publishTeam(team, 'task_cancelled');
      } else throw new Error('仅进行中的任务可以取消');
      return this.teamView(team);
    }
    if (action === 'task/reassign') {
      const task = team.tasks.find(entry => entry.id === args.taskId);
      if (!task) throw new Error('未知的团队任务');
      if (!['failed', 'interrupted', 'pending'].includes(task.status)) throw new Error('运行中或已完成的任务不能改派；请先取消或等待其结算');
      const target = this.resolveMember(team, args.memberId);
      if ([...this.jobs.values()].some(entry => entry.teamId === team.id && entry.memberId === target.id && entry.status === 'running')) throw new Error(`成员 ${target.name} 正在执行其他任务，不能改派`);
      if (rt.execution.isRunning(threadId)) throw new Error('主导者回合进行中，请在回合结束后改派');
      if (target.id !== task.assignee) { task.reassignedFrom = task.assignee; task.assignee = target.id; }
      task.status = task.dependsOn.some(id => team.tasks.find(entry => entry.id === id)?.status !== 'completed') ? 'blocked' : 'pending';
      task.result = undefined; task.updatedAt = Date.now();
      this.refreshTeamStatus(team);
      await this.publishTeam(team, 'task_reassigned');
      dispatch(`[Harness Mix collaboration · 用户改派]\n用户在团队看板上将任务「${task.title}」改派给成员 ${target.name}（Harness: #${target.agent}）。该任务已重置为待开始。请立即调用 delegate_to_agent 派发它：team_id=${team.id}、member_id=${target.id}、team_task_id=${task.id}、agent_type=${target.agent}，任务描述写明目标${args.note ? `，并纳入用户备注：${args.note}` : ''}。${task.reassignedFrom ? '任务此前已部分执行过，派发时说明不要重复已完成的步骤。' : ''}`);
      return this.teamView(team);
    }
    if (action === 'message/send') {
      if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('消息内容不能为空');
      if (args.kind && !['text', 'handoff', 'review-request', 'review-result'].includes(args.kind)) throw new Error('未知的消息类型');
      const to = args.to ?? '*';
      if (to !== '*') this.resolveMember(team, to);
      // 以 lead 身份发出：teamCall 以 team.owner 为 principal 解析为 lead
      return this.teamCall(team.owner, 'send_team_message', { team_id: team.id, to, message: args.message, ...(args.kind ? { kind: args.kind } : {}) });
    }
    if (action === 'message/ack') {
      if (args.memberId) this.resolveMember(team, args.memberId);
      const cleared = this.acknowledgeMemberMail(team, args.memberId ?? null);
      if (cleared) { team.updatedAt = Date.now(); await this.publishTeam(team, 'message_acknowledged'); }
      else await this.saveTeams();
      return this.teamView(team);
    }
    throw new Error('未知的用户操作');
  }

  view(job) {
    const pending = job.childId ? this.runtime.core.interactions?.pending(job.childId)?.[0] : null;
    return { task_id: job.id, parent_thread_id: job.owner, child_thread_id: job.childId, agent_type: job.agent, status: job.status,
      team_id: job.teamId, member_id: job.memberId, team_task_id: job.teamTaskId,
      display_status: pending ? 'waiting_approval' : job.status, attention: pending ? { type: pending.type, title: pending.title, message: pending.message } : undefined,
      task: job.task, workspace: job.workspace, applied: !!job.appliedDigest, result: job.result, error: job.error,
      diff: job.diff, digest: job.digest, branch: job.workspace?.branch, verification: job.verification,
      script_id: job.scriptId, handoff: job.handoff };
  }

  async call(principal, name, args) {
    await this.initialize();
    if (this.closing) throw new Error('Host is closing');
    if (!validators.has(name)) throw new Error('Unknown collaboration tool');
    if (!this.prefs.collaboration) {
      throw new Error('多 Agent 协作已在设置中停用（设置 → 协作）。Multi-Agent collaboration is disabled in Settings → Collaboration.');
    }
    args = validators.get(name).parse(args);
    const rt = this.runtime;
    const teamTools = TEAM_TOOL_NAMES;
    const participant = this.participant(principal, args.team_id);
    const owner = participant?.team.owner ?? principal;
    const parent = rt.threads.find(t => t.id === owner);
    if (teamTools.has(name)) {
      if (name === 'create_agent_team' && !this.prefs.agentTeam) {
        throw new Error('Agent Team 已在设置中停用（设置 → 协作）。Agent Team is disabled in Settings → Collaboration; one-shot delegation remains available.');
      }
      if (!rt.execution.isRunning(principal) || (principal === owner && this.cancelling.has(owner))) throw new Error('Collaboration turn is no longer active');
      return this.teamCall(principal, name, args);
    }
    if (!parent || principal !== owner || parent.parentThreadId) throw new Error('Only lead tasks can delegate');
    if (!rt.execution.isRunning(principal) || this.cancelling.has(owner)) throw new Error('Collaboration turn is no longer active');
    if (name === 'list_agents') return [...rt.adapters.values()].map(a => ({ agent_type: a.manifest.id, name: a.manifest.name, available: !!rt.status[a.manifest.id]?.available, team_capable: !!a.manifest.capabilities?.collaborationTools }));
    if (name === 'list_delegations') return this.list(owner);
    if (name === 'update_agent_plan') {
      rt.emitCollaboration(owner, { kind: 'plan', entries: args.steps });
      return { steps: args.steps };
    }
    if (name === 'delegate_to_agent') {
      const agent = rt.resolveHarnessId(args.agent_type);
      if (!agent || !rt.status[agent]?.available) throw new Error('Target Harness unavailable');
      // Server-side enforcement: multi-agent collaboration can ONLY start when the user explicitly selected/mentioned agents.
      if (!parent.activeMentions || !parent.activeMentions.length) {
        throw new Error('跨 Harness 协作仅在用户显式选择 Agent，或在团队/委派语境中明确写出 Harness 名称时允许启动（例如 #pi #claude，或“用 Pi 开发、Claude 审查组成团队”）。用户本轮未显式委派，不能由大模型自行决定启动跨 Harness 协作。');
      }
      if (!parent.activeMentions.includes(agent)) {
        throw new Error(`用户仅显式指定了 [${parent.activeMentions.join(', ')}]，不能委派给未指定的 "${agent}"。请向用户确认是否需要委派给其他 Harness。`);
      }
      let team, member, teamTask, previousMemberJob;
      const teamFields = [args.team_id, args.member_id, args.team_task_id].filter(Boolean).length;
      if (teamFields && teamFields !== 3) throw new Error('Agent Team delegation requires team_id, member_id and team_task_id together');
      if (teamFields) {
        ({ team } = this.teamFor(owner, args.team_id));
        if (team.driver?.status === 'running') throw new Error('该团队正在运行编排脚本（Host 驱动），Lead 直接委派被独占；请等脚本结束、失败或中断团队后再派发');
        member = this.resolveMember(team, args.member_id);
        teamTask = team.tasks.find(entry => entry.id === args.team_task_id);
        if (!teamTask || teamTask.assignee !== member.id) throw new Error('Team task is not assigned to this member');
        if (member.agent !== agent) throw new Error('Delegated Harness does not match the team member');
        if (member.childId && !rt.threads.some(thread => thread.id === member.childId)) delete member.childId;
        previousMemberJob = member.childId ? [...this.jobs.values()].reverse().find(job => job.teamId === team.id && job.memberId === member.id && job.childId === member.childId) : null;
        if (teamTask.dependsOn.some(id => team.tasks.find(entry => entry.id === id)?.status !== 'completed')) throw new Error('Team task dependencies are not complete');
        if (teamTask.status === 'completed') throw new Error('Team task is already completed');
        if (teamTask.status === 'in_progress') throw new Error('Team task is already running');
        if ([...this.jobs.values()].some(job => job.teamId === team.id && job.memberId === member.id && job.status === 'running')) throw new Error('Team member is already working on another task');
      }
      const jobs = [...this.jobs.values()].filter(j => j.owner === owner);
      if (jobs.filter(j => j.status === 'running').length >= MAX_CONCURRENT_SUBTASKS) throw new Error('At most six concurrent subtasks; collect existing results first');
      if (jobs.filter(j => j.turnId === rt.execution.lastTurn(owner)?.id).length >= MAX_SUBTASKS_PER_TURN) throw new Error('At most sixteen subtasks per lead turn');
      // Risk-aware default: while another session outside this collaboration group is
      // actively running in the lead directory, a shared workspace would let both sides
      // silently overwrite each other — start new workers isolated ('auto' isolates Git
      // projects into a worktree and falls back to shared only outside Git). A teammate's
      // inherited workspace and an explicit isolation argument still win over the default.
      const externalActive = rt.threads.some(t => t.id !== owner && t.parentThreadId !== owner && !this.isParticipant(t, owner)
        && String(t.cwd).toLowerCase() === String(parent.cwd).toLowerCase()
        && (rt.execution.isRunning(t.id) || t.reviewPending));
      const job = { id: randomUUID(), owner, agent, turnId: rt.execution.lastTurn(owner).id, status: 'running', task: args.task,
        isolation: previousMemberJob?.isolation ?? args.isolation ?? (externalActive ? 'auto' : 'shared'),
        ...(previousMemberJob?.workspace ? { workspace: previousMemberJob.workspace } : {}),
        ...(team ? { teamId: team.id, memberId: member.id, teamTaskId: teamTask.id, ...(member.childId ? { childId: member.childId } : {}) } : {}) };
      this.jobs.set(job.id, job);
      if (team) {
        teamTask.status = 'in_progress'; teamTask.jobId = job.id; teamTask.updatedAt = Date.now();
        member.status = 'working'; this.refreshTeamStatus(team);
        await this.publishTeam(team, 'task_started');
      }
      await this.save();
      const teamPrompt = team ? this.teamEnvelope(team, member, teamTask, args.task) : args.task;
      job.done = this.run(parent, job, teamPrompt);
      return this.view(job);
    }
    if (name === 'get_delegation_status') {
      const jobs = args.task_ids.map(id => this.owned(owner, id));
      const until = Date.now() + (args.wait_ms ?? 0);
      while (jobs.every(j => j.status === 'running') && Date.now() < until && !this.closing && !this.cancelling.has(owner) && rt.execution.isRunning(owner)) await delay(Math.min(100, until - Date.now()));
      return jobs.map(j => this.view(j));
    }
    const job = this.owned(owner, args.task_id);
    if (name === 'cancel_delegation') { await this.cancel(job); return this.view(job); }
    if (name === 'review_delegation_changes') return this.review(job.id);
    if (name === 'apply_delegation_changes') return this.apply(job.id, args.digest);
    if (name === 'resume_delegation' && job.status !== 'interrupted') throw new Error('Only interrupted tasks can be resumed');
    if (job.handshaking) throw new Error('成员正在生成中断收尾交接，请稍候再恢复');
    if (job.status === 'running' || job.cancelling || job.followupPending || job.applying) throw new Error('Subtask still running; wait before sending a follow-up');
    if (job.appliedDigest) throw new Error('Applied task is closed; delegate a new task for further changes');
    if (!job.childId && name !== 'resume_delegation') throw new Error('Subtask did not create a session; resume or delegate a new task');
    job.followupPending = true;
    try { await job.done; } finally { job.followupPending = false; }
    if (this.closing || !rt.execution.isRunning(owner) || this.cancelling.has(owner)) throw new Error('Lead turn is no longer active');
    if ([...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running').length >= MAX_CONCURRENT_SUBTASKS) throw new Error('At most six concurrent subtasks');
    job.status = 'running'; job.result = undefined; job.error = undefined;
    job.turnId = rt.execution.lastTurn(owner).id;
    const task = name === 'resume_delegation'
      ? `Continue the interrupted task in this existing workspace. Inspect existing progress before acting; do not repeat completed side effects.${job.handoff ? `\n\n[Worker handoff at interruption — the worker's own account; verify against the actual workspace before acting]\n${job.handoff}` : ''}\nOriginal task:\n${job.task}`
      : args.task;
    if (name !== 'resume_delegation') job.task = task;
    if (job.teamId) {
      const team = this.teams.get(job.teamId);
      const member = team?.members.find(entry => entry.id === job.memberId);
      const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
      if (member) member.status = 'working';
      if (teamTask) { teamTask.status = 'in_progress'; teamTask.updatedAt = Date.now(); }
      if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, name === 'resume_delegation' ? 'task_resumed' : 'task_followup'); }
    }
    await this.save();
    job.done = this.run(parent, job, task);
    return this.view(job);
  }

  async run(parent, job, task) {
    const rt = this.runtime;
    const turnId = job.turnId;
    const title = `Agent 协作 · ${rt.adapters.get(job.agent).manifest.name}`;
    // 「创建智能体」(spawnAgent) 与「执行中」(sendInput) 是两个独立的投影 item：
    // spawn 在子会话就绪后立即结算为 done，否则 Desktop 原生协作卡片会在整个
    // 执行期间一直停留在「创建中 N 个智能体」。
    const spawnCallId = `collaboration:${randomUUID()}`;
    const workCallId = `collaboration:${randomUUID()}`;
    const emit = (event, operation, toolCallId) => {
      if (rt.execution.lastTurn(parent.id)?.id === turnId) rt.emitCollaboration(parent.id, { ...event,
        collaboration: { ...this.view(job), operation } });
    };
    // 已有子会话的后续输入（message_agent / resume / 团队持久成员）不涉及创建。
    let spawnSettled = !!job.childId;
    try {
      if (!job.workspace) {
        job.workspace = await createWorkspace(parent.cwd, job.id, job.isolation);
        await this.save();
      }
      const workerOptions = workerSessionOptions(job.agent);
      if (!spawnSettled) emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'running', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
      // resume/follow-up 时既有子会话可能已被删除：回落新建替代会话（同一 Harness、
      // 同一工作区），而不是永久报错把该作业废弃
      const child = (job.childId && rt.threads.find(t => t.id === job.childId)) || await rt.createThread({
        harnessId: job.agent, cwd: job.workspace.cwd, title: `${parent.title} › ${task.slice(0, 40)}`, parentThreadId: parent.id,
        options: workerOptions,
        onCreated: async thread => {
          job.childId = thread.id;
          const team = job.teamId ? this.teams.get(job.teamId) : null;
          const member = team?.members.find(entry => entry.id === job.memberId);
          if (member) { member.childId = thread.id; member.status = 'working'; team.updatedAt = Date.now(); await this.publishTeam(team, 'member_session_ready'); }
          await this.save();
        }
      });
      job.childId = child.id;
      await this.save();
      if (!spawnSettled) {
        emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'done', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
        spawnSettled = true;
      }
      emit({ kind: 'tool', toolCallId: workCallId, title, input: task, state: 'running', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId);
      // 终态保持：cancel()/close() 已写入的 cancelled/interrupted 不得在此被覆写——
      // 关机竞态下覆写成 cancelled 会让重启后的 resume_delegation 拒绝恢复该作业。
      // 编排脚本与团队持久成员的作业都独立于 Lead 回合存活：脚本由 driver 监督；
      // 团队成员遵循信箱模型（deliverToMember 已支持 Lead 回合外直投），在 Lead
      // 回合之间继续执行并自行更新任务状态，任务落定时再唤醒空闲 Lead 交接。
      // 仅显式中断（cancelling/interruptOwners）与关停才级联取消。
      const scriptSupervised = () => !!job.scriptId && this.teams.get(job.teamId)?.driver?.status === 'running';
      const teamSupervised = () => !!job.teamId && !this.closing;
      const supervised = () => scriptSupervised() || teamSupervised();
      if (job.status !== 'running' || this.closing) {
        if (job.status === 'running') {
          job.status = 'interrupted';
          await this.settleStoppedJob(job);
        }
        return;
      }
      if (!rt.execution.isRunning(parent.id) && !supervised()) {
        job.status = 'cancelled';
        await this.settleStoppedJob(job);
        return;
      }
      // Child native file events remain visible; only the lead snapshots the shared workspace.
      // 成员会话可能被并发占用（邮箱投递泵、用户追问、上一回合结算尾部，或 isRunning
      // 已清而 sending 锁未释放的结算窗口）：busy 拒绝等空闲后重试（≤10s），而不是把
      // 「任务正在执行」误判为任务失败（改派/重派紧跟失败结算时尤其容易触发）
      let sendDone = false, sendError, sendRetrying = false;
      const dispatchInput = async () => {
        for (let attempt = 0; ; attempt++) {
          // 作业已取消/停止后不得再投递：忙等重试期间取消结算会让成员恰好空闲，
          // 无此守卫时重试会突然成功，在已取消的作业下留下无人监督的僵尸回合
          if (job.status !== 'running' || job.cancelling || this.cancelling.has(parent.id) || this.closing) throw new Error('Subtask cancelled before dispatch');
          try {
            // 编排脚本/团队成员作业可能在 Lead 回合结束后才派发：collaborationOf 只在
            // Lead 回合活动时携带，否则 #send 以「协作父任务已结束」拒绝——回落成员
            // 独立成回合的路径（与邮箱投递的降级分支一致）
            const collaborationOf = (job.scriptId || job.teamId) && !rt.execution.isRunning(parent.id) ? undefined : parent.id;
            return await rt.send(child.id, task, { collaborationOf, isolated: job.workspace.mode === 'worktree' });
          } catch (error) {
            if (!/任务正在执行/.test(String(error?.message ?? error)) || attempt >= 100) throw error;
            sendRetrying = true;
            await delay(100);
            sendRetrying = false;
          }
        }
      };
      const sending = dispatchInput();
      void sending.then(() => { sendDone = true; }, error => { sendDone = true; sendError = error; });
      const timeoutMs = rt.delegationTimeoutMs ?? 30 * 60 * 1000;
      const until = Date.now() + timeoutMs;
      let displayedStatus = 'running';
      let turnInactiveSince = null;
      while (job.status === 'running' && !this.closing && !this.cancelling.has(parent.id) && (rt.execution.isRunning(parent.id) || supervised())) {
        // 已删除的 worker 线程：core 回合可能仍呈 running 态（removeThread 不结算回合），
        // 不得据此继续等待，否则作业空转到超时
        const childRunning = rt.threads.some(t => t.id === child.id) && (rt.execution.isRunning(child.id) || child.reviewPending);
        if (!childRunning) {
          if (!turnInactiveSince) turnInactiveSince = Date.now();
          // sendRetrying 期间不按「子回合静默」提前结算：投递还在等成员空闲
          if (sendDone || (!sendRetrying && Date.now() - turnInactiveSince > 2000)) break;
        } else {
          turnInactiveSince = null;
        }
        const current = this.view(job).display_status;
        if (current !== displayedStatus) { displayedStatus = current; emit({ kind: 'tool', toolCallId: workCallId, state: 'running', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId); }
        if (Date.now() > until) {
          // 先落失败再取消子线程：runtime.cancel 会把 running 作业标记为 cancelled，
          // 若先取消后抛错，catch 的记录分支（仅认 running）会吞掉超时错误并误报已取消
          job.status = 'failed';
          job.error = `Subtask timed out after ${Math.round(timeoutMs / 60000)} minutes`;
          await rt.cancel(child.id);
          throw new Error(job.error);
        }
        // 顺带泵送排队消息：其他成员可能已空闲（不打断任何人运行中的回合）
        if (job.teamId) this.drainTeamMailbox(this.teams.get(job.teamId));
        await delay(100);
      }
      if (job.status !== 'running') return;
      if (!rt.threads.some(t => t.id === child.id)) {
        // 子线程在执行中被删除：按停止结算，而不是把未完成的 core 回合误判为 completed
        job.status = 'cancelled';
        await this.settleStoppedJob(job);
        return;
      }
      if (sendError) throw sendError;
      const turn = rt.execution.lastTurn(child.id);
      if (!turn || turn.status === 'error') throw new Error(turn?.error || child.error || 'Subtask failed');
      job.status = turn.status === 'cancelled' ? 'cancelled' : 'completed';
      const messages = rt.core.getItemsForTurn(turn.id).filter(i => i.type === 'agent_message');
      const finals = messages.filter(i => i.phase === 'final');
      job.result = (finals.length ? finals : messages).map(i => i.content || '').join('\n').slice(0, 48000);
      if (job.teamId) {
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member) member.status = 'ready';
        if (teamTask && teamTask.status === 'in_progress') {
          teamTask.status = job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'pending' : 'failed';
          teamTask.result = job.result;
          teamTask.updatedAt = Date.now();
          for (const candidate of team.tasks) {
            if (candidate.status === 'blocked' && candidate.dependsOn.every(id => team.tasks.find(entry => entry.id === id)?.status === 'completed')) candidate.status = 'pending';
          }
        }
        if (team) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_settled'); this.drainTeamMailbox(team); }
        if (team && !job.scriptId) void this.wakeLeadForTask(team, job);
      }
      if (job.workspace?.mode === 'worktree' && job.status === 'completed') {
        try {
          const rev = await reviewWorkspace(job.workspace);
          job.diff = rev.patch;
          job.digest = rev.digest;
        } catch {}
      }
    } catch (error) {
      if (job.status === 'running') { job.status = 'failed'; job.error = error.message; }
      if (job.teamId) {
        const team = this.teams.get(job.teamId);
        const member = team?.members.find(entry => entry.id === job.memberId);
        const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
        if (member && member.status !== 'interrupted') member.status = 'ready';
        let retried = false;
        if (teamTask && teamTask.status === 'in_progress') {
          // 失败必达：system 通知先进 lead 邮箱，再决定自动重派或落 failed
          retried = await this.retryTeamTask(parent, job, team, member, teamTask, error);
        }
        if (teamTask && !retried) { teamTask.status = 'failed'; teamTask.result = error.message; teamTask.updatedAt = Date.now(); }
        if (team && !retried) { this.refreshTeamStatus(team); await this.publishTeam(team, 'task_failed'); this.drainTeamMailbox(team); }
        if (team && !retried && !job.scriptId) void this.wakeLeadForTask(team, job);
      }
    }
    finally {
      await this.save();
      // 创建阶段失败（如原生会话启动报错）时，把仍在「创建中」的 spawn 卡片结算为错误。
      if (!spawnSettled) emit({ kind: 'tool', toolCallId: spawnCallId, title, input: task, state: 'error', output: JSON.stringify(this.view(job)) }, 'spawnAgent', spawnCallId);
      emit({ kind: 'tool', toolCallId: workCallId, title, state: job.status === 'completed' ? 'done' : 'error', output: JSON.stringify(this.view(job)) }, 'sendInput', workCallId);
    }
  }

  // 团队委派的任务信封：成员身份 + 共享图约定（call() 的首次派发与失败重派共用）
  teamEnvelope(team, member, teamTask, baseTask) {
    return `${baseTask}\n\n[Harness Mix Agent Team]\nTeam: ${team.name} (${team.id})\nShared goal: ${team.goal}\nYou are ${member.name}. Role: ${member.role}\nAssigned task: ${teamTask.title} (${teamTask.id})\nYou are a persistent teammate, not a one-shot subagent. Read shared state with get_team_state, update your assigned task with update_team_task, and coordinate directly with teammates through send_team_message. Do not create or assign team members.`;
  }

  // system 伪参与者通知：不进 roster、不投递，只进邮箱与团队动态，供 lead 免轮询看到失败
  pushSystemNotice(team, body, taskId) {
    team.messages.push({ id: randomUUID(), from: 'system', fromName: 'Harness Mix', to: 'lead', kind: 'text', body, ...(taskId ? { taskId } : {}), at: Date.now(), delivery: 'mailbox' });
    if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
  }

  // 失败结算的统一入口：先投 system 通知，再按 retry 预算决定自动重派（同一成员，
  // 复用其会话与工作区，附上次失败原因）或落 failed。返回 true 表示已重新派发。
  // 重派仍处于同一 lead 回合内（run() 的监管前提），预算只在真正重新派发时消耗。
  async retryTeamTask(parent, failedJob, team, member, teamTask, error) {
    if (!team || !teamTask || failedJob.status !== 'failed') return false;
    const rt = this.runtime;
    const reason = String(error?.message ?? error ?? 'unknown failure');
    const budget = teamTask.retry;
    const canRetry = !!budget && budget.used < budget.max && member
      && !this.closing && !this.cancelling.has(parent.id) && rt.execution.isRunning(parent.id)
      && rt.status[member.agent]?.available !== false
      && [...this.jobs.values()].filter(j => j.owner === parent.id && j.status === 'running').length < MAX_CONCURRENT_SUBTASKS;
    this.pushSystemNotice(team, `任务「${teamTask.title}」失败：${reason}${canRetry ? `；将自动重试（第 ${budget.used + 1}/${budget.max} 次）` : budget ? '；重试预算已耗尽' : ''}`, teamTask.id);
    if (!canRetry) return false;
    budget.used += 1;
    const retryJob = { id: randomUUID(), owner: parent.id, agent: failedJob.agent, turnId: rt.execution.lastTurn(parent.id)?.id,
      status: 'running', task: failedJob.task, isolation: failedJob.isolation,
      ...(failedJob.workspace ? { workspace: failedJob.workspace } : {}),
      teamId: team.id, memberId: failedJob.memberId, teamTaskId: teamTask.id,
      ...(failedJob.childId && rt.threads.some(t => t.id === failedJob.childId) ? { childId: failedJob.childId } : {}) };
    this.jobs.set(retryJob.id, retryJob);
    teamTask.status = 'in_progress'; teamTask.jobId = retryJob.id; teamTask.updatedAt = Date.now();
    if (member) member.status = 'working';
    this.refreshTeamStatus(team);
    await this.publishTeam(team, 'task_retry');
    await this.save();
    retryJob.done = this.run(parent, retryJob, this.teamEnvelope(team, member, teamTask,
      `Previous attempt failed: ${reason}\nInspect what was already done; do not repeat completed side effects and avoid the failure path.\n\nOriginal task:\n${retryJob.task}`));
    return true;
  }

  // 所有「作业在运行中被外力终止」的路径（取消工具、lead 停止级联、用户直接停止/
  // 删除 worker 线程、宿主关机）共用的收尾：团队图里不得残留 in_progress 的任务——
  // 否则该成员永远无法被再次委派（delegate_to_agent 会以 already running 拒绝）。
  async settleStoppedJob(job) {
    if (job.teamId) {
      const team = this.teams.get(job.teamId);
      const member = team?.members.find(entry => entry.id === job.memberId);
      const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
      const interrupted = job.status === 'interrupted';
      const memberStatus = interrupted ? 'interrupted' : 'ready';
      let changed = false;
      if (member && member.status !== memberStatus) { member.status = memberStatus; changed = true; }
      if (teamTask?.status === 'in_progress') { teamTask.status = interrupted ? 'interrupted' : 'pending'; teamTask.updatedAt = Date.now(); changed = true; }
      if (team && changed) { this.refreshTeamStatus(team); await this.publishTeam(team, interrupted ? 'task_interrupted' : 'task_cancelled'); }
      // 取消/中断 unwind 后成员空闲：泵送排队消息（lead 已停则按语义降级回邮箱）
      if (team) this.drainTeamMailbox(team);
    }
    await this.save();
  }

  async cancel(job, { interrupt = false } = {}) {
    if (job.status !== 'running') return;
    job.status = this.closing || interrupt ? 'interrupted' : 'cancelled';
    job.cancelling = true;
    try {
      if (job.childId) {
        await Promise.race([
          this.runtime.cancel(job.childId),
          new Promise(r => setTimeout(r, 3_000)),
        ]).catch(() => {});
      }
    } finally {
      job.cancelling = false;
      await this.settleStoppedJob(job);
      // 编排脚本拥有的作业被停止时同步叫停 driver：解释器与派发等待在下一个
      // tick/轮询点退出，driver 落 interrupted，交由「继续协作」重放
      if (job.scriptId) {
        const team = this.teams.get(job.teamId);
        if (team?.driver?.status === 'running') team.driver.stop = true;
      }
      // 中断（可恢复语义）的团队子任务在子回合停稳后，异步发起一次有界收尾握手：
      // 让成员自述交接并写回任务图与 lead 邮箱。握手是中断的增益而非前置——任何
      // 失败（会话已删、发送被拒、超时）都静默放弃，不阻塞也不推翻中断结果。
      // 用户在任务卡上主动取消（task/cancel → cancel 默认 interrupt=false）与宿主
      // 关机不握手：前者语义是放弃，后者必须立即退出。
      if (interrupt && !this.closing && job.teamId && job.childId) void this.collectHandoff(job).catch(() => {});
    }
  }

  handoffEnvelope(team, member, teamTask) {
    return `[Harness Mix Agent Team handoff]\nThe team is being interrupted, but your task stays resumable. Reply now with a short handoff note for the Team Lead as your final answer. Do not read or write files, run commands, or call any tools. In plain text, cover: (1) what you already completed on task "${teamTask.title}", (2) what was in progress when interrupted, (3) blockers or open questions, (4) the next concrete step for whoever resumes.`;
  }

  // 收尾握手：向刚被中断的成员原生会话发一个独立收尾回合，把成员自述的交接
  // （已完成/进行中/阻塞/下一步）落在作业、团队任务与 lead 邮箱三处，供
  // resume_delegation 与「继续协作」在恢复时直接引用，而不是从任务状态重建。
  async collectHandoff(job) {
    const rt = this.runtime;
    const team = this.teams.get(job.teamId);
    const member = team?.members.find(entry => entry.id === job.memberId);
    const teamTask = team?.tasks.find(entry => entry.id === job.teamTaskId);
    if (!team || !member || !teamTask) return;
    const child = rt.threads.find(t => t.id === job.childId);
    if (!child || rt.execution.isRunning(child.id)) return;
    job.handshaking = true;
    let aborted = false;
    try {
      const deadline = Date.now() + (rt.handshakeTimeoutMs ?? 90_000);
      const send = async () => {
        for (let attempt = 0; ; attempt++) {
          if (aborted || this.closing) return;
          try {
            await rt.send(job.childId, this.handoffEnvelope(team, member, teamTask), { isolated: job.workspace?.mode === 'worktree' });
            return;
          } catch (error) {
            // cancel 刚放锁，原生侧结算存在毫秒级窗口：沿用 run() 的 busy 重试等空闲
            if (aborted || this.closing || !/任务正在执行/.test(String(error?.message ?? error)) || Date.now() > deadline) throw error;
            await delay(100);
          }
        }
      };
      const sent = await Promise.race([send().then(() => true, () => false), delay(deadline - Date.now()).then(() => null)]);
      if (sent !== true || this.closing) {
        aborted = true;
        void rt.cancel(job.childId).catch(() => {});
        return;
      }
      // adapter.send 已返回但回合事件可能尚在途：有界等待子回合真正结算再取终答
      while (!this.closing && rt.execution.isRunning(job.childId) && Date.now() < deadline) await delay(100);
      if (this.closing || rt.execution.isRunning(job.childId)) {
        if (rt.execution.isRunning(job.childId)) void rt.cancel(job.childId).catch(() => {});
        return;
      }
      const turn = rt.execution.lastTurn(job.childId);
      if (!turn || turn.status === 'cancelled' || turn.status === 'error') return;
      const messages = rt.core.getItemsForTurn(turn.id).filter(i => i.type === 'agent_message');
      const finals = messages.filter(i => i.phase === 'final');
      const text = (finals.length ? finals : messages).map(i => i.content || '').join('\n').slice(0, 8000).trim();
      if (!text) return;
      job.handoff = text;
      teamTask.handoff = text;
      teamTask.updatedAt = Date.now();
      // 以成员身份落入 lead 邮箱（kind=handoff）：不进 roster、不重置未读，Workbench
      // 通信流按成员消息渲染，恢复回合由 teamHandoffBrief 汇总引用
      team.messages.push({ id: randomUUID(), from: member.id, fromName: member.name, to: 'lead', kind: 'handoff', body: text, taskId: teamTask.id, at: Date.now(), delivery: 'mailbox', deliveryBy: {} });
      if (team.messages.length > 200) team.messages.splice(0, team.messages.length - 200);
      await this.save();
      await this.publishTeam(team, 'member_handoff');
    } finally {
      job.handshaking = false;
    }
  }

  // 「继续协作」指令里附带的交接摘要：中断握手留下的成员自述，恢复时先核对再行动
  teamHandoffBrief(team) {
    const notes = [];
    for (const task of team.tasks) {
      if (!task.handoff) continue;
      const member = team.members.find(entry => entry.id === task.assignee);
      notes.push(`- 任务「${task.title}」（${member?.name ?? task.assignee}）的成员交接：${String(task.handoff).slice(0, 600)}`);
    }
    return notes.length ? `\n中断时成员留下的收尾交接（成员自述；恢复前先核对，与实际进度不符处以文件系统为准）：\n${notes.join('\n')}` : '';
  }

  // ---- 编排脚本 driver：Lead 一次生成脚本，Host 确定性执行，执行期零模型调用 ----
  // 脚本编译进持久任务图（task() 即 assign_team_task + 派发），控制流在 driver；
  // journal 记控制流、任务图记副作用，重放因此可零成本落定已结算步。MCP 客户端
  // 有 70s 超时，run_team_script 必须立即返回；脚本独立于 Lead 回合存活（run()
  // 的监督条件为此放宽），完成/失败时以一次汇总回合唤醒 Lead。

  async startTeamScript(owner, team, { script }) {
    const rt = this.runtime;
    const parent = rt.threads.find(t => t.id === owner);
    if (!parent) throw new Error('Lead thread missing');
    if (team.driver?.status === 'running') throw new Error('该团队已有编排脚本在运行；请等待其完成、失败或中断团队');
    let ast;
    let taskCount = 0;
    try {
      ast = parseScript(script);
      ({ taskCount } = validateScript(ast, label => {
        try { this.resolveMember(team, label); } catch {
          throw new Error(`成员「${label}」不在团队中。可用成员：${team.members.map(member => member.name).join('、')}`);
        }
      }, { maxTasks: MAX_SUBTASKS_PER_TURN }));
    } catch (error) {
      throw new Error(`编排脚本未通过验证门：${error.message}`);
    }
    if (taskCount < 1) throw new Error('编排脚本未通过验证门：至少需要声明一个 task(...)');
    if ([...this.jobs.values()].some(j => j.teamId === team.id && j.status === 'running')) {
      throw new Error('团队成员正在执行直接委派的任务，请等其结算后再启动编排脚本');
    }
    const driver = { id: randomUUID(), teamId: team.id, owner, status: 'running', phase: null, script, ast, journal: [], seq: 0, steps: 0, inFlight: 0, stop: false, startedAt: Date.now(), result: null, error: null };
    team.driver = driver;
    await this.publishTeam(team, 'script_started');
    void this.runTeamDriver(team, driver).catch(error => {
      driver.status = 'failed';
      driver.error = error?.message ?? String(error);
      void this.saveTeams();
    });
    return {
      script_id: driver.id, status: 'running', phase: null,
      tasks: team.tasks.filter(t => t.scriptId === driver.id).map(t => ({ task_id: t.id, title: t.title, status: t.status })),
      note: 'Host 侧执行、零模型调用；完成或失败时你会收到一次汇总唤醒，期间不要轮询 get_delegation_status。',
    };
  }

  async runTeamDriver(team, driver) {
    const api = {
      tick: () => this.driverTick(driver),
      task: spec => this.driverTask(team, driver, spec),
      phase: async name => {
        const seq = driver.seq++;
        const recorded = driver.journal.find(entry => entry.seq === seq);
        if (recorded) {
          if (recorded.kind !== 'phase' || recorded.name !== name) throw new Error(`脚本重放发散：第 ${seq} 个编排原语与 journal 记录不一致；请调整脚本后重新运行`);
          return;
        }
        driver.journal.push({ seq, kind: 'phase', name });
        driver.phase = name;
        await this.publishTeam(team, 'script_phase');
      },
      state: async () => this.teamView(team),
    };
    if (!driver.ast) driver.ast = parseScript(driver.script);
    try {
      const value = await executeScript(driver.ast, api);
      // 脚本 return 不隐式等待未决任务：显式 join 全部已声明句柄，终态语义才成立。
      // 中断冒泡为 interrupted；非中断异常按脚本失败处理。
      let interruptedTail = false;
      const errors = [];
      for (const handle of [...(driver.pending ?? new Set())]) {
        try { await handle.then(() => null, error => { throw error; }); }
        catch (error) {
          if (error?.code === 'SCRIPT_INTERRUPTED') interruptedTail = true;
          else errors.push(error);
        }
      }
      if (interruptedTail || driver.stop || this.closing) {
        driver.status = 'interrupted';
        await this.publishTeam(team, 'script_interrupted');
        return;
      }
      if (errors.length) throw errors[0];
      driver.status = 'completed';
      driver.result = this.summarizeScriptValue(value);
      await this.publishTeam(team, 'script_completed');
      await this.wakeLead(team, driver, 'completed');
    } catch (error) {
      if (error?.code === 'SCRIPT_INTERRUPTED') {
        driver.status = 'interrupted';
        await this.publishTeam(team, 'script_interrupted');
        return;
      }
      driver.status = 'failed';
      driver.error = String(error?.message ?? error);
      await this.publishTeam(team, 'script_failed');
      await this.wakeLead(team, driver, 'failed');
    } finally {
      await this.saveTeams();
    }
  }

  driverTick(driver) {
    driver.steps = (driver.steps ?? 0) + 1;
    if (driver.steps > 20000) throw new Error('编排脚本超出步数预算（20000 步）');
    if (driver.stop || this.closing) throw new ScriptInterrupted();
  }

  summarizeScriptValue(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(item => this.summarizeScriptValue(item));
    if (typeof value === 'object') {
      if (typeof value.taskId === 'string') return { taskId: value.taskId, title: value.title ?? null, status: value.status ?? null };
      return JSON.parse(JSON.stringify(value)).toString?.() ?? null;
    }
    return String(value).slice(0, 2000);
  }

  /**
   * task() 原语：同步建立图任务并返回句柄（taskId 立即可用于 dependsOn），结算
   * 异步推进。重放时按 seq 命中 journal 的已结算条目直接落定（不重派）；未命中
   * 则活跑，并采纳同一 driver 留下的未完成同名任务（中断恢复语义）。
   */
  driverTask(team, driver, spec) {
    const plain = value => {
      if (value && typeof value.then === 'function') throw new Error('task(...) 的 title/description/member 不能引用未完成的 task 句柄；如需引用请先 await');
      return value;
    };
    const title = String(plain(spec?.title) ?? '').trim();
    const description = String(plain(spec?.description) ?? '');
    const memberInput = String(plain(spec?.member) ?? '').trim();
    if (!title || title.length > 160) throw new Error('task(...) 的 title 需为 1-160 个字符');
    let member;
    try { member = this.resolveMember(team, memberInput); } catch {
      throw new Error(`task(...) 成员「${memberInput}」不在团队中。可用成员：${team.members.map(entry => entry.name).join('、')}`);
    }
    const deps = [...new Set((Array.isArray(spec?.dependsOn) ? spec.dependsOn : []).map(dep => {
      if (dep && typeof dep === 'object') {
        const handle = dep.__taskHandle ?? dep;
        if (typeof handle.taskId === 'string') return handle.taskId;
      }
      if (typeof dep === 'string' && dep) return dep;
      throw new Error('dependsOn 只能引用 task(...) 句柄、其完成结果或任务 id');
    }))];
    const retryInput = spec?.retry;
    const retry = retryInput && Number.isInteger(retryInput.max) && retryInput.max >= 1 && retryInput.max <= 3 ? { max: retryInput.max, used: 0 } : null;
    const specHash = createHash('sha256').update(JSON.stringify({ title, description, member: member.id, deps, retry })).digest('hex').slice(0, 16);
    const seq = driver.seq++;
    const recorded = driver.journal.find(entry => entry.seq === seq);
    if (recorded) {
      if (recorded.kind !== 'task' || recorded.specHash !== specHash) throw new Error(`脚本重放发散：第 ${seq} 个编排原语与 journal 记录不一致；请调整脚本后重新运行`);
      return settledTaskHandle(recorded.summary);
    }
    let entry = team.tasks.find(t => t.scriptId === driver.id && t.title === title && t.assignee === member.id && t.status !== 'completed');
    if (!entry) {
      entry = { id: randomUUID(), title, description, assignee: member.id, dependsOn: deps, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), scriptId: driver.id, ...(retry ? { retry } : {}) };
      team.tasks.push(entry);
    } else {
      entry.dependsOn = deps;
      entry.description = description;
      entry.result = undefined;
      entry.updatedAt = Date.now();
    }
    entry.status = deps.every(id => team.tasks.find(t => t.id === id)?.status === 'completed') ? 'pending' : 'blocked';
    this.refreshTeamStatus(team);
    void this.publishTeam(team, 'task_assigned').catch(() => {});
    const ctx = { seq, specHash };
    let settlePromise = null;
    const handle = { taskId: entry.id, title, member: member.id, then(onFulfilled, onRejected) { return settle().then(onFulfilled, onRejected); } };
    const settle = () => settlePromise ??= this.driveScriptTask(team, driver, entry, member, ctx, handle);
    // 声明即执行：settle 在创建时启动（依赖/槽位在 driveScriptTask 内等待），
    // deref/Promise.all/终态 join 只是观察结算
    void settle().catch(() => {});
    (driver.pending ??= new Set()).add(handle);
    return handle;
  }

  async driveScriptTask(team, driver, entry, member, ctx, handle) {
    const rt = this.runtime;
    const parent = rt.threads.find(t => t.id === team.owner);
    if (!parent) throw new Error('Lead thread missing');
    // 依赖就绪 + 并发槽位 + 同成员互斥：任一不满足则每 100ms 复查；中断/关机立即退出
    for (;;) {
      if (driver.status !== 'running' || driver.stop || this.closing) throw new ScriptInterrupted();
      if (entry.status === 'blocked') {
        entry.status = entry.dependsOn.every(id => team.tasks.find(t => t.id === id)?.status === 'completed') ? 'pending' : 'blocked';
      }
      const memberBusy = [...this.jobs.values()].some(j => j.teamId === team.id && j.memberId === member.id && j.status === 'running');
      if (entry.status !== 'blocked' && driver.inFlight < MAX_CONCURRENT_SUBTASKS && !memberBusy) break;
      await delay(100);
    }
    driver.inFlight += 1;
    try {
      await this.dispatchScriptJob(parent, team, member, entry, driver);
      const job = this.jobs.get(entry.jobId);
      if (job?.done) await job.done;
      if (driver.status !== 'running' || driver.stop || this.closing) throw new ScriptInterrupted();
      if (entry.status !== 'completed' && entry.status !== 'failed') throw new ScriptInterrupted();
      const summary = {
        taskId: entry.id, title: entry.title, member: member.id, memberName: member.name,
        status: entry.status, result: typeof entry.result === 'string' ? entry.result.slice(0, 48000) : null,
        error: entry.status === 'failed' ? (typeof entry.result === 'string' ? entry.result : 'task failed') : null,
        handoff: job?.handoff ?? null,
      };
      driver.journal.push({ seq: ctx.seq, kind: 'task', specHash: ctx.specHash, taskId: entry.id, summary });
      await this.saveTeams();
      return summary;
    } finally {
      driver.inFlight -= 1;
      if (driver.pending) driver.pending.delete(handle);
    }
  }

  async dispatchScriptJob(parent, team, member, entry, driver) {
    const rt = this.runtime;
    const priorJob = [...this.jobs.values()].reverse().find(j => j.teamId === team.id && j.teamTaskId === entry.id && j.status === 'interrupted');
    let job;
    if (priorJob) {
      job = priorJob;
      job.status = 'running';
      job.result = undefined;
      job.error = undefined;
      job.turnId = rt.execution.lastTurn(parent.id)?.id ?? job.turnId ?? null;
      job.scriptId = driver.id;
      job.task = `Continue the interrupted team task in this existing workspace. Inspect existing progress before acting; do not repeat completed side effects.${job.handoff ? `\n\n[Worker handoff at interruption — the worker's own account; verify against the actual workspace]\n${job.handoff}` : ''}\nOriginal task:\n${entry.description || entry.title}`;
    } else {
      // 与 call() 的风险感知默认一致：同目录有外部会话在跑时隔离，否则共享
      const externalActive = rt.threads.some(t => t.id !== parent.id && t.parentThreadId !== parent.id && !this.isParticipant(t, parent.id)
        && String(t.cwd).toLowerCase() === String(parent.cwd).toLowerCase()
        && (rt.execution.isRunning(t.id) || t.reviewPending));
      job = { id: randomUUID(), owner: parent.id, agent: member.agent, turnId: rt.execution.lastTurn(parent.id)?.id ?? null, status: 'running',
        task: entry.description || entry.title, isolation: externalActive ? 'auto' : 'shared',
        teamId: team.id, memberId: member.id, teamTaskId: entry.id, scriptId: driver.id };
      this.jobs.set(job.id, job);
    }
    entry.status = 'in_progress';
    entry.jobId = job.id;
    entry.updatedAt = Date.now();
    member.status = 'working';
    this.refreshTeamStatus(team);
    await this.publishTeam(team, 'task_started');
    await this.save();
    job.done = this.run(parent, job, this.teamEnvelope(team, member, entry, job.task));
    return job;
  }

  /**
   * 团队成员任务在 Lead 回合之外落定（Lead 自然收尾后成员继续执行的信箱模型）时
   * 唤醒空闲 Lead 交接结果：调度新解锁任务或完成最终验收。Lead 回合仍在运行时不
   * 唤醒（运行中的 Lead 经自身工具等待/轮询看到结算）；Lead 上一回合被取消或出错
   * 时维持降级语义——不把用户刚中止的协作再拉起来（与 deliverToMember 一致）。
   */
  async wakeLeadForTask(team, job) {
    const rt = this.runtime;
    if (this.closing || rt.execution.isRunning(team.owner)) return;
    const lastTurn = rt.execution.lastTurn(team.owner);
    if (['cancelled', 'error'].includes(lastTurn?.status ?? 'completed')) return;
    const task = team.tasks.find(entry => entry.id === job.teamTaskId);
    const member = team.members.find(entry => entry.id === job.memberId);
    const mention = [...new Set(team.members.map(entry => entry.agent))].map(agent => `#${agent}`).join(' ');
    const settled = task?.status === 'completed' ? '已完成' : `已落定（${task?.status ?? job.status}）`;
    const text = `[Harness Mix collaboration · 团队任务${task?.status === 'completed' ? '完成' : '落定'}]\n${mention}\n`
      + `团队成员「${member?.name ?? job.memberId}」的任务「${task?.title ?? job.teamTaskId}」${settled}。结果摘录（勿重放已完成的写入）：\n`
      + `${String(task?.result ?? job.result ?? '').slice(0, 2000)}\n\n`
      + '请用 get_team_state 核对共享任务图：调度新解锁的任务（delegate_to_agent，携带 team_id/member_id/team_task_id），或在其全部落定后完成最终验收与汇总。';
    for (let attempt = 0; attempt < 600 && !this.closing; attempt++) {
      if (!rt.execution.isRunning(team.owner)) {
        try { await rt.send(team.owner, text, {}); return; } catch { /* Lead 忙/竞态：稍后重试 */ }
      }
      await delay(100);
    }
  }

  /** 脚本终态后的一次性 Lead 唤醒：等 Lead 空闲后注入汇总回合（约 60s 内重试） */
  async wakeLead(team, driver, outcome) {
    const rt = this.runtime;
    const agents = [...new Set(team.members.map(member => member.agent))];
    const mention = agents.map(agent => `#${agent}`).join(' ');
    const tasks = team.tasks.filter(t => t.scriptId === driver.id);
    const lines = tasks.map(task => {
      const member = team.members.find(entry => entry.id === task.assignee);
      const result = task.status === 'completed' || task.status === 'failed' ? `- 「${task.title}」（${member?.name ?? task.assignee} / ${task.status}）：${String(task.result ?? '').slice(0, 500)}` : null;
      return result ? result + (task.handoff ? `\n    中断交接：${String(task.handoff).slice(0, 200)}` : '') : null;
    }).filter(Boolean);
    const header = outcome === 'completed'
      ? `[Harness Mix collaboration · 编排脚本完成]\n${mention}\n你为团队「${team.name}」启动的编排脚本已执行完毕（最终阶段：${driver.phase ?? '未标记'}），执行期未消耗你的回合。以下是全部任务结果，请核对、整合并完成最终验收；不要重放已完成的写入：`
      : `[Harness Mix collaboration · 编排脚本失败]\n${mention}\n团队「${team.name}」的编排脚本执行失败：${driver.error}\n以下是已落定的任务（勿重放）；请修正脚本后重新 run_team_script，或改用直接委派善后：`;
    const text = lines.length ? `${header}\n${lines.join('\n')}` : header;
    for (let attempt = 0; attempt < 600 && !this.closing; attempt++) {
      if (!rt.execution.isRunning(team.owner)) {
        try { await rt.send(team.owner, text, {}); return; } catch { /* Lead 忙/竞态：稍后重试 */ }
      }
      await delay(100);
    }
  }

  // teamMembers=false 时跳过团队持久成员作业：Lead 回合自然结算只回收无团队归属的
  // 孤儿委派（/delegate 协作链）；用户显式中断/停止走默认全量级联。
  async cancelOwner(owner, { interrupt = this.interruptOwners.has(owner), teamMembers = true } = {}) {
    const jobs = [...this.jobs.values()].filter(j => j.owner === owner && j.status === 'running' && (teamMembers || !j.teamId));
    if (!jobs.length) return;
    this.cancelling.add(owner);
    try {
      await Promise.race([
        Promise.all(jobs.map(j => this.cancel(j, { interrupt }))),
        new Promise(r => setTimeout(r, 5_000)),
      ]).catch(() => {});
    } finally { this.cancelling.delete(owner); }
  }
  isParticipant(thread, owner) { return thread.id === owner || [...this.jobs.values()].some(j => j.owner === owner && j.childId === thread.id); }

  // 线程删除后不得残留悬空的成员会话引用，否则团队视图会永远显示一个
  // 已不存在的 working 成员、消息投递也会反复打到死 id 上
  async forgetThread(threadId) {
    let changed = false;
    for (const team of this.teams.values()) {
      for (const member of team.members) {
        if (member.childId === threadId) { delete member.childId; changed = true; }
      }
    }
    if (changed) await this.saveTeams();
  }
  async close() {
    await this.initialize();
    this.closing = true;
    await Promise.all([...this.jobs.values()].map(j => this.cancel(j)));
    await Promise.all([...this.jobs.values()].map(j => j.done));
    this.keys.clear();
    await this.save();
    await this.saveTeams();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}

function mentionedAgents(text, runtime) {
  // Ignore code and email/package addresses; explicit links survive draft copy/paste.
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  const ids = new Set();
  // CJK ideographs (\u4e00-\u9fff) and fullwidth/halfwidth forms are valid word boundaries,
  // so #agent works in Chinese prose (for example 帮我#pi做这个). A single
  // Markdown escape before # or the link brackets is still an explicit mention —
  // the Desktop composer serializes pasted plain-text links as \[名称]\(…\).
  // @ remains native Codex syntax.
  for (const match of prose.matchAll(/(?<!\\)(?:\\)?\[[^\]\n]+\](?:\\)?\(harness-mix:\/\/agent\/([\w-]+)(?:\\)?\)|(?:^|[\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff，。；：、！？""''（）【】])(?:\\)?#([\w-]+)(?=$|[\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff，。；：、！？""''（）【】])/g)) {
    const id = runtime.resolveHarnessId(match[1] || match[2]);
    if (id) ids.add(id);
  }
  // Natural-language team requests may name Harnesses without using the picker.
  // Require an explicit collaboration intent so ordinary product discussion such
  // as "Codex UI" does not silently authorize cross-Harness delegation.
  const teamIntent = /agent\s*team|团队|组队|协作|委派|调度|分工|成员|队长|主导者|\b(?:team|delegate|delegation|assign|member|teammate)\b/i.test(prose);
  if (teamIntent) {
    for (const adapter of runtime.adapters.values()) {
      const labels = [adapter.manifest.id, adapter.manifest.name, ...(adapter.manifest.aliases ?? [])]
        .filter(label => String(label ?? '').trim().length >= 2)
        .sort((a, b) => String(b).length - String(a).length);
      if (labels.some(label => containsPlainAgentName(prose, label))) ids.add(adapter.manifest.id);
    }
  }
  return [...ids];
}

function containsPlainAgentName(text, label) {
  const haystack = String(text).toLowerCase();
  const needle = String(label).trim().toLowerCase();
  for (let offset = haystack.indexOf(needle); offset !== -1; offset = haystack.indexOf(needle, offset + 1)) {
    const before = offset === 0 ? '' : haystack[offset - 1];
    const afterIndex = offset + needle.length;
    const after = afterIndex === haystack.length ? '' : haystack[afterIndex];
    if (plainNameBoundary(before) && plainNameBoundary(after)) return true;
  }
  return false;
}

function plainNameBoundary(char) {
  return !char || /[\s\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff,;:!?()[\]{}"'，。；：、！？“”‘’]/u.test(char);
}

module.exports = { Collaboration, mentionedAgents, workerSessionOptions, teamTaskDepths, teamPhase, teamProgress };
