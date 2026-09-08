// Capability：UI/Core 判断功能的唯一依据，禁止按 Harness 名称分支。
// 结构按域分组，默认全部为 false，由 Adapter Manifest 显式声明开启。
const CAPABILITY_GROUPS = {
  conversation: ['streaming', 'reasoning', 'plan', 'compaction'],
  interaction: ['approval', 'question', 'permissionMode'],
  session: ['resume', 'fork', 'forkFromMessage'],
  workspace: ['nativeDiff', 'nativePatch'],
  model: ['selection', 'thinkingLevel'],
  usage: ['tokens', 'context', 'cost'],
};

function createCapabilities(overrides = {}) {
  const caps = {};
  for (const [group, keys] of Object.entries(CAPABILITY_GROUPS)) {
    caps[group] = {};
    for (const key of keys) caps[group][key] = overrides[group]?.[key] === true;
  }
  return caps;
}

function validateCapabilities(caps) {
  const errors = [];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return ['capabilities must be an object'];
  for (const [group, values] of Object.entries(caps)) {
    if (!CAPABILITY_GROUPS[group]) { errors.push(`capabilities.${group} is not a known group`); continue; }
    if (!values || typeof values !== 'object' || Array.isArray(values)) { errors.push(`capabilities.${group} must be an object`); continue; }
    for (const [key, value] of Object.entries(values)) {
      if (!CAPABILITY_GROUPS[group].includes(key)) errors.push(`capabilities.${group}.${key} is not a known capability`);
      else if (typeof value !== 'boolean') errors.push(`capabilities.${group}.${key} must be a boolean`);
    }
  }
  return errors;
}

module.exports = { CAPABILITY_GROUPS, createCapabilities, validateCapabilities };
