// 统一 Harness Adapter 契约（§20/§21）。
// 方法是否必须存在由 Manifest capability 声明决定（§21：不是每个能力都必须存在）。
// 命名沿用现行 Adapter 形状：open 同时承担 createSession / resumeSession
// （thread.restore 决定路径），respond 即 respondInteraction。
const CONTRACT_METHODS = [
  { name: 'inspect', when: () => true },
  { name: 'open', when: () => true },        // createSession / resumeSession
  { name: 'send', when: () => true },
  { name: 'cancel', when: () => true },
  { name: 'close', when: () => true },
  { name: 'respond', when: (c) => c.approvals === true || c.questions === true }, // respondInteraction
  { name: 'fork', when: (c) => c.fork === true },
  { name: 'listCommands', when: (c) => c.compaction === true },
  { name: 'executeCommand', when: (c) => c.compaction === true },
  { name: 'listModelsFor', when: (c) => c.models === true }, // listModels(session)：open 后按会话取目录
  { name: 'setModel', when: (c) => c.models === true },
  { name: 'setThinkingLevel', when: (c) => c.thinkingLevels === true },
];

/** 结构性契约校验：方法存在性与能力声明一致（行为验证由真实 Harness E2E 承担） */
function validateAdapterContract(adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') return ['adapter must be an object'];
  const caps = adapter.manifest?.capabilities ?? {};
  for (const { name, when } of CONTRACT_METHODS) {
    const required = when(caps);
    const present = typeof adapter[name] === 'function';
    if (required && !present) errors.push(`adapter missing required method: ${name}()`);
    // 未声明能力却提供实现不算错误（允许超前实现），但不允许声明了却没有实现
  }
  return errors;
}

module.exports = { CONTRACT_METHODS, validateAdapterContract };
