// PR 4 验收（§18/§19）：无 Electron 回放真实 Harness 事件 fixtures。
// 链路覆盖：Native Event → Adapter 投影（统一事件）→ Normalizer → CoreEvent → Projector → State，
// 并用 ShadowComparator 验证 Core 投影与 Legacy Transcript 语义一致。
const fs = require('node:fs');
const path = require('node:path');
const { ProtocolCore } = require('../src/main/protocol-core');
const { ShadowMirror } = require('./support/shadow.cjs');
const { appendDelta, projectTool, finishMessage } = require('./support/legacy-transcript.cjs');
const pi = require('../src/main/adapters/pi');
const claude = require('../src/main/adapters/claude');
const dsh = require('../src/main/adapters/dsh');

// Native Event → 统一事件的各 Adapter 纯投影函数（与运行时同一份实现）
const PROJECTORS = {
  pi: (event) => pi.project(event),
  claude: (event) => claude.projectEvent(event),
  dsh: (event) => dsh.projectWireEvent(event),
};
// Adapter 在原生流之外自行合成的事件（§replay 边界诚实声明）：
// - cancel 场景：runtime.cancel() 直接结算为 cancelled（DSH turn/end interrupted 同为原生结算）
function syntheticTail(harnessId, label) {
  if (label === 'cancel') return [{ kind: 'completed', stopReason: 'cancelled' }];
  return [];
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok', name); }
  catch (error) { failed++; console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

/** Legacy 投影模拟：与 runtime #applyEvent 对消息/工具/用量部分的语义一致 */
function legacySimulator() {
  const thread = { id: 'replay-thread', harnessId: null, cwd: '/replay', messages: [], tools: [], pendingApprovals: [], usage: {} };
  const appendAssistant = () => {
    const message = { id: `m${thread.messages.length}`, role: 'assistant', text: '', at: Date.now(), streaming: true };
    thread.messages.push(message);
    return message;
  };
  const apply = (event) => {
    const last = thread.messages.at(-1);
    switch (event.kind) {
      case 'text-delta': {
        const target = last?.role === 'assistant' && last.streaming ? last : appendAssistant();
        target.text += event.text;
        appendDelta(target, 'text', event.text);
        break;
      }
      case 'thinking-delta': {
        const target = last?.role === 'assistant' && last.streaming ? last : appendAssistant();
        target.thinking = (target.thinking ?? '') + event.text;
        appendDelta(target, 'thinking', event.text);
        break;
      }
      case 'tool': {
        const target = last?.role === 'assistant' && last.streaming ? last : appendAssistant();
        projectTool(thread, target, event);
        break;
      }
      case 'approval':
        if (!thread.pendingApprovals.some((a) => a.requestId === event.requestId)) {
          thread.pendingApprovals.push({ requestId: event.requestId, title: event.title });
        }
        break;
      case 'usage':
        thread.usage = { ...thread.usage, ...event.usage };
        break;
      case 'completed':
        finishMessage(thread, last, event.stopReason ?? 'completed');
        break;
      case 'error':
        thread.error = event.message;
        finishMessage(thread, last, 'error');
        break;
      default: break; // status/notice/session/artifact 不参与对照
    }
  };
  return { thread, apply };
}

function replayFixture(harnessId, label, file) {
  const project = PROJECTORS[harnessId];
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const nativeCount = records.filter((r) => !r.__control__).length;
  const legacyEvents = [];
  for (const record of records) {
    // 控制记录：宿主动作（cancel）在事件流中的真实位置 → 注入 runtime 合成事件
    if (record.__control__ === 'cancel') { legacyEvents.push({ kind: 'completed', stopReason: 'cancelled' }); continue; }
    if (record.__control__) continue;
    const mapped = project(record);
    legacyEvents.push(...(Array.isArray(mapped) ? mapped : [mapped]).filter(Boolean));
  }
  const hasSettlement = legacyEvents.some((e) => e.kind === 'completed' || e.kind === 'error');
  const events = hasSettlement ? legacyEvents : [...legacyEvents, ...syntheticTail(harnessId, label)];

  // Legacy 路径：用户消息 + streaming assistant 占位（与 runtime.send 一致）
  const legacy = legacySimulator();
  legacy.thread.harnessId = harnessId;
  legacy.thread.messages.push({ id: 'u1', role: 'user', text: '<fixture prompt>', at: Date.now() });
  legacy.thread.messages.push({ id: 'a1', role: 'assistant', text: '', at: Date.now(), streaming: true });

  // Core 路径：Shadow Mirror（与运行时同一份实现）
  const core = new ProtocolCore();
  const shadow = new ShadowMirror({ core });
  shadow.threadCreated(legacy.thread);
  shadow.turnStarted(legacy.thread, '<fixture prompt>');

  for (const event of events) {
    legacy.apply(event); // 先更新 legacy，再让 shadow 对照（同 runtime 顺序）
    shadow.applyLegacyEvent(legacy.thread, event);
  }

  const lastMessage = legacy.thread.messages.at(-1);
  // 结算判定以“是否应用过结算事件”为准：cancel 后迟到的原生 chunk 会在 legacy 侧
  // 留下悬挂的 streaming 消息（真实 runtime 行为），不代表 Turn 未结算。
  const settled = events.some((e) => e.kind === 'completed' || e.kind === 'error');
  const turn = core.turns.turnsForThread(legacy.thread.id)[0];
  const items = core.getItemsForTurn(turn.id);
  const report = shadow.report();

  return { nativeCount, legacyEvents: events, legacy: legacy.thread, settled, turn, items, report, lastMessage };
}

const fixturesRoot = path.join(__dirname, '..', 'fixtures');
if (!fs.existsSync(fixturesRoot)) {
  console.error('FAIL fixtures/ 不存在，先运行 node scripts/fixture-capture.cjs');
  process.exit(1);
}

for (const harnessId of Object.keys(PROJECTORS)) {
  const dir = path.join(fixturesRoot, harnessId);
  if (!fs.existsSync(dir)) { test(`[${harnessId}] required fixtures`, () => { throw new Error('missing fixture directory'); }); continue; }
  for (const label of ['simple-message', 'reasoning', 'tool-call', 'file-edit', 'cancel']) {
    test(`[${harnessId}/${label}] required scenario present`, () => {
      if (!fs.existsSync(path.join(dir, `${label}.jsonl`))) throw new Error('missing required scenario');
    });
  }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const label = file.replace(/\.jsonl$/, '');
    test(`[${harnessId}/${label}] native → legacy → core 回放一致`, () => {
      const r = replayFixture(harnessId, label, path.join(dir, file));
      if (r.nativeCount === 0) throw new Error('empty fixture');
      if (r.report.errors.length) throw new Error(`shadow errors: ${JSON.stringify(r.report.errors)}`);

      if (!r.settled) throw new Error('fixture never settled');
      // cancel 场景 Core 必须保持 cancelled（首次结算生效）
      if (label === 'cancel' && r.turn.status !== 'cancelled') throw new Error(`cancel fixture but turn=${r.turn.status}`);
      // Shadow Match：语义一致性零差异（§15）
      // 已知可忽略差异：cancel 后原生流迟到的结算事件会覆盖 legacy stopReason（旧逻辑怪癖），
      // Core 按“首次结算生效”保持 cancelled —— 只记录，不改变现有用户行为（约束 #14）。
      let mismatches = r.report.mismatches.flatMap((m) => m.mismatches);
      if (mismatches.length) throw new Error(`shadow mismatch: ${JSON.stringify(mismatches)}`);

      // 场景不变量：期望状态由 legacy 终态推导（fixture 可能记录了真实的限流/错误回合）
      const expected = label === 'cancel' ? 'cancelled' : 'completed';
      if (r.turn.status !== expected) throw new Error(`turn=${r.turn.status}, expected ${expected}`);
      if (r.legacy.error) console.log(`  note: [${harnessId}/${label}] fixture 为真实错误回合：${r.legacy.error.slice(0, 60)}`);
      if (!r.items.some((i) => i.type === 'user_message')) throw new Error('missing user_message item');
      const answer = r.items.filter((i) => i.type === 'agent_message').map((i) => i.content).join('');
      const legacyText = r.legacy.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('');
      if (answer !== legacyText) throw new Error('agent_message ≠ legacy text');
      // 覆盖度提示（不否决）：fixture 名宣称的类型是否真的出现
      const coverage = {
        'file-edit': r.items.some((i) => i.type === 'tool_call'),
        'tool-call': r.items.some((i) => i.type === 'tool_call'),
        reasoning: r.items.some((i) => i.type === 'reasoning' && i.content),
        usage: r.items.some((i) => i.type === 'usage'),
      }[label];
      if (coverage === false) throw new Error('fixture does not cover declared scenario');
      if (label === 'file-edit') {
        const evidence = JSON.parse(fs.readFileSync(path.join(dir, `${label}.capture.json`), 'utf8'));
        if (!evidence.fileVerified) throw new Error('missing real file edit verification');
      }
    });
  }
}

console.log(`core-replay: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
