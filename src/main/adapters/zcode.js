// Native ZCode adapter: speaks the ZCode Protocol stdio app-server directly
// (`zcode.cjs app-server --stdio`), the same entry the ZCode desktop app uses.
// The ZCode CLI does not speak ACP — the previous nativeAcp-based adapter could
// never work without an ACP bridge that nobody ships.
//
// Verified protocol (zcode.cjs 0.16.5, "ZCode Protocol" v1):
// - framing: newline JSON {id, method, params} without a "jsonrpc" key
//   (JsonlProcess jsonrpc:false); server→client requests are answered {id, result}.
// - session/create {workspace:{workspacePath, workspaceKey}} → {session:{sessionId,...},
//   projection:{contextUsed, contextWindow, mode, status,...}}
// - session/subscribe {sessionId, deliveryKind:'desktop-continuous'} enables
//   session/event push notifications {eventId, payload:{type,...}}.
// - session/send {sessionId, content} → {accepted, stateRevision}; events:
//   turn.started, part.delta {field:text|reasoning|input|output, delta},
//   tool.updated (kinds scheduled|started|progress|result|error), turn.completed
//   {response, tokenCount, usage, toolCallCount, duration}, turn.failed {error}.
// - session/send also accepts attachments: [{kind:'image', filename,
//   mimeType, sizeBytes?, dataBase64?|localPath?}] (union also covers
//   audio/video/pdf/file, but Harness Mix only routes images). Verified live:
//   localPath delivers the image to the model; dataBase64 degrades to a
//   "[Attached image/*: name]" metadata placeholder, so base64-only images are
//   materialized to a temp file and sent as localPath instead.
// - collaboration: the protocol has NO runtime MCP registration RPC and the
//   plugin root (~/.zcode/cli/plugins) is the user's own native storage, which
//   Harness Mix never rewrites — so ZCode joins multi-agent work as a
//   dispatchable worker / Agent-Team member / /delegate target (all
//   kernel-driven), but cannot take the `#` lead role yet. Lead-side wiring
//   would need a harness-mix plugin installed via the sanctioned
//   plugins/install RPC plus a PATH-resolved bridge shim; documented as the
//   follow-up design.
// - models arrive via state.updated patches {model:{available:[{providerId, modelId,...}]}}
//   once the logged-in account materializes; session/setModel {sessionId, model}.
// - server requests: session/requestRuntimePreferences (answer the fixed
//   preference block), interaction/requestOfficialMcpAuthHeaders (decline),
//   interaction/requestPermission (surfaces as an approval card, answered
//   {decision:'allow'|'deny'}), interaction/requestUserInput (question card).
// - permission modes: session/setMode {sessionId, mode} with the canonical
//   enum plan|build|edit|yolo|auto ('auto' is internal); the desktop selector's
//   计划模式/变更前确认/自动编辑/完全访问 map onto the first four.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JsonlProcess, cliSpawn } = require('../host/jsonl');

const manifest = {
  id: 'zcode',
  name: 'ZCode',
  icon: 'zcode-color.svg',
  capabilities: {
    // Dispatchable worker + Agent-Team member; the `#` lead role stays off
    // until MCP injection exists (see the header note).
    collaborationTools: true,
    plan: true, streaming: true, thinking: false, tools: true,
    approvals: true, questions: true, models: true, thinkingLevels: true,
    permissionModes: true, resume: true, fork: false, forkFromMessage: false,
    compaction: false, nativeDiff: false, nativePatch: false,
    usage: true, contextUsage: true, cost: false, attachments: true,
  },
};

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

// Same four modes the official desktop selector offers; ids are the
// session/setMode enum. `default` marks the agent's own startup mode (build)
// so the renderer shows a real selection instead of a placeholder; `dangerous`
// is presentation-only and gets projected to the renderer catalog.
const PERMISSION_MODES = [
  { id: 'plan', label: '计划模式', description: '探索并制定计划；批准计划后才执行变更。' },
  { id: 'build', label: '变更前确认', description: '自动允许读取；写入或执行操作前询问。', default: true },
  { id: 'edit', label: '自动编辑', description: '自动允许读取和写入；执行操作前询问。' },
  { id: 'yolo', label: '完全访问', description: '无需批准提示即可运行所有工具操作。', dangerous: true },
];

// Headless entry resolution. The desktop-bundled zcode.cjs is the primary
// source; a standalone CLI on PATH and explicit env overrides also work.
// The desktop app executable itself is NOT a headless CLI — never guess it
// (the Qoder IDE-launcher lesson). The ZCode installer offers per-user
// (%LOCALAPPDATA%\Programs) and per-machine (Program Files) layouts; probe
// both, per-user first so existing installs keep their original path.
function bundledCli() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ];
    return candidates.find((file) => {
      try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch { return false; }
    }) || null;
  }
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  return null;
}

function resolveLaunch() {
  const official = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (official) {
    let extra = [];
    try { extra = process.env.ZCODE_AGENT_SERVER_ARGS_JSON ? JSON.parse(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) : []; } catch { /* ignore malformed override */ }
    return { command: official, args: [...extra, 'app-server', '--stdio'] };
  }
  const override = process.env.HARNESS_MIX_ZCODE_EXECUTABLE;
  for (const candidate of [override, bundledCli()].filter(Boolean)) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        if (/\.(cjs|mjs|js)$/i.test(candidate)) return { command: process.execPath, args: [candidate, 'app-server', '--stdio'] };
        return { command: candidate, args: ['app-server', '--stdio'] };
      }
    } catch { /* fall through to the next candidate */ }
  }
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const file = path.join(dir, `zcode${suffix}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          if (/\.cmd$/i.test(file)) return cliSpawn('zcode', ['app-server', '--stdio']);
          return { command: file, args: ['app-server', '--stdio'] };
        }
      } catch { /* keep scanning */ }
    }
  }
  throw new Error('未找到 ZCode 无头 CLI；请安装 ZCode 桌面版（自带 glm/zcode.cjs）或设置 HARNESS_MIX_ZCODE_EXECUTABLE 指向 zcode.cjs');
}

function workspaceIdentity(cwd) {
  // The desktop itself uses the workspace path as the key.
  return { workspacePath: cwd, workspaceKey: cwd };
}

// The desktop feeds the agent its provider catalog through these env vars
// (createNodeProviderRuntimePathEnv); the agent requires BOTH paths and
// without the builtin file the provider registry stays empty ("Select a
// model before continuing").
function providerConfigPaths() {
  const desktopDir = bundledCli() ? path.dirname(path.dirname(bundledCli())) : null;
  const builtin = process.env.HARNESS_MIX_ZCODE_BUILTIN_CONFIG
    || (desktopDir && path.join(desktopDir, 'config', 'provider', 'zcode-builtin.json'));
  const personal = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.zcode', 'v2', 'provider_config.json') : null;
  return {
    builtin: builtin && fs.existsSync(builtin) ? builtin : null,
    personal: personal && fs.existsSync(personal) ? personal : null,
  };
}

function agentEnvironment() {
  const paths = providerConfigPaths();
  return {
    ...(paths.builtin ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.builtin } : {}),
    ...(paths.personal ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.personal } : {}),
    ...systemProxyEnv(),
  };
}

// Console children do not inherit the WinINET proxy that GUI apps use; the
// agent's provider/entitlement checks fail silently without it. Read the
// machine proxy once (registry) and export it for the child only.
let cachedProxyEnv;
function systemProxyEnv() {
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) return {};
  if (cachedProxyEnv !== undefined) return cachedProxyEnv;
  cachedProxyEnv = {};
  if (process.platform !== 'win32') return cachedProxyEnv;
  try {
    const reg = require('node:child_process').execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).toString();
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(reg)?.[1];
    if (enabled && server) {
      const url = /^[a-z]+:\/\//i.test(server) ? server : `http://${server}`;
      cachedProxyEnv = { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' };
    }
  } catch { /* registry unavailable: no proxy */ }
  return cachedProxyEnv;
}

// The builtin file declares one account provider per coding plan
// (account:bigmodel-individual-coding-plan, …). The account push links each
// one to the user's credential ENTRY NAME via states.connectionKey — an
// identifier, never the credential value itself, which the agent resolves
// from its own store.
function accountProviders(builtinPath) {
  try {
    const builtin = JSON.parse(fs.readFileSync(builtinPath, 'utf8'));
    const rules = builtin?.config?.providerConfigRules?.providerRules ?? [];
    const declared = rules
      .filter(rule => /^account:/.test(rule?.providerId) && rule?.config?.access?.type === 'zhipu-account')
      .map(rule => ({ providerId: rule.providerId, modelIds: rule.config.builtinModelIds ?? [] }));
    const credPath = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.zcode', 'v2', 'credentials.json') : null;
    let credentialKeys = [];
    try {
      // Key NAMES only; values are never read or retained.
      credentialKeys = Object.keys(JSON.parse(fs.readFileSync(credPath, 'utf8'))).filter(key => /^account-provider:.*:api-key$/.test(key));
    } catch { /* no credentials file: nothing to link */ }
    return declared
      .map(entry => {
        const slug = entry.providerId.replace(/^account:/, '');
        const connectionKey = credentialKeys.find(key => key.includes(slug));
        return connectionKey ? { ...entry, connectionKey } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The registry applies an account push only when basedOnZCodeBuiltinRevision
// equals the agent's builtin snapshot revision, which is
// `zcode-builtin:${fileRevision}:${sha256(resolvedBuiltinPath)}` (Fy/TSo).
function builtinRevision(builtinPath) {
  try {
    const revision = JSON.parse(fs.readFileSync(builtinPath, 'utf8'))?.revision;
    if (revision === undefined) return null;
    return `zcode-builtin:${revision}:${require('node:crypto').createHash('sha256').update(path.resolve(builtinPath)).digest('hex')}`;
  } catch {
    return null;
  }
}

// Key-free account declaration: providers carry {builtinModelIds,
// access:{type, entitled}} only and states link the credential entry by NAME
// (connectionKey) — the agent resolves the actual key from its own store, so
// no secret ever flows through Harness Mix.
async function pushAccountConfig(session) {
  const paths = providerConfigPaths();
  if (!paths.builtin) return;
  const basedOn = builtinRevision(paths.builtin);
  const accounts = accountProviders(paths.builtin);
  if (!basedOn || !accounts.length) return;
  const providers = {};
  const states = {};
  for (const account of accounts) {
    providers[account.providerId] = { builtinModelIds: account.modelIds, access: { type: 'zhipu-account', entitled: true } };
    states[account.providerId] = { availability: 'available', entitled: true, current: true, connectionKey: account.connectionKey };
  }
  try {
    await session.proc.request('provider/updateAccountConfig', {
      revision: `account:${Date.now()}`,
      basedOnZCodeBuiltinRevision: basedOn,
      providers,
      states,
    });
  } catch (error) {
    session.diagnostic?.(`ZCode 账号声明推送失败：${error.message}`);
  }
}

// The session only broadcasts the model catalog (state.updated
// {model:{available:[…]}}) after a model is actually selected, so bootstrap
// the selection with the first builtin model of the first entitled account.
// GLM models require a reasoningLevel; try the common levels until one is
// accepted.
async function ensureModelCatalog(session) {
  const paths = providerConfigPaths();
  if (!paths.builtin) return;
  const accounts = accountProviders(paths.builtin);
  const modelId = accounts[0]?.modelIds?.[0];
  if (!accounts[0] || !modelId) return;
  for (const level of ['high', 'low', 'max', 'medium']) {
    try {
      await session.proc.request('session/setModel', {
        sessionId: session.state.sessionId,
        model: { providerId: accounts[0].providerId, modelId, options: { reasoningLevel: level } },
      });
      return;
    } catch (error) {
      if (!/Reasoning level/.test(String(error.message))) return;
    }
  }
}

// The agent's available-list can lag its registry (e.g. GLM-5.3-Flash is
// selectable but never broadcast). Probe each declared model: registered
// models answer the reasoning-level demand, unregistered ones reject outright.
// The session's active model is restored afterwards.
async function discoverModels(session) {
  const paths = providerConfigPaths();
  if (!paths.builtin) return;
  const accounts = accountProviders(paths.builtin);
  const known = new Set(session.state.models.map(model => model.id));
  const fallback = session.state.models[0] ?? null;
  for (const account of accounts) {
    for (const modelId of account.modelIds) {
      if (known.has(modelId)) continue;
      const levels = [];
      for (const level of ['low', 'high', 'max', 'medium']) {
        try {
          await session.proc.request('session/setModel', {
            sessionId: session.state.sessionId,
            model: { providerId: account.providerId, modelId, options: { reasoningLevel: level } },
          });
          levels.push(level);
        } catch (error) {
          if (/Reasoning level/.test(String(error.message))) continue;
          break;
        }
      }
      if (levels.length) {
        known.add(modelId);
        session.state.models.push({
          id: modelId, name: modelId, provider: account.providerId,
          efforts: levels, defaultEffort: levels[0],
        });
      }
    }
  }
  if (fallback) {
    const level = fallback.efforts?.[0] ?? fallback.defaultEffort;
    await session.proc.request('session/setModel', {
      sessionId: session.state.sessionId,
      model: { providerId: fallback.provider, modelId: fallback.id, ...(level ? { options: { reasoningLevel: level } } : {}) },
    }).catch(() => {});
  }
}

function modelView(entry) {
  const id = entry?.ref?.modelId ?? entry?.modelId ?? entry?.id;
  if (!id || typeof id !== 'string') return null;
  const provider = typeof entry?.ref?.providerId === 'string' ? entry.ref.providerId : (typeof entry?.providerId === 'string' ? entry.providerId : undefined);
  const levels = Array.isArray(entry?.reasoning?.levels)
    ? entry.reasoning.levels.map(level => (typeof level === 'string' ? level : level?.value)).filter(Boolean)
    : [];
  const view = { id, name: entry?.label ?? entry?.displayName ?? id };
  if (provider) view.provider = provider;
  if (levels.length) view.efforts = levels;
  if (entry?.reasoning?.defaultLevel) view.defaultEffort = entry.reasoning.defaultLevel;
  if (Number.isFinite(entry?.contextWindow)) view.contextWindow = entry.contextWindow;
  return view;
}

function usageView(turn) {
  const usage = turn?.usage && typeof turn.usage === 'object' ? turn.usage : {};
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: turn?.cacheStats?.cacheReadTokens ?? usage.cacheReadTokens,
    totalTokens: turn?.tokenCount ?? usage.totalTokens,
  };
}

function asText(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// dataBase64-only images degrade to a metadata placeholder on this wire
// (verified live), so materialize them to a temp file and hand over localPath.
const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
function materializeImage(session, image) {
  const extension = IMAGE_EXTENSIONS[image.mime] ?? '.png';
  const file = path.join(os.tmpdir(), `harness-mix-zcode-${randomUUID()}${extension}`);
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  session.state.tempFiles.push(file);
  return file;
}

function nativeAttachments(session, attachments) {
  return (attachments?.images ?? []).map(image => {
    const localPath = image.path || (image.data ? materializeImage(session, image) : null);
    if (!localPath) return null;
    return {
      kind: 'image',
      filename: image.name ?? 'image.png',
      mimeType: image.mime ?? 'image/png',
      localPath,
      ...(image.data ? { sizeBytes: Math.floor(image.data.length * 3 / 4) } : {}),
    };
  }).filter(Boolean);
}

function attachSession(launch, { thread, emit, diagnostic }) {
  const session = {
    proc: null, threadRef: thread, cwd: thread.cwd, model: null, emit, diagnostic,
    state: {
      sessionId: null, active: false, turn: null, closed: false,
      models: [], usage: undefined, context: undefined, turnText: '',
      pending: new Map(), seenEvents: new Set(), afterSeq: 0, pollTimer: null, polling: false,
      // 取消后到下一回合开始之间的 turn.completed/turn.failed 属于被停掉的旧回合，
      // 不得结算新回合（否则下一轮秒回空文本）
      suppressCompletions: false,
      // 进程代际：重连后旧进程的迟到 onExit/onEvent 不得污染新会话状态
      generation: 0,
      // 附件临时文件（base64 落盘）：会话关闭时清理
      tempFiles: [],
      // 子进程 stderr 尾部：进程异常退出时并入错误消息，连接页可见真实原因
      stderrTail: [],
    },
  };
  bindProcess(session, launch, thread);
  return session;
}

// (Re)bind a transport process onto an existing session object. Reconnects
// reuse this: the generation guard makes the retired process's late
// exit/event callbacks no-ops.
function bindProcess(session, launch, thread) {
  const generation = ++session.state.generation;
  const stale = () => generation !== session.state.generation;
  session.proc = new JsonlProcess(launch.command, launch.args, {
    cwd: session.cwd, env: { ...process.env, ...agentEnvironment(), ...(thread.environment || {}) }, jsonrpc: false,
  }, {
    onRequest: request => { if (stale()) return {}; return handleServerRequest(session, request); },
    onEvent: value => { if (!stale()) handleNotification(session, value); },
    onDiagnostic: line => {
      if (stale()) return;
      const text = String(line);
      session.state.stderrTail.push(text);
      if (session.state.stderrTail.length > 12) session.state.stderrTail.shift();
      diagnosticGuard(session, text);
    },
    onExit: error => {
      if (stale()) return;
      session.state.closed = true;
      if (session.state.pollTimer) { clearInterval(session.state.pollTimer); session.state.pollTimer = null; }
      // Server requests parked on user answers can no longer be answered.
      for (const resolve of session.state.pending.values()) resolve({ cancelled: true });
      session.state.pending.clear();
      const tail = session.state.stderrTail.join('\n').slice(-800);
      if (tail) error.message = `${error.message}\n${tail}`;
      session.state.turn?.reject(error);
      session.state.turn = null;
      session.state.active = false;
    },
  });
}

function diagnosticGuard(session, text) {
  try { session.diagnostic?.(text); } catch { /* renderer diagnostics must not break the pump */ }
}

// The context projection rides the subscribe snapshot (and state.updated
// patches); normalize it to the keys projectUsage consumes (tokens/contextWindow).
function captureProjection(session, projection) {
  if (!projection || typeof projection !== 'object') return;
  const used = Number(projection.contextUsed);
  const window = Number(projection.contextWindow);
  if (Number.isFinite(used) && Number.isFinite(window) && window > 0) {
    session.state.context = { tokens: used, contextWindow: window };
  }
}

// A dead transport between turns used to hang the next send forever (requests
// to an exited JsonlProcess never settle). Restore the same native session on
// a fresh process and replay the confirmed mode/model selections.
async function reconnectSession(session, applySelections) {
  const thread = session.threadRef;
  session.diagnostic?.('ZCode 原生进程已退出，正在恢复原生会话…');
  try { session.proc?.stop(); } catch { /* already gone */ }
  if (session.state.pollTimer) { clearInterval(session.state.pollTimer); session.state.pollTimer = null; }
  session.state.pending.clear();
  session.state.closed = false;
  session.state.turnText = '';
  session.state.afterSeq = 0;
  // 新进程 = 新事件空间：eventId 可能与旧进程撞号（fixture 计数器如此，真实
  // 服务端亦不保证跨进程唯一）。跨重连保留去重集会把恢复后的全部事件当
  // 重复丢弃，回合永不结算。
  session.state.seenEvents.clear();
  bindProcess(session, resolveLaunch(), thread);
  await startSession(session, { ...thread, restore: true, nativeSessionId: session.state.sessionId });
  const subscribed = await session.proc.request('session/subscribe', { sessionId: session.state.sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true }).catch(() => null);
  if (Number.isFinite(Number(subscribed?.eventSeq))) session.state.afterSeq = Number(subscribed.eventSeq);
  captureProjection(session, subscribed?.snapshot?.projection);
  startEventPolling(session);
  // 新进程没有任何供应商声明：重放账号推送，否则 setModel/send 全被拒。
  await pushAccountConfig(session);
  await applySelections();
}

function emitInteraction(session, method, params, requestId) {
  if (method === 'interaction/requestPermission') {
    session.emit({
      kind: 'approval', requestId,
      title: `ZCode 权限 · ${params?.toolName ?? '工具'}`,
      message: params?.reason ?? asText(params?.input) ?? '',
      options: [
        { id: 'accept', label: '允许' },
        { id: 'decline', label: '拒绝', kind: 'reject' },
      ],
    });
    return;
  }
  if (method === 'interaction/requestUserInput') {
    const choices = Array.isArray(params?.choices) ? params.choices : [];
    session.emit({
      kind: 'approval', requestId,
      ...(choices.length ? {} : { method: 'input' }),
      title: 'ZCode 提问',
      message: params?.prompt ?? '',
      ...(choices.length
        ? { options: choices.map(choice => ({ id: choice, label: choice })) }
        : { placeholder: '请输入…' }),
    });
  }
}

// Permissions and questions stay open until the user answers via respond();
// the returned promise is what JsonlProcess writes back to the server.
function parkInteraction(session, request, buildAnswer) {
  const requestId = `zcode-${request.id}-${request.method}`;
  emitInteraction(session, request.method, request.params, requestId);
  return new Promise(resolve => {
    session.state.pending.set(requestId, answer => {
      session.state.pending.delete(requestId);
      resolve(answer?.cancelled ? { cancelled: true } : buildAnswer(answer));
    });
  });
}

function handleServerRequest(session, request) {
  if (request.method === 'session/requestRuntimePreferences') return RUNTIME_PREFERENCES;
  if (request.method === 'interaction/requestOfficialMcpAuthHeaders') {
    return { ok: false, reason: 'official_auth_unavailable' };
  }
  if (request.method === 'interaction/requestProviderRuntimeHeaders') {
    // Before every model request the agent asks its client for the request
    // auth (same-machine stdio, exactly like the desktop client). The key is
    // read in memory only: never logged, persisted, or sent anywhere else.
    const providerId = request.params?.providerId;
    const apiKey = credentialValueFor(providerId);
    if (!apiKey) return { headersApplied: false, errorMessage: 'credential unavailable' };
    return { headersApplied: true, requestAuth: { apiKey } };
  }
  if (request.method === 'interaction/requestPermission') {
    return parkInteraction(session, request, answer => ({
      decision: answer.optionId === 'decline' ? 'deny' : 'allow',
    }));
  }
  if (request.method === 'interaction/requestUserInput') {
    return parkInteraction(session, request, answer => ({ value: answer.optionId ?? answer.value ?? '' }));
  }
  session.diagnostic?.(`ZCode server request unhandled: ${request.method}`);
  return {};
}

// Resolve the credential VALUE for an account provider, in memory only, and
// hand it straight to the local agent's runtime-headers request — exactly the
// flow the official desktop client runs. Values are AES-256-GCM encrypted at
// rest (enc:v1:<iv>.<tag>.<ct>, key = sha256(secret)); the secret comes from
// ZCODE_CREDENTIAL_SECRET or ZCode's platform fallback. The plaintext is never
// logged, persisted, or sent anywhere but the local agent's stdin.
function credentialValueFor(providerId) {
  const paths = providerConfigPaths();
  if (!paths.builtin) return null;
  const account = accountProviders(paths.builtin).find(entry => entry.providerId === providerId);
  if (!account) return null;
  const file = process.env.HARNESS_MIX_ZCODE_CREDENTIALS
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.zcode', 'v2', 'credentials.json') : null);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))?.[account.connectionKey];
    if (typeof raw !== 'string') return null;
    const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || (() => {
      let username = 'unknown';
      try { username = require('node:os').userInfo().username; } catch { /* keep fallback */ }
      const os = require('node:os');
      return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
    })();
    const crypto = require('node:crypto');
    const key = crypto.createHash('sha256').update(secret).digest();
    const parts = raw.slice('enc:v1:'.length).split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const body = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
    return plain.trim() || null;
  } catch {
    return null;
  }
}

// The agent's stream recovery (streamRecovery, recoveredFromRequestId) replays
// the tail window of the model stream after every upstream hiccup: the same
// span arrives a second time, the replay extending a few characters past the
// first copy, under fresh eventIds the eventId dedup cannot catch. Flatten by
// trimming any replayed overlap — a delta that begins with the accumulated
// text's own tail. A genuine continuation cannot repeat the exact 12+ chars it
// just ended with, while a replayed window always does.
function trimStreamReplayOverlap(accumulated, delta) {
  if (!accumulated) return delta;
  const longest = Math.min(accumulated.length, delta.length);
  for (let length = longest; length >= 12; length -= 1) {
    if (accumulated.endsWith(delta.slice(0, length))) return delta.slice(length);
  }
  return delta;
}

function settleTurn(session, error) {
  const turn = session.state.turn;
  session.state.turn = null;
  session.state.active = false;
  if (!turn) return;
  if (error) turn.reject(error);
  else turn.resolve();
}

function projectSessionEvent(session, payload, eventId) {
  if (!payload || typeof payload !== 'object') return;
  if (eventId !== undefined) {
    if (session.state.seenEvents.has(eventId)) return;
    session.state.seenEvents.add(eventId);
    if (session.state.seenEvents.size > 500) {
      for (const item of session.state.seenEvents) { session.state.seenEvents.delete(item); break; }
    }
  }
  const emit = session.emit;
  switch (payload.type) {
    case 'part.delta': {
      if (payload.field === 'text') {
        const delta = trimStreamReplayOverlap(session.state.turnText, payload.delta);
        if (delta) { session.state.turnText += delta; emit({ kind: 'text-delta', text: delta }); }
      }
      else if (payload.field === 'reasoning') emit({ kind: 'thinking-delta', text: payload.delta });
      break;
    }
    case 'model.streaming': {
      if (payload.kind === 'text_delta' && payload.delta) {
        const delta = trimStreamReplayOverlap(session.state.turnText, payload.delta);
        if (delta) { session.state.turnText += delta; emit({ kind: 'text-delta', text: delta }); }
      }
      else if (payload.kind === 'reasoning_delta' && payload.delta) emit({ kind: 'thinking-delta', text: payload.delta });
      break;
    }
    case 'tool.updated': {
      const title = payload.toolName ?? payload.toolCallId ?? 'tool';
      if (payload.kind === 'scheduled' || payload.kind === 'started' || payload.kind === 'progress') {
        emit({
          kind: 'tool', toolCallId: payload.toolCallId, title, state: 'running',
          ...(asText(payload.input) !== undefined ? { input: asText(payload.input) } : {}),
        });
      } else if (payload.kind === 'result') {
        emit({
          kind: 'tool', toolCallId: payload.toolCallId, title, state: 'done',
          ...(asText(payload.output ?? payload.result ?? payload.text) !== undefined
            ? { output: asText(payload.output ?? payload.result ?? payload.text) } : {}),
        });
      } else if (payload.kind === 'error') {
        emit({
          kind: 'tool', toolCallId: payload.toolCallId, title, state: 'error',
          ...(payload.error?.message ? { output: String(payload.error.message) } : {}),
        });
      }
      break;
    }
    case 'turn.started': {
      session.state.turnText = '';
      session.state.suppressCompletions = false;
      break;
    }
    case 'turn.completed': {
      if (session.state.suppressCompletions) break;
      session.state.usage = usageView(payload);
      emit({ kind: 'usage', usage: session.state.usage });
      // SSE 在部分网络下只经拉取通道送达:若无流式 delta,补发完整回复
      if (payload.response && !session.state.turnText) emit({ kind: 'text-delta', text: payload.response });
      emit({ kind: 'completed', finalAnswer: true });
      settleTurn(session, null);
      break;
    }
    case 'turn.failed': {
      if (session.state.suppressCompletions) break;
      const message = payload.error?.message ?? 'ZCode 回合失败';
      emit({ kind: 'error', message });
      settleTurn(session, new Error(message));
      break;
    }
    default:
      break;
  }
}

function handleNotification(session, value) {
  if (value.method === 'session/event') {
    // Wire shape: {deliveryKind, eventId, type, payload:{…fields}} — type sits
    // on the envelope, payload holds only the fields. Normalize before projecting.
    const params = value.params ?? {};
    const payload = { ...(params.payload ?? {}), ...(params.type ? { type: params.type } : {}) };
    projectSessionEvent(session, payload, params.eventId);
    return;
  }
  if (value.method !== 'state.updated') return;
  const patch = value.params?.patch;
  if (!patch || typeof patch !== 'object') return;
  if (Array.isArray(patch.model?.available)) {
    // Merge, don't replace: probed entries (models the agent accepts but
    // never broadcasts) would otherwise be wiped by every patch.
    const reported = patch.model.available.map(modelView).filter(Boolean);
    const merged = [...reported];
    for (const extra of session.state.models) {
      if (!merged.some(model => model.id === extra.id)) merged.push(extra);
    }
    session.state.models = merged;
  }
  const projection = patch.projection;
  if (projection && typeof projection === 'object') {
    captureProjection(session, projection);
  }
}

async function startSession(session, thread) {
  const resumeId = thread.restore ? thread.nativeSessionId : null;
  if (resumeId) {
    try {
      const resumed = await session.proc.request('session/resume', { sessionId: resumeId, workspace: workspaceIdentity(thread.cwd) });
      session.state.sessionId = resumed?.session?.sessionId ?? resumeId;
      return;
    } catch (error) {
      session.diagnostic?.(`ZCode 会话恢复失败，改用新会话：${error.message}`);
    }
  }
  const created = await session.proc.request('session/create', { workspace: workspaceIdentity(thread.cwd) });
  session.state.sessionId = created?.session?.sessionId;
  if (!session.state.sessionId) throw new Error('ZCode app-server 未返回 sessionId');
}

// The desktop-continuous push channel silently stalls on some networks while
// the pull API (session/events + afterSeq) keeps delivering; poll it as the
// primary event source, with push handled too (eventId dedup keeps them from
// double-firing).
function startEventPolling(session) {
  session.state.pollTimer = setInterval(async () => {
    if (session.state.closed || session.state.polling) return;
    session.state.polling = true;
    try {
      const result = await session.proc.request('session/events', { sessionId: session.state.sessionId, afterSeq: session.state.afterSeq });
      const events = result?.events ?? [];
      let maxSeq = session.state.afterSeq;
      for (const event of events) {
        const seq = Number(event.seq);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
        const payload = { ...(event.payload ?? {}), ...(event.type ? { type: event.type } : {}) };
        projectSessionEvent(session, payload, event.eventId);
      }
      if (maxSeq > session.state.afterSeq) session.state.afterSeq = maxSeq;
    } catch { /* transient poll failure; the next tick retries */ }
    session.state.polling = false;
  }, 350);
}

function create() {
  return {
    manifest,

    async inspect() {
      try {
        const launch = resolveLaunch();
        return await new Promise(resolve => {
          execFile(launch.command, [...launch.args, '--version'], { timeout: 15000, windowsHide: true }, (error, out) => {
            resolve(error ? { available: false, detail: `${manifest.name} CLI 启动失败` } : { available: true, detail: String(out).trim() });
          });
        });
      } catch (error) {
        return { available: false, detail: error.message };
      }
    },

    async describe() { return { models: null, thinkingLevels: [], permissionModes: PERMISSION_MODES }; },

    async open({ thread, emit, diagnostic = () => {}, collaboration }) {
      // `collaboration` is accepted (worker/Agent-Team membership works through
      // kernel-driven dispatch) but the lead-side MCP tools are not wired yet —
      // see the header note; deliberately NOT setting collaborationEnabled
      // keeps the `#`-lead gate honest until that lands.
      void collaboration;
      const launch = resolveLaunch();
      const session = attachSession(launch, { thread, emit, diagnostic });
      try {
        await startSession(session, thread);
        const subscribed = await session.proc.request('session/subscribe', { sessionId: session.state.sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: true }).catch(() => null);
        if (Number.isFinite(Number(subscribed?.eventSeq))) session.state.afterSeq = Number(subscribed.eventSeq);
        captureProjection(session, subscribed?.snapshot?.projection);
        startEventPolling(session);
        // The user's mode choice rides on the thread options (new-thread
        // preference or mid-session selector); apply it like the desktop does.
        if (thread.options?.permissionMode) await this.setPermissionMode(session, thread.options.permissionMode);
        await pushAccountConfig(session);
        await ensureModelCatalog(session).catch(() => {});
        emit({ kind: 'session', nativeSessionId: session.state.sessionId });
        return session;
      } catch (error) {
        session.proc.stop();
        throw error;
      }
    },

    async send(session, prompt, _hooks, attachments) {
      if (session.state.active) throw new Error('ZCode 当前回合尚未结束');
      if (session.state.closed) {
        await reconnectSession(session, async () => {
          if (session.permissionMode) await this.setPermissionMode(session, session.permissionMode)
            .catch(error => session.diagnostic?.(`ZCode 恢复权限模式失败：${error.message}`));
          if (session.model) await this.setModel(session, session.model)
            .catch(error => session.diagnostic?.(`ZCode 恢复模型选择失败：${error.message}`));
          else await ensureModelCatalog(session).catch(() => {});
        });
      }
      session.state.active = true;
      const settled = new Promise((resolve, reject) => { session.state.turn = { resolve, reject }; });
      const images = nativeAttachments(session, attachments);
      try {
        const result = await session.proc.request('session/send', {
          sessionId: session.state.sessionId,
          content: prompt,
          ...(images.length ? { attachments: images } : {}),
        });
        if (result && result.accepted === false) throw new Error('ZCode 拒绝了这条消息');
      } catch (error) {
        settleTurn(session, error);
        throw error;
      }
      return settled;
    },

    async cancel(session) {
      if (session.state.sessionId) {
        session.proc.request('session/stop', { sessionId: session.state.sessionId }).catch(() => {});
      }
      for (const resolve of session.state.pending.values()) resolve({ cancelled: true });
      session.state.pending.clear();
      // 旧回合的迟到 turn.completed/turn.failed 不得结算下一个回合；见
      // projectSessionEvent 的 suppressCompletions 守卫（turn.started 复位）。
      session.state.suppressCompletions = true;
      settleTurn(session, null);
    },

    async respond(session, requestId, response) {
      const resolvePending = session.state.pending.get(requestId);
      if (!resolvePending) throw new Error('ZCode 原生请求已经结束');
      // decline 必须走 buildAnswer 映射成 {decision:'deny'}；短路成 {cancelled:true}
      // 会让服务端把「拒绝」当「无应答」处理。
      if (response?.cancelled || response?.confirmed === false) resolvePending({ cancelled: true });
      else resolvePending({ optionId: response?.optionId, value: response?.value });
    },

    async listModelsFor(session) {
      return (await this.describeFor(session)).models;
    },

    async describeFor(session) {
      // Models materialize once the account declaration is applied and the
      // agent resolves its own credentials; if the first push candidate didn't
      // match, retry the remaining revision forms before giving up.
      const deadline = Date.now() + 6000;
      while (!session.state.models.length && Date.now() < deadline && !session.state.closed) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!session.state.models.length && !session.state.closed) {
        await pushAccountConfig(session);
        const extended = Date.now() + 6000;
        while (!session.state.models.length && Date.now() < extended && !session.state.closed) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      if (session.state.models.length && !session.state.closed) {
        await discoverModels(session);
      }
      if (!session.state.models.length) {
        session.diagnostic?.('ZCode 模型目录未物化：需要 ZCode 桌面版安装（内建供应商目录）、已登录的共享凭据（connectionKey）与可达 Z.AI 的网络。');
      }
      const levels = [...new Set(session.state.models.flatMap(model => model.efforts ?? []))];
      return {
        models: session.state.models.length ? session.state.models : null,
        thinkingLevels: levels.map(level => ({ id: level, label: level })),
        permissionModes: PERMISSION_MODES,
      };
    },

    async setPermissionMode(session, mode) {
      if (!PERMISSION_MODES.some(entry => entry.id === mode)) throw new Error(`未知的 ZCode 权限模式：${mode}`);
      await session.proc.request('session/setMode', { sessionId: session.state.sessionId, mode });
      session.permissionMode = mode;
    },

    async setModel(session, model) {
      // GLM models require an explicit reasoningLevel; default to the model's
      // own default level when the selection didn't carry one.
      const view = session.state.models.find(entry => entry.id === model.id);
      const level = model.effort ?? view?.defaultEffort ?? view?.efforts?.[0]
        ?? session.state.models.flatMap(entry => entry.efforts ?? [])[0];
      await session.proc.request('session/setModel', {
        sessionId: session.state.sessionId,
        model: {
          providerId: model.provider ?? view?.provider ?? 'account:bigmodel-individual-coding-plan',
          modelId: model.id,
          ...(level ? { options: { reasoningLevel: level } } : {}),
        },
      });
      session.model = { id: model.id, name: model.name ?? model.id, provider: model.provider ?? view?.provider };
      return session.model;
    },

    async setThinkingLevel(session, level) {
      await session.proc.request('session/setThoughtLevel', { sessionId: session.state.sessionId, thoughtLevel: level });
    },

    async getContextUsage(session) { return session.state.context; },

    async close(session) {
      session.state.closed = true;
      if (session.state.pollTimer) { clearInterval(session.state.pollTimer); session.state.pollTimer = null; }
      for (const resolve of session.state.pending.values()) resolve({ cancelled: true });
      session.state.pending.clear();
      for (const file of session.state.tempFiles.splice(0)) { try { fs.rmSync(file, { force: true }); } catch { /* best-effort cleanup */ } }
      settleTurn(session, null);
      if (session.state.sessionId) {
        session.proc.request('session/close', { sessionId: session.state.sessionId }).catch(() => {});
      }
      session.proc.stop();
    },
  };
}

module.exports = { manifest, create, resolveLaunch, modelView, usageView, handleNotification, trimStreamReplayOverlap };

// ZCode scans, per scope: .zcode/skills then .agents/skills (deeper workspace levels win).
// https://zcode.z.ai/en/docs/skill
module.exports.manifest.integrations = { mcp: false, skills: { global: ['.zcode/skills', '.agents/skills'], project: ['.zcode/skills', '.agents/skills'] } };
