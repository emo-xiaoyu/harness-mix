const { newItemId } = require('./ids');
const { createNativeRef, validateNativeRef } = require('./native-ref');

// Item：Turn 内的最小呈现单元。第一阶段类型清单（后续只增不改语义）。
const ITEM_TYPES = [
  'user_message',
  'agent_message',
  'reasoning',
  'tool_call',
  'file_change',
  'approval',
  'question',
  'plan',
  'usage',
  'notice',
];

// started：刚建立；streaming：持续接收 delta；completed/cancelled/error：终态。
const ITEM_STATUS = ['started', 'streaming', 'completed', 'cancelled', 'error'];
const TERMINAL_ITEM_STATUS = ['completed', 'cancelled', 'error'];

function createItem({ id, threadId, turnId, type, status = 'started', nativeRef, ...rest } = {}, now = Date.now()) {
  return {
    id: id ?? newItemId(),
    threadId: threadId ?? null,
    turnId: turnId ?? null,
    type,
    status,
    createdAt: now,
    updatedAt: now,
    nativeRef: createNativeRef(nativeRef),
    ...rest,
  };
}

function validateItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return ['item must be an object'];
  if (typeof item.id !== 'string' || !item.id) errors.push('item.id is required');
  if (typeof item.threadId !== 'string' || !item.threadId) errors.push('item.threadId is required');
  if (item.turnId != null && typeof item.turnId !== 'string') errors.push('item.turnId must be a string or null');
  if (!ITEM_TYPES.includes(item.type)) errors.push(`item.type must be one of ${ITEM_TYPES.join('/')}`);
  if (!ITEM_STATUS.includes(item.status)) errors.push(`item.status must be one of ${ITEM_STATUS.join('/')}`);
  if (typeof item.createdAt !== 'number') errors.push('item.createdAt must be a number');
  if (typeof item.updatedAt !== 'number') errors.push('item.updatedAt must be a number');
  errors.push(...validateNativeRef(item.nativeRef));
  return errors;
}

module.exports = { ITEM_TYPES, ITEM_STATUS, TERMINAL_ITEM_STATUS, createItem, validateItem };
