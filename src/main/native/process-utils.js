// Child-process lifecycle helpers shared by adapters, host runtime and launcher.
// On Windows a plain child.kill() only terminates the direct child, so CLI
// wrappers (cmd → npm → node) need taskkill /T to reach the whole tree.
const { spawn, execFile } = require('node:child_process');

function descendantPids(rows, root) {
  const children = new Map();
  for (const row of rows.split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]), parent = Number(match[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const result = [], visited = new Set([root]);
  function visit(parent) {
    for (const pid of children.get(parent) || []) {
      if (visited.has(pid) || pid === process.pid) continue;
      visited.add(pid);
      visit(pid);
      result.push(pid);
    }
  }
  visit(root);
  return result;
}

// Force-terminate a process tree. Resolves once the attempt finished; never
// throws and never rejects, so callers can fire-and-forget with `void`.
function terminateTree(pid, { timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      execFile('ps', ['-ax', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, rows) => {
        const descendants = error ? [] : descendantPids(rows, pid);
        for (const target of [...descendants, pid]) {
          try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
        }
        resolve();
      });
      return;
    }
    let settled = false;
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* ignore */ } done(); }, timeoutMs);
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    killer.on('error', done);
    killer.on('close', done);
  });
}

// Windows console children never inherit the WinINET system proxy: Go CLIs
// (agy, gh, …) only honor HTTP(S)_PROXY env vars, so when harness-mix spawns
// them from a desktop host without proxy env, their OAuth token refresh and
// API traffic black-hole even though the system proxy is up — for agy this
// re-triggers interactive login on every start. Expose the WinINET settings as
// standard proxy env vars; callers merge this into the child env. Explicit
// proxy env on the host always wins.
const WININET_INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const SYSTEM_PROXY_ENV_TTL_MS = 5 * 60 * 1000;
let systemProxyEnvCache = { env: null, at: 0 };

function parseWininetProxyTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!text.includes('=')) return { http: text, https: text };
  const perScheme = {};
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const scheme = part.slice(0, eq).trim().toLowerCase();
    const target = part.slice(eq + 1).trim();
    if (!target) continue;
    if (scheme === 'http' || scheme === 'https' || scheme === 'socks') perScheme[scheme] = target;
  }
  const socks = perScheme.socks ? `socks5://${perScheme.socks.replace(/^socks5:\/\//i, '')}` : null;
  const http = perScheme.http || socks || null;
  const https = perScheme.https || socks || perScheme.http || null;
  return http || https ? { http, https } : null;
}

function withProxyScheme(target) {
  const text = String(target || '').trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text}`;
}

// WinINET's wildcard override list (`127.*`, `*.corp`, `<local>`) is not valid
// NO_PROXY syntax for Go/curl; map the common shapes and pass the rest through.
function parseWininetProxyOverride(raw) {
  const entries = String(raw || '').split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return null;
  const out = ['localhost', '127.0.0.1', '::1'];
  for (const entry of entries) {
    if (entry === '<local>' || entry === 'localhost' || entry === '127.*') continue;
    if (entry === '10.*') out.push('10.0.0.0/8');
    else if (entry === '192.168.*') out.push('192.168.0.0/16');
    else if (/^172\.(?:1[6-9]|2\d|3[01])\.\*$/.test(entry)) out.push('172.16.0.0/12');
    else if (entry.startsWith('*.')) out.push(entry.slice(1));
    else out.push(entry);
  }
  return [...new Set(out)].join(',');
}

function readWininetProxySettings() {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', WININET_INTERNET_SETTINGS_KEY],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        const values = {};
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+\S+\s+(.*?)\s*$/);
          if (match) values[match[1]] = match[2];
        }
        resolve(values);
      },
    );
  });
}

function hasExplicitProxyEnv(env) {
  return Boolean(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy);
}

async function systemProxyEnv() {
  if (process.platform !== 'win32') return {};
  if (hasExplicitProxyEnv(process.env)) return {};
  const now = Date.now();
  if (systemProxyEnvCache.env && now - systemProxyEnvCache.at < SYSTEM_PROXY_ENV_TTL_MS) {
    return systemProxyEnvCache.env;
  }
  const values = await readWininetProxySettings();
  let resolved = {};
  if (values && String(values.ProxyEnable || '').trim() === '0x1') {
    const targets = parseWininetProxyTarget(values.ProxyServer);
    if (targets) {
      resolved = {};
      if (targets.http) resolved.HTTP_PROXY = resolved.http_proxy = withProxyScheme(targets.http);
      if (targets.https) resolved.HTTPS_PROXY = resolved.https_proxy = withProxyScheme(targets.https);
      const noProxy = parseWininetProxyOverride(values.ProxyOverride);
      if (noProxy) resolved.NO_PROXY = resolved.no_proxy = noProxy;
    }
  }
  systemProxyEnvCache = { env: resolved, at: now };
  return resolved;
}

module.exports = { terminateTree, descendantPids, systemProxyEnv, parseWininetProxyTarget, parseWininetProxyOverride, withProxyScheme };
