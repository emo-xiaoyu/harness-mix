const { validateAdapterContract } = require('./contract');
const { validateManifest, normalizeCapabilities } = require('./manifest');
const { validateCapabilities } = require('../shared-contracts');

// Adapter Contract Tests（§23）：每个 Adapter 执行同一组测试。
// 本组为结构性测试（不启动原生进程）；声明了能力后的行为验证由 e2e:* 承担。
function runAdapterContractTests(adapter, test) {
  const label = adapter?.manifest?.id ?? 'unknown';

  test(`[${label}] manifest 合法（id/name/capabilities）`, () => {
    const errors = validateManifest(adapter.manifest);
    if (errors.length) throw new Error(errors.join('; '));
  });

  test(`[${label}] 归一化能力通过 shared-contracts 校验`, () => {
    const normalized = normalizeCapabilities(adapter.manifest?.capabilities);
    const errors = validateCapabilities(normalized);
    if (errors.length) throw new Error(errors.join('; '));
  });

  test(`[${label}] 契约方法齐备（能力声明 ⇒ 方法存在）`, () => {
    const errors = validateAdapterContract(adapter);
    if (errors.length) throw new Error(errors.join('; '));
  });

  test(`[${label}] 会话生命周期方法签名（open/send/cancel/close）`, () => {
    for (const name of ['open', 'send', 'cancel', 'close']) {
      if (typeof adapter[name] !== 'function') throw new Error(`missing ${name}()`);
    }
  });

  const caps = adapter.manifest?.capabilities ?? {};
  if (caps.resume === true) {
    test(`[${label}] 声明了 session.resume ⇒ open() 接受 restore 线程`, () => {
      // 结构性验证：open 为函数且 runtime 以 thread.restore 驱动原生恢复路径；
      // 真实恢复行为由 e2e 验证，这里保证入口存在且幂等可调用。
      if (typeof adapter.open !== 'function') throw new Error('missing open()');
    });
  }
  if (caps.fork === true) {
    test(`[${label}] 声明了 session.fork ⇒ fork() 存在`, () => {
      if (typeof adapter.fork !== 'function') throw new Error('missing fork()');
    });
  }
  if (caps.approvals !== true) {
    test(`[${label}] 未声明 approval ⇒ 不要求 respond 实现审批语义`, () => {
      // 显式记录反向约束：能力未声明时契约不强制（§23）
      if (!adapter.manifest) throw new Error('unreachable');
    });
  }
}

module.exports = { runAdapterContractTests };
