const fs = require('node:fs');
const path = require('node:path');

const ICONS_DIR = path.resolve(__dirname, '../../assets/icons');

const MODEL_FAMILIES = [
  { id: 'gemini', regex: /gemini/i, file: 'model-gemini.svg', label: 'Gemini' },
  { id: 'deepseek', regex: /deepseek/i, file: 'model-deepseek.svg', label: 'DeepSeek' },
  { id: 'xiaomimimo', regex: /mimo|xiaomi/i, file: 'model-xiaomimimo.svg', label: 'Xiaomi MIMO' },
  { id: 'qwen', regex: /qwen|qwq/i, file: 'model-qwen-color.svg', label: 'Qwen' },
  { id: 'hunyuan', regex: /hunyuan|混元/i, file: 'model-hunyuan.svg', label: 'Hunyuan' },
  { id: 'minimax', regex: /minimax|abab/i, file: 'model-minimax.svg', label: 'MiniMax' },
  { id: 'claude', regex: /claude|anthropic/i, file: 'model-claude.svg', label: 'Claude' },
  { id: 'kimi', regex: /kimi|moonshot/i, file: 'model-kimi.svg', label: 'Kimi' },
  { id: 'zai', regex: /glm|zhipu|智谱|z[.-]?ai\b/i, file: 'model-zai.svg', label: 'GLM / Zai' },
  { id: 'openai', regex: /gpt|openai|o[134](?:-|\b)/i, file: 'model-openai.svg', label: 'OpenAI' },
  { id: 'astra', regex: /.*/, file: 'model-astra.svg', label: 'Astra' },
];

const HARNESS_ICONS = [
  { id: 'kiro-cli', file: 'kiro-cli-color.svg', label: 'Kiro CLI' },
  { id: 'cursor-cli', file: 'cursor-cli-color.svg', label: 'Cursor CLI' },
  { id: 'antigravity', file: 'antigravity-color.svg', label: 'Antigravity' },
  { id: 'claude', file: 'claude-color.svg', label: 'Claude Code' },
  { id: 'codex', file: 'codex-harness.svg', label: 'Codex' },
  { id: 'dsh', file: 'deepseek-color.svg', label: 'DeepSeek Harness' },
  { id: 'pi', file: 'pi.svg', label: 'Pi' },
  { id: 'omp', file: 'omp-color.svg', label: 'Oh My Pi' },
  { id: 'opencode', file: 'opencode-color.svg', label: 'OpenCode' },
  { id: 'grok', file: 'grok-color.svg', label: 'Grok' },
  { id: 'openclaw', file: 'openclaw-color.svg', label: 'OpenClaw' },
  { id: 'hermes', file: 'hermes-color.svg', label: 'Hermes' },
  { id: 'qoder', file: 'qoder-color.svg', label: 'Qoder' },
  { id: 'codebuddy', file: 'codebuddy-color.svg', label: 'CodeBuddy' },
  { id: 'zcode', file: 'zcode-color.svg', label: 'ZCode' },
  { id: 'trae', file: 'trae-color.svg', label: 'Trae' },
];

const svgCache = new Map();

function readSvg(filename) {
  if (svgCache.has(filename)) return svgCache.get(filename);
  try {
    const filePath = path.join(ICONS_DIR, filename);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      svgCache.set(filename, content);
      return content;
    }
  } catch (_e) {
    // fallback
  }
  return '';
}

function matchModelFamily(modelOrName) {
  const text = typeof modelOrName === 'string'
    ? modelOrName
    : [modelOrName?.id, modelOrName?.name, modelOrName?.provider].filter(Boolean).join(' ');
  for (const family of MODEL_FAMILIES) {
    if (family.regex.test(text)) return family;
  }
  return MODEL_FAMILIES[MODEL_FAMILIES.length - 1];
}

function getModelSvg(modelOrName) {
  const family = matchModelFamily(modelOrName);
  return readSvg(family.file);
}

function getHarnessSvg(harnessId) {
  const item = HARNESS_ICONS.find(h => h.id === harnessId) || HARNESS_ICONS.find(h => h.id === 'codex');
  return readSvg(item.file);
}

function getAllIconsDictionary() {
  const dict = {
    models: {},
    harnesses: {},
  };
  for (const f of MODEL_FAMILIES) {
    dict.models[f.id] = {
      label: f.label,
      svg: readSvg(f.file),
    };
  }
  for (const h of HARNESS_ICONS) {
    dict.harnesses[h.id] = {
      label: h.label,
      svg: readSvg(h.file),
    };
  }
  return dict;
}

module.exports = {
  MODEL_FAMILIES,
  HARNESS_ICONS,
  matchModelFamily,
  getModelSvg,
  getHarnessSvg,
  getAllIconsDictionary,
};
