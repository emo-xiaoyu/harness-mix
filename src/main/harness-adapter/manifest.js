const { CAPABILITY_GROUPS, createCapabilities } = require('../shared-contracts');

// Adapter Manifest 校验与能力归一化（§22）。
// 现有 Adapter 使用扁平 capability flags；Core/UI 消费分组结构（§22）。
// 本模块是两者之间的唯一映射，避免 UI 判断 Harness 名称（§45）。

const MANIFEST_CAPABILITY_FLAGS = [
  'streaming', 'thinking', 'tools', 'approvals', 'questions', 'models',
  'plan', 'nativeDiff', 'nativePatch', 'cost', 'compaction',
  'thinkingLevels', 'permissionModes', 'resume', 'fork', 'forkFromMessage', 'usage', 'contextUsage', 'attachments',
];

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest must be an object'];
  if (typeof manifest.id !== 'string' || !manifest.id) errors.push('manifest.id is required');
  if (typeof manifest.name !== 'string' || !manifest.name) errors.push('manifest.name is required');
  if (manifest.icon != null && typeof manifest.icon !== 'string') errors.push('manifest.icon must be a string');
  const caps = manifest.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    errors.push('manifest.capabilities must be an object');
  } else {
    for (const [key, value] of Object.entries(caps)) {
      if (!MANIFEST_CAPABILITY_FLAGS.includes(key)) errors.push(`manifest.capabilities.${key} is not a known flag`);
      else if (typeof value !== 'boolean') errors.push(`manifest.capabilities.${key} must be a boolean`);
    }
  }
  return errors;
}

/** 扁平 flags → §22 分组结构（Core Capability Manager 的消费形态） */
function normalizeCapabilities(caps = {}) {
  return createCapabilities({
    conversation: { streaming: caps.streaming === true, reasoning: caps.thinking === true, plan: caps.plan === true, compaction: caps.compaction === true, attachments: caps.attachments === true },
    interaction: { approval: caps.approvals === true, question: caps.questions === true, permissionMode: caps.permissionModes === true },
    workspace: { nativeDiff: caps.nativeDiff === true, nativePatch: caps.nativePatch === true },
    session: { resume: caps.resume === true, fork: caps.fork === true, forkFromMessage: caps.fork === true && caps.forkFromMessage === true },
    model: { selection: caps.models === true, thinkingLevel: caps.thinkingLevels === true },
    usage: { tokens: caps.usage === true, context: caps.contextUsage === true, cost: caps.cost === true },
  });
}

module.exports = { MANIFEST_CAPABILITY_FLAGS, validateManifest, normalizeCapabilities, CAPABILITY_GROUPS };
