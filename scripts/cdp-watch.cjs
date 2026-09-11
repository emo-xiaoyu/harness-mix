// Watch renderer console/log for N milliseconds.
const http = require('node:http');
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
async function main() {
  const port = process.argv[2];
  const seconds = Number(process.argv[3] || 60);
  const filter = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find(t => t.type === 'page' && t.url === 'app://-/index.html');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const send = (method, params) => { ws.send(JSON.stringify({ id: ++id, method, params })); };
  send('Runtime.enable');
  send('Log.enable');
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    let line = null;
    if (msg.method === 'Runtime.consoleAPICalled') {
      line = 'console.' + msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ').slice(0, 500);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      line = `log.${e.level}: ${(e.text || '').slice(0, 500)}`;
    } else if (msg.method === 'Runtime.exceptionThrown') {
      line = 'EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500);
    }
    if (line && (!filter || filter.test(line))) console.log(new Date().toLocaleTimeString(), line);
  };
  console.log('watching for', seconds, 's');
  setTimeout(() => { ws.close(); process.exit(0); }, seconds * 1000);
}
main().catch(e => { console.error(e.message); process.exit(1); });
