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

module.exports = { terminateTree, descendantPids };
