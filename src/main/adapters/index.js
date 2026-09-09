const pi = require("./pi");
const dsh = require("./dsh");
const claude = require("./claude");
const codex = require("./codex");
const antigravity = require("./antigravity");

/**
 * Adapter 注册表（借鉴 codex-host 插件结构：Manifest + 工厂 + Adapter + Session）。
 * 新增 Harness 时：实现同形状模块并加入此列表，Renderer 无需改动协议。
 */
const REGISTRY = [antigravity, pi, dsh, claude, codex];

function buildAdapters(emit) {
  return REGISTRY.map(({ manifest, create }) => {
    const adapter = create(emit);
    adapter.manifest = manifest;
    return adapter;
  });
}

module.exports = { buildAdapters };
