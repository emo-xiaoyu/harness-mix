const { ParityObserver } = require('./support/parity-observer.cjs');
// PR 4：捕获真实 Harness 原生事件为 fixtures（§16/§17）。
// 用法：node scripts/fixture-capture.cjs [pi|claude|dsh|all]
// 保存的是 Native Event（Adapter 转换前），回放链路覆盖 Native→Normalize→Core→State。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { HostRuntime } = require('../src/main/host/runtime');
const recorder = require('../src/main/harness-adapter/fixture-recorder');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 场景清单（§16）。各 Harness 能力不同，不适用的场景会明确跳过并说明。
const SCENARIOS = {
  'simple-message': { prompt: '只回复两个字：收到' },
  'reasoning': { prompt: '请先简要推理，再回答：17 乘以 23 等于多少？', options: { thinking: 'medium' } },
  'tool-call': { prompt: '请运行 shell 命令 `echo harness-mix-fixture`，然后把命令输出原样告诉我。', autoApprove: true },
  'file-edit': { prompt: 'Only in this temporary working directory: use your native file editing tool to create fixture-edit.txt containing exactly harness-mix-fixture. Do not access other folders. Then reply done.', autoApprove: true, options: { permissionMode: 'acceptEdits' } },
  'cancel': { prompt: '请逐行输出从 1 到 100000 的所有数字，中间不要停。', cancelAfterMs: 3000 },
};

async function capture(harnessId, label, scenario) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fixture-work-'));
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fixture-record-'));
  const rt = new HostRuntime({ observer: new ParityObserver(), dataDirectory: path.join(os.tmpdir(), `hm-fixture-${harnessId}-${label}-${Date.now()}`) });
  try {
    await rt.initialize();
    if (!rt.status[harnessId]?.available) {
      console.log(`skip [${harnessId}/${label}] harness unavailable: ${rt.status[harnessId]?.detail}`);
      return false;
    }
    const thread = await rt.createThread({ harnessId, cwd: workspace, title: `fixture ${label}`, options: scenario.options });
    if (thread.status === 'error') {
      console.log(`skip [${harnessId}/${label}] open failed: ${thread.error}`);
      return false;
    }
    recorder.startRecording(harnessId, label, recordingDir);
    void rt.send(thread.id, scenario.prompt).catch(() => {});
    if (scenario.cancelAfterMs) {
      await sleep(scenario.cancelAfterMs);
      recorder.recordControl(harnessId, 'cancel'); // 标记 cancel 在事件流中的真实位置
      await rt.cancel(thread.id).catch(() => {});
    }
    // 先等 send() 完成异步准备进入 working，再等执行结束
    const startDeadline = Date.now() + 30_000;
    while (Date.now() < startDeadline) {
      const t = rt.threads.find((x) => x.id === thread.id);
      if (t.status === 'working' || t.status === 'error') break;
      await sleep(200);
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const t = rt.threads.find((x) => x.id === thread.id);
      // 自动应答审批/权限请求，避免捕获卡住（同时留下 approval 原生事件）
      for (const a of [...(t.pendingApprovals ?? [])]) {
        if (!scenario.autoApprove) throw new Error("unexpected approval in read-only scenario");
        await rt.respondApproval(t.id, a.requestId, { confirmed: true, optionId: a.options?.find(o => o.kind === 'allow_once' || /allow|允许/i.test(o.id ?? o.optionId ?? o.label ?? ''))?.id }).catch(() => {});
      }
      if (t.status !== 'working') break;
      await sleep(500);
    }
    recorder.stopRecording();
    const file = path.join(recordingDir, harnessId, `${label}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    const t = rt.threads.find((x) => x.id === thread.id);
    console.log(`captured [${harnessId}/${label}] ${lines} native events | legacy status=${t.status} | answer=${JSON.stringify((t.messages.at(-1)?.text ?? '').slice(0, 40))}`);
    if (t.status !== 'ready' || !lines) throw new Error(`capture not successful: ${t.error ?? t.status}`);
    const report = rt.shadowReport();
    if (report.errors.length || report.mismatches.length) throw new Error(`shadow mismatch: ${JSON.stringify(report)}`);
    if (label === 'file-edit' && fs.readFileSync(path.join(workspace, 'fixture-edit.txt'), 'utf8').trim() !== 'harness-mix-fixture') throw new Error('file edit did not happen');
    fs.mkdirSync(path.join(FIXTURES_DIR, harnessId), { recursive: true });
    fs.copyFileSync(file, path.join(FIXTURES_DIR, harnessId, `${label}.jsonl`));
    fs.writeFileSync(path.join(FIXTURES_DIR, harnessId, `${label}.capture.json`), JSON.stringify({ capturedAt: new Date().toISOString(), harnessId, label, nativeEvents: lines, fileVerified: label === 'file-edit', report }, null, 2));
    return true;
  } catch (error) {
    recorder.stopRecording();
    console.log(`skip [${harnessId}/${label}] ${error.message}`);
    return false;
  } finally {
    await rt.close().catch(() => {});
  }
}

(async () => {
  const target = process.argv[2] ?? 'all';
  const harnesses = target === 'all' ? ['pi', 'claude', 'dsh'] : [target];
  for (const harnessId of harnesses) {
    for (const [label, scenario] of Object.entries(SCENARIOS)) {
      // 能力裁剪：claude 不投影 thinking，跳过 reasoning 场景
      if (process.argv[3] && label !== process.argv[3]) continue;
      if (!await capture(harnessId, label, scenario)) process.exitCode = 1;
    }
    // usage fixture：任何包含 usage 原生事件的 run 都可充当；从 simple-message 派生，避免额外模型调用
    const usageFile = path.join(FIXTURES_DIR, harnessId, 'usage.jsonl');
    const simpleFile = path.join(FIXTURES_DIR, harnessId, 'simple-message.jsonl');
    if (!fs.existsSync(usageFile) && fs.existsSync(simpleFile)) {
      const hasUsage = fs.readFileSync(simpleFile, 'utf8').includes('message_end') || fs.readFileSync(simpleFile, 'utf8').includes('usage_update');
      if (hasUsage) { fs.copyFileSync(simpleFile, usageFile); console.log(`derived [${harnessId}/usage] from simple-message`); }
    }
  }
  console.log('capture done');
})().catch((e) => { console.error('CAPTURE FAILED:', e); process.exit(1); });
