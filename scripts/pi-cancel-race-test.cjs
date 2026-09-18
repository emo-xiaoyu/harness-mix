// Pi 家族 adapter 的「取消竞态」单元测试（不起原生进程、不走模型）：
// Pi RPC 的 prompt 在 preflight 完成后才 ack，期间 abort 没有活动 run 可停，会落空；
// 修复后：cancel 落在 prompt in-flight 窗口时，ack 之后必须补发一发 abort，
// 把刚启动的 run 真正停掉，避免用户看不见的僵尸运行。
const { piFamily } = require('../src/main/adapters/pi-family');

let passed = 0;
let failed = 0;
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('ok', name); })
    .catch((error) => { failed++; console.error('FAIL', name, '-', error.message); process.exitCode = 1; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSession({ preflightMs = 50, failFirst = null } = {}) {
  const calls = [];
  let promptAttempts = 0;
  return {
    calls,
    get aborts() { return calls.filter((c) => c.type === 'abort').length; },
    get prompts() { return calls.filter((c) => c.type === 'prompt'); },
    process: {
      harnessMixAnswer: undefined,
      async command(payload) {
        calls.push(payload);
        if (payload.type === 'prompt') {
          promptAttempts += 1;
          if (failFirst && promptAttempts === 1) throw new Error(failFirst);
          // 模拟 preflight：ack 之前的异步窗口（此时原生侧尚无 active run）
          await sleep(preflightMs);
          return {};
        }
        if (payload.type === 'abort') return {};
        return {};
      },
    },
  };
}

const adapter = piFamily({ id: 'pi', name: 'Pi', icon: '', bin: 'pi', packageHint: '' }).create(() => {});
const hooks = { emit() {} };

// 1) cancel 落在 preflight 窗口：ack 后必须补发第二发 abort
test('cancel during prompt preflight re-issues abort after ack', async () => {
  const session = fakeSession({ preflightMs: 60 });
  const pending = adapter.send(session, 'hello', hooks);
  await sleep(10); // prompt 已发出、ack 未回（in-flight）
  await adapter.cancel(session); // 第一发 abort（原生侧落空）
  await pending;
  await sleep(10); // 补发是 fire-and-forget，等它落盘
  if (session.aborts !== 2) throw new Error(`expected 2 aborts (cancel + re-abort after ack), got ${session.aborts}`);
});

// 2) 正常路径：send 已完成后再 cancel，不应多补 abort
test('cancel after prompt ack does not re-abort', async () => {
  const session = fakeSession({ preflightMs: 5 });
  await adapter.send(session, 'hello', hooks);
  await adapter.cancel(session);
  await sleep(10);
  if (session.aborts !== 1) throw new Error(`expected exactly 1 abort, got ${session.aborts}`);
});

// 3) 无 cancel：不应多任何 abort
test('plain send issues no abort', async () => {
  const session = fakeSession({ preflightMs: 5 });
  await adapter.send(session, 'hello', hooks);
  await sleep(10);
  if (session.aborts !== 0) throw new Error(`expected 0 aborts, got ${session.aborts}`);
});

// 4) already processing → followUp 排队路径上 cancel：ack 后同样补停
test('cancel during followUp-queue retry also re-aborts after ack', async () => {
  const session = fakeSession({ preflightMs: 60, failFirst: 'Agent is already processing. Specify streamingBehavior...' });
  const pending = adapter.send(session, 'hello', hooks);
  await sleep(10);
  await adapter.cancel(session);
  await pending;
  await sleep(10);
  if (session.prompts.length !== 2) throw new Error(`expected prompt retry as followUp, got ${session.prompts.length} prompts`);
  if (session.prompts[1].streamingBehavior !== 'followUp') throw new Error('retry must use streamingBehavior followUp');
  if (session.aborts !== 2) throw new Error(`expected 2 aborts (cancel + re-abort after ack), got ${session.aborts}`);
});

// 5) preflight 失败（ack 拒绝）后 cancel 标志不残留、不误伤后续 send
test('failed preflight clears in-flight state; later send unaffected', async () => {
  const session = fakeSession({ failFirst: 'Authentication failed for "kimi-coding"' });
  await adapter.send(session, 'hello', hooks).catch(() => {});
  await adapter.cancel(session); // 此时已无 in-flight
  await sleep(10);
  if (session.aborts !== 1) throw new Error(`expected exactly 1 abort, got ${session.aborts}`);
  await adapter.send(session, 'again', hooks); // 第二次 send 走 preflight 成功
  await sleep(10);
  if (session.aborts !== 1) throw new Error(`stale cancel flag leaked into later send (aborts=${session.aborts})`);
});

process.on('beforeExit', () => {
  console.log(`pi-cancel-race: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exitCode = 1;
});
