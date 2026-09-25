/**
 * CLI 协作前端测试：真实 HostRuntime + 无 MCP 能力的假 lead + 真控制面 + 真注册表发现，
 * 子进程调用 collaboration-cli.cjs 走完整链路（发现 → 鉴权 → call → 输出/退出码）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(`output/collab-cli-${Date.now()}-${process.pid}`);
const registryDir = path.join(root, 'registry');
// 必须在 require runtime 之前就位：Collaboration 构造时读取默认注册表目录
process.env.HARNESS_MIX_COLLAB_REGISTRY_DIR = registryDir;

const { HostRuntime } = require('../src/main/host/runtime');
const { discoverRegistry } = require('../src/main/host/collab-registry');
const CLI = path.resolve(__dirname, '../src/main/host/collaboration-cli.cjs');

const wait = async fn => { for (let i = 0; i < 1000; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

function runCli(args, { cwd, env = {}, input = null } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  await fs.mkdir(root, { recursive: true });
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  const pending = new Map();
  let leadPrompts = 0;
  // 刻意不带 collaborationTools：CLI 前端的主张就是这类 harness 也能当 lead
  const lead = { manifest: { id: 'zlead', name: 'ZLead', capabilities: {} },
    async open(input) { return { emit: input.emit, collaborationEnabled: false }; },
    async send() { leadPrompts++; }, async cancel() {}, async close() {} };
  const worker = { manifest: { id: 'worker', name: 'Worker', aliases: ['w'], capabilities: { collaborationTools: true } },
    async open(input) { return { id: input.thread.id, emit: input.emit }; },
    async send(session, text) { pending.set(session.id, { session, text }); },
    async cancel(session) { pending.delete(session.id); }, async close() {} };
  rt.adapters.set('zlead', lead); rt.status.zlead = { available: true };
  rt.adapters.set('worker', worker); rt.status.worker = { available: true };
  const reviewer = { ...worker, manifest: { id: 'reviewer', name: 'Reviewer', capabilities: { collaborationTools: true } } };
  rt.adapters.set('reviewer', reviewer); rt.status.reviewer = { available: true };
  try {
    const parent = await rt.createThread({ harnessId: 'zlead', cwd: root });
    await wait(async () => (await discoverRegistry({ cwd: root })).entries.length >= 1);
    const [entry] = (await discoverRegistry({ cwd: root })).entries;
    assert.equal(entry.threadId, parent.id, '注册表登记 lead 线程');
    assert.equal(entry.kind, 'lead');

    // 父 turn 保持运行（假 lead 的 send 永不结算）；白名单手工授权（发送路径注入属第 3 步覆盖）
    await rt.send(parent.id, 'orchestrate please');
    assert.ok(rt.execution.isRunning(parent.id));
    parent.activeMentions = ['worker'];

    // 1) whoami：注册表发现 + json/compact
    const who = await runCli(['--cwd', root, 'whoami'], { cwd: path.resolve(root, '..') });
    assert.equal(who.code, 0, who.stderr);
    const identity = JSON.parse(who.stdout);
    assert.equal(identity.threadId, parent.id);
    assert.equal(identity.frontend, 'cli');
    assert.equal(identity.role, 'lead');
    assert.equal(identity.collaborationEnabled, false, '无 MCP harness 的 CLI 身份如实报告');
    assert.deepEqual(identity.activeMentions, ['worker']);
    const whoCompact = await runCli(['--format', 'compact', 'whoami'], { cwd: root });
    assert.equal(whoCompact.code, 0);
    assert.match(whoCompact.stdout, /lead zlead/);

    // 2) agents compact
    const agents = await runCli(['--format', 'compact', 'agents'], { cwd: root });
    assert.match(agents.stdout, /worker Worker available=true/);
    assert.match(agents.stdout, /zlead ZLead available=true/);

    // 3) delegate：任务文本走 stdin（Windows argv 引号/长度的规避路径）
    const delegation = await runCli(['delegate', 'worker'], { cwd: root, input: '检查 flaky 测试\n包含中文与 "引号"' });
    assert.equal(delegation.code, 0, delegation.stderr);
    const job = JSON.parse(delegation.stdout);
    assert.ok(job.task_id);
    assert.equal(job.agent_type, 'worker');
    await wait(() => pending.size === 1);
    const [childSession] = [...pending.values()];
    assert.match(childSession.text, /检查 flaky 测试/);

    // 4) status --wait-ms：子任务结算后取回结果
    childSession.session.emit({ kind: 'text-delta', text: '根因是竞态' });
    childSession.session.emit({ kind: 'completed', finalAnswer: true });
    const status = await runCli(['status', job.task_id, '--wait-ms', '8000'], { cwd: root });
    assert.equal(status.code, 0, status.stderr);
    const [settled] = JSON.parse(status.stdout);
    assert.equal(settled.status, 'completed');
    assert.match(settled.result, /根因是竞态/);
    const statusCompact = await runCli(['--format', 'compact', 'status', job.task_id], { cwd: root });
    assert.match(statusCompact.stdout, /\[task \w{8}\] completed worker — 根因是竞态/);

    // 5) followup：复用子会话再派一条
    const followup = await runCli(['followup', job.task_id, '补一个回归测试'], { cwd: root });
    assert.equal(followup.code, 0, followup.stderr);
    await wait(() => pending.size === 1);
    const [again] = [...pending.values()];
    again.session.emit({ kind: 'text-delta', text: '已补充' });
    again.session.emit({ kind: 'completed', finalAnswer: true });
    const after = await runCli(['status', job.task_id, '--wait-ms', '8000'], { cwd: root });
    assert.match(JSON.parse(after.stdout)[0].result, /已补充/);

    // 6) 服务端拒绝 → 退出码 1 + stderr JSON（白名单强制在控制面生效）
    const rejected = await runCli(['delegate', 'reviewer', 'x'], { cwd: root, input: '' });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /"error"/);

    // 7) 歧义：同 cwd 第二个 lead 线程 → 必须显式 --thread
    const second = await rt.createThread({ harnessId: 'zlead', cwd: root });
    await wait(async () => (await discoverRegistry({ cwd: root })).entries.filter(e => e.kind === 'lead').length === 2);
    const ambiguous = await runCli(['whoami'], { cwd: root });
    assert.equal(ambiguous.code, 2, '多 lead 候选必须报发现失败');
    assert.match(ambiguous.stderr, /--thread/);
    const pinned = await runCli(['--thread', parent.id, 'whoami'], { cwd: root });
    assert.equal(pinned.code, 0, pinned.stderr);
    assert.equal(JSON.parse(pinned.stdout).threadId, parent.id);
    const unknownThread = await runCli(['--thread', 'nope', 'whoami'], { cwd: root });
    assert.equal(unknownThread.code, 2);

    // 8) 空目录无注册 → 退出码 2
    const emptyDir = path.join(root, 'nowhere');
    const none = await runCli(['--cwd', emptyDir, 'whoami'], { cwd: root });
    assert.equal(none.code, 2);

    // 9) 环境变量发现（与 MCP 桥同名变量）+ 错误 key 403
    const viaEnv = await runCli(['whoami'], { cwd: path.parse(root).root, env: { HARNESS_MIX_COLLAB_URL: entry.url, HARNESS_MIX_COLLAB_KEY: entry.key } });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.equal(JSON.parse(viaEnv.stdout).threadId, parent.id);
    const badKey = await runCli(['whoami'], { cwd: root, env: { HARNESS_MIX_COLLAB_URL: entry.url, HARNESS_MIX_COLLAB_KEY: 'wrong' } });
    assert.equal(badKey.code, 1);
    assert.match(badKey.stderr, /Forbidden/);

    // 10) 用法错误 → 退出码 3
    assert.equal((await runCli(['bogus'], { cwd: root })).code, 3);
    assert.equal((await runCli(['delegate'], { cwd: root, input: 'x' })).code, 3);

    // 11) worker 线程也登记（kind=worker），lead 解析不受其干扰
    //     delegate 响应早于子线程落建，child_thread_id 以结算后的 status 视图为准
    const settledChild = settled.child_thread_id;
    assert.ok(settledChild, '结算后的作业视图携带子线程 id');
    await wait(async () => {
      const { entries } = await discoverRegistry({ cwd: root });
      return entries.some(e => e.threadId === settledChild && e.kind === 'worker');
    });

    await rt.close();
    // Host 关闭后实例文件回收，发现通道随之失效
    const afterClose = await discoverRegistry({ cwd: root });
    assert.equal(afterClose.entries.length, 0, 'close() 删除实例注册文件');

    console.log('PASS: collaboration CLI — registry discovery, stdin delegation, status/followup, whitelist rejection, ambiguity/env/bad-key/usage exit codes');
  } finally {
    await rt.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
