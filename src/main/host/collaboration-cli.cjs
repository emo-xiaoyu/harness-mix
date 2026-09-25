#!/usr/bin/env node
/**
 * Harness Mix 协作 CLI：控制面 HTTP 的命令行前端（与 42 行的 MCP 桥同级）。
 *
 * 约定（docs/cli-collaboration-design.md §4）：
 * - 长文本（task/message/desc/result/script/plan/members）支持 stdin：参数给 `-` 或缺省，
 *   且 stdin 是管道/重定向时读取——彻底规避 Windows argv 引号与长度坑；
 * - 发现顺序：HARNESS_MIX_COLLAB_URL/KEY 环境变量 → --url/--key → cwd 注册表
 *   （唯一 lead 自动选用，多候选必须 --thread）；
 * - 退出码：0 命令成功（不代表子任务成功）；1 服务端拒绝；2 发现失败；3 用法错误；
 * - 错误统一 {"error":{"code","message"}} 进 stderr；服务端 400 body 原样透传。
 */
const fs = require('node:fs');
const path = require('node:path');
const { discoverRegistry } = require('./collab-registry');

const DEFAULT_TIMEOUT_MS = 70000;

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: { code: code === 3 ? 'USAGE' : code === 2 ? 'DISCOVERY' : 'SERVER', message } }) + '\n');
  process.exit(code);
}

async function readStdin(label) {
  if (process.stdin.isTTY) fail(3, `${label}: stdin was requested (argument "-" or omitted) but nothing is piped`);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readTextArgument(value, positionals, label) {
  // 位置参数优先（多段以空格连接），其次显式 `-`，最后缺省回落 stdin
  if (positionals.length) return positionals.join(' ');
  if (value !== undefined && value !== null) return value;
  return readStdin(label);
}

async function readPayload(spec, label) {
  if (!spec || spec === '-') return readStdin(label);
  return fs.promises.readFile(spec, 'utf8');
}

// 值选项表：选项名 → 是否取值。子命令共用一个命名空间，无冲突。
const VALUE_OPTIONS = new Set(['format', 'thread', 'url', 'key', 'cwd', 'timeout-ms', 'wait-ms', 'isolation',
  'team', 'member', 'task-id', 'digest', 'name', 'goal', 'members', 'title', 'desc', 'assignee',
  'depends-on', 'retry', 'status', 'result', 'to', 'kind', 'script']);

function tokenize(argv) {
  const opts = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (!VALUE_OPTIONS.has(name)) { opts[name] = true; continue; }
    if (index + 1 >= argv.length) fail(3, `Option --${name} requires a value`);
    opts[name] = argv[++index];
  }
  return { opts, positionals };
}

function parsePositiveInt(value, label, { maximum } = {}) {
  const parsed = Number(value);
  if (!/^\d+$/u.test(String(value)) || parsed < 0 || (maximum && parsed > maximum)) {
    fail(3, `${label} must be a non-negative integer${maximum ? ` no greater than ${maximum}` : ''}`);
  }
  return parsed;
}

async function resolveTarget(opts) {
  const envUrl = process.env.HARNESS_MIX_COLLAB_URL;
  const envKey = process.env.HARNESS_MIX_COLLAB_KEY;
  if (envUrl && envKey) return { url: envUrl, key: envKey };
  if (opts.url || opts.key) fail(3, '--url and --key must be provided together');
  const { entries } = await discoverRegistry({ cwd: opts.cwd });
  if (!entries.length) {
    fail(2, `No Harness Mix collaboration session is registered for ${opts.cwd ?? process.cwd()}. `
      + 'Run this command inside a Harness Mix lead session after triggering a collaboration turn, or pass --url and --key.');
  }
  if (opts.thread) {
    const hit = entries.find(entry => entry.threadId === opts.thread);
    if (!hit) fail(2, `--thread ${opts.thread} is not registered for this directory`);
    return { url: hit.url, key: hit.key };
  }
  const leads = entries.filter(entry => entry.kind === 'lead');
  if (leads.length === 1) return { url: leads[0].url, key: leads[0].key };
  fail(2, `Multiple sessions are registered for this directory: `
    + entries.map(entry => `${entry.threadId} (${entry.kind}, ${entry.harnessId}, ${JSON.stringify(entry.title)})`).join('; ')
    + '. Re-run with --thread <id>.');
}

async function call(url, key, name, args, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(1, `Control plane unreachable: ${error.message}`);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value?.error ?? `HTTP ${response.status}`;
    fail(1, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return value.result;
}

function snippet(value, length = 80) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function compact(result) {
  const lines = [];
  if (Array.isArray(result)) {
    for (const item of result) lines.push(compactValue(item));
    return lines.join('\n');
  }
  return compactValue(result);
}

function compactValue(item) {
  if (item === null || item === undefined) return '';
  if (Array.isArray(item)) return item.map(compactValue).join('\n');
  if (typeof item === 'object') {
    if ('task_id' in item) {
      const parts = [`[task ${String(item.task_id).slice(0, 8)}]`, item.display_status ?? item.status, item.agent_type ?? ''];
      if (item.attention) parts.push(`attention:${item.attention.type}`);
      if (item.branch) parts.push(`branch:${item.branch}`);
      const body = item.error ?? item.result ?? '';
      return parts.filter(Boolean).join(' ') + (body ? ` — ${snippet(body)}` : '');
    }
    if ('agent_type' in item && 'name' in item) {
      return `${item.agent_type} ${item.name} available=${!!item.available}${item.team_capable ? ' team_capable=true' : ''}`;
    }
    if ('threadId' in item) {
      return `${String(item.threadId).slice(0, 8)} ${item.role} ${item.harnessId} cwd=${item.cwd}`
        + `${item.team ? ` team=${item.team.name}` : ''}${item.activeMentions?.length ? ` mentions=${item.activeMentions.join(',')}` : ''}`;
    }
    if ('digest' in item && 'patch' in item) {
      return `digest ${item.digest}\n${item.patch}`;
    }
    if ('script_id' in item) {
      return `[script ${String(item.script_id).slice(0, 8)}] ${item.status}${item.phase ? ` phase=${item.phase}` : ''} — ${snippet(item.note ?? '')}`;
    }
    if ('team_id' in item && 'phase' in item) return JSON.stringify(item);
    if ('id' in item && 'members' in item) {
      return `team ${item.id} "${item.name}" ${item.status ?? ''} members=${(item.members ?? []).map(member => `${member.name}(${member.agent})`).join(',')} tasks=${(item.tasks ?? []).length}`;
    }
  }
  return JSON.stringify(item);
}

const HELP = `usage: node ${path.basename(__filename)} [options] <command> [args]

Harness Mix collaboration CLI. Talks to the local Host control plane as the
calling lead session. Long texts (task/message/desc/result/script/plan/members)
are read from stdin when the argument is "-" or omitted.

discovery (first match wins):
  HARNESS_MIX_COLLAB_URL + HARNESS_MIX_COLLAB_KEY env
  --url <u> --key <k>
  cwd registry: the single registered lead session is used automatically;
  multiple candidates require --thread <id>

options:
  --format json|compact   output shape (default json; compact prints one line per item)
  --thread <id>           pick an exact registry entry
  --url <u> --key <k>     explicit control plane access
  --cwd <path>            registry lookup directory (default: process cwd)
  --timeout-ms <n>        HTTP timeout (default ${DEFAULT_TIMEOUT_MS})

commands:
  whoami                            caller identity: thread, harness, cwd, role, whitelist
  agents                            list delegatable harnesses
  delegate <agent> [task]           start a subtask; --isolation auto|worktree|shared;
                                    team mode: --team <id> --member <id> --task-id <tid>
  delegations                       list this lead's durable child tasks (incl. interrupted)
  status <task_id>... [--wait-ms n] collect results; wait up to n ms (max 60000); repeat while running
  followup <task_id> [message]      send a follow-up to a completed subtask, reusing its session
  cancel <task_id>                  cancel one running subtask
  review <task_id>                  read an isolated subtask patch and its digest
  apply <task_id> --digest <d>      apply the reviewed patch (explicit user authorization only)
  resume <task_id>                  continue an interrupted subtask without replaying side effects
  plan [file|-]                     publish the lead plan: JSON array [{text,status}]
  team create --name <n> --goal <g> [--members file|-]   members JSON: [{name,role,agent_type}]
  team assign <team> --title <t> --desc - --assignee <m> [--depends-on a,b] [--retry n]
  team state <team>                 roster, shared task graph, mailbox, script driver
  team update <team> <task> --status <s> [--result -]
  team message <team> --to <to> [--kind k] [--task <tid>] [message]
  team script <team> [--script file|-]  async: returns script_id; you are woken once at completion

exit codes: 0 command ok (task may still be running) · 1 server rejected ·
2 discovery failed · 3 usage error. Errors: {"error":{"code","message"}} on stderr.`;

async function buildRequest(command, opts, positionals) {
  switch (command) {
    case 'whoami': return ['session_info', { frontend: 'cli' }];
    case 'agents': return ['list_agents', {}];
    case 'delegations': return ['list_delegations', {}];
    case 'delegate': {
      const [agent] = positionals;
      if (!agent) fail(3, 'usage: delegate <agent> [task]');
      const task = await readTextArgument(undefined, positionals.slice(1), 'task');
      return ['delegate_to_agent', {
        agent_type: agent, task,
        ...(opts.isolation ? { isolation: opts.isolation } : {}),
        ...(opts.team || opts.member || opts['task-id']
          ? { team_id: opts.team, member_id: opts.member, team_task_id: opts['task-id'] }
          : {}),
      }];
    }
    case 'status': {
      if (!positionals.length) fail(3, 'usage: status <task_id>... [--wait-ms n]');
      return ['get_delegation_status', {
        task_ids: positionals,
        ...(opts['wait-ms'] !== undefined ? { wait_ms: parsePositiveInt(opts['wait-ms'], '--wait-ms', { maximum: 60000 }) } : {}),
      }];
    }
    case 'followup': {
      const [taskId] = positionals;
      if (!taskId) fail(3, 'usage: followup <task_id> [message]');
      const message = await readTextArgument(undefined, positionals.slice(1), 'message');
      return ['message_agent', { task_id: taskId, task: message }];
    }
    case 'cancel': {
      const [taskId] = positionals;
      if (!taskId) fail(3, 'usage: cancel <task_id>');
      return ['cancel_delegation', { task_id: taskId }];
    }
    case 'review': {
      const [taskId] = positionals;
      if (!taskId) fail(3, 'usage: review <task_id>');
      return ['review_delegation_changes', { task_id: taskId }];
    }
    case 'apply': {
      const [taskId] = positionals;
      if (!taskId || !opts.digest) fail(3, 'usage: apply <task_id> --digest <d>');
      return ['apply_delegation_changes', { task_id: taskId, digest: opts.digest }];
    }
    case 'resume': {
      const [taskId] = positionals;
      if (!taskId) fail(3, 'usage: resume <task_id>');
      return ['resume_delegation', { task_id: taskId }];
    }
    case 'plan': {
      const raw = await readPayload(positionals[0], 'plan');
      let steps;
      try { steps = JSON.parse(raw); } catch { fail(3, 'plan: stdin/file must be a JSON array [{text,status}]'); }
      if (!Array.isArray(steps)) fail(3, 'plan: expected a JSON array [{text,status}]');
      return ['update_agent_plan', { steps }];
    }
    case 'team': {
      const [sub, ...rest] = positionals;
      if (sub === 'create') {
        if (!opts.name || (!opts.goal && !opts.members)) fail(3, 'usage: team create --name <n> --goal <g> [--members file|-]');
        const goal = opts.goal ?? await readStdin('goal');
        const membersRaw = opts.members ? await readPayload(opts.members, 'members') : await readStdin('members');
        let members;
        try { members = JSON.parse(membersRaw); } catch { fail(3, 'members: expected JSON array [{name,role,agent_type}]'); }
        if (!Array.isArray(members)) fail(3, 'members: expected JSON array [{name,role,agent_type}]');
        return ['create_agent_team', { name: opts.name, goal, members }];
      }
      if (sub === 'assign') {
        const [teamId] = rest;
        if (!teamId || !opts.title || !opts.assignee) fail(3, 'usage: team assign <team> --title <t> --desc - --assignee <m> [--depends-on a,b] [--retry n]');
        const description = opts.desc && opts.desc !== '-' ? opts.desc : await readStdin('desc');
        return ['assign_team_task', {
          team_id: teamId, title: opts.title, description, assignee: opts.assignee,
          ...(opts['depends-on'] ? { depends_on: opts['depends-on'].split(',').map(value => value.trim()).filter(Boolean) } : {}),
          ...(opts.retry ? { retry: { max: parsePositiveInt(opts.retry, '--retry', { maximum: 3 }) || 1 } } : {}),
        }];
      }
      if (sub === 'state') {
        const [teamId] = rest;
        if (!teamId) fail(3, 'usage: team state <team>');
        return ['get_team_state', { team_id: teamId }];
      }
      if (sub === 'update') {
        const [teamId, taskId] = rest;
        if (!teamId || !taskId || !opts.status) fail(3, 'usage: team update <team> <task> --status <s> [--result -]');
        const result = opts.result && opts.result !== '-' ? opts.result : (opts.result === '-' || rest[2] === '-' ? await readStdin('result') : undefined);
        return ['update_team_task', { team_id: teamId, task_id: taskId, status: opts.status, ...(result !== undefined ? { result } : {}) }];
      }
      if (sub === 'message') {
        const [teamId] = rest;
        if (!teamId || !opts.to) fail(3, 'usage: team message <team> --to <to> [--kind k] [--task <tid>] [message]');
        const message = await readTextArgument(undefined, rest.slice(1), 'message');
        return ['send_team_message', {
          team_id: teamId, to: opts.to, message,
          ...(opts.kind ? { kind: opts.kind } : {}),
          ...(opts.task ? { task_id: opts.task } : {}),
        }];
      }
      if (sub === 'script') {
        const [teamId] = rest;
        if (!teamId) fail(3, 'usage: team script <team> [--script file|-]');
        const script = await readPayload(opts.script ?? '-', 'script');
        return ['run_team_script', { team_id: teamId, script }];
      }
      return [null, null, `unknown team subcommand "${sub ?? ''}" (create|assign|state|update|message|script)`];
    }
    default:
      return [null, null, `unknown command "${command}"`];
  }
}

async function main(argv) {
  const { opts, positionals } = tokenize(argv);
  if (opts.help || !positionals.length) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }
  if (opts.format && !['json', 'compact'].includes(opts.format)) fail(3, '--format must be json or compact');
  const timeoutMs = opts['timeout-ms'] ? parsePositiveInt(opts['timeout-ms'], '--timeout-ms') || DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const [name, args, usageError] = await buildRequest(positionals[0], opts, positionals.slice(1));
  if (usageError) fail(3, usageError);
  const target = await resolveTarget(opts);
  const result = await call(target.url, target.key, name, args, timeoutMs);
  process.stdout.write((opts.format === 'compact' ? compact(result) : JSON.stringify(result, null, 2)) + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => fail(1, error.message));
}
