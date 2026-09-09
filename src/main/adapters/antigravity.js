const { spawn, execFile } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { recordNative } = require('../harness-adapter/fixture-recorder');

const manifest = {
  id: 'antigravity',
  name: 'Antigravity',
  icon: 'antigravity-color.svg',
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
    forkFromMessage: false,
    compaction: false,
    usage: true,
    contextUsage: true,
    attachments: true,
  },
};

const ANTIGRAVITY_PERMISSION_MODES = [
  { id: 'default', label: '默认', hint: '按 Antigravity 预设规则拦截或执行' },
  { id: 'desktop', label: '桌面确认', hint: '在 Harness Mix 桌面端弹出确认工具执行' },
  { id: 'skip', label: '自动放行', hint: '自动放行工具执行（--dangerously-skip-permissions）' },
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

function parseUsage(usageObj, modelId) {
  if (!usageObj) return null;
  const input = usageObj.input_tokens ?? usageObj.inputTokens;
  const output = usageObj.output_tokens ?? usageObj.outputTokens;
  const thinking = usageObj.thinking_tokens ?? usageObj.reasoningOutputTokens;
  const total = usageObj.total_tokens ?? usageObj.totalTokens;
  const contextWindow = resolveContextWindow(modelId);
  const contextUsed = usageObj.context_used_tokens ?? usageObj.estimated_tokens_used ?? input;
  const tokens = typeof contextUsed === 'number' ? contextUsed : (typeof total === 'number' ? total : null);
  return {
    tokens,
    contextWindow,
    contextPercent: tokens != null && contextWindow ? Math.min(100, Math.round((100 * tokens / contextWindow) * 10) / 10) : null,
    inputTokens: typeof input === 'number' ? input : null,
    outputTokens: typeof output === 'number' ? output : null,
    reasoningOutputTokens: typeof thinking === 'number' ? thinking : null,
  };
}

function formatPrompt(text) {
  if (!text) return '';
  if (text.startsWith('/') || text.includes('ArtifactMetadata')) return text;
  return `${ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION}${text}`;
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

async function cloneDatabase(sourceId, derivedId, homedir = os.homedir()) {
  const sourceDb = nativeConversationDbPath(sourceId, homedir);
  const targetDb = nativeConversationDbPath(derivedId, homedir);
  try {
    await fs.promises.mkdir(path.dirname(targetDb), { recursive: true });
    await fs.promises.copyFile(sourceDb, targetDb);
  } catch {
    return false;
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(targetDb);
    try {
      db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run(derivedId);
    } finally {
      db.close();
    }
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

function create(emit) {
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
      const approvals = session.permissionMode === 'desktop';
      const bridge = await QuestionBridge.create({
        approvals,
        emit: emitEvent,
      });
      session.bridge = bridge;

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
      if (session.thinkingLevel) {
        args.push('--effort', session.thinkingLevel);
      }
      if (session.permissionMode === 'skip' || session.permissionMode === 'desktop') {
        args.push('--dangerously-skip-permissions');
      }
      args.push('--add-dir', session.cwd);
      args.push('--add-dir', bridge.directory);
      args.push('--log-file', logPath);

      const child = spawn(bin, args, {
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

      session.activeTurn = { child, resolve: turnResolve, reject: turnReject, logPath };
      let sawTextDelta = false;

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
          const s = event.step_update || {};
          const stepRef = { ...nativeRef, itemId: String(s.step_index) };

          if (s.step_type === 'agent_response') {
            const text = s.text_delta || s.text || s.content || s.message;
            if (text) {
              sawTextDelta = true;
              emitEvent({ kind: 'text-delta', text, nativeRef: stepRef });
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

          if (s.step_type === 'tool') {
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
              if (params.TargetFile) {
                emitEvent({
                  kind: 'file-change',
                  source: 'native',
                  changes: [{
                    path: params.TargetFile,
                    after: params.CodeContent ?? params.ReplacementContent,
                    changeType: toolName === 'write_to_file' ? (params.Overwrite ? 'modified' : 'added') : 'modified',
                    complete: true,
                    nativeRef: stepRef,
                  }],
                  nativeRef: stepRef,
                });
              }
            }
          }

          if (s.usage) {
            const u = parseUsage(s.usage, session.model?.id);
            if (u) {
              session.usage = u;
              emitEvent({ kind: 'usage', usage: u, nativeRef: stepRef });
            }
          }
          return;
        }

        if (event.event === 'result') {
          const res = event.result || {};
          if (res.conversation_id && !session.nativeSessionId) {
            session.nativeSessionId = res.conversation_id;
          }
          if (res.usage) {
            const u = parseUsage(res.usage, session.model?.id);
            if (u) {
              session.usage = u;
              emitEvent({ kind: 'usage', usage: u, nativeRef });
            }
          }
          if (res.response && !sawTextDelta) {
            emitEvent({ kind: 'text-delta', text: res.response, nativeRef });
          }
          emitEvent({
            kind: 'completed',
            finalAnswer: res.status === 'SUCCESS',
            stopReason: res.status === 'SUCCESS' ? 'completed' : 'error',
            nativeRef,
          });
          turnResolve?.();
        }
      });

      child.on('error', (err) => {
        emitEvent({ kind: 'error', message: `Antigravity 进程错误: ${err.message}` });
        turnReject?.(err);
      });

      child.on('close', (code) => {
        void fs.promises.unlink(logPath).catch(() => {});
        void bridge.dispose();
        session.bridge = null;
        session.activeTurn = null;
        if (code !== 0 && code !== null) {
          emitEvent({ kind: 'completed', finalAnswer: false, stopReason: 'error' });
        }
        turnResolve?.();
      });

      try {
        const fullPrompt = formatPrompt(prompt);
        if (child.stdin.writable) {
          child.stdin.write(JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n');
        }
      } catch (err) {
        child.kill();
        turnReject?.(err);
      }

      return settled;
    },

    async cancel(session) {
      if (session.activeTurn?.child) {
        try { session.activeTurn.child.kill(); } catch {}
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
          { id: 'high', label: 'High' },
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
      if (sourceId) {
        await cloneDatabase(sourceId, derivedId);
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
  formatPrompt,
  ANTIGRAVITY_PERMISSION_MODES,
  ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION,
};
