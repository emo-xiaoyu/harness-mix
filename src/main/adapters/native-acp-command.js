const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cliSpawn } = require('../host/jsonl');

// Resolve only the named native CLI. In particular, `agent` can belong to Grok.
function nativeCommand(id, argv) {
  const cursor = id === 'cursor-cli';
  const buddy = id === 'codebuddy';
  const specs = {
    codebuddy: ['codebuddy', 'HARNESS_MIX_CODEBUDDY_EXECUTABLE', 'https://www.codebuddy.ai/docs/cli/overview'],
    'cursor-cli': ['cursor-agent', 'HARNESS_MIX_CURSOR_EXECUTABLE', 'https://cursor.com/docs/cli/installation'],
    'kiro-cli': ['kiro-cli', 'HARNESS_MIX_KIRO_EXECUTABLE', 'https://kiro.dev/docs/cli/'],
    qoder: ['qodercli', 'HARNESS_MIX_QODER_EXECUTABLE', 'https://docs.qoder.com/cli/acp'],
    trae: ['traecli', 'HARNESS_MIX_TRAE_EXECUTABLE', 'https://github.com/bytedance/trae-agent'],
    zcode: ['zcode-acp-server', 'HARNESS_MIX_ZCODE_ACP_EXECUTABLE', 'https://zcode.z.ai/'],
  };
  if (!specs[id]) throw new Error(`Unknown native CLI: ${id}`);
  const [bin, variable, url] = specs[id];
  const override = process.env[variable] || (buddy ? process.env.HARNESS_MIX_WORKBUDDY_EXECUTABLE : undefined);
  if (id === 'trae' && !override) throw new Error('Trae 官方仓库未确认 ACP 服务入口；请设置已验证的 HARNESS_MIX_TRAE_EXECUTABLE，不会猜测 traecli acp serve');
  if (id === 'zcode' && !override) throw new Error('ZCode 原生 CLI 提供 app-server 而非 ACP；需要显式配置 HARNESS_MIX_ZCODE_ACP_EXECUTABLE 指向兼容 ACP 桥接器');
  const roots = cursor
    ? [path.join(process.env.LOCALAPPDATA || os.homedir(), 'cursor-agent'), path.join(os.homedir(), '.local', 'bin')]
    : [path.join(process.env.LOCALAPPDATA || os.homedir(), 'Kiro-Cli'), path.join(os.homedir(), '.kiro', 'bin'), path.join(os.homedir(), '.local', 'bin')];
  const dirs = [...roots, path.join(process.env.APPDATA || os.homedir(), 'npm'), ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : [''];
  const bundled = buddy ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy'), path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy')] : [];
  const bins = id === 'qoder' ? [bin, 'qoder'] : [bin];
  const found = override || [...dirs.flatMap(dir => bins.flatMap(name => suffixes.map(ext => path.join(dir, name + ext)))), ...bundled].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found || !fs.existsSync(found)) throw new Error(`${bin} 未安装；请从 ${url} 安装并原生登录`);
  if ((buddy && bundled.includes(found)) || /\.(cjs|mjs|js)$/i.test(found)) return { command: process.execPath, args: [found, ...argv] };
  if (id === 'qoder' && /\.(cmd|ps1)$/i.test(found)) {
    const bundle = path.join(path.dirname(found), 'node_modules/@qoder-ai/qodercli/bundle/qodercli.js');
    if (fs.existsSync(bundle)) return { command: process.execPath, args: [bundle, ...argv] };
  }
  if (cursor && /\.(cmd|ps1)$/i.test(found)) {
    const versions = path.join(path.dirname(found), 'versions');
    const version = fs.existsSync(versions) && fs.readdirSync(versions).filter(v => /^\d{4}\.\d{2}\.\d{2}-[a-z0-9-]+$/i.test(v)).sort().reverse().find(v => ['node.exe', 'index.js'].every(f => fs.existsSync(path.join(versions, v, f))));
    if (!version) throw new Error('Cursor launcher 缺少原生 bundle；请重新安装 Cursor CLI');
    return { command: path.join(versions, version, 'node.exe'), args: [path.join(versions, version, 'index.js'), ...argv] };
  }
  if (/\.(cmd|bat)$/i.test(found)) return cliSpawn(found.replace(/\.(cmd|bat)$/i, ''), argv);
  if (/\.ps1$/i.test(found)) return { command: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-File', found, ...argv] };
  return { command: found, args: argv };
}
module.exports = { nativeCommand };
