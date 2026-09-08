const { randomUUID } = require('node:crypto');

// 统一 ID 生成：带前缀，便于在日志 / Fixture / NativeRef 中辨识实体类型。
const newId = (prefix) => `${prefix}_${randomUUID()}`;

module.exports = {
  newThreadId: () => newId('thread'),
  newTurnId: () => newId('turn'),
  newItemId: () => newId('item'),
  newEventId: () => newId('evt'),
  newInteractionId: () => newId('int'),
};
