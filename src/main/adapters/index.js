const pi = require("./pi");
const dsh = require("./dsh");
const claude = require("./claude");
const codex = require("./codex");
const antigravity = require("./antigravity");
const opencode = require('./opencode');
const grok = require('./grok');
const omp = require('./omp');
const openclaw = require('./openclaw');
const hermes = require('./hermes');
const qoder = require('./qoder');
const codebuddy = require('./codebuddy');
const zcode = require('./zcode');
const trae = require('./trae');
const kiro = require('./kiro');
const cursor = require('./cursor');
const cline = require('./cline');
const kimi = require('./kimi');

/**
 * Adapter 注册表：Manifest + 工厂 + Adapter + Session。
 * 新增 Harness 时：实现同形状模块并加入此列表，Renderer 无需改动协议。
 */
const REGISTRY = [antigravity, pi, omp, dsh, claude, codex, opencode, grok, openclaw, hermes, qoder, codebuddy, zcode, trae, kiro, cursor, cline, kimi];

// HARNESSMIX_DISABLED_HARNESSES（设置文件持久化，逗号/空格分隔）：按 id 或别名
// 整体摘除对应适配器——Host 的启动探测、配额、模型目录、健康刷新、账号列表都
// 不再拉起其 CLI。典型场景：antigravity 登录态损坏时 agy 每次被拉起都会弹
// 浏览器 OAuth 登录页，用户明确要求关闭时用此开关，删掉设置即可恢复。
function disabledHarnessIds(env = process.env) {
  const raw = String(env.HARNESSMIX_DISABLED_HARNESSES || '');
  return new Set(raw.split(/[\s,]+/).map((id) => id.trim().toLowerCase()).filter(Boolean));
}

function isHarnessDisabled(module, disabled) {
  if (!disabled.size) return false;
  const ids = [module.manifest?.id, ...(module.manifest?.aliases || [])].filter(Boolean);
  return ids.some((id) => disabled.has(id.toLowerCase()));
}

function buildAdapters(emit, env = process.env) {
  const disabled = disabledHarnessIds(env);
  return REGISTRY
    .filter((module) => !isHarnessDisabled(module, disabled))
    .map(({ manifest, create }) => {
      const adapter = create(emit);
      adapter.manifest = manifest;
      return adapter;
    });
}

module.exports = { buildAdapters, disabledHarnessIds, isHarnessDisabled };
