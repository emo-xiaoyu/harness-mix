const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '../../..');
const settingKeys = ['HARNESS_MIX_DSH_ROOT', 'CODEXHOST_PI_COMMAND', 'CODEXHOST_CLAUDE_COMMAND', 'CODEXHOST_DEEPSEEK_HARNESS_COMMAND', 'CODEXHOST_ANTIGRAVITY_COMMAND', 'HARNESS_MIX_CODEBUDDY_EXECUTABLE', 'HARNESS_MIX_WORKBUDDY_EXECUTABLE', 'HARNESS_MIX_KIRO_EXECUTABLE', 'HARNESS_MIX_CURSOR_EXECUTABLE', 'HARNESS_MIX_QODER_EXECUTABLE', 'HARNESS_MIX_ZCODE_ACP_EXECUTABLE', 'HARNESS_MIX_TRAE_EXECUTABLE'];

function nativePaths() {
  const build = path.join(root, 'output/native-build');
  return {
    cli: path.join(root, 'scripts/launch-codex.cjs'),
    shim: path.join(build, 'harness-mix-shim.exe'),
    activation: path.join(build, 'harness-mix-appx.exe'),
    secret: path.join(build, 'harness-mix-secret.exe'),
    runtime: path.join(root, 'src/main/native/host.js'),
    controller: path.join(build, 'desktop-controller.mjs'),
    renderer: path.join(build, 'renderer-extension.js'),
    wrapper: path.join(root, 'scripts', 'native-host.cjs'),
  };
}

function nativeEnvironment(environment = process.env) {
  const env = { ...environment };
  env.CODEXHOST_DATA_DIR ||= path.join(env.APPDATA || os.homedir(), 'harness-mix', 'codexhost');
  const settingsPath = path.join(env.CODEXHOST_DATA_DIR, 'harness-mix-settings.json');
  if (fs.existsSync(settingsPath)) {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const key of settingKeys) {
      if (!env[key] && typeof saved[key] === 'string') env[key] = saved[key];
    }
  }
  env.CODEXHOST_DEFAULT_AGENT ||= 'codex';
  env.HARNESS_MIX_NODE_PATH = process.execPath;
  if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('--max-old-space-size')) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' ');
  }
  if (!env.CODEXHOST_DEEPSEEK_HARNESS_COMMAND && process.platform === 'win32') {
    env.CODEXHOST_DEEPSEEK_HARNESS_COMMAND = path.join(root, 'scripts', 'dsh-native.cmd');
  }
  return env;
}

function saveNativeSettings(env) {
  fs.mkdirSync(env.CODEXHOST_DATA_DIR, { recursive: true });
  // Only executable locations are persisted; never copy the complete environment.
  const settings = Object.fromEntries(settingKeys.filter(key => env[key] &&
    !(key === 'CODEXHOST_DEEPSEEK_HARNESS_COMMAND' && env[key] === path.join(root, 'scripts', 'dsh-native.cmd')))
    .map(key => [key, env[key]]));
  const file = path.join(env.CODEXHOST_DATA_DIR, 'harness-mix-settings.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { nativePaths, nativeEnvironment, saveNativeSettings };
