// Child-process lifecycle helpers shared by adapters, host runtime and launcher.
// On Windows a plain child.kill() only terminates the direct child, so CLI
// wrappers (cmd → npm → node) need taskkill /T to reach the whole tree.
const { spawn } = require('node:child_process');

// Force-terminate a process tree. Resolves once the attempt finished; never
// throws and never rejects, so callers can fire-and-forget with `void`.
function terminateTree(pid, { timeoutMs = 5000 } = {}) {
  if (!pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve();
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

module.exports = { terminateTree };
