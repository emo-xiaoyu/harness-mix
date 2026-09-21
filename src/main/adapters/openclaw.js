const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cliSpawn } = require("../host/jsonl");
const { OpenClawGatewayHost, readGatewayConfig, OPENCLAW_CONFIG } = require("./openclaw-gateway");
const { recordNative } = require("../harness-adapter/fixture-recorder");

// 静态思考档位仅作兜底（sessions.describe 失败时）；会话级权威目录来自 sessions.describe
// （thinkingLevels/thinkingDefault，随模型而变）。实测 Gateway 2026.5.12（2026-09-21 复核）：
// sessions.create 后、首turn 前 describe 即返回 thinkingLevels:[off,minimal,low,medium,high]（5 档）
// 与 thinkingDefault:"off"，open() 的 refreshSessionState 即可取到；兜底列表对齐该实测值，
// 证据：output/openclaw-thinking-probe/*.json。
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const AGENT_TIMEOUT_MS = 600_000; // 与 openclaw agent --timeout 默认值一致

const manifest = {
  id: "openclaw",
  name: "OpenClaw",
  icon: "openclaw-color.svg",
  aliases: ["openclaw"],
  // 能力均按 Gateway 2026.5.12 实测声明；usage/contextUsage 取自 sessions.describe 的原生
  // token 统计与上下文窗口，不用累计输入量伪装。thinking 流投影已接线（形状取自上游
  // emitAgentEvent stream:"thinking" 的 {text,delta}，会话级 reasoningLevel=stream 已实测
  // 受理），但 Gateway 的 agent RPC 通道未接 onReasoningStream（该回调只在 Telegram 等
  // 消息渠道装配；2026.5.12 实测：reasoningLevel=stream + 推理模型 MiniMax-M3 也只有
  // assistant 流，推理内容并入正文），故能力位保持 false，属上游协议边界。
  // compaction：原生 /compact 实测在 commands.list 目录中，且斜杠命令以消息文本经
  // agent 运行管道执行（压缩结果流形状未实测，结算不伪造 token 前后值）。
  capabilities: { streaming: true, thinking: false, tools: true, approvals: true, questions: false, models: true, thinkingLevels: true, permissionModes: false, resume: true, fork: false, forkFromMessage: false, compaction: true, usage: true, contextUsage: true, attachments: true },
};

manifest.integrations = { mcp: true, skills: {
  global: ['.openclaw/skills', '.agents/skills'],
  project: ['skills', '.agents/skills'],
  overrides: { '.openclaw/skills': { env: 'OPENCLAW_STATE_DIR', suffix: 'skills' } },
} };

// 托管 MCP 在 OpenClaw 侧落到 openclaw.json 的 mcp.servers 注册表（机器级，内嵌运行时按
// 配置消费）。只允许触碰 harness-mix/ 前缀的自有键，用户手写的服务器定义绝不增删改。
const MCP_OWNED_PREFIX = "harness-mix/";
const OPENCLAW_MCP_DOC = "mcp.servers 注册表（OpenClaw 官方集中式 MCP 客户端配置）";

/** 托管条目（managed-mcp 原始形状）→ OpenClaw 注册表条目；形状对齐 `openclaw mcp set` 的 JSON 值 */
function toOpenClawServerEntry(server) {
  if (server?.url) return { url: server.url, ...(server.http_headers ? { headers: server.http_headers } : {}) };
  const entry = { command: server.command };
  if (Array.isArray(server.args) && server.args.length) entry.args = server.args;
  if (server.env && typeof server.env === "object" && Object.keys(server.env).length) entry.env = server.env;
  return entry;
}

/**
 * 纯函数：现有 mcp.servers + 托管集合 → 对账计划（新增/更新/移除，仅限自有键）。
 * 返回 { kept, sets: [[name, entry]], unsets: [name] }；kept 为不动区（含用户键）。
 */
function planMcpReconcile(currentServers, managed) {
  const current = (currentServers && typeof currentServers === "object") ? currentServers : {};
  const desired = {};
  for (const server of Array.isArray(managed) ? managed : []) {
    if (!server?.name) continue;
    desired[`${MCP_OWNED_PREFIX}${server.name}`] = toOpenClawServerEntry(server);
  }
  const sets = [];
  const unsets = [];
  const kept = {};
  for (const [name, entry] of Object.entries(current)) {
    if (!name.startsWith(MCP_OWNED_PREFIX)) { kept[name] = entry; continue; }
    if (!(name in desired)) { unsets.push(name); continue; }
    if (JSON.stringify(entry) !== JSON.stringify(desired[name])) sets.push([name, desired[name]]);
  }
  for (const [name, entry] of Object.entries(desired)) {
    if (!(name in current)) sets.push([name, entry]);
  }
  return { kept, sets, unsets };
}

/**
 * 把托管 MCP 服务器对账进 openclaw.json 的 mcp.servers（文件级外科合并）。
 * 返回是否有实际变更。实测（Gateway 2026.5.12）：mcp.servers 仅在 Gateway 启动时被
 * agent 运行消费，运行中不热载——调用方应在连接 Gateway 之前对账（本次拉起即生效），
 * 对已在运行的 Gateway 需提示重启后新工具才可用。
 * - 只动 harness-mix/* 自有键；写回前做"去自有键后逐键等值"断言，内容零丢失才落盘；
 * - 原子写（临时文件 + rename）；失败只记 diagnostic，不阻塞会话（与 Skills 预建同策略）；
 * - 上游 CLI `openclaw mcp set` 的整档规范化写入会触发 size-drop 守卫（本机排版为
 *   PowerShell 风格），故不走 CLI/RPC 写入面；首次推送会把排版规整为标准 JSON。
 */
async function applyManagedMcpServers(managed, diagnostic = () => {}) {
  let raw;
  try { raw = await fs.promises.readFile(OPENCLAW_CONFIG, "utf8"); }
  catch (error) { diagnostic(`[openclaw] 读取 ${OPENCLAW_MCP_DOC} 失败：${error.message}`); return false; }
  let config;
  try { config = JSON.parse(raw); } catch (error) { diagnostic(`[openclaw] 配置不是合法 JSON，跳过 MCP 对账`); return false; }
  if (!config || typeof config !== "object" || Array.isArray(config)) { diagnostic(`[openclaw] 配置根不是对象，跳过 MCP 对账`); return false; }

  const plan = planMcpReconcile(config.mcp?.servers, managed);
  if (!plan.sets.length && !plan.unsets.length) return false;

  // 保留原始形状：用户无自有 servers 键时清理后不残留空键；mcp 原本缺失则不创建
  const nextMcp = { ...config.mcp };
  const keptServers = plan.kept;
  if (Object.keys(keptServers).length || plan.sets.length) {
    nextMcp.servers = { ...keptServers, ...Object.fromEntries(plan.sets) };
  } else {
    delete nextMcp.servers;
  }
  const next = { ...config };
  if (Object.keys(nextMcp).length) next.mcp = nextMcp;
  else delete next.mcp;
  const text = `${JSON.stringify(next, null, 2).replace(/\n/g, "\r\n")}\n`;

  // 等值断言：去掉自有键后，新旧内容必须逐键一致（防序列化意外丢内容）
  const stripOwned = (servers) => Object.fromEntries(Object.entries(servers ?? {}).filter(([k]) => !k.startsWith(MCP_OWNED_PREFIX)));
  const before = JSON.stringify({ ...config, mcp: { ...config.mcp, servers: stripOwned(config.mcp?.servers) } });
  const after = JSON.stringify({ ...JSON.parse(text), mcp: { ...JSON.parse(text).mcp, servers: stripOwned(JSON.parse(text).mcp?.servers) } });
  if (before !== after) { diagnostic(`[openclaw] MCP 对账等值断言失败，放弃写入`); return false; }

  try {
    const tmp = path.join(os.tmpdir(), `harness-mix-openclaw-mcp-${randomUUID()}.json`);
    await fs.promises.writeFile(tmp, text, "utf8");
    await fs.promises.rename(tmp, OPENCLAW_CONFIG);
    diagnostic(`[openclaw] MCP 注册表对账完成：+${plan.sets.length} 更新 / -${plan.unsets.length} 移除（仅自有键）`);
    return true;
  } catch (error) {
    diagnostic(`[openclaw] 写入 ${OPENCLAW_MCP_DOC} 失败：${error.message}`);
    return false;
  }
}

const textOfContent = (result) => (result?.content ?? []).map((c) => (c?.type === "text" ? c.text : "")).filter(Boolean).join("\n");
const stringifyArgs = (args) => {
  if (args == null) return undefined;
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
};

/**
 * Gateway agent 广播事件（{runId, stream, data, sessionKey, seq, ts}）→ 统一事件投影。
 * 纯映射（运行时与 fixture 回放共用）；session 仅用于跨事件累积（assistant/thinking 累计文本、生命周期错误）。
 * thinking 流形状取自上游 emitAgentEvent（{text 累计, delta 增量}，与 assistant 同构）；
 * item/plan/patch/approval/compaction 流形态未逐字段实测，不投影，不伪造。
 */
function projectAgentEvent(payload, session) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  const data = payload.data ?? {};
  switch (payload.stream) {
    case "assistant": {
      let delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta && typeof data.text === "string") {
        // 缺 delta 时按累计文本差分补齐
        const last = session?.state?.lastAssistantText ?? "";
        delta = data.text.startsWith(last) ? data.text.slice(last.length) : data.text;
      }
      if (typeof data.text === "string" && session) session.state.lastAssistantText = data.text;
      if (delta) out.push({ kind: "text-delta", text: delta });
      break;
    }
    case "thinking": {
      let delta = typeof data.delta === "string" ? data.delta : "";
      if (!delta && typeof data.text === "string") {
        const last = session?.state?.lastThinkingText ?? "";
        delta = data.text.startsWith(last) ? data.text.slice(last.length) : data.text;
      }
      if (typeof data.text === "string" && session) session.state.lastThinkingText = data.text;
      if (delta) out.push({ kind: "thinking-delta", text: delta });
      break;
    }
    case "tool": {
      if (!data.toolCallId) break;
      const title = data.meta ? `${data.name ?? "tool"} ${data.meta}` : (data.name ?? "tool");
      if (data.phase === "start") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", input: stringifyArgs(data.args) });
      } else if (data.phase === "update") {
        const output = textOfContent(data.partialResult);
        if (output) out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", output });
      } else if (data.phase === "result") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: data.isError ? "error" : "done", output: textOfContent(data.result) || (data.isError ? "原生工具执行失败" : undefined) });
      }
      break;
    }
    case "command_output": {
      // 命令输出与工具卡片同一投影（toolCallId 归并）：delta 增量输出，end 携带退出码收尾
      if (!data.toolCallId) break;
      const title = data.title || data.name || "command";
      if (data.phase === "delta") {
        if (typeof data.output === "string" && data.output) out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: "running", output: data.output });
      } else if (data.phase === "end") {
        out.push({ kind: "tool", toolCallId: data.toolCallId, title, state: data.status === "completed" ? "done" : "error", output: data.output, detail: data.exitCode != null ? `exit ${data.exitCode}` : undefined });
      }
      break;
    }
    case "lifecycle": {
      if (session && data.phase === "error") session.state.lastError = typeof data.error === "string" ? data.error : data.error?.message;
      break;
    }
    default:
      break;
  }
  return out;
}

/** exec/plugin 审批请求广播 → 统一 approval 事件 */
function projectApproval(eventName, payload, sessionKey) {
  const id = String(payload?.id ?? "");
  const request = payload?.request ?? {};
  const isPlugin = eventName.startsWith("plugin.") || id.startsWith("plugin:");
  const lines = [];
  if (request.command) lines.push(`\`${request.command}\``);
  if (request.cwd) lines.push(`工作目录：${request.cwd}`);
  if (request.ask) lines.push(`原因：${request.ask}`);
  return {
    kind: "approval",
    requestId: `openclaw-${id}`,
    title: isPlugin ? "插件权限审批" : "命令执行审批",
    message: lines.join("\n") || undefined,
    options: [
      { id: "allowed-once", label: "允许一次" },
      { id: "allowed-always", label: "始终允许" },
      { id: "rejected", label: "拒绝", kind: "reject" },
    ],
    nativeRef: { sessionId: sessionKey, interactionId: id },
  };
}

/** sessions.describe 行 → 会话状态（生效模型、思考档位目录与当前值、原生用量）。字段随 turn 推进逐渐齐备。 */
function applySessionDescription(session, row) {
  if (!row || typeof row !== "object") return;
  if (Array.isArray(row.thinkingLevels) && row.thinkingLevels.length) {
    session.state.thinkingLevels = row.thinkingLevels.map((l) => ({ id: String(l.id ?? l), label: String(l.label ?? l.id ?? l) }));
  }
  if (typeof row.thinkingDefault === "string") session.state.thinkingDefault = row.thinkingDefault;
  if (row.model) {
    const id = row.modelProvider ? `${row.modelProvider}/${row.model}` : String(row.model);
    session.model = session.models?.find((m) => m.id === id) ?? { id, name: String(row.model), provider: row.modelProvider };
  }
  if (Number.isFinite(row.totalTokens) && Number.isFinite(row.contextTokens) && row.contextTokens > 0) {
    const usage = { tokens: row.totalTokens, contextWindow: row.contextTokens, contextPercent: Math.round((row.totalTokens / row.contextTokens) * 10000) / 100 };
    if (typeof row.estimatedCostUsd === "number" && row.estimatedCostUsd > 0) usage.cost = row.estimatedCostUsd;
    session.state.usage = usage;
  }
}

/** 拉取并应用会话状态；返回是否有可用用量。 */
async function refreshSessionState(session) {
  const described = await session.host.call("sessions.describe", { key: session.nativeSessionId }).catch(() => null);
  applySessionDescription(session, described?.session);
  return session.state.usage;
}

/** 命令 name → UI 契约 id（[A-Za-z0-9._:-]+，≤128）；规范化后为空则返回 ''，由调用方跳过 */
function slugifyCommandId(name) {
  if (typeof name !== "string") return "";
  return name.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
}

const COMMAND_SOURCES = { native: "原生", skill: "技能", plugin: "插件" };

/**
 * commands.list {scope:'text'} 应答 → 统一命令目录（Gateway 2026.5.12 实测行形状：
 * {name, nativeName, textAliases, description, category, source:'native'|'skill'|'plugin',
 *  scope:'both'|'text', acceptsArgs, args:[{name,type,required?,description?,choices?}]}）。
 * 斜杠命令以消息文本经 agent 管道执行，只有携带 textAliases[0] 的条目可被 operator
 * 文本面触发，无别名条目诚实跳过；id 取 name 的 slug（与 compact 重复或规范化失败
 * 同样跳过），描述附参数提示（<必选>/[可选]）与来源标注。
 */
function projectTextCommands(listed) {
  const rows = Array.isArray(listed?.commands) ? listed.commands : Array.isArray(listed) ? listed : [];
  const seen = new Set(["compact"]); // 原生 compact 由专用 execute 条目提供，映射去重
  const out = [];
  for (const row of rows) {
    const alias = row?.textAliases?.[0];
    if (typeof alias !== "string" || !alias) continue;
    const id = slugifyCommandId(row.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const hint = (Array.isArray(row.args) ? row.args : [])
      .filter((arg) => typeof arg?.name === "string" && arg.name)
      .map((arg) => (arg.required === true ? `<${arg.name}>` : `[${arg.name}]`))
      .join(" ");
    out.push({
      id,
      label: alias,
      description: `${[String(row.description ?? "").trim(), hint].filter(Boolean).join(" ")}（${COMMAND_SOURCES[row.source] ?? "原生"}）`,
      action: "insert",
      text: `${alias} `,
    });
  }
  return out;
}
function create() {
  const adapter = {
    manifest,

    async inspect() {
      const cli = cliSpawn("openclaw", ["--version"]);
      const version = await new Promise((resolve) => execFile(cli.command, cli.args, { windowsHide: true, timeout: 10000 }, (error, out) => resolve(error ? null : out.trim())));
      if (!version) return { available: false, detail: "OpenClaw CLI 不可用（npm i -g openclaw）" };
      try {
        const cfg = await readGatewayConfig();
        return { available: true, detail: `${version} · Gateway 127.0.0.1:${cfg.port}` };
      } catch (error) {
        return { available: false, detail: `OpenClaw 配置不可读：${error.message}` };
      }
    },

    async describe() {
      // 全局模型目录：只读已有 Gateway（不为选择器拉起进程），不可达时交回空目录
      try {
        const host = await OpenClawGatewayHost.acquire(() => {}, { autostart: false });
        try { return { models: await listModels(host), thinkingLevels: thinkingCatalog(), permissionModes: [] }; }
        finally { await OpenClawGatewayHost.release(); }
      } catch { return { models: null, thinkingLevels: [], permissionModes: [] }; }
    },

    async open({ thread, emit: emitEvent, diagnostic = () => {}, managedMcp = [] }) {
      // 托管 MCP 先落注册表再连 Gateway：Gateway 由本次拉起则启动即消费到新工具；
      // 已在运行的 Gateway 实测不热载 mcp.servers，变更后提示重启生效。
      const mcpChanged = await applyManagedMcpServers(managedMcp, diagnostic);
      const host = await OpenClawGatewayHost.acquire(diagnostic);
      if (mcpChanged && !host.child) diagnostic("[openclaw] 托管 MCP 变更已写入注册表；运行中的 Gateway 需重启后新工具才可用");
      const session = {
        host,
        cwd: thread.cwd,
        nativeSessionId: null,
        state: { lastAssistantText: "", lastThinkingText: "", lastError: null, runId: null },
        pendingApprovals: new Map(), // requestId -> approvalId
        modelOverride: null,
        thinkingOverride: null,
        emit: emitEvent,
        unwatch: null,
      };

      try {
        // 新会话显式登记（携带标题），恢复会话直接沿用原生 sessionKey
        if (thread.restore && thread.nativeSessionId) {
          session.nativeSessionId = thread.nativeSessionId;
        } else {
          const label = String(thread.title || "Harness Mix 任务").slice(0, 60);
          const baseKey = `harness-mix-${thread.nativeSessionId || randomUUID()}`;
          let created = await host.call("sessions.create", { key: baseKey, label, cwd: thread.cwd }).catch(() => null);
          if (!created?.key) created = await host.call("sessions.create", { key: baseKey, label }).catch(() => null);
          session.nativeSessionId = created?.key ?? `agent:main:${baseKey}`;
        }

        // 思考流开关：会话级 reasoningLevel=stream（2026.5.12 实测受理并回读持久化）。
        // 是否真正出流由 thinkingLevel≠off（用户档位）与上游模型/运行时支持决定。
        await host.call("sessions.patch", { key: session.nativeSessionId, reasoningLevel: "stream" }).catch(() => {});

        session.unwatch = host.onEvent((frame) => {
          recordNative(manifest.id, frame);
          if (frame?.type === "closed") {
            for (const pending of session.pendingApprovals.values()) pending.reject?.(new Error("OpenClaw Gateway 连接已断开"));
            session.pendingApprovals.clear();
            return;
          }
          if (frame.type !== "event") return;
          // agent 流：按 runId（本轮）或 sessionKey（本会话）归属
          if (frame.event === "agent") {
            const payload = frame.payload ?? {};
            if (payload.runId !== session.state.runId && payload.sessionKey !== session.nativeSessionId) return;
            for (const event of projectAgentEvent(payload, session)) emitEvent(event);
            return;
          }
          // 审批广播：只归集显式携带本会话 sessionKey 的请求，不劫持其他客户端的审批
          if (frame.event === "exec.approval.requested" || frame.event === "plugin.approval.requested") {
            const payload = frame.payload ?? {};
            if (payload.request?.sessionKey !== session.nativeSessionId) return;
            const id = String(payload.id ?? "");
            if (!id) return;
            const projected = projectApproval(frame.event, payload, session.nativeSessionId);
            session.pendingApprovals.set(projected.requestId, { approvalId: id });
            emitEvent(projected);
            return;
          }
          if (frame.event === "exec.approval.resolved" || frame.event === "plugin.approval.resolved") {
            // 他端（如 OpenClaw 自有 UI）已处理的审批：同步收掉卡片
            const requestId = `openclaw-${frame.payload?.id ?? ""}`;
            if (session.pendingApprovals.delete(requestId)) emitEvent({ kind: "interaction-responded", requestId });
          }
        });

        const models = await listModels(host).catch(() => []);
        if (models.length) session.models = models;
        // 生效模型/思考档位/用量以 sessions.describe 为准（2026-09-21 实测：新会话 create 后
        // 首 turn 前 describe 即返回 thinkingLevels/thinkingDefault，open 时即可取到目录）
        await refreshSessionState(session);
        if (thread.options?.model) await adapter.setModel(session, thread.options.model);
        if (thread.options?.thinking) await adapter.setThinkingLevel(session, thread.options.thinking);
        emitEvent({ kind: "session", nativeSessionId: session.nativeSessionId, model: session.model });
        return session;
      } catch (error) {
        try { session.unwatch?.(); } catch { /* 已断开 */ }
        await OpenClawGatewayHost.release();
        throw error;
      }
    },

    async describeFor(session) {
      const levels = session.state.thinkingLevels ?? thinkingCatalog();
      // 原生 sessions.describe 上报的 thinkingDefault 即当前生效档，标记后由协议层作为安全预选秀下发
      const marked = session.state.thinkingDefault
        ? levels.map(l => ({ ...l, default: l.id === session.state.thinkingDefault }))
        : levels;
      return { models: session.models ?? null, thinkingLevels: marked, permissionModes: [] };
    },

    async listModelsFor(session) { return listModels(session.host); },

    async send(session, text, hooks, attachments) {
      const params = {
        message: text,
        sessionKey: session.nativeSessionId,
        idempotencyKey: randomUUID(),
        deliver: false, // 回复只走 Desktop 原生流，不向 OpenClaw 渠道投递
      };
      // 图片走 Gateway agent RPC 原生 attachments 字段：{ mimeType, content(base64), fileName }（协议 schema 见附件归一化实现）
      const images = attachments?.images ?? [];
      if (images.length) {
        params.attachments = images.map((img) => ({
          mimeType: img.mime || "image/png",
          content: img.data,
          fileName: img.name || undefined,
        }));
      }
      if (session.modelOverride) params.model = session.modelOverride;
      if (session.thinkingOverride) params.thinking = session.thinkingOverride;
      const accepted = await session.host.call("agent", params);
      if (accepted?.status === "in_flight") throw new Error("该会话已有进行中的原生任务，请稍候");
      const runId = accepted?.runId;
      if (!runId) throw new Error("OpenClaw Gateway 未返回 runId");
      session.state.runId = runId;
      session.state.lastAssistantText = "";
      session.state.lastThinkingText = "";
      session.state.lastError = null;
      try {
        const result = await session.host.call("agent.wait", { runId, timeoutMs: AGENT_TIMEOUT_MS }, AGENT_TIMEOUT_MS + 30_000);
        // turn 结束后回读原生会话状态：生效模型、思考目录、token 用量（真实统计，不用估计值冒充）
        const modelBefore = session.model?.id;
        await refreshSessionState(session);
        if (session.state.usage) hooks.emit({ kind: "usage", usage: session.state.usage });
        if (session.model && session.model.id !== modelBefore) hooks.emit({ kind: "session", nativeSessionId: session.nativeSessionId, model: session.model });
        if (result?.status === "ok") { hooks.emit({ kind: "completed", finalAnswer: true }); return; }
        if (result?.stopReason === "rpc") return; // 用户取消：runtime 已按取消结算
        throw new Error(result?.error || session.state.lastError || `原生任务未正常结束（${result?.status ?? "未知"}）`);
      } finally {
        if (session.state.runId === runId) session.state.runId = null;
      }
    },

    async cancel(session) {
      const runId = session.state.runId;
      await session.host.call("sessions.abort", runId ? { key: session.nativeSessionId, runId } : { key: session.nativeSessionId }).catch(() => {});
    },

    async respond(session, requestId, response) {
      const pending = session.pendingApprovals.get(requestId);
      if (!pending) throw new Error("未知或已过期的原生审批请求");
      const decision = response?.confirmed === true || response?.optionId === "allowed-once" ? "allow-once"
        : response?.optionId === "allowed-always" ? "allow-always"
        : "deny"; // 拒绝/取消统一收敛为 deny，不替用户放行
      const method = pending.approvalId.startsWith("plugin:") ? "plugin.approval.resolve" : "exec.approval.resolve";
      await session.host.call(method, { id: pending.approvalId, decision });
      session.pendingApprovals.delete(requestId);
    },

    async listCommands(session) {
      const compact = { id: "compact", label: "/compact", action: "execute", description: "由 OpenClaw 原生压缩当前会话上下文" };
      if (session?.host) {
        try {
          const listed = await session.host.call("commands.list", { scope: "text" });
          const commands = [compact, ...projectTextCommands(listed)];
          session.state.commands = commands;
          return commands;
        } catch { return [compact]; } // 目录 RPC 失败时至少保留可执行的压缩指令
      }
      // 无会话时只连已有 Gateway（绝不为命令菜单拉起/恢复进程）；连接失败 → 菜单诚实禁用
      try {
        const host = await OpenClawGatewayHost.acquire(() => {}, { autostart: false });
        try { return [compact, ...projectTextCommands(await host.call("commands.list", { scope: "text" }))]; }
        finally { await OpenClawGatewayHost.release(); }
      } catch { return []; }
    },

    async executeCommand(session, id, { emit }) {
      if (id !== "compact") throw new Error("未知 OpenClaw 指令");
      // /compact 即消息文本，走 agent 运行管道；压缩流形状未实测，不伪造 tokensBefore/After
      await this.send(session, "/compact", { emit });
      emit({ kind: "compaction", state: "completed", outcome: "succeeded", summary: "上下文已由 OpenClaw 压缩。" });
    },

    async setModel(session, model) {
      // Gateway 按 run 应用 model 覆盖（需 operator.admin，握手已声明）；逐轮生效，不写原生配置
      session.modelOverride = model.id;
      session.model = model;
      return model;
    },

    async setThinkingLevel(session, level) {
      const catalog = session.state.thinkingLevels?.map((l) => l.id) ?? THINKING_LEVELS;
      if (!catalog.includes(level)) throw new Error(`OpenClaw 当前会话不支持思考档位 ${level}`);
      session.thinkingOverride = level;
    },

    async getContextUsage(session) { return session.state.usage; },

    async close(session) {
      for (const pending of session.pendingApprovals.values()) pending.reject?.(new Error("会话已关闭"));
      session.pendingApprovals.clear();
      try { session.unwatch?.(); } catch { /* 已断开 */ }
      await OpenClawGatewayHost.release();
    },
  };
  return adapter;
}

/** models.list → 统一目录（id 带 provider 前缀，与 agent 的 model 覆盖参数同形） */
async function listModels(host) {
  const result = await host.call("models.list", {});
  const rows = Array.isArray(result?.models) ? result.models : [];
  return rows.filter((m) => m && m.id).map((m) => ({
    id: m.provider ? `${m.provider}/${m.id}` : String(m.id),
    name: m.name || String(m.id),
    provider: m.provider,
    description: m.contextWindow ? `上下文窗口 ${Math.round(m.contextWindow / 1000)}k` : undefined,
  }));
}

function thinkingCatalog() {
  return THINKING_LEVELS.map((id) => ({ id, label: id }));
}

module.exports = { manifest, create, projectAgentEvent, projectApproval, applySessionDescription, planMcpReconcile, toOpenClawServerEntry, applyManagedMcpServers, MCP_OWNED_PREFIX, THINKING_LEVELS };
