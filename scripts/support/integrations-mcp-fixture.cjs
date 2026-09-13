// Local read-only MCP server used by the native integration acceptance probe.
const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (process.argv[2]) fs.appendFileSync(process.argv[2], `${request.method}\n`);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harness-mix-integration-probe', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'integration_probe', description: 'Return a fixed test token without side effects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'HARNESS_MIX_MCP_OK' }] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } })}\n`); return; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
