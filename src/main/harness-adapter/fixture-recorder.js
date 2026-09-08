const fs = require('node:fs');
const path = require('node:path');

// Fixture Recorder（§16/§17）：捕获 Harness 原生事件（不是 normalize 后的），
// 供 core-replay-test 无 Electron 回放。仅在捕获脚本显式 start 时生效，平时完全空操作。
// 本模块对 Harness 名称零感知，harnessId 仅作为输出目录名由调用方传入。

const MAX_STRING = 4000; // 工具输出/图片 data 截断，控制 fixture 体积

let active = null; // { harnessId, file }

function truncate(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncate(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 8) return '[max-depth]';
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = truncate(v, depth + 1);
    return out;
  }
  return value;
}

function startRecording(harnessId, label, dir = 'fixtures') {
  const folder = path.join(dir, harnessId);
  fs.mkdirSync(folder, { recursive: true });
  active = { harnessId, file: path.join(folder, `${label}.jsonl`) };
  fs.writeFileSync(active.file, '');
}

function recordNative(harnessId, event) {
  if (!active || active.harnessId !== harnessId || !event || typeof event !== 'object') return;
  try {
    fs.appendFileSync(active.file, `${JSON.stringify(truncate(event))}\n`);
  } catch { /* 录制失败不影响运行 */ }
}

function stopRecording() {
  active = null;
}

/** 控制记录（非原生事件）：标记宿主侧动作的发生位置，如 cancel 时刻，供回放按真实顺序注入 */
function recordControl(harnessId, control) {
  if (!active || active.harnessId !== harnessId) return;
  try {
    fs.appendFileSync(active.file, `${JSON.stringify({ __control__: String(control), at: Date.now() })}\n`);
  } catch { /* 录制失败不影响运行 */ }
}

function isRecording() {
  return Boolean(active);
}

module.exports = { startRecording, recordNative, recordControl, stopRecording, isRecording };
