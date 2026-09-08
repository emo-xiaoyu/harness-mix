// Shared Contracts：Core、Adapter、Renderer 共享的数据协议唯一来源。
module.exports = {
  ...require('./ids'),
  ...require('./thread'),
  ...require('./turn'),
  ...require('./item'),
  ...require('./event'),
  ...require('./native-ref'),
  ...require('./capability'),
  ...require('./interaction'),
};
