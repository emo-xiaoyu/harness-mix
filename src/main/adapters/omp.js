// OMP（Oh My Pi）Adapter：Pi 的 fork，CLI 与 --mode rpc 协议同源。
// 实现共享自 Pi 家族工厂（见 pi-family.js）；OMP 侧差异在此覆盖。
// 权限模型已分叉：OMP 用 --approval-mode always-ask|write|yolo（无 Pi 的
// --approve/--no-approve 项目信任旗标），目录与启动旗标见 pi-family.js 的
// OMP_APPROVAL_MODES（实测 @oh-my-pi/pi-coding-agent 18.1.19 旗标表与设置 schema）。
const { piFamily, OMP_APPROVAL_MODES, ompPermissionLaunchArgs } = require('./pi-family');

module.exports = piFamily({
  id: 'omp',
  name: 'Oh My Pi',
  icon: 'omp-color.svg',
  bin: 'omp',
  packageHint: 'npm i -g @oh-my-pi/pi-coding-agent 或 https://omp.sh/install',
  aliases: ['omp', 'oh-my-pi'],
  permissionModes: OMP_APPROVAL_MODES,
  permissionLaunchArgs: ompPermissionLaunchArgs,
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
