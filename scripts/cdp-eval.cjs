// CDP driver: evaluate JS and/or send raw CDP commands against the live Codex Desktop.
// usage: node scripts/cdp-eval.cjs <port> <expression>          -> Runtime.evaluate
//        node scripts/cdp-eval.cjs <port> --cmd <method> <json> -> raw command
const http = require('node:http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const port = process.argv[2];
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find(t => t.type === 'page' && t.url === 'app://-/index.html');
  if (!page) throw new Error('main page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (process.argv[3] === '--cmd') {
    const result = await send(process.argv[4], JSON.parse(process.argv[5] || '{}'));
    console.log(JSON.stringify(result.result ?? result.error ?? null));
  } else {
    const result = await send('Runtime.evaluate', { expression: process.argv[3], returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) console.error('EX:', JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    else console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2));
  }
  ws.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
