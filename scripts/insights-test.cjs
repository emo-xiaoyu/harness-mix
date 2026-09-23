const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { UsageHistory, utcDay } = require('../src/main/host/usage-history');
const { HealthCenter } = require('../src/main/host/health');

const wait = async fn => { for (let i = 0; i < 600; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

// 用量中心历史层 + 健康中心快照
async function main() {
  const root = await fs.mkdtemp(path.resolve('output/insights-'));
  const dataDir = path.join(root, 'data');
  const rt = new HostRuntime({ dataDirectory: dataDir });
  await rt.store.load();
  let prompts = [];
  const fakeAdapter = (caps, available = true, id = 'pi') => ({
    manifest: { id, name: id === 'pi' ? 'Pi' : 'NoFork', capabilities: caps },
    async inspect() { return available === false ? { available: false, detail: '未安装' } : { available: true }; },
    async open(input) { return { id: input.thread.id, emit: input.emit }; },
    async send(session, text) { prompts.push(text); setTimeout(() => { session.emit({ kind: 'text-delta', text: 'ok' }); session.emit({ kind: 'completed', finalAnswer: true }); }, 0); },
    async cancel() {}, async close() {}, async setModel() {}, async setThinkingLevel() {},
  });
  rt.adapters.set('pi', fakeAdapter({ usage: true, resume: true, fork: true, forkFromMessage: true }));
  rt.status.pi = { available: true, detail: null };
  rt.adapters.set('noFork', fakeAdapter({}, false, 'noFork'));
  rt.status.noFork = { available: false, detail: '未安装' };
  // 不调用 rt.initialize()（会用真实 buildAdapters 覆盖测试夹具），按需初始化各服务
  await rt.usageHistory.initialize();

  // ---- 用量中心 ----
  const thread = await rt.createThread({ harnessId: 'pi', cwd: root, options: { model: { id: 'm1', name: 'Model One' } } });
  await rt.send(thread.id, '第一回合');
  await wait(() => !rt.execution.isRunning(thread.id));
  const session = rt.sessions.get(thread.id);
  // 适配器上报的是会话累计值：首报建立基线，后续只累计正向增量
  session.emit({ kind: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, totalCostUsd: 0.01 } });
  session.emit({ kind: 'usage', usage: { inputTokens: 120, outputTokens: 90, totalTokens: 210, totalCostUsd: 0.02 } });
  session.emit({ kind: 'usage', usage: { inputTokens: 110, outputTokens: 80, totalTokens: 190, totalCostUsd: 0.015 } });
  await rt.usageHistory.flush();
  const today = utcDay();
  let summary = rt.usageHistory.summary();
  assert.equal(summary.totals.totalTokens, 60, '只累计正向增量（150→210 为 60，回落不计）');
  assert.equal(summary.totals.inputTokens, 20);
  assert.equal(summary.totals.outputTokens, 40);
  assert.equal(Math.round(summary.totals.totalCostUsd * 1000) / 1000, 0.01);
  assert.equal(summary.totals.turns, 1, '有增量的上报计一次');
  assert.equal(summary.byHarness[0].harnessId, 'pi');
  assert.equal(summary.byHarness[0].name, 'Pi');
  assert.equal(summary.byModel[0].model, 'Model One');
  const history = rt.usageHistory.history({ days: 7 });
  assert.equal(history.days.length, 1);
  assert.equal(history.days[0].day, today);
  assert.equal(history.days[0].harnesses[0].models[0].model, 'Model One');

  // 切模型后基线重置，不把旧累计灌入新桶
  await rt.setModel(thread.id, { id: 'm2', name: 'Model Two' });
  session.emit({ kind: 'usage', usage: { inputTokens: 500, outputTokens: 500, totalTokens: 1000 } }); // 基线
  session.emit({ kind: 'usage', usage: { inputTokens: 510, outputTokens: 505, totalTokens: 1015 } });
  summary = rt.usageHistory.summary();
  assert.equal(summary.byModel.find(m => m.model === 'Model Two').totalTokens, 15, '换模型后首报只建基线');
  assert.equal(summary.byHarness[0].totalTokens, 75);

  // 保留窗口：过期行在 prune 时清除
  rt.usageHistory.rows.push({ day: '2020-01-01', harnessId: 'pi', model: 'Model One', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, totalCostUsd: 0, totalCredits: 0, turns: 1 });
  rt.usageHistory.prune();
  assert.ok(!rt.usageHistory.rows.some(row => row.day === '2020-01-01'), '90 天窗口外的行被清理');

  // 持久化：新实例从磁盘恢复
  await rt.usageHistory.flush();
  const rt2 = new HostRuntime({ dataDirectory: dataDir });
  await rt2.store.load();
  await rt2.usageHistory.initialize();
  assert.equal(rt2.usageHistory.summary().totals.totalTokens, 75, '用量历史跨 Host 重启恢复');

  // ---- 健康中心 ----
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'runtime', 'crash-1700000000000.json'), JSON.stringify({ kind: 'uncaughtException', pid: 1, at: 1700000000000, message: 'boom', stack: 'a\nb\nc\nd' }));
  await fs.writeFile(path.join(root, 'runtime', 'instance.json'), JSON.stringify({ pid: process.pid, version: '0.3.2-test', startedAt: Date.now() - 1000, beatAt: Date.now() - 500, mode: 'native-host' }));
  const health = rt.health;
  const snapshot = await health.snapshot();
  assert.equal(snapshot.runtime.platform, process.platform);
  assert.equal(snapshot.runtime.nodeVersion, process.versions.node);
  assert.ok(snapshot.runtime.uptimeMs >= 0);
  assert.equal(snapshot.runtime.instance.version, '0.3.2-test');
  assert.ok(snapshot.runtime.instance.heartbeatAgeMs >= 0);
  const piEntry = snapshot.harnesses.find(entry => entry.id === 'pi');
  const noForkEntry = snapshot.harnesses.find(entry => entry.id === 'noFork');
  assert.equal(piEntry.available, true);
  assert.equal(noForkEntry.available, false);
  assert.equal(noForkEntry.detail, '未安装');
  assert.equal(snapshot.threads.total >= 1, true);
  assert.equal(snapshot.storage.threadCount >= 1, true, '存储摘要来自 inspectStorage');
  assert.equal(snapshot.crashReports.length, 1);
  assert.equal(snapshot.crashReports[0].message, 'boom');
  assert.equal(snapshot.crashReports[0].stack.split('\n').length, 3, '堆栈只保留前三行');
  // 重新握手：noFork 变为可用
  rt.adapters.set('noFork', fakeAdapter({}, false, 'noFork'));
  const refreshed = await health.refreshHarnesses();
  assert.equal(refreshed.harnesses.find(entry => entry.id === 'noFork').available, false, 'inspect 缺省时保持不可用');
  rt.adapters.set('noFork', { ...fakeAdapter({}, true, 'noFork'), async inspect() { return { available: true }; } });
  const refreshed2 = await health.refreshHarnesses();
  assert.equal(refreshed2.harnesses.find(entry => entry.id === 'noFork').available, true, 'refreshHarnesses 重跑握手并更新状态');

  await rt.close();
  await rt2.close();
  console.log('insights-test: all assertions passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
