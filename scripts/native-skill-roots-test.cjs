const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ParityObserver } = require('./support/parity-observer.cjs');
const { HostRuntime } = require('../src/main/host/runtime');

// 用户可见契约：打开原生会话时，先为每个 Harness 创建缺失的原生技能根目录，
// 这样刚安装、从未运行过的 Harness 也能立即被 Harness Mix 发现并安装技能。
// 单个目录创建失败只提示、不阻断会话；项目作用域不可用时退化为全局根目录。

const skills = { global: ['.test-harness/skills'], project: ['.agents/skills'] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timed out'); }

function stubAdapter(id, onOpen) {
  return {
    manifest: { id, name: 'Test Harness', capabilities: {}, integrations: { mcp: false, skills: JSON.parse(JSON.stringify(skills)) } },
    async open(input) { onOpen?.(input); return {}; },
    async send() {}, async cancel() {}, async respond() {}, async close() {},
  };
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-skill-roots-'));
  const workspace = path.join(directory, 'workspace');
  const home = path.join(directory, 'home');
  await fs.mkdir(workspace); await fs.mkdir(home);

  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: directory });
  await rt.store.load();
  rt.integrations.home = home;
  rt.integrations.environment = {};

  // 1) 缺失的技能目录在会话打开时被创建（全局 + 项目）。
  let opened = 0, emit = null;
  const adapter = stubAdapter('test-harness', input => { opened++; emit = input.emit; });
  rt.adapters.set(adapter.manifest.id, adapter);
  rt.status[adapter.manifest.id] = { available: true };
  const thread = await rt.createThread({ harnessId: adapter.manifest.id, cwd: workspace });
  const toasts = [];
  rt.subscribe(event => { if (event.type === 'toast') toasts.push(event); });
  await rt.send(thread.id, 'hello');
  assert.equal(opened, 1, 'native session opened');
  for (const root of [path.join(home, '.test-harness', 'skills'), path.join(workspace, '.agents', 'skills')]) {
    assert.equal((await fs.stat(root)).isDirectory(), true, `${root} created on launch`);
  }
  assert.deepEqual(toasts, [], 'a successful launch reports no skill-root failure');
  emit({ kind: 'completed', finalAnswer: true });
  await until(() => thread.status === 'ready' && !thread.reviewPending);

  // 2) 已存在的根目录被复用，重复打开不会失败。
  await fs.mkdir(path.join(home, '.test-harness', 'skills', 'existing'), { recursive: true });
  await rt.send(thread.id, 'again');
  assert.equal(opened, 1, 'same thread reuses the native session');
  emit({ kind: 'completed', finalAnswer: true });
  await until(() => thread.status === 'ready' && !thread.reviewPending);
  assert.equal((await fs.stat(path.join(home, '.test-harness', 'skills', 'existing'))).isDirectory(), true, 'existing skill content untouched');

  // 3) 无法创建的根目录只提示并跳过，会话照常打开。
  const blockedHome = path.join(directory, 'blocked-home');
  await fs.mkdir(path.join(blockedHome, '.test-harness'), { recursive: true });
  await fs.writeFile(path.join(blockedHome, '.test-harness', 'skills'), 'not a directory');
  const blockedWorkspace = path.join(directory, 'blocked-workspace');
  await fs.mkdir(blockedWorkspace);
  const blocked = new HostRuntime({ observer: new ParityObserver(), dataDirectory: path.join(directory, 'blocked-data') });
  await blocked.store.load();
  blocked.integrations.home = blockedHome;
  blocked.integrations.environment = {};
  let blockedOpened = 0;
  const blockedAdapter = stubAdapter('test-harness', () => { blockedOpened++; });
  blocked.adapters.set(blockedAdapter.manifest.id, blockedAdapter);
  blocked.status[blockedAdapter.manifest.id] = { available: true };
  const blockedThread = await blocked.createThread({ harnessId: blockedAdapter.manifest.id, cwd: blockedWorkspace });
  const blockedToasts = [];
  console.log('DBG blocked.integrations.home =', blocked.integrations.home);
  console.log('DBG global root stat type =', (await fs.lstat(path.join(blockedHome, '.test-harness', 'skills'))).isFile() ? 'FILE' : 'other');
  blocked.subscribe(event => { if (event.type === 'toast') blockedToasts.push(event); });
  await blocked.send(blockedThread.id, 'hello');
  assert.equal(blockedOpened, 1, 'session still opens when a skill root cannot be created');
  assert.equal(blocked.sessions.has(blockedThread.id), true, 'native session attached despite the uncreatable root');
  assert.equal(blockedThread.error, undefined, 'no session error from the uncreatable root');
  assert.equal((await fs.stat(path.join(blockedWorkspace, '.agents', 'skills'))).isDirectory(), true, 'the remaining root is still created');
  console.log('TOASTS:', JSON.stringify(blockedToasts.map(t => ({ type: t.type, level: t.level, text: String(t.text).slice(0, 140) }))));
  assert.equal(blockedToasts.filter(event => /原生技能目录准备失败/.test(event.text)).length, 1, 'the skipped root is reported once');

  console.log('native skill roots: created on session open, reused when present, and never fatal PASS');
  await fs.rm(directory, { recursive: true, force: true });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
