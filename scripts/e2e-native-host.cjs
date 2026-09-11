const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JsonlProcess } = require('../src/main/host/jsonl');
const { nativePaths, nativeEnvironment } = require('../src/main/native/config');

async function main() {
  const paths = nativePaths();
  const installation = execFileSync(process.execPath, [paths.cli, '--check'], { encoding: 'utf8', windowsHide: true });
  const stock = installation.match(/^executable_codex_cli=(.+)$/m)?.[1].trim();
  assert.ok(stock && fs.existsSync(stock), 'Official Codex executable must exist');
  const directory = path.resolve('output/native-host', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const env = nativeEnvironment({ ...process.env, CODEXHOST_DATA_DIR: path.join(directory, 'data') });
  Object.assign(env, {
    CODEXHOST_STOCK_CODEX_PATH: stock,
    CODEXHOST_HOST_NODE_PATH: process.execPath,
    CODEXHOST_HOST_RUNTIME_PATH: paths.wrapper,
    CODEXHOST_DEFAULT_AGENT: 'codex',
  });
  const events = [];
  const diagnostics = [];
  const transport = new JsonlProcess(paths.shim, ['app-server', '--listen', 'stdio://'], { env }, {
    onEvent: event => events.push(event),
    onDiagnostic: line => diagnostics.push(line),
    onRequest: () => { throw new Error('Unexpected interactive request in native-host test'); },
  });
  const request = (method, params) => {
    let timer;
    return Promise.race([
      transport.request(method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000); }),
    ]).finally(() => clearTimeout(timer));
  };
  const report = { stock, checks: [] };
  try {
    await request('initialize', { clientInfo: { name: 'harness-mix-native-test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    transport.notify('initialized', {});
    report.checks.push('official initialize passthrough');
    const ownership = await request('harness-mix/runtime/inspect', {});
    assert.equal(ownership.owner, 'harness-mix');
    assert.equal(ownership.core, 'src/main/protocol-core/protocol-core.js');
    report.checks.push('Harness Mix HostRuntime and ProtocolCore own external execution');
    const plugins = await request('codexhost/harness/plugins/list', {});
    assert.ok(plugins.plugins.some(plugin => (plugin.id || plugin.manifest?.id) === 'pi'), 'Pi plugin registered');
    report.checks.push('external harness plugins registered');
    for (const harnessId of ['pi', 'claude-code', 'deepseek-harness']) {
      const inspection = await request('codexhost/harness/inspect', { harnessId, cwd: directory });
      report[harnessId] = inspection;
      console.log(`${harnessId}: ${inspection.status}; models=${inspection.catalog?.models?.length || 0}${inspection.error ? `; ${inspection.error.message}` : ''}`);
      assert.equal(inspection.status, 'ready', `${harnessId} must be ready`);
    }
    const officialModels = await request('model/list', {});
    assert.ok(Array.isArray(officialModels.data), 'Official model/list passes through');
    report.checks.push('official model/list passthrough');
    // Real Host + stock-server section catalog, with test threads isolated in output/.
    const sidebarThread = await request('thread/start', { cwd: directory, model: 'codexhost/pi-native' });
    const sidebarId = sidebarThread.thread.id;
    assert.equal(sidebarThread.thread.sessionId, sidebarId);
    const descendants = await request('thread/list', { ancestorThreadId: sidebarId, sourceKinds: ['subAgentThreadSpawn'] });
    assert.equal(descendants.data.some(thread => thread.id === sidebarId), false);
    const sections = await request('threadSection/list', { limit: 100 });
    const section = sections.data[0];
    assert.ok(section, 'Desktop has a section available for pin/unpin verification');
    const inSection = async () => (await request('thread/list', { sectionId: section.id, sortKey: 'section_position' })).data.filter(thread => thread.id === sidebarId);
    assert.equal((await inSection()).length, 0, 'New external thread is not auto-pinned');
    await request('thread/section/move', { threadId: sidebarId, sectionId: section.id });
    assert.equal((await inSection()).length, 1, 'Pinned external thread appears exactly once');
    await request('thread/section/move', { threadId: sidebarId, sectionId: null });
    assert.equal((await inSection()).length, 0, 'Unpin stays removed on the next list query');
    const resumed = await request('thread/resume', { threadId: sidebarId });
    assert.equal(resumed.model, 'codexhost/pi-native');
    const inspected = await request('codexhost/thread/inspect', { threadId: sidebarId });
    assert.equal(inspected.harnessId, 'pi');
    assert.equal(inspected.transportModelId, resumed.model);
    report.checks.push('external identity, no self-descendants, pin/unpin and resume ownership');
    if (process.argv.includes('--live')) {
      const harnessId = process.argv.find(arg => arg.startsWith('--harness='))?.split('=')[1] || 'pi';
      const started = await request('thread/start', { cwd: directory, model: `codexhost/${harnessId}-native` });
      assert.ok(started.thread?.id, 'Native external thread created');
      const threadId = started.thread.id;
      const turn = await request('turn/start', {
        threadId, input: [{ type: 'text', text: 'Reply with exactly HARNESS_MIX_NATIVE_OK. Do not use any tools.' }],
      });
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && !events.some(event => event.method === 'turn/completed' && event.params?.threadId === threadId)) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const completed = events.find(event => event.method === 'turn/completed' && event.params?.threadId === threadId);
      assert.ok(completed, 'Native turn completion projected');
      assert.equal(completed.params.turn.status, 'completed');
      const reply = events.filter(event => event.method === 'item/agentMessage/delta' && event.params?.threadId === threadId)
        .map(event => event.params.delta || '').join('');
      const finalReply = events.filter(event => event.method === 'item/completed' && event.params?.threadId === threadId && event.params?.item?.type === 'agentMessage')
        .map(event => event.params.item.text || '').join('');
      assert.ok(`${reply}${finalReply}`.includes('HARNESS_MIX_NATIVE_OK'), 'Agent output, not echoed user input, must contain the marker');
      const history = await request('thread/read', { threadId, includeTurns: true });
      assert.equal(history.thread.id, threadId, 'External thread history is readable through native protocol');
      report.live = { harnessId, threadId, turnId: turn.turn?.id, status: completed.params.turn.status, reply: finalReply || reply };
      report.checks.push(`real ${harnessId} turn through Shim and Desktop protocol`);
      // Live external steering: a slow Turn is replaced mid-flight by turn/steer.
      const slow = await request('turn/start', {
        threadId, input: [{ type: 'text', text: 'Count from 1 to 30, one number per line. No commentary.' }],
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
      const steered = await request('turn/steer', {
        threadId,
        expectedTurnId: slow.turn.id,
        clientUserMessageId: `e2e-steer-${Date.now()}`,
        input: [{ type: 'text', text: 'Reply with exactly HARNESS_MIX_STEER_OK. Do not use any tools.' }],
      });
      assert.ok(steered.turnId && steered.turnId !== slow.turn.id, 'Steering allocates a new Turn identity');
      const steerDeadline = Date.now() + 120000;
      while (Date.now() < steerDeadline && !events.some(event => event.method === 'turn/completed' && event.params?.turn?.id === steered.turnId)) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const steerCompleted = events.find(event => event.method === 'turn/completed' && event.params?.turn?.id === steered.turnId);
      assert.ok(steerCompleted, 'Steered turn completion projected');
      const oldTurn = events.filter(event => event.method === 'turn/completed' && event.params?.turn?.id === slow.turn.id).at(-1);
      assert.ok(oldTurn && ['interrupted', 'completed'].includes(oldTurn.params.turn.status), 'Replaced Turn reached a terminal state');
      const steerReply = events.filter(event => event.method === 'item/agentMessage/delta' && event.params?.turnId === steered.turnId)
        .map(event => event.params.delta || '').join('');
      const steerFinal = events.filter(event => event.method === 'item/completed' && event.params?.turnId === steered.turnId && event.params?.item?.type === 'agentMessage')
        .map(event => event.params.item.text || '').join('');
      assert.ok(`${steerReply}${steerFinal}`.includes('HARNESS_MIX_STEER_OK'), 'Steered turn output contains the marker');
      report.live.steer = { replacedTurnId: slow.turn.id, turnId: steered.turnId, replacedStatus: oldTurn.params.turn.status };
      report.checks.push(`real ${harnessId} external steering through turn/steer`);
    }
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS: ${report.checks.join('; ')}\nReport: ${directory}`);
  } catch (error) {
    console.error(diagnostics.slice(-8).join('\n'));
    throw error;
  } finally {
    transport.child.stdin.end();
    await new Promise(resolve => {
      if (transport.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { transport.stop(); resolve(); }, 5000);
      transport.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
