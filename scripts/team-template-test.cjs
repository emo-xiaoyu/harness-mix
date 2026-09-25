const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const wait = async fn => { for (let i = 0; i < 600; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

// Agent Team 模板：自定义 Harness 角色的持久化编成 + # 提及展开。
async function main() {
  const root = await fs.mkdtemp(path.resolve('output/team-template-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  let leadPrompt = '';
  const lead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
    async open(input) { return { emit: input.emit, collaborationEnabled: true }; },
    async send(session, text) { leadPrompt = text; setTimeout(() => { session.emit({ kind: 'text-delta', text: 'done' }); session.emit({ kind: 'completed', finalAnswer: true }); }, 0); },
    async cancel() {}, async close() {} };
  const worker = { manifest: { id: 'worker', name: 'Worker', capabilities: { collaborationTools: true } },
    async open(input) { return { id: input.thread.id, emit: input.emit }; },
    async send() {}, async cancel() {}, async close() {} };
  const reviewer = { ...worker, manifest: { id: 'reviewer', name: 'Reviewer', capabilities: { collaborationTools: true } } };
  rt.adapters.set('lead', lead); rt.status.lead = { available: true };
  rt.adapters.set('worker', worker); rt.status.worker = { available: true };
  rt.adapters.set('reviewer', reviewer); rt.status.reviewer = { available: true };
  await rt.collaboration.initialize();

  // 1) CRUD：保存带自定义职责的成员编成
  const saved = await rt.collaboration.saveTeamTemplate({
    name: '评审团队',
    description: '一写一评的经典闭环',
    members: [
      { name: '实现者', role: '负责编写 TypeScript 实现，保持与现有代码风格一致', agent: 'Worker' },
      { name: '审查者', role: '对改动做安全与测试覆盖审查，只报告不改码', agent: 'reviewer' },
    ],
  });
  assert.equal(saved.members[0].agent, 'worker', '成员 Harness 名称会被解析为注册表 id');
  assert.equal(saved.members[0].role, '负责编写 TypeScript 实现，保持与现有代码风格一致', '自定义职责原样保留');
  const listed = await rt.collaboration.listTeamTemplates();
  assert.equal(listed.length, 7, '用户模板 + 6 套内置模板');
  const mine = listed.find(t => t.id === saved.id);
  assert.equal(mine.members[1].available, true, '列表标注成员 Harness 当前可用性');
  assert.ok(mine.id && mine.createdAt && mine.updatedAt);
  assert.ok(listed.filter(t => t.builtin).length === 6, '全新数据目录自动补种 6 套内置模板');

  // 2) 校验：成员数、重名、职责必填
  await assert.rejects(rt.collaboration.saveTeamTemplate({ name: '空', members: [] }), /1-6 个成员/);
  await assert.rejects(rt.collaboration.saveTeamTemplate({ name: '超员', members: Array.from({ length: 7 }, (_, i) => ({ name: `m${i}`, role: 'r', agent: 'worker' })) }), /1-6 个成员/);
  await assert.rejects(rt.collaboration.saveTeamTemplate({ name: '重名', members: [{ name: 'A', role: 'r', agent: 'worker' }, { name: 'a', role: 'r', agent: 'reviewer' }] }), /不能重复/);
  await assert.rejects(rt.collaboration.saveTeamTemplate({ name: '无职责', members: [{ name: 'A', agent: 'worker' }] }), /职责/);

  // 3) 更新与删除
  const updated = await rt.collaboration.saveTeamTemplate({ id: saved.id, name: '评审团队', members: [{ name: '实现者', role: '新职责', agent: 'worker' }] });
  assert.equal(updated.members.length, 1);
  assert.equal(updated.description, '', '更新未传描述时清空');
  await assert.rejects(rt.collaboration.deleteTeamTemplate('missing'), /未找到/);
  await rt.collaboration.deleteTeamTemplate(saved.id);
  assert.equal((await rt.collaboration.listTeamTemplates()).length, 6, '删除用户模板后内置模板仍在');

  // 4) 从现存 Agent Team 提取模板
  const parent = await rt.createThread({ harnessId: 'lead', cwd: root });
  parent.activeMentions = ['worker', 'reviewer'];
  const view = await rt.collaboration.teamCall(parent.id, 'create_agent_team', {
    name: '发布小队',
    goal: '发布 0.4.0',
    members: [
      { name: '实现者', role: '写代码', agent_type: 'worker' },
      { name: '审查者', role: '看代码', agent_type: 'reviewer' },
    ],
  });
  const fromTeam = await rt.collaboration.teamTemplateFromTeam(view.team_id, { name: '发布模板' });
  assert.deepEqual(fromTeam.members.map(m => ({ name: m.name, role: m.role, agent: m.agent })), [
    { name: '实现者', role: '写代码', agent: 'worker' },
    { name: '审查者', role: '看代码', agent: 'reviewer' },
  ]);
  await assert.rejects(rt.collaboration.teamTemplateFromTeam('missing'), /未找到/);

  // 5) # 提及展开校验
  assert.equal(await rt.collaboration.expandTeamTemplateMention('普通消息，无模板提及', parent), null, '无模板提及时原样返回 null');
  await assert.rejects(async () => rt.collaboration.expandTeamTemplateMention('#[不存在](harness-mix://team-template/missing)', parent), /未找到团队模板「不存在」/);
  const expanded = await rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id}) 修复登录超时`, parent);
  assert.match(expanded, /^#worker #reviewer /, '展开指令以 # 授权提及开头');
  assert.match(expanded, /团队名称：发布模板/);
  assert.match(expanded, /团队目标：修复登录超时/);
  assert.match(expanded, /- 实现者（Worker）：写代码/);
  assert.match(expanded, /- 审查者（Reviewer）：看代码/);
  const configured = await rt.collaboration.saveTeamTemplate({
    name: '模型配置团队', members: [{ name: '实现者', role: '写代码', agent: 'worker',
      model: { id: 'native-model', name: 'Native Model', provider: 'example' }, thinking: 'high' }],
  });
  const configuredMention = await rt.collaboration.expandTeamTemplateMention(`#[模型配置团队](harness-mix://team-template/${configured.id}) 实现功能`, parent);
  assert.match(configuredMention, /模型 Native Model，思考强度 high/);
  const configuredTeam = await rt.collaboration.teamCall(parent.id, 'create_agent_team', {
    name: '模型配置团队', goal: '实现功能', members: [{ name: '实现者', role: '写代码', agent_type: 'worker' }],
  });
  assert.deepEqual(configuredTeam.members[0].model, { id: 'native-model', name: 'Native Model', provider: 'example' });
  assert.equal(configuredTeam.members[0].thinking, 'high', 'Host 从用户选中的模板绑定模型与思考强度');
  await rt.collaboration.deleteTeamTemplate(configured.id);
  delete parent.pendingTeamTemplate;
  rt.adapters.set('pi', { ...worker, manifest: { id: 'pi', name: 'Pi', capabilities: { collaborationTools: true, approvals: true } } });
  rt.status.pi = { available: true };
  parent.activeMentions.push('pi');
  const piTeam = await rt.collaboration.teamCall(parent.id, 'create_agent_team', {
    name: 'Pi 团队', goal: '测试', members: [{ name: 'Pi', role: '执行', agent_type: 'pi' }],
  });
  assert.equal(piTeam.members[0].agent, 'pi', 'Pi 内置工具默认执行，可作为 Agent Team 成员');
  const fallbackGoal = await rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id})`, parent);
  assert.match(fallbackGoal, /团队目标：发布模板/, '缺省目标回落到模板名');
  // Desktop 输入框会把未成链的纯文本提及序列化为 \#[名称]\(…\)：转义形式必须同样展开
  const escaped = await rt.collaboration.expandTeamTemplateMention(`\\#[发布模板]\\(harness-mix://team-template/${fromTeam.id}) 修复登录超时`, parent);
  assert.match(escaped, /^#worker #reviewer /, '转义提及展开指令同样以 # 授权提及开头');
  assert.match(escaped, /团队目标：修复登录超时/, '转义提及剥离后剩余文本仍作为团队目标');
  const child = await rt.createThread({ harnessId: 'lead', cwd: root, parentThreadId: parent.id });
  await assert.rejects(async () => rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id})`, child), /子任务不能创建/);
  rt.adapters.set('solo', { ...lead, manifest: { id: 'solo', name: 'Solo', capabilities: {} } }); rt.status.solo = { available: true };
  const soloThread = await rt.createThread({ harnessId: 'solo', cwd: root });
  await assert.rejects(async () => rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id})`, soloThread), /Lead 协作能力/);
  rt.status.worker = { available: false };
  await assert.rejects(async () => rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id})`, parent), /当前不可用/);
  rt.status.worker = { available: true };
  rt.collaboration.prefs.agentTeam = false;
  await assert.rejects(async () => rt.collaboration.expandTeamTemplateMention(`#[发布模板](harness-mix://team-template/${fromTeam.id})`, parent), /已.*关闭/);
  rt.collaboration.prefs.agentTeam = true;

  // 5b) 指令目录：/team 指令已移除（团队模板改由 # 提及唤起）
  const threadCatalog = await rt.listCommands({ threadId: parent.id });
  assert.ok(!threadCatalog.some(c => c.id === 'team'), '命令目录不再包含 /team 指令');
  // 6) 真实发送路径：/team 指令展开后走 Lead 编排
  await rt.send(parent.id, `#[发布模板](harness-mix://team-template/${fromTeam.id}) 修复登录超时`);
  await wait(() => !rt.execution.isRunning(parent.id));
  assert.deepEqual(parent.activeMentions, ['worker', 'reviewer'], '/team 展开后的 # 提及完成协作授权');
  assert.match(leadPrompt, /create_agent_team/, 'Lead 收到团队创建指令');
  assert.match(leadPrompt, /审查者（Reviewer）：看代码/, '模板职责进入 Lead 提示词');
  const userMessage = parent.messages.filter(m => m.role === 'user').at(-1);
  assert.match(userMessage.text, /Harness Mix 团队模板 · 发布模板/, '用户消息展示展开后的指令（可见、可追溯）');
  // 真实提交路径的转义形式（Desktop 序列化 \#[名称]\(…\)）同样要展开成团队指令
  await rt.send(parent.id, `\\#[发布模板]\\(harness-mix://team-template/${fromTeam.id}) 修复登录超时`);
  await wait(() => !rt.execution.isRunning(parent.id));
  assert.match(parent.messages.filter(m => m.role === 'user').at(-1).text, /Harness Mix 团队模板 · 发布模板/, '转义提及在真实发送路径同样展开');
  // /team 前缀不会被误伤：非 /team 单词边界开头的消息不拦截
  // 纯文本提及 URL（无 markdown 链接）不触发展开：expandTeamTemplateMention 匹配不到即原样通过
  await rt.send(parent.id, '看看 harness-mix://team-template/ 这个地址的文档');
  await wait(() => !rt.execution.isRunning(parent.id));
  assert.doesNotMatch(leadPrompt, /create_agent_team/);

  // 7) 持久化：新 Collaboration 实例从 team-templates.json 恢复
  const rt2 = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt2.store.load();
  await rt2.collaboration.initialize();
  const restored = await rt2.collaboration.listTeamTemplates();
  assert.equal(restored.length, 7, '用户模板与内置模板都在 Host 重启后恢复');
  const reissued = restored.find(t => t.name === '发布模板');
  assert.deepEqual(reissued.members.map(m => m.role), ['写代码', '看代码']);
  await rt.close();
  await rt2.close();

  // 8) 内置模板：留空 Harness、改造降级、删除墓碑、恢复内置
  const root2 = await fs.mkdtemp(path.resolve('output/team-template-builtin-'));
  const rt3 = new HostRuntime({ dataDirectory: path.join(root2, 'data') });
  await rt3.store.load();
  rt3.adapters.set('lead', lead); rt3.status.lead = { available: true };
  rt3.adapters.set('worker', worker); rt3.status.worker = { available: true };
  rt3.adapters.set('reviewer', reviewer); rt3.status.reviewer = { available: true };
  await rt3.collaboration.initialize();
  const builtins = await rt3.collaboration.listTeamTemplates();
  assert.equal(builtins.length, 6, '全新数据目录补种 6 套内置模板');
  assert.ok(builtins.every(t => t.builtin === true), '内置模板带 builtin 标记');
  const bugReview = builtins.find(t => t.id === 'builtin-bug-review');
  assert.ok(bugReview, '缺陷评审组在内置清单中');
  assert.ok(bugReview.members.length >= 2 && bugReview.members.every(m => m.agent === '' && m.available === false), '内置成员 Harness 留空待指定');
  const leadThread3 = await rt3.createThread({ harnessId: 'lead', cwd: root2 });
  await assert.rejects(async () => rt3.collaboration.expandTeamTemplateMention(`#[缺陷评审组](harness-mix://team-template/builtin-bug-review) 修一下`, leadThread3), /未指定 Harness/, '未指定 Harness 的内置模板不能展开');
  const customized = await rt3.collaboration.saveTeamTemplate({
    id: 'builtin-bug-review', name: '缺陷评审组', description: '本队定制版',
    members: bugReview.members.map(m => ({ name: m.name, role: m.role, agent: 'worker' })),
  });
  assert.equal(customized.builtin, false, '用户保存后内置模板降级为普通模板');
  const builtinExpanded = await rt3.collaboration.expandTeamTemplateMention('#[缺陷评审组](harness-mix://team-template/builtin-bug-review) 修一下', leadThread3);
  assert.match(builtinExpanded, /#worker /, '换上 Harness 后内置模板可正常展开');
  assert.match(builtinExpanded, /团队目标：修一下/);
  await rt3.collaboration.deleteTeamTemplate('builtin-research');
  assert.ok(!(await rt3.collaboration.listTeamTemplates()).some(t => t.id === 'builtin-research'), '内置模板可删除');
  await rt3.close();
  const rt4 = new HostRuntime({ dataDirectory: path.join(root2, 'data') });
  await rt4.store.load();
  await rt4.collaboration.initialize();
  const afterRestart = await rt4.collaboration.listTeamTemplates();
  assert.equal(afterRestart.length, 5, '删除的内置不复活，其余保留');
  assert.ok(!afterRestart.some(t => t.id === 'builtin-research'), '删除墓碑在重启后生效');
  const kept = afterRestart.find(t => t.id === 'builtin-bug-review');
  assert.ok(kept && kept.builtin === false && kept.description === '本队定制版', '用户改造过的模板不被内置覆盖');
  const restoreResult = await rt4.collaboration.restoreBuiltInTeamTemplates();
  assert.ok(restoreResult.restored >= 1, '恢复内置报告补回数量');
  assert.ok((await rt4.collaboration.listTeamTemplates()).some(t => t.id === 'builtin-research' && t.builtin === true), '恢复内置找回被删除的模板');
  assert.equal((await rt4.collaboration.listTeamTemplates()).length, 6, '恢复后编成完整（改造版保持原样）');
  await rt4.close();

  // 9) 项目作用域文件模板：.harness-mix/teams/*.md 随仓库走，项目 > 用户 > 内置
  const { parseTeamTemplateFrontmatter } = require('../src/main/host/team-template-files');
  // 解析器边界：引号值、CRLF、BOM、注释行、缩进字段归属
  const crlfSource = ['---', 'name: "带引号"', "description: '单引号'", '# 一行注释', 'members:', '  - name: 甲', '    role: 干活', '    agent: Worker', '---', '正文忽略'].join('\r\n');
  const parsed = parseTeamTemplateFrontmatter('\uFEFF' + crlfSource);
  assert.equal(parsed.name, '带引号');
  assert.equal(parsed.description, '单引号');
  assert.deepEqual(parsed.members, [{ name: '甲', role: '干活', agent: 'Worker' }]);
  assert.throws(() => parseTeamTemplateFrontmatter('没有围栏'), /frontmatter/);
  assert.throws(() => parseTeamTemplateFrontmatter('---\nname: x\nmembers: 不是列表\n---\n'), /列表形式/);

  const projRoot = await fs.mkdtemp(path.resolve('output/team-template-project-'));
  const teamsDir = path.join(projRoot, '.harness-mix', 'teams');
  await fs.mkdir(teamsDir, { recursive: true });
  await fs.writeFile(path.join(teamsDir, 'release-squad.md'), [
    '---',
    'name: 发布小队',
    'description: 文件版编成',
    'members:',
    '  - name: 实现者',
    '    role: 文件版写码职责',
    '    agent: Worker',
    '  - name: 审查者',
    '    role: 文件版审查职责',
    '    agent: reviewer',
    '---',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(teamsDir, 'broken.md'), '不是 frontmatter');
  await fs.writeFile(path.join(teamsDir, 'too-many.md'), '---\nname: 超员\ndescription: 七人\nmembers:\n' + Array.from({ length: 7 }, (_, i) => `  - name: m${i}\n    role: r\n    agent: worker`).join('\n') + '\n---\n');
  await fs.writeFile(path.join(teamsDir, 'ignored.txt'), '---\nname: 非 md\nmembers:\n  - name: x\n    role: r\n    agent: worker\n---\n');

  const rt5 = new HostRuntime({ dataDirectory: path.join(projRoot, 'data') });
  await rt5.store.load();
  rt5.adapters.set('lead', lead); rt5.status.lead = { available: true };
  rt5.adapters.set('worker', worker); rt5.status.worker = { available: true };
  rt5.adapters.set('reviewer', reviewer); rt5.status.reviewer = { available: true };
  await rt5.collaboration.initialize();
  // 同名冲突：用户存储里也存一个「发布小队」，项目文件版必须胜出
  await rt5.collaboration.saveTeamTemplate({ name: '发布小队', description: '存储版编成', members: [{ name: '实现者', role: '存储版写码职责', agent: 'worker' }] });
  const projLead = await rt5.createThread({ harnessId: 'lead', cwd: projRoot });
  projLead.activeMentions = ['worker', 'reviewer'];

  // 无 cwd：仅存储模板（设置页语义）
  const storedOnly = await rt5.collaboration.listTeamTemplates();
  assert.equal(storedOnly.length, 7, '不带 cwd 时不合并项目文件模板');
  assert.ok(!storedOnly.some(t => t.source === 'project'));
  // 带 cwd：项目优先合并 + 坏文件跳过
  const merged = await rt5.collaboration.listTeamTemplates(projRoot);
  assert.equal(merged.length, 7, '项目模板覆盖同名存储模板（1 项目 + 6 内置），坏文件被跳过');
  const projectEntry = merged.find(t => t.source === 'project');
  assert.ok(projectEntry, '项目模板带 source 标记');
  assert.equal(projectEntry.id, 'release-squad');
  assert.equal(projectEntry.description, '文件版编成');
  assert.deepEqual(projectEntry.members.map(m => ({ name: m.name, role: m.role, agent: m.agent })), [
    { name: '实现者', role: '文件版写码职责', agent: 'worker' },
    { name: '审查者', role: '文件版审查职责', agent: 'reviewer' },
  ], 'Harness 名称别名解析为注册表 id');
  assert.equal(projectEntry.members[0].available, true, '项目模板成员也标注可用性');
  assert.ok(rt5.collaboration.projectTemplateWarnings.some(w => w.file === 'broken.md' && /frontmatter/.test(w.error)), '坏 frontmatter 进 warnings');
  assert.ok(rt5.collaboration.projectTemplateWarnings.some(w => w.file === 'too-many.md' && /1-6 个成员/.test(w.error)), '校验失败的文件进 warnings');
  assert.ok(!merged.some(t => t.name === '发布小队' && t.builtin === undefined && t.source !== 'project' && t.description === '存储版编成'), '同名时存储版被项目版就近覆盖');

  // # 提及展开：项目 id 与名称都能命中文件版
  const projExpanded = await rt5.collaboration.expandTeamTemplateMention('#[发布小队](harness-mix://team-template/release-squad) 发布 1.0', projLead);
  assert.match(projExpanded, /^#worker #reviewer /);
  assert.match(projExpanded, /文件版写码职责/);
  assert.match(projExpanded, /团队目标：发布 1\.0/);
  assert.match(projExpanded, /Harness Mix 团队模板 · 发布小队/);
  const byName = await rt5.collaboration.findTeamTemplateFor('release-squad', '发布小队', projRoot);
  assert.equal(byName.source, 'project');
  // 无项目模板命中时回落存储（内置 id）
  assert.equal((await rt5.collaboration.findTeamTemplateFor('builtin-research', '技术调研组', projRoot)).id, 'builtin-research');
  // 其他 cwd（无 .harness-mix 目录）不受影响：回落存储版而非项目版
  const elsewhere = await rt5.collaboration.findTeamTemplateFor('release-squad', '发布小队', path.join(projRoot, 'elsewhere'));
  assert.ok(elsewhere && elsewhere.source !== 'project', '项目模板只在声明它的目录生效，其他目录回落存储版');
  assert.ok((await rt5.collaboration.listTeamTemplates(path.join(projRoot, 'elsewhere'))).every(t => t.source !== 'project'));

  // 热加载：改文件后无需重启即生效（mtime+size 缓存失效）
  await fs.writeFile(path.join(teamsDir, 'release-squad.md'), [
    '---',
    'name: 发布小队',
    'description: 文件版编成 v2',
    'members:',
    '  - name: 实现者',
    '    role: 热加载后的新职责内容',
    '    agent: Worker',
    '---',
    '',
  ].join('\n'));
  const reloaded = await rt5.collaboration.listTeamTemplates(projRoot);
  assert.equal(reloaded.find(t => t.source === 'project').members[0].role, '热加载后的新职责内容', '文件改动即时生效');
  assert.equal(reloaded.find(t => t.source === 'project').members.length, 1);

  // 协议面：threadId → 以线程 cwd 为项目作用域；缺省不带项目模板
  const { NativeProtocol } = require('../src/main/native/protocol');
  const protocol5 = new NativeProtocol(rt5, () => {});
  const viaProtocol = await protocol5.request('harnessmix/collaboration/team-template/list', { threadId: projLead.id });
  assert.ok(viaProtocol.templates.some(t => t.source === 'project' && t.id === 'release-squad'), '协议按 threadId 合并项目模板');
  const withoutThread = await protocol5.request('harnessmix/collaboration/team-template/list', {});
  assert.ok(!withoutThread.templates.some(t => t.source === 'project'), '不带 threadId 时仅存储模板');
  protocol5.close();
  await rt5.close();

  console.log('team-template-test: all assertions passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
