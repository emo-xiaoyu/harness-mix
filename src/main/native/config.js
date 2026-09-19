const fs = require('node:fs');
const path = require('node:path');
const { dataDirectory, executableName } = require('./platform');
const root = path.resolve(__dirname, '../../..');
const settingKeys = ['HARNESS_MIX_DSH_ROOT', 'HARNESSMIX_PI_COMMAND', 'HARNESSMIX_CLAUDE_COMMAND', 'HARNESSMIX_DEEPSEEK_HARNESS_COMMAND', 'HARNESSMIX_ANTIGRAVITY_COMMAND', 'HARNESS_MIX_CODEBUDDY_EXECUTABLE', 'HARNESS_MIX_WORKBUDDY_EXECUTABLE', 'HARNESS_MIX_KIRO_EXECUTABLE', 'HARNESS_MIX_CURSOR_EXECUTABLE', 'HARNESS_MIX_QODER_EXECUTABLE', 'HARNESS_MIX_ZCODE_EXECUTABLE', 'HARNESS_MIX_TRAE_EXECUTABLE'];

function nativePaths(platform = process.platform) {
  const build = path.join(root, 'output/native-build');
  return {
    cli: path.join(root, 'scripts/launch-codex.cjs'),
    shim: path.join(build, executableName('harness-mix-shim', platform)),
    ...(platform === 'win32' ? {
      activation: path.join(build, 'harness-mix-appx.exe'),
      secret: path.join(build, 'harness-mix-secret.exe'),
    } : {}),
    runtime: path.join(root, 'src/main/native/host.js'),
    controller: path.join(build, 'desktop-controller.mjs'),
    renderer: path.join(build, 'renderer-extension.js'),
    wrapper: path.join(root, 'scripts', 'native-host.cjs'),
  };
}

function nativeEnvironment(environment = process.env) {
  const env = { ...environment };
  env.HARNESSMIX_DATA_DIR = dataDirectory(env);
  const settingsPath = path.join(env.HARNESSMIX_DATA_DIR, 'harness-mix-settings.json');
  if (fs.existsSync(settingsPath)) {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const key of settingKeys) {
      if (!env[key] && typeof saved[key] === 'string') env[key] = saved[key];
    }
  }
  env.HARNESSMIX_DEFAULT_AGENT ||= 'codex';
  env.HARNESS_MIX_NODE_PATH = process.execPath;
  if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('--max-old-space-size')) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' ');
  }
  if (!env.HARNESSMIX_DEEPSEEK_HARNESS_COMMAND && process.platform === 'win32') {
    env.HARNESSMIX_DEEPSEEK_HARNESS_COMMAND = path.join(root, 'scripts', 'dsh-native.cmd');
  }
  return env;
}

function saveNativeSettings(env) {
  fs.mkdirSync(env.HARNESSMIX_DATA_DIR, { recursive: true });
  // Only executable locations are persisted; never copy the complete environment.
  const settings = Object.fromEntries(settingKeys.filter(key => env[key] &&
    !(key === 'HARNESSMIX_DEEPSEEK_HARNESS_COMMAND' && env[key] === path.join(root, 'scripts', 'dsh-native.cmd')))
    .map(key => [key, env[key]]));
  const file = path.join(env.HARNESSMIX_DATA_DIR, 'harness-mix-settings.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { nativePaths, nativeEnvironment, saveNativeSettings };
