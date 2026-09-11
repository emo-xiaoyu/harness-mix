const readline = require('node:readline');
const { tools } = require('./collaboration-tools');

async function call(name, args) {
  const response = await fetch(process.env.HARNESS_MIX_COLLAB_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.HARNESS_MIX_COLLAB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(70000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Collaboration request failed');
  return value.result;
}

async function dispatch(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harness-mix', version: '0.1.0' } };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools };
  if (message.method === 'tools/call') {
    try { return { content: [{ type: 'text', text: JSON.stringify(await call(message.params.name, message.params.arguments ?? {})) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }
  throw new Error('Unknown MCP method');
}

if (require.main === module) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    void dispatch(message).then(result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'),
      error => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: error.message } }) + '\n'));
  });
}
module.exports = { call, dispatch };
