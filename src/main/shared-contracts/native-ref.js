// NativeRef：Core 实体与 Harness 原生身份之间的桥。
// 所有字段均可选，但绝不允许丢失已知的原生 ID（执行约束 #8/#9）。
const NATIVE_REF_FIELDS = ['sessionId', 'turnId', 'itemId', 'toolCallId', 'interactionId', 'checkpointId'];

function createNativeRef(ref = {}) {
  const out = {};
  for (const field of NATIVE_REF_FIELDS) {
    if (typeof ref[field] === 'string' && ref[field]) out[field] = ref[field];
  }
  return out;
}

function validateNativeRef(ref) {
  const errors = [];
  if (ref == null) return errors; // 整体可选
  if (typeof ref !== 'object' || Array.isArray(ref)) return ['nativeRef must be an object'];
  for (const [key, value] of Object.entries(ref)) {
    if (!NATIVE_REF_FIELDS.includes(key)) errors.push(`nativeRef.${key} is not a known field`);
    else if (typeof value !== 'string' || !value) errors.push(`nativeRef.${key} must be a non-empty string`);
  }
  return errors;
}

module.exports = { NATIVE_REF_FIELDS, createNativeRef, validateNativeRef };
