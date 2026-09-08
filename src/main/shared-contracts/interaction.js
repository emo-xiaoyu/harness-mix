const { newInteractionId } = require('./ids');
const { createNativeRef, validateNativeRef } = require('./native-ref');

// Interaction：approval / question / permission / confirmation / input / select
// 统一建模（PR 8 的 InteractionRouter 以此为协议）。第一阶段仅定义契约。
const INTERACTION_TYPES = ['approval', 'question', 'permission', 'confirmation', 'input', 'select'];
const INTERACTION_STATUS = ['pending', 'responded', 'cancelled', 'expired'];

function createInteraction({ id, threadId, turnId, type, title, message, options, allowTextInput, nativeRef, status = 'pending' } = {}, now = Date.now()) {
  return {
    id: id ?? newInteractionId(),
    threadId: threadId ?? null,
    turnId: turnId ?? null,
    type,
    title: title ?? '',
    message: message ?? '',
    options: Array.isArray(options) ? options.map((o) => ({ id: String(o?.id ?? o), label: String(o?.label ?? o?.id ?? o) })) : [],
    allowTextInput: allowTextInput === true,
    nativeRef: createNativeRef(nativeRef),
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function validateInteraction(interaction) {
  const errors = [];
  if (!interaction || typeof interaction !== 'object') return ['interaction must be an object'];
  if (typeof interaction.id !== 'string' || !interaction.id) errors.push('interaction.id is required');
  if (!INTERACTION_TYPES.includes(interaction.type)) errors.push(`interaction.type must be one of ${INTERACTION_TYPES.join('/')}`);
  if (!INTERACTION_STATUS.includes(interaction.status)) errors.push(`interaction.status must be one of ${INTERACTION_STATUS.join('/')}`);
  if (!Array.isArray(interaction.options)) errors.push('interaction.options must be an array');
  errors.push(...validateNativeRef(interaction.nativeRef));
  return errors;
}

module.exports = { INTERACTION_TYPES, INTERACTION_STATUS, createInteraction, validateInteraction };
