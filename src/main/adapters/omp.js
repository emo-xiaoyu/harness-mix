// OMP（Oh My Pi）Adapter：Pi 的 fork，CLI 与 --mode rpc 协议同源。
// 实现共享自 Pi 家族工厂（见 pi-family.js）；OMP 侧差异（如有）在此覆盖。
const { piFamily } = require('./pi-family');

module.exports = piFamily({
  id: 'omp',
  name: 'Oh My Pi',
  icon: 'omp-color.svg',
  bin: 'omp',
  packageHint: 'npm i -g @oh-my-pi/pi-coding-agent 或 https://omp.sh/install',
  aliases: ['omp', 'oh-my-pi'],
});
module.exports.manifest.integrations = {
  mcp: false,
  skills: {
    global: ['.omp/agent/skills', '.agents/skills', '.pi/agent/skills'],
    project: ['.omp/skills', '.agents/skills', '.pi/skills'],
    overrides: {
      '.omp/agent/skills': { env: 'OMP_CODING_AGENT_DIR', suffix: 'skills' },
      '.pi/agent/skills': { env: 'PI_CODING_AGENT_DIR', suffix: 'skills' },
    },
  },
};
