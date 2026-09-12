// ACP 家族能力探针：对 qoder / workbuddy / zcode / trae / hermes 逐一
//   1) initialize          → 报告 agentCapabilities（promptCapabilities.image、mcpCapabilities 等）
//   2) session/new 带 dummy stdio MCP server → 验证 MCP 注入是否被接受（多 Agent 协作的接线前提）
// 结果只读打印，不修改任何适配器。运行：node scripts/acp-capabilities-probe.cjs [harnessId...]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cliSpawn } = require('../src/main/host/jsonl');

const TARGETS = {
  qoder: () => cliSpawn(process.env.HARNESS_MIX_QODER_EXECUTABLE || 'qodercli', ['--acp']),
  workbuddy: () => {
    const candidates = [
      process.env.HARNESS_MIX_WORKBUDDY_EXECUTABLE,
      'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    ].filter(Boolean);
    const found = candidates.find(p => fs.existsSync(p));
    return found ? { command: process.execPath, args: [found, '--acp'] } : cliSpawn('codebuddy', ['--acp']);
  },
  zcode: () => cliSpawn(process.env.HARNESS_MIX_ZCODE_EXECUTABLE || 'zcode', ['acp']),
  trae: () => cliSpawn(process.env.HARNESS_MIX_TRAE_EXECUTABLE || 'traecli', ['acp', 'serve']),
  hermes: () => ({ command: process.env.HARNESS_MIX_HERMES_EXECUTABLE || 'hermes.exe', args: ['acp'] }),
};

// 最小 MCP stdio server：应答 initialize / tools/list，让 agent 完成 MCP 握手
const PROBE_SERVER = path.join(__dirname, '..', 'output', 'acp-probe-mcp.cjs');
fs.mkdirSync(path.dirname(PROBE_SERVER), { recursive: true });
fs.writeFileSync(PROBE_SERVER, `let buf='';
process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line)}catch{continue}
if(msg.method==='initialize')reply(msg.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'harness-mix-probe',version:'0'}});
else if(msg.method==='tools/list')reply(msg.id,{tools:[{name:'probe_tool',description:'probe',inputSchema:{type:'object',properties:{}}}]});
else if(msg.id!==undefined)reply(msg.id,{});}});
function reply(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\\\n');}
`);

function probe(id, makeCli) {
  return new Promise((resolve) => {
    const cli = makeCli();
    const report = { id, image: null, audio: null, mcpCapabilities: null, loadSession: null, mcpAccepted: null, detail: '' };
    let child;
    try { child = spawn(cli.command, cli.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { report.detail = `spawn 失败: ${error.message}`; return resolve(report); }
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { report.mcpAccepted = report.mcpAccepted ?? 'timeout'; done(); }, 30000);
    function done() { clearTimeout(timer); try { child.kill(); } catch {} resolve(report); }
    function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
    child.on('error', (error) => { report.detail = `不可用: ${error.message}`; done(); });
    child.on('exit', (code) => { if (report.mcpAccepted === null) { report.mcpAccepted = 'exited'; report.detail = `进程退出(${code}) ${stderr.slice(-200)}`; } done(); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.stdout.on('data', (c) => {
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0 && msg.result) {
          const caps = msg.result.agentCapabilities || {};
          report.image = caps.promptCapabilities?.image ?? null;
          report.audio = caps.promptCapabilities?.audio ?? null;
          report.mcpCapabilities = caps.mcpCapabilities ?? null;
          report.loadSession = caps.loadSession ?? null;
          send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [
            { name: 'harness-mix-probe', command: process.execPath, args: [PROBE_SERVER], env: [] },
          ] } });
        } else if (msg.id === 0 && msg.error) {
          report.detail = `initialize 拒绝: ${msg.error.message}`; report.mcpAccepted = 'n/a'; done();
        } else if (msg.id === 1) {
          if (msg.result?.sessionId) report.mcpAccepted = true;
          else { report.mcpAccepted = false; report.detail = `session/new 拒绝: ${msg.error?.message || 'unknown'}`; }
          done();
        }
      }
    });
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'harness-mix-probe', version: '0.1.0' } } });
  });
}

async function main() {
  const only = process.argv.slice(2);
  const entries = Object.entries(TARGETS).filter(([id]) => !only.length || only.includes(id));
  console.log('harness      image   audio   loadSession  mcpCaps            mcpServers 注入  备注');
  for (const [id, makeCli] of entries) {
    const r = await probe(id, makeCli);
    console.log([
      id.padEnd(12),
      String(r.image).padEnd(7),
      String(r.audio).padEnd(7),
      String(r.loadSession).padEnd(12),
      JSON.stringify(r.mcpCapabilities).padEnd(18),
      String(r.mcpAccepted).padEnd(12),
      r.detail.slice(0, 80),
    ].join(' '));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
