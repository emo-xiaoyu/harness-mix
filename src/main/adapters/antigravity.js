const { spawn, execFile } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { recordNative } = require('../harness-adapter/fixture-recorder');
const { terminateTree } = require('../native/process-utils');

const manifest = {
  id: 'antigravity',
  name: 'Antigravity',
  icon: 'antigravity-color.svg',
  aliases: ['agy', 'antigravity'],
  capabilities: {
    streaming: true,
    thinking: true,
    tools: true,
    approvals: true,
    questions: true,
    models: true,
    thinkingLevels: true,
    permissionModes: true,
    resume: true,
    fork: true,
    forkFromMessage: true,
    compaction: false,
    usage: true,
    contextUsage: true,
    attachments: true,
  },
};

const ANTIGRAVITY_PERMISSION_MODES = [
  { id: 'default', label: '默认', description: '按 Antigravity 预设规则拦截或执行' },
  { id: 'desktop', label: '桌面确认', description: '在 Harness Mix 桌面端弹出确认工具执行' },
  { id: 'skip', label: '自动放行', description: '自动放行工具执行（--dangerously-skip-permissions）', dangerous: true },
];

const ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION =
  '[System Instruction: When creating new files in the workspace, you MUST use the write_to_file tool. When modifying existing files, use the replace_file_content tool. CRITICAL: NEVER include ArtifactMetadata when calling write_to_file for workspace files (ArtifactMetadata is strictly reserved for artifacts in the brain directory, and providing it for workspace files causes a path validation rejection). Do NOT use terminal commands (such as Set-Content, Out-File, echo, or cat) to create or write code files. For clarification, ask_question is connected to the codexhost Desktop through a Hook. Use single-choice or text questions. The Hook returns the actual user response in its reason while blocking the native auto-skip behavior; do not retry merely because the native tool reports it was blocked.]\n\n';

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
const EFFORT_SUFFIX_PATTERN = /^(?<base>.+)-(?<effort>low|medium|high)$/u;
const EFFORT_LABEL_SUFFIX_PATTERN = /\s*\((?:low|medium|high)\)$/iu;
const ANTIGRAVITY_RESULT_DRAIN_MS = 250;
const ANTIGRAVITY_RESULT_DRAIN_MAX_MS = 10_000;

function positiveDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function resolveExecutable() {
  if (process.env.HARNESS_MIX_ANTIGRAVITY_COMMAND) return process.env.HARNESS_MIX_ANTIGRAVITY_COMMAND;
  if (process.env.CODEXHOST_ANTIGRAVITY_COMMAND) return process.env.CODEXHOST_ANTIGRAVITY_COMMAND;
  if (process.platform === 'win32') {
    const local = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(local)) return local;
  }
  return 'agy';
}

function parseModelsOutput(output) {
  const grouped = new Map();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Fetching')) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx <= 0) continue;
    const id = line.slice(0, tabIdx).trim();
    const label = line.slice(tabIdx + 1).trim();
    if (!id || !label) continue;
    const match = EFFORT_SUFFIX_PATTERN.exec(id);
    const baseId = match?.groups?.base || id;
    const baseLabel = match ? label.replace(EFFORT_LABEL_SUFFIX_PATTERN, '').trim() || label : label;
    const effort = match?.groups?.effort || null;

    if (!grouped.has(baseId)) {
      grouped.set(baseId, { id: baseId, name: baseLabel, efforts: [] });
    }
    const entry = grouped.get(baseId);
    if (effort && !entry.efforts.some((e) => e.id === effort)) {
      entry.efforts.push({ id: effort, label: EFFORT_LABELS[effort] || effort });
    }
  }

  const models = [];
  for (const entry of grouped.values()) {
    let provider = 'google';
    if (/claude/i.test(entry.id)) provider = 'anthropic';
    else if (/gpt|openai/i.test(entry.id)) provider = 'openai';

    const order = ['low', 'medium', 'high'];
    entry.efforts.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    models.push({
      id: entry.id,
      name: entry.name,
      provider,
      efforts: entry.efforts,
      defaultEffort: entry.efforts.at(-1)?.id || 'high',
      contextWindow: /claude/i.test(entry.id) ? 200_000 : 1_048_576,
    });
  }
  return models;
}

function resolveContextWindow(modelId) {
  if (modelId && /claude/i.test(modelId)) return 200_000;
  return 1_048_576;
}

function usedPercentFrom(remainingFraction) {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) return null;
  const used = (1 - Math.min(1, Math.max(0, remainingFraction))) * 100;
  return Math.round(used * 100) / 100;
}

function parseAntigravityUsageCommand(command, fetchedAt = new Date().toISOString()) {
  if (!command || typeof command !== 'object' || command.name !== 'usage' || !command.data) return null;
  const { groups } = command.data;
  if (!Array.isArray(groups)) return null;
  const buckets = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    const groupName = typeof group.name === 'string' ? group.name.trim() : '';
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const usagePercent = usedPercentFrom(bucket.remaining_fraction);
      if (usagePercent === null) continue;
      const window = typeof bucket.window === 'string' ? bucket.window.trim() : '';
      const label = window === 'weekly' ? 'Weekly window' : window === '5h' ? '5-hour window' : (window || bucket.id);
      const resetsAt = typeof bucket.reset_time === 'string' && bucket.reset_time.trim() ? bucket.reset_time.trim() : undefined;
      buckets.push({
        product: groupName ? `${groupName} · ${label}` : label,
        usagePercent,
        window,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  if (!buckets.length) return null;
  const leading = [...buckets].sort((a, b) => {
    if (b.usagePercent !== a.usagePercent) return b.usagePercent - a.usagePercent;
    return Number(b.window === '5h') - Number(a.window === '5h');
  })[0];
  const others = buckets.filter((b) => b !== leading);
  return {
    usedPercent: leading.usagePercent,
    periodType: leading.window === '5h' ? 'five_hour' : 'weekly',
    fetchedAt,
    ...(leading.resetsAt ? { resetsAt: leading.resetsAt } : {}),
    ...(others.length > 0
      ? { productUsage: others.map(({ product, usagePercent, resetsAt }) => ({ product, usagePercent, ...(resetsAt ? { resetsAt } : {}) })) }
      : {}),
  };
}

async function fetchAntigravityQuota(executable = resolveExecutable()) {
  return new Promise((resolve) => {
    execFile(executable, ['--print=/usage', '--output-format', 'stream-json'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.event === 'command_result') {
            const snapshot = parseAntigravityUsageCommand(event.command);
            if (snapshot) return resolve(snapshot);
          }
        } catch {}
      }
      resolve(null);
    });
  });
}

function parseUsage(usageObj, modelId, quota) {
  if (!usageObj) return null;
  const input = usageObj.input_tokens ?? usageObj.inputTokens;
  const output = usageObj.output_tokens ?? usageObj.outputTokens;
  const thinking = usageObj.thinking_tokens ?? usageObj.reasoningOutputTokens;
  const cached = usageObj.cache_read_tokens ?? usageObj.cachedInputTokens;
  const total = usageObj.total_tokens ?? usageObj.totalTokens;
  const contextWindow = resolveContextWindow(modelId);
  const contextUsed = usageObj.context_used_tokens ?? usageObj.estimated_tokens_used ?? input;
  const tokens = typeof contextUsed === 'number' ? contextUsed : (typeof total === 'number' ? total : null);
  const result = {
    tokens,
    contextWindow,
    contextPercent: tokens != null && contextWindow ? Math.min(100, Math.round((100 * tokens / contextWindow) * 10) / 10) : null,
    inputTokens: typeof input === 'number' ? input : null,
    outputTokens: typeof output === 'number' ? output : null,
    reasoningOutputTokens: typeof thinking === 'number' ? thinking : null,
    cachedInputTokens: typeof cached === 'number' ? cached : null,
    totalTokens: typeof total === 'number' ? total : (typeof input === 'number' && typeof output === 'number' ? input + output : null),
  };
  if (quota) {
    if (quota.periodType === 'five_hour') {
      result.planFiveHourUsedPercent = quota.usedPercent;
      if (quota.resetsAt) {
        const unix = Math.floor(Date.parse(quota.resetsAt) / 1000);
        if (Number.isFinite(unix) && unix > 0) result.planFiveHourResetsAtUnix = unix;
      }
    }
    const weekly = quota.productUsage?.find(p => /weekly/i.test(p.product)) || (quota.periodType === 'weekly' ? quota : null);
    if (weekly) {
      result.planSevenDayUsedPercent = weekly.usagePercent;
      if (weekly.resetsAt) {
        const unix = Math.floor(Date.parse(weekly.resetsAt) / 1000);
        if (Number.isFinite(unix) && unix > 0) result.planSevenDayResetsAtUnix = unix;
      }
    }
  }
  return result;
}

function errorText(value) {
  if (value == null) return '';
  if (value instanceof Error) return value.message.trim();
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    const code = value.code ?? value.errorCode ?? value.status;
    const nested = value.message ?? value.errorMessage ?? value.error_message ?? value.detail ?? value.description ?? value.reason ?? value.error;
    const message = errorText(nested);
    if (message) {
      const codeText = code == null ? '' : String(code).trim();
      return codeText && !message.startsWith(`${codeText}:`) ? `${codeText}: ${message}` : message;
    }
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value);
}

function formatAntigravityResultError(result) {
  const detail = [result?.error, result?.errorMessage, result?.error_message, result?.message, result?.detail]
    .map(errorText)
    .find(Boolean);
  if (detail) return `Antigravity 回合失败：${detail}`;
  const status = errorText(result?.status);
  return status ? `Antigravity 回合失败（${status}）` : 'Antigravity 回合失败（未知错误）';
}

function resultSucceeded(result) {
  return errorText(result?.status).toUpperCase() === 'SUCCESS';
}

function modelSupportsEffort(model) {
  const id = String(model?.id ?? '').trim();
  if (Array.isArray(model?.efforts)) return model.efforts.length > 0;
  // Claude models expose built-in thinking in agy and reject --effort.
  return !/^claude(?:[-_.]|$)/i.test(id);
}

function formatPrompt(text) {
  if (!text) return '';
  if (text.startsWith('/') || text.includes('ArtifactMetadata')) return text;
  return `${ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION}${text}`;
}

async function prepareImageAttachments(images, cwd) {
  if (!Array.isArray(images) || !images.length) return { imageEntries: [], extraDirs: [] };
  const imageEntries = [];
  const extraDirs = [];
  let targetDir = null;
  const ensureTargetDir = async () => {
    if (targetDir) return targetDir;
    targetDir = path.join(cwd, '.gemini', 'attachments');
    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
    } catch {
      targetDir = path.join(os.tmpdir(), 'harness-mix-antigravity-attachments');
      await fs.promises.mkdir(targetDir, { recursive: true });
      if (!extraDirs.includes(targetDir)) extraDirs.push(targetDir);
    }
    return targetDir;
  };

  for (const img of images) {
    if (!img) continue;
    const ext = path.extname(img.name || '') || (img.mime === 'image/jpeg' ? '.jpg' : img.mime === 'image/gif' ? '.gif' : img.mime === 'image/webp' ? '.webp' : img.mime === 'image/svg+xml' ? '.svg' : '.png');
    const safeBase = path.basename(img.name || 'image', ext).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_') || 'image';
    const fileName = `${Date.now()}-${randomUUID().slice(0, 6)}-${safeBase}${ext}`;
    const sourcePath = typeof img.path === 'string' && img.path ? path.resolve(cwd, img.path) : null;
    const hasData = typeof img.data === 'string' && img.data.length > 0;
    if (!sourcePath && !hasData) throw new Error(`图片附件「${img.name || 'image'}」缺少本地文件或内容`);

    // Desktop clipboard images live in %TEMP% and may disappear after this
    // turn. Always materialize a durable copy before putting a path in the
    // native prompt, even when the source still exists right now.
    const durableDir = await ensureTargetDir();
    const filePath = path.join(durableDir, fileName);
    if (hasData) await fs.promises.writeFile(filePath, Buffer.from(img.data, 'base64'));
    else await fs.promises.copyFile(sourcePath, filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`图片附件「${img.name || 'image'}」保存失败`);
    }
    const normalizedPath = path.resolve(filePath).replace(/\\/g, '/');
    imageEntries.push({ name: img.name || path.basename(filePath), path: normalizedPath });
  }
  return { imageEntries, extraDirs };
}

async function restoreLegacyClipboardAttachments(thread) {
  const tempRoot = path.resolve(os.tmpdir());
  const restored = new Set();
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (const message of messages) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      if (attachment?.kind !== 'image' || typeof attachment.path !== 'string' || !attachment.path || typeof attachment.data !== 'string' || !attachment.data) continue;
      const filePath = path.resolve(thread.cwd || process.cwd(), attachment.path);
      const relative = path.relative(tempRoot, filePath);
      if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !/^codex-clipboard-[a-z0-9-]+\.(?:png|jpe?g|gif|webp)$/i.test(path.basename(filePath))) continue;
      if (fs.existsSync(filePath) || restored.has(filePath)) continue;
      try {
        await fs.promises.writeFile(filePath, Buffer.from(attachment.data, 'base64'));
        restored.add(filePath);
      } catch { /* A missing legacy temp file must not prevent session recovery. */ }
    }
  }
  return restored.size;
}

function toolTitle(name) {
  if (!name) return 'Antigravity 工具';
  if (name === 'run_command') return 'exec_command';
  if (name === 'write_to_file' || name === 'replace_file_content') return 'edit';
  if (name === 'view_file') return 'view_file';
  if (name === 'list_dir') return 'list_dir';
  if (name === 'grep_search') return 'grep_search';
  if (name === 'find_by_name') return 'find_by_name';
  if (name === 'read_url_content') return 'web_fetch';
  if (name === 'search_web') return 'search_web';
  if (name === 'ask_question') return '提问';
  if (name === 'generate_image') return '生成图片';
  if (name === 'schedule') return '调度任务';
  if (name === 'manage_task') return '后台任务';
  if (name === 'invoke_subagent') return '子 Agent';
  return name;
}

function mergePendingStep(pending, step) {
  if (!pending) return step;
  const toolName = step.tool_name ?? pending.tool_name;
  const name = step.tool_info?.name ?? pending.tool_info?.name;
  const parameters = step.tool_info?.parameters ?? pending.tool_info?.parameters;
  const output = step.tool_info?.output ?? pending.tool_info?.output;
  const error = step.tool_info?.error ?? pending.tool_info?.error;
  return {
    ...pending,
    ...step,
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(step.tool_info !== undefined || pending.tool_info !== undefined
      ? {
          tool_info: {
            ...(name !== undefined ? { name } : {}),
            ...(parameters !== undefined ? { parameters } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        }
      : {}),
  };
}

function toolInput(step) {
  const params = step.tool_info?.parameters;
  if (!params) return undefined;
  if (typeof params === 'string') return params;
  if (params.CommandLine) return params.CommandLine;
  if (params.TargetFile) return `${params.TargetFile}\n${params.Description || ''}`.trim();
  if (params.AbsolutePath) return params.AbsolutePath;
  if (params.DirectoryPath) return params.DirectoryPath;
  if (params.Url) return params.Url;
  if (params.query) return params.query;
  if (Array.isArray(params.Subagents)) {
    return params.Subagents.map((s) => `[${s.Role || s.TypeName || 'Agent'}] ${s.Prompt || ''}`.trim()).join('\n');
  }
  return JSON.stringify(params, null, 2);
}

function toolOutput(step) {
  const info = step.tool_info;
  if (!info) return undefined;
  if (info.error) return typeof info.error === 'string' ? info.error : JSON.stringify(info.error, null, 2);
  if (info.output != null) return typeof info.output === 'string' ? info.output : JSON.stringify(info.output, null, 2);
  return undefined;
}

function nativeConversationDbPath(sessionId, homedir = os.homedir()) {
  return path.join(homedir, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
}

function nativeBrainDirPath(sessionId, homedir = os.homedir()) {
  return path.join(homedir, '.gemini', 'antigravity-cli', 'brain', sessionId);
}

async function cloneDatabase(sourceId, derivedId, retainedTurnsCountOrHomedir, homedirOption = os.homedir()) {
  let retainedTurnsCount;
  let homedir = homedirOption;
  if (typeof retainedTurnsCountOrHomedir === 'string') {
    homedir = retainedTurnsCountOrHomedir;
  } else if (typeof retainedTurnsCountOrHomedir === 'number') {
    retainedTurnsCount = retainedTurnsCountOrHomedir;
  }

  const sourceDb = nativeConversationDbPath(sourceId, homedir);
  const targetDb = nativeConversationDbPath(derivedId, homedir);
  try {
    await fs.promises.mkdir(path.dirname(targetDb), { recursive: true });
    await fs.promises.copyFile(sourceDb, targetDb);
  } catch {
    return false;
  }

  let remainingStepCount = 0;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(targetDb);
    try {
      db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run(derivedId);
      if (typeof retainedTurnsCount === 'number' && Number.isInteger(retainedTurnsCount)) {
        try {
          if (retainedTurnsCount <= 0) {
            db.prepare('DELETE FROM steps').run();
          } else {
            const rows = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC').all();
            const cutoff = rows[retainedTurnsCount];
            if (cutoff && typeof cutoff.idx === 'number') {
              db.prepare('DELETE FROM steps WHERE idx >= ?').run(cutoff.idx);
            }
          }
        } catch {}
        try { db.prepare('DELETE FROM gen_metadata WHERE idx >= ?').run(retainedTurnsCount); } catch {}
        try { db.prepare('DELETE FROM executor_metadata WHERE idx >= ?').run(retainedTurnsCount); } catch {}
        try { db.prepare('DELETE FROM parent_references WHERE idx >= ?').run(retainedTurnsCount); } catch {}
        try { db.prepare('DELETE FROM battle_mode_infos WHERE idx >= ?').run(retainedTurnsCount); } catch {}
      }
      try {
        const countRow = db.prepare('SELECT count(*) as c FROM steps').get();
        if (countRow && typeof countRow.c === 'number') remainingStepCount = countRow.c;
      } catch {}
    } finally {
      db.close();
    }

    // Register in conversation_summaries.db so `agy` trajectory lookup succeeds
    try {
      const summariesDbPath = path.join(homedir, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
      if (fs.existsSync(summariesDbPath)) {
        const sumDb = new DatabaseSync(summariesDbPath);
        try {
          const row = sumDb.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(sourceId);
          if (row) {
            const cols = Object.keys(row);
            const newRow = {
              ...row,
              conversation_id: derivedId,
              last_modified_time: new Date().toISOString(),
              ...(typeof retainedTurnsCount === 'number' ? { step_count: remainingStepCount } : {}),
            };
            const placeholders = cols.map(() => '?').join(', ');
            const values = cols.map((col) => newRow[col]);
            sumDb
              .prepare(
                `INSERT OR REPLACE INTO conversation_summaries (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})`
              )
              .run(...values);
          }
        } finally {
          sumDb.close();
        }
      }
    } catch {}
  } catch {}
  return true;
}

async function cloneBrain(sourceId, derivedId, homedir = os.homedir()) {
  const sourceBrain = nativeBrainDirPath(sourceId, homedir);
  const targetBrain = nativeBrainDirPath(derivedId, homedir);
  try {
    await fs.promises.cp(sourceBrain, targetBrain, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.system_generated',
    });
    return true;
  } catch {
    return false;
  }
}

const ANTIGRAVITY_QUESTION_HOOK_CLIENT = `
const http = require("node:http");
const limit = 131072;
let input = "";
let finished = false;
let request;
function finish(value) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(value));
}
function unavailable() {
  finish({
    decision: "deny",
    reason: "codexhost question bridge is unavailable. No user answer was received. Do not report that the user skipped or selected an option."
  });
  if (request) request.destroy();
}
process.stdin.setEncoding("utf8");
process.stdin.on("error", unavailable);
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > limit) {
    input = "";
    process.stdin.destroy();
    unavailable();
  }
});
process.stdin.on("end", () => {
  if (finished) return;
  try {
    const target = new URL(process.env.CODEXHOST_AGY_QUESTION_URL);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" ||
        target.pathname !== "/question" || target.username || target.password) {
      return unavailable();
    }
    const payload = JSON.parse(input);
    const approval = process.env.CODEXHOST_AGY_QUESTION_APPROVALS === "1" &&
      payload.toolCall && payload.toolCall.name !== "ask_question";
    request = http.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + process.env.CODEXHOST_AGY_QUESTION_TOKEN,
        "content-length": Buffer.byteLength(input)
      }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("error", unavailable);
      response.on("aborted", unavailable);
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > limit) unavailable();
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode !== 200 ||
              (value.decision !== "deny" && !(approval && value.decision === "allow")) ||
              typeof value.reason !== "string") return unavailable();
          finish(value);
        } catch { unavailable(); }
      });
    });
    request.setTimeout(Number(process.env.CODEXHOST_AGY_QUESTION_TIMEOUT_MS) + 5000, unavailable);
    request.on("error", unavailable);
    request.end(input);
  } catch { unavailable(); }
});
`;

class QuestionBridge {
  constructor({ approvals, emit, timeoutMs = 600000 }) {
    this.approvals = approvals;
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.token = randomBytes(32).toString('hex');
    this.pending = new Map();
    this.directory = '';
    this.server = null;
    this.environment = {};
  }

  static async create(options) {
    const bridge = new QuestionBridge(options);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codexhost-agy-question-'));
    bridge.directory = dir;

    bridge.server = http.createServer((req, res) => bridge.#receive(req, res));
    await new Promise((resolve, reject) => {
      bridge.server.once('error', reject);
      bridge.server.listen(0, '127.0.0.1', () => {
        bridge.server.removeListener('error', reject);
        resolve();
      });
    });

    const address = bridge.server.address();
    const port = address.port;
    const clientPath = path.join(dir, 'question-hook.cjs');
    await fs.promises.mkdir(path.join(dir, '.agents'), { recursive: true });
    await fs.promises.writeFile(clientPath, ANTIGRAVITY_QUESTION_HOOK_CLIENT, 'utf8');

    const hookCmd = process.platform === 'win32'
      ? '%CODEXHOST_AGY_QUESTION_NODE% %CODEXHOST_AGY_QUESTION_CLIENT%'
      : `"${process.execPath}" "${clientPath}"`;

    await fs.promises.writeFile(
      path.join(dir, '.agents', 'hooks.json'),
      JSON.stringify({
        'codexhost-question-bridge': {
          PreToolUse: [
            {
              matcher: options.approvals ? '.*' : '^ask_question$',
              hooks: [
                {
                  type: 'command',
                  command: hookCmd,
                  timeout: Math.ceil(options.timeoutMs / 1000) + 15,
                },
              ],
            },
          ],
        },
      }, null, 2),
      'utf8',
    );

    bridge.environment = {
      CODEXHOST_AGY_QUESTION_TOKEN: bridge.token,
      CODEXHOST_AGY_QUESTION_URL: `http://127.0.0.1:${port}/question`,
      CODEXHOST_AGY_QUESTION_TIMEOUT_MS: String(options.timeoutMs),
      CODEXHOST_AGY_QUESTION_APPROVALS: options.approvals ? '1' : '0',
      CODEXHOST_AGY_QUESTION_NODE: `"${process.execPath.replaceAll('\\', '/')}"`,
      CODEXHOST_AGY_QUESTION_CLIENT: `"${clientPath.replaceAll('\\', '/')}"`,
    };

    return bridge;
  }

  #receive(req, res) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${this.token}` || req.method !== 'POST' || req.url !== '/question') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision: 'deny', reason: 'Forbidden' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'deny', reason: 'Invalid JSON' }));
        return;
      }
      this.#handlePayload(payload, res);
    });
  }

  #handlePayload(payload, res) {
    const toolCall = payload.toolCall || {};
    const toolName = toolCall.name;
    const conversationId = payload.conversationId;

    if (toolName === 'ask_question') {
      const questions = toolCall.args?.questions || [];
      const q = questions[0] || { question: 'Antigravity 提问' };
      const requestId = `antigravity-q-${randomUUID()}`;
      this.pending.set(requestId, { type: 'question', questions, response: res });
      this.emit({
        kind: 'approval',
        requestId,
        method: q.options?.length ? undefined : 'input',
        title: 'Antigravity 提问',
        message: q.question,
        options: (q.options || []).map((opt) => ({ id: opt, label: opt })),
        placeholder: '请输入或选择…',
        nativeRef: { sessionId: conversationId },
      });
      return;
    }

    if (this.approvals && toolName) {
      const requestId = `antigravity-app-${randomUUID()}`;
      this.pending.set(requestId, { type: 'approval', toolCall, response: res });
      this.emit({
        kind: 'approval',
        requestId,
        title: `Antigravity: ${toolName}`,
        message: `请求执行工具 ${toolName}\n${JSON.stringify(toolCall.args || {}, null, 2)}`,
        options: [
          { id: 'allow', label: '允许' },
          { id: 'deny', label: '拒绝', kind: 'reject' },
        ],
        nativeRef: { sessionId: conversationId },
      });
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ decision: 'allow' }));
  }

  respond(requestId, response) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);

    if (pending.type === 'question') {
      const answer = response?.cancelled ? '' : String(response?.optionId ?? response?.value ?? '');
      const result = response?.cancelled
        ? { status: 'cancelled', answers: {} }
        : {
            status: 'answered',
            answers: (pending.questions || []).map((q) => ({
              question: q.question,
              answers: answer ? [answer] : [],
            })),
          };
      const reason =
        'codexhost handled this question through the Desktop. Native ask_question is blocked only to prevent automatic skipping. ' +
        'The following JSON contains the actual user response, not a tool permission decision: ' +
        JSON.stringify(result);
      if (!pending.response.writableEnded) {
        pending.response.writeHead(200, { 'content-type': 'application/json' });
        pending.response.end(JSON.stringify({ decision: 'deny', reason }));
      }
      return true;
    }

    if (pending.type === 'approval') {
      const allowed = !response?.cancelled && (response?.optionId === 'allow' || response?.confirmed !== false);
      const decision = allowed ? 'allow' : 'deny';
      const reason = allowed ? 'User approved this tool call once.' : 'User denied this tool call.';
      if (!pending.response.writableEnded) {
        pending.response.writeHead(200, { 'content-type': 'application/json' });
        pending.response.end(JSON.stringify({ decision, reason }));
      }
      return true;
    }
    return false;
  }

  async dispose() {
    for (const pending of this.pending.values()) {
      if (!pending.response.writableEnded) {
        pending.response.writeHead(200, { 'content-type': 'application/json' });
        pending.response.end(JSON.stringify({ decision: 'deny', reason: 'Session closed' }));
      }
    }
    this.pending.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve)).catch(() => {});
      this.server = null;
    }
    if (this.directory) {
      await fs.promises.rm(this.directory, { recursive: true, force: true }).catch(() => {});
      this.directory = '';
    }
  }
}

function create(emit, options = {}) {
  let cachedQuota = null;
  let quotaPromise = null;
  const spawnProcess = options.spawnProcess || spawn;
  const resultDrainMs = positiveDuration(
    options.resultDrainMs ?? process.env.HARNESS_MIX_ANTIGRAVITY_RESULT_DRAIN_MS,
    ANTIGRAVITY_RESULT_DRAIN_MS,
  );
  const resultDrainMaxMs = Math.max(
    resultDrainMs,
    positiveDuration(
      options.resultDrainMaxMs ?? process.env.HARNESS_MIX_ANTIGRAVITY_RESULT_DRAIN_MAX_MS,
      ANTIGRAVITY_RESULT_DRAIN_MAX_MS,
    ),
  );

  return {
    manifest,

    async inspect() {
      const bin = resolveExecutable();
      return new Promise((resolve) => {
        execFile(bin, ['--version'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
          if (error) {
            resolve({ available: false, detail: '未找到 Antigravity CLI（agy）' });
          } else {
            resolve({ available: true, detail: `agy ${String(stdout).trim()}` });
          }
        });
      });
    },

    async open({ thread, emit: emitEvent, diagnostic }) {
      // Do not start a second agy process while a real turn may be starting.
      // Quota is loaded only by the explicit account/usage refresh path below.
      await restoreLegacyClipboardAttachments(thread);
      const model = thread.options?.model ?? { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google' };
      const thinkingLevel = thread.options?.thinking ?? 'high';
      const permissionMode = thread.options?.permissionMode ?? 'default';
      const session = {
        nativeSessionId: thread.nativeSessionId || null,
        cwd: thread.cwd,
        model,
        thinkingLevel,
        permissionMode,
        activeTurn: null,
        bridge: null,
        usage: undefined,
        pendingApprovals: new Map(),
      };
      if (thread.restore && thread.nativeSessionId) {
        emitEvent({ kind: 'session', nativeSessionId: thread.nativeSessionId, model });
      }
      return session;
    },

    async send(session, prompt, hooks, attachments) {
      if (session.activeTurn) throw new Error('Antigravity 当前回合尚未结束');

      const emitEvent = hooks?.emit || emit;
      const bin = resolveExecutable();
      const approvals = session.permissionMode === 'desktop' || session.permissionMode === 'desktop-approvals';
      const bridge = await QuestionBridge.create({
        approvals,
        emit: emitEvent,
      });
      session.bridge = bridge;

      let effectivePrompt = prompt ?? '';
      const { imageEntries, extraDirs } = await prepareImageAttachments(attachments?.images, session.cwd);
      if (imageEntries.length) {
        const imageNotice = [
          '[用户上传了图片附件]',
          '[仅使用本轮列出的持久化副本路径；不要复用历史消息中的 codex-clipboard 临时路径。]',
          ...imageEntries.map(e => `- [${e.name}](file:///${e.path}): 请使用 view_file 工具查看并分析该图片。`),
        ].join('\n');
        effectivePrompt = effectivePrompt.trim()
          ? `${imageNotice}\n\n${effectivePrompt}`
          : `${imageNotice}\n\n请查看并分析上述图片附件。`;
      }

      const logPath = path.join(os.tmpdir(), `harness-mix-antigravity-${randomUUID()}.log`);
      const args = [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--print-timeout', '30m',
      ];
      if (session.nativeSessionId) {
        args.push('--conversation', session.nativeSessionId);
      }
      if (session.model?.id) {
        args.push('--model', session.model.id);
      }
      if (session.thinkingLevel && modelSupportsEffort(session.model)) {
        args.push('--effort', session.thinkingLevel);
      }
      if (['skip', 'desktop', 'dangerously-skip-permissions', 'desktop-approvals'].includes(session.permissionMode)) {
        args.push('--dangerously-skip-permissions');
      }
      args.push('--add-dir', session.cwd);
      args.push('--add-dir', bridge.directory);
      for (const dir of extraDirs) {
        args.push('--add-dir', dir);
      }
      args.push('--log-file', logPath);

      const child = spawnProcess(bin, args, {
        cwd: session.cwd,
        env: { ...process.env, ...bridge.environment },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let turnResolve, turnReject;
      const settled = new Promise((resolve, reject) => {
        turnResolve = resolve;
        turnReject = reject;
      });

      const turn = {
        child,
        resolve: turnResolve,
        reject: turnReject,
        logPath,
        resultSeen: false,
        result: null,
        completed: false,
        processClosing: false,
        processClosed: false,
        killTimer: null,
        resultDrainTimer: null,
        resultDrainMaxTimer: null,
        pendingSteps: new Map(),
      };
      session.activeTurn = turn;
      let sawTextSinceLastTool = false;
      let stderrTail = '';
      child.stderr?.setEncoding('utf8')?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-8000);
      });

      // agy 在 stream-json 模式下产出 result 后进程仍常驻（实测 25s+ 不自行退出），
      // 不主动收尾会让 session.activeTurn 永远悬挂，下一回合 send 被“当前回合尚未结束”拒绝。
      // 但某些工具（尤其 view_file 图片）会先产生没有 output 字段的 DONE，随后才
      // 刷出最终 assistant_response。先结算 Turn 再结束 stdin 会把这段迟到文本丢给
      // 已关闭的 Normalizer，所以空结果时必须先做一个有界 drain。
      const clearResultDrainTimers = () => {
        if (turn.resultDrainTimer) clearTimeout(turn.resultDrainTimer);
        if (turn.resultDrainMaxTimer) clearTimeout(turn.resultDrainMaxTimer);
        turn.resultDrainTimer = null;
        turn.resultDrainMaxTimer = null;
      };

      const closeProcess = () => {
        if (turn.processClosing || turn.processClosed) return;
        turn.processClosing = true;
        try { child.stdin.end(); } catch {}
        turn.killTimer = setTimeout(() => { void terminateTree(child.pid); }, 10000);
        turn.killTimer.unref?.();
      };

      const settleResult = () => {
        if (turn.completed || !turn.result) return;
        turn.completed = true;
        clearResultDrainTimers();
        if (session.activeTurn === turn) session.activeTurn = null;
        const { res, nativeRef } = turn.result;
        const completedRef = {
          ...nativeRef,
          turnId: res.num_turns != null ? `turn:${res.num_turns}` : undefined,
          checkpointId: res.num_turns != null ? String(res.num_turns) : undefined,
        };
        const successful = resultSucceeded(res);
        const hasAssistantText = (typeof res.response === 'string'
          ? Boolean(res.response.trim())
          : Boolean(res.response)) || sawTextSinceLastTool;
        if (!successful) {
          const message = formatAntigravityResultError(res);
          emitEvent({ kind: 'error', message, nativeRef: completedRef });
          turnReject?.(new Error(message));
          closeProcess();
          return;
        }
        if (!hasAssistantText) {
          const message = 'Antigravity 回合返回 SUCCESS，但没有 assistant 文本';
          emitEvent({ kind: 'error', message, nativeRef: completedRef });
          turnReject?.(new Error(message));
          closeProcess();
          return;
        }
        emitEvent({
          kind: 'completed',
          finalAnswer: true,
          stopReason: 'completed',
          nativeRef: completedRef,
        });
        turnResolve?.();
        closeProcess();
      };

      const scheduleResultDrain = () => {
        if (!turn.resultSeen || turn.completed || !turn.result) return;
        if (!resultSucceeded(turn.result.res)) {
          settleResult();
          return;
        }
        const hasAssistantText = (typeof turn.result.res.response === 'string'
          ? Boolean(turn.result.res.response.trim())
          : Boolean(turn.result.res.response)) || sawTextSinceLastTool;
        if (hasAssistantText) {
          if (turn.resultDrainMaxTimer) clearTimeout(turn.resultDrainMaxTimer);
          turn.resultDrainMaxTimer = null;
          if (turn.resultDrainTimer) clearTimeout(turn.resultDrainTimer);
          turn.resultDrainTimer = setTimeout(settleResult, resultDrainMs);
          return;
        }
        // No text at result time is not proof that the native turn is finished.
        // Keep the Core turn active until a late assistant response arrives, but
        // always retain a hard ceiling for a genuinely tool-only/empty turn.
        if (!turn.resultDrainMaxTimer) {
          turn.resultDrainMaxTimer = setTimeout(settleResult, resultDrainMaxMs);
        }
      };

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let event;
        try { event = JSON.parse(line.trim()); } catch { return; }
        recordNative(manifest.id, event);

        const nativeRef = {
          sessionId: session.nativeSessionId || event.conversation_id || event.result?.conversation_id,
        };

        if (event.event === 'init') {
          session.nativeSessionId = event.conversation_id;
          emitEvent({ kind: 'session', nativeSessionId: event.conversation_id, model: session.model });
          return;
        }

        if (event.event === 'step_update') {
          const rawStep = event.step_update || {};
          const prevStep = turn.pendingSteps.get(rawStep.step_index);
          const s = mergePendingStep(prevStep, rawStep);
          if (s.step_index != null) turn.pendingSteps.set(s.step_index, s);
          const stepRef = { ...nativeRef, itemId: String(s.step_index) };

          if (s.step_type === 'agent_response') {
            const text = s.text_delta || s.text || s.content || s.message;
            if (typeof text === 'string' && text) {
              sawTextSinceLastTool = true;
              emitEvent({ kind: 'text-delta', text, nativeRef: stepRef });
              scheduleResultDrain();
            }
            return;
          }

          if (s.step_type === 'thought' || s.step_type === 'thinking') {
            const thinkingText = s.text_delta || s.text || s.content;
            if (thinkingText) {
              emitEvent({ kind: 'thinking-delta', text: thinkingText, nativeRef: stepRef });
            }
            return;
          }

          if (s.step_type === 'subagent') {
            sawTextSinceLastTool = false;
            const info = s.subagent_info || {};
            const subagents = Array.isArray(info.subagents) ? info.subagents : [];
            const state = s.state === 'DONE' ? 'done' : (s.state === 'ERROR' ? 'error' : 'running');
            const details = subagents.map((sub) => `[${sub.role || sub.type_name || 'Subagent'}] ID: ${sub.conversation_id || ''}\n${sub.initial_prompt || ''}`.trim()).join('\n\n');
            emitEvent({
              kind: 'tool',
              toolCallId: String(s.step_index),
              title: '子 Agent',
              state,
              input: details || undefined,
              output: s.state === 'DONE' ? '子 Agent 启动完成' : undefined,
              nativeRef: stepRef,
            });
            return;
          }

          if (s.step_type === 'tool') {
            sawTextSinceLastTool = false;
            const toolName = s.tool_name || s.tool_info?.name;
            const state = s.state === 'DONE' ? 'done' : (s.state === 'ERROR' ? 'error' : 'running');
            emitEvent({
              kind: 'tool',
              toolCallId: String(s.step_index),
              title: toolTitle(toolName),
              state,
              input: toolInput(s),
              output: toolOutput(s),
              nativeRef: stepRef,
            });

            // Native file mutations
            if (s.state === 'DONE' && (toolName === 'write_to_file' || toolName === 'replace_file_content')) {
              const params = s.tool_info?.parameters || {};
              // agy stream-json 工具事件只携带 TargetFile，不携带文件内容（实测 ACTIVE/DONE 均如此）。
              // 保持 complete: false（与 codex.js 同一约定）：仅作实时提示，回合结算时由
              // 工作区快照（ReviewStore）用权威 before/after 覆盖，UI 才能显示真实增删统计。
              const target = typeof params.TargetFile === 'string' ? params.TargetFile : null;
              const relative = target ? path.relative(session.cwd, path.resolve(session.cwd, target)).replace(/\\/g, '/') : '';
              // 只投影工作区内的变更；脑目录等 --add-dir 目录不属于本轮文件审查
              if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
                emitEvent({
                  kind: 'file-change',
                  source: 'native',
                  changes: [{
                    path: target,
                    changeType: toolName === 'write_to_file' ? (params.Overwrite ? 'modified' : 'added') : 'modified',
                    complete: false,
                    nativeRef: stepRef,
                  }],
                  nativeRef: stepRef,
                });
              }
            }
          }

          if (s.usage) {
            const u = parseUsage(s.usage, session.model?.id, cachedQuota);
            if (u) {
              session.usage = u;
              emitEvent({ kind: 'usage', usage: u, nativeRef: stepRef });
            }
          }
          return;
        }

        if (event.event === 'result') {
          if (turn.resultSeen || turn.completed) return;
          const res = event.result || {};
          if (res.conversation_id && !session.nativeSessionId) {
            session.nativeSessionId = res.conversation_id;
          }
          if (res.usage) {
            const u = parseUsage(res.usage, session.model?.id, cachedQuota);
            if (u) {
              session.usage = u;
              emitEvent({ kind: 'usage', usage: u, nativeRef });
            }
          }
          if (res.response && !sawTextSinceLastTool) {
            if (typeof res.response === 'string') {
              sawTextSinceLastTool = true;
              emitEvent({ kind: 'text-delta', text: res.response, nativeRef });
            }
          }
          turn.resultSeen = true;
          turn.result = { res, nativeRef };
          scheduleResultDrain();
        }
      });

      child.on('error', (err) => {
        if (turn.resultSeen) {
          settleResult();
          return;
        }
        if (turn.killTimer) clearTimeout(turn.killTimer);
        clearResultDrainTimers();
        turn.completed = true;
        if (session.activeTurn === turn) session.activeTurn = null;
        void fs.promises.unlink(logPath).catch(() => {});
        void bridge.dispose();
        if (session.bridge === bridge) session.bridge = null;
        emitEvent({ kind: 'error', message: `Antigravity 进程错误: ${err.message}` });
        turnReject?.(err);
      });

      child.on('close', (code) => {
        turn.processClosed = true;
        if (turn.killTimer) clearTimeout(turn.killTimer);
        clearResultDrainTimers();
        void fs.promises.unlink(logPath).catch(() => {});
        void bridge.dispose();
        if (session.bridge === bridge) session.bridge = null;
        if (turn.resultSeen) {
          // A real process close means stdout can no longer deliver a late
          // assistant event; settle the already received result now.
          settleResult();
        } else if (!turn.completed) {
          turn.completed = true;
          if (session.activeTurn === turn) session.activeTurn = null;
          const cleanErr = stderrTail.trim();
          const message = cleanErr
            ? `Antigravity CLI 未返回 result（退出码 ${code ?? 'unknown'}）：${cleanErr}`
            : `Antigravity CLI 未返回 result（退出码 ${code ?? 'unknown'}）`;
          // 进程未产出 result 即退出（崩溃、认证失败或协议中断）：明确失败，
          // 不能把 code 0 的空 stdout 伪装成成功回合。
          emitEvent({ kind: 'error', message });
          turnReject?.(new Error(message));
        }
      });

      try {
        const fullPrompt = formatPrompt(effectivePrompt);
        if (child.stdin.writable) {
          child.stdin.write(JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n');
        }
      } catch (err) {
        const message = `Antigravity 输入失败：${err.message}`;
        turn.completed = true;
        if (session.activeTurn === turn) session.activeTurn = null;
        void bridge.dispose();
        if (session.bridge === bridge) session.bridge = null;
        void terminateTree(child.pid);
        emitEvent({ kind: 'error', message });
        turnReject?.(new Error(message));
      }

      return settled;
    },

    async cancel(session) {
      if (session.activeTurn?.child) {
        void terminateTree(session.activeTurn.child.pid);
      }
      if (session.bridge) {
        await session.bridge.dispose().catch(() => {});
        session.bridge = null;
      }
      session.activeTurn?.resolve?.();
      session.activeTurn = null;
    },

    async respond(session, requestId, response) {
      if (session.bridge) {
        session.bridge.respond(requestId, response);
      }
    },

    async listModels() {
      return null;
    },

    async listModelsFor(_session) {
      const bin = resolveExecutable();
      return new Promise((resolve) => {
        execFile(bin, ['models'], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
          if (error) return resolve([]);
          resolve(parseModelsOutput(stdout));
        });
      });
    },

    async setModel(session, model) {
      session.model = { id: model.id, name: model.name || model.id, provider: model.provider || 'google' };
      return session.model;
    },

    async setThinkingLevel(session, level) {
      session.thinkingLevel = level;
    },

    async setPermissionMode(session, mode) {
      session.permissionMode = mode;
    },

    async getContextUsage(session) {
      return session.usage;
    },

    async describe() {
      const bin = resolveExecutable();
      const stdout = await new Promise((resolve) => {
        execFile(bin, ['models'], { windowsHide: true, timeout: 20000 }, (error, out) => {
          if (error) return resolve('');
          resolve(out);
        });
      });
      const models = parseModelsOutput(stdout);
      return {
        models,
        thinkingLevels: [
          // default: true 是 adapter 的显式声明：该 Harness 的思考档位可在 UI 选择，
          // 且默认档与 open() 的回退值（'high'）一致——协议层据此下发可选集合。
          { id: 'high', label: 'High', default: true },
          { id: 'medium', label: 'Medium' },
          { id: 'low', label: 'Low' },
        ],
        permissionModes: ANTIGRAVITY_PERMISSION_MODES,
      };
    },

    async describeFor(session) {
      const { models, thinkingLevels } = await this.describe();
      return {
        models,
        thinkingLevels,
        permissionModes: ANTIGRAVITY_PERMISSION_MODES,
      };
    },

    async fork(source, { emit: emitEvent, diagnostic, message }) {
      const derivedId = randomUUID();
      const sourceId = source.nativeSessionId;
      const checkpointId = message?.coreTurn?.nativeTurnRef?.checkpointId;
      const retainedTurnsCount = checkpointId != null && !Number.isNaN(Number(checkpointId)) ? Number(checkpointId) : undefined;
      if (sourceId) {
        await cloneDatabase(sourceId, derivedId, retainedTurnsCount);
        await cloneBrain(sourceId, derivedId);
      }
      const model = source.model || { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google' };
      const session = {
        nativeSessionId: derivedId,
        cwd: source.cwd,
        model,
        thinkingLevel: source.options?.thinking || 'high',
        permissionMode: source.options?.permissionMode || 'default',
        activeTurn: null,
        bridge: null,
        usage: undefined,
        pendingApprovals: new Map(),
      };
      emitEvent({ kind: 'session', nativeSessionId: derivedId, model });
      return { session, nativeSessionId: derivedId };
    },

    credits() {
      return cachedQuota;
    },

    async refreshCredits() {
      if (!quotaPromise) quotaPromise = fetchAntigravityQuota();
      const request = quotaPromise;
      const quota = await request.finally(() => {
        if (quotaPromise === request) quotaPromise = null;
      });
      if (quota) cachedQuota = quota;
      return cachedQuota;
    },

    async inspectAccount() {
      const quota = await this.refreshCredits();
      if (!quota) return null;
      return {
        label: 'Antigravity',
        plan: 'Google Gemini',
        credits: quota,
      };
    },

    async close(session) {
      await this.cancel(session);
    },
  };
}

module.exports = {
  manifest,
  create,
  parseModelsOutput,
  parseUsage,
  formatAntigravityResultError,
  modelSupportsEffort,
  formatPrompt,
  prepareImageAttachments,
  mergePendingStep,
  cloneDatabase,
  fetchAntigravityQuota,
  parseAntigravityUsageCommand,
  ANTIGRAVITY_PERMISSION_MODES,
  ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION,
};

