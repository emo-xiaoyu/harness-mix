const { newTurnId } = require('./ids');
const { createNativeRef, validateNativeRef } = require('./native-ref');

// Turn：一次独立执行。生命周期只能由 TurnManager 推进（执行约束：状态不得由
// Renderer / Transcript / Adapter 推断）。
const TURN_STATUS = ['created', 'starting', 'running', 'waiting_interaction', 'completed', 'cancelled', 'error'];
const TERMINAL_TURN_STATUS = ['completed', 'cancelled', 'error'];

// 合法状态机。终态不允许再迁移（例如 completed → running 必须拒绝）。
const TURN_TRANSITIONS = {
  created: ['starting', 'cancelled', 'error'],
  starting: ['running', 'waiting_interaction', 'completed', 'cancelled', 'error'],
  running: ['waiting_interaction', 'completed', 'cancelled', 'error'],
  waiting_interaction: ['running', 'completed', 'cancelled', 'error'],
  completed: [],
  cancelled: [],
  error: [],
};

function canTransition(from, to) {
  return (TURN_TRANSITIONS[from] ?? []).includes(to);
}

function createTurn({ id, threadId, nativeTurnRef, status = 'created', itemIds, lastSequence, error } = {}, now = Date.now()) {
  return {
    id: id ?? newTurnId(),
    threadId: threadId ?? null,
    nativeTurnRef: createNativeRef(nativeTurnRef),
    status,
    startedAt: null,
    completedAt: null,
    itemIds: Array.isArray(itemIds) ? [...itemIds] : [],
    lastSequence: typeof lastSequence === 'number' ? lastSequence : 0,
    error: error ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function validateTurn(turn) {
  const errors = [];
  if (!turn || typeof turn !== 'object') return ['turn must be an object'];
  if (typeof turn.id !== 'string' || !turn.id) errors.push('turn.id is required');
  if (typeof turn.threadId !== 'string' || !turn.threadId) errors.push('turn.threadId is required');
  if (!TURN_STATUS.includes(turn.status)) errors.push(`turn.status must be one of ${TURN_STATUS.join('/')}`);
  if (turn.startedAt != null && typeof turn.startedAt !== 'number') errors.push('turn.startedAt must be a number or null');
  if (turn.completedAt != null && typeof turn.completedAt !== 'number') errors.push('turn.completedAt must be a number or null');
  if (!Array.isArray(turn.itemIds)) errors.push('turn.itemIds must be an array');
  if (typeof turn.lastSequence !== 'number') errors.push('turn.lastSequence must be a number');
  errors.push(...validateNativeRef(turn.nativeTurnRef));
  return errors;
}

module.exports = { TURN_STATUS, TERMINAL_TURN_STATUS, TURN_TRANSITIONS, canTransition, createTurn, validateTurn };
