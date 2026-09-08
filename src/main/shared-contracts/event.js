const { newEventId } = require('./ids');
const { createNativeRef, validateNativeRef } = require('./native-ref');

// CoreEvent：所有 Harness 事件的统一出口。Adapter/Normalizer 只产出 CoreEvent，
// Core 只消费 CoreEvent（Native Event 能力优先于 Host 推测，语义由 source 侧给出）。
const EVENT_TYPES = [
  'thread.created',
  'thread.updated',
  'turn.started',
  'turn.waiting',
  'turn.resumed',
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
  'item.started',
  'item.delta',
  'item.updated',
  'item.completed',
  'usage.updated',
  'files.updated',
  'plan.updated',
];

function createCoreEvent({ eventId, sequence, timestamp, threadId, turnId, itemId, source, nativeRef, type, payload } = {}, now = Date.now()) {
  return {
    eventId: eventId ?? newEventId(),
    sequence: typeof sequence === 'number' ? sequence : null,
    timestamp: typeof timestamp === 'number' ? timestamp : now,
    threadId: threadId ?? null,
    turnId: turnId ?? null,
    itemId: itemId ?? null,
    source: source ?? null,
    nativeRef: createNativeRef(nativeRef),
    type,
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

function validateCoreEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') return ['event must be an object'];
  if (typeof event.eventId !== 'string' || !event.eventId) errors.push('event.eventId is required');
  if (event.sequence != null && typeof event.sequence !== 'number') errors.push('event.sequence must be a number or null');
  if (typeof event.timestamp !== 'number') errors.push('event.timestamp must be a number');
  if (typeof event.threadId !== 'string' || !event.threadId) errors.push('event.threadId is required');
  if (event.turnId != null && typeof event.turnId !== 'string') errors.push('event.turnId must be a string or null');
  if (event.itemId != null && typeof event.itemId !== 'string') errors.push('event.itemId must be a string or null');
  if (!EVENT_TYPES.includes(event.type)) errors.push(`event.type must be one of ${EVENT_TYPES.join('/')}`);
  if (event.payload != null && (typeof event.payload !== 'object' || Array.isArray(event.payload))) errors.push('event.payload must be an object');
  errors.push(...validateNativeRef(event.nativeRef));
  return errors;
}

module.exports = { EVENT_TYPES, createCoreEvent, validateCoreEvent };
