const { newThreadId } = require('./ids');
const { createNativeRef, validateNativeRef } = require('./native-ref');

// Thread：一次任务会话的 Core 侧身份。与具体 Harness 无关。
const THREAD_STATUS = ['idle', 'running', 'waiting', 'error'];

function createThread({ id, workspaceId, harnessId, nativeSessionRef, status = 'idle', metadata } = {}, now = Date.now()) {
  return {
    id: id ?? newThreadId(),
    workspaceId: workspaceId ?? null,
    harnessId: harnessId ?? null,
    nativeSessionRef: createNativeRef(nativeSessionRef),
    status,
    activeTurnId: null,
    createdAt: now,
    updatedAt: now,
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
  };
}

function validateThread(thread) {
  const errors = [];
  if (!thread || typeof thread !== 'object') return ['thread must be an object'];
  if (typeof thread.id !== 'string' || !thread.id) errors.push('thread.id is required');
  if (thread.workspaceId != null && typeof thread.workspaceId !== 'string') errors.push('thread.workspaceId must be a string');
  if (thread.harnessId != null && typeof thread.harnessId !== 'string') errors.push('thread.harnessId must be a string');
  if (!THREAD_STATUS.includes(thread.status)) errors.push(`thread.status must be one of ${THREAD_STATUS.join('/')}`);
  if (thread.activeTurnId != null && typeof thread.activeTurnId !== 'string') errors.push('thread.activeTurnId must be a string or null');
  if (typeof thread.createdAt !== 'number') errors.push('thread.createdAt must be a number');
  if (typeof thread.updatedAt !== 'number') errors.push('thread.updatedAt must be a number');
  if (thread.metadata != null && (typeof thread.metadata !== 'object' || Array.isArray(thread.metadata))) errors.push('thread.metadata must be an object');
  errors.push(...validateNativeRef(thread.nativeSessionRef));
  return errors;
}

module.exports = { THREAD_STATUS, createThread, validateThread };
