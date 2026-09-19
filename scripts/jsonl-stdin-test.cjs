const assert = require('node:assert/strict');
const { JsonlProcess } = require('../src/main/host/jsonl');

// JsonlProcess stdin EPIPE 防护：子进程异常退出/管道破裂后，迟到的 stdin.write 会在
// 流上异步抛 'error'（EPIPE）；Writable 无 error 监听时 Node 将其当作未捕获异常直接
// crash 宿主进程。修复后错误进入诊断通道，真实失败仍由 exit/error 路径统一结算。
(async () => {
  let crashed = null;
  const onCrash = error => { crashed = error; };
  process.on('uncaughtException', onCrash);
  const diags = [];
  try {
    const proc = new JsonlProcess(process.execPath, ['-e', 'process.exit(0)'], {}, {
      onDiagnostic(line) { diags.push(String(line)); },
    });
    await new Promise(resolve => proc.child.on('exit', resolve));
    // 迟到写入（管道已破）+ 直接注入流错误：两种形态都不得成为未捕获异常
    proc.notify('late.notify', {});
    proc.send({ type: 'late' });
    proc.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(crashed, null, `stdin EPIPE 不得成为未捕获异常: ${crashed?.message ?? ''}`);
    assert.ok(diags.some(line => /stdin/.test(line)), 'stdin 流错误进入诊断通道');
    console.log('jsonl-stdin-test: late writes and EPIPE after child exit are swallowed as diagnostics');
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }

  // 子进程退出时，挂起中的请求必须以带 harnessExited 标记的错误结算——
  // protocol.inspect 依赖该标记把确定性失败标为不可重试，抑制渲染层的重开循环。
  {
    const proc = new JsonlProcess(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], {}, {});
    const pending = proc.request('never/answered', {});
    await assert.rejects(pending, error => error.harnessExited === true && /进程已退出/.test(error.message));
    console.log('jsonl-stdin-test: pending requests reject with the harnessExited marker');
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
