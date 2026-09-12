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

/**
 * Adapter 注册表（借鉴 codex-host 插件结构：Manifest + 工厂 + Adapter + Session）。
 * 新增 Harness 时：实现同形状模块并加入此列表，Renderer 无需改动协议。
 */
const REGISTRY = [antigravity, pi, omp, dsh, claude, codex, opencode, grok, openclaw, hermes, qoder, codebuddy, zcode, trae, kiro, cursor];

function buildAdapters(emit) {
  return REGISTRY.map(({ manifest, create }) => {
    const adapter = create(emit);
    adapter.manifest = manifest;
    return adapter;
  });
}

module.exports = { buildAdapters };
