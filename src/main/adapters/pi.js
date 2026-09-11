// Pi Adapter：pi.cmd --mode rpc。实现共享自 Pi 家族工厂（见 pi-family.js）。
const { piFamily } = require('./pi-family');

module.exports = piFamily({
  id: 'pi',
  name: 'Pi',
  icon: 'pinumber1_80899.svg',
  bin: 'pi',
  packageHint: 'npm i -g @earendil-works/pi-coding-agent',
});
