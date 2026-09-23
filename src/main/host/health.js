const fs = require('node:fs');
const path = require('node:path');

// 健康中心：把宿主运行状态、各 Harness 握手结果、存储治理摘要与崩溃报告
// 汇总成一个只读快照。崩溃报告由 native/host.js 写在 <base>/runtime/ 下
// （与 dataDirectory 同级），这里只读取，不写入。
const MAX_CRASH_REPORTS = 10;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

class HealthCenter {
  constructor(runtime) {
    this.runtime = runtime;
    this.startedAt = Date.now();
  }

  runtimeDir() {
    // host.js: instanceFile = path.join(path.dirname(dataDirectory), 'runtime', 'instance.json')
    return path.join(path.dirname(this.runtime.store.directory), 'runtime');
  }

  crashReports() {
    try {
      const dir = this.runtimeDir();
      const files = fs.readdirSync(dir).filter(name => /^crash-\d+\.json$/.test(name)).sort().reverse().slice(0, MAX_CRASH_REPORTS);
      return files.map(name => {
        const report = readJson(path.join(dir, name));
        if (!report) return null;
        return {
          file: name,
          kind: String(report.kind ?? 'unknown'),
          at: Number.isFinite(report.at) ? report.at : null,
          version: report.version ?? null,
          message: String(report.message ?? '').slice(0, 400),
          stack: String(report.stack ?? '').split('\n').slice(0, 3).join('\n').slice(0, 400),
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  instanceInfo() {
    const instance = readJson(path.join(this.runtimeDir(), 'instance.json'));
    if (!instance) return null;
    return {
      pid: Number.isFinite(instance.pid) ? instance.pid : null,
      version: instance.version ?? null,
      startedAt: Number.isFinite(instance.startedAt) ? instance.startedAt : null,
      beatAt: Number.isFinite(instance.beatAt) ? instance.beatAt : null,
      heartbeatAgeMs: Number.isFinite(instance.beatAt) ? Math.max(0, Date.now() - instance.beatAt) : null,
    };
  }

  harnesses() {
    return [...this.runtime.adapters.values()].map(adapter => {
      const status = this.runtime.status[adapter.manifest.id] ?? {};
      const capabilities = adapter.manifest.capabilities ?? {};
      return {
        id: adapter.manifest.id,
        name: adapter.manifest.name,
        available: status.available === true,
        detail: typeof status.detail === 'string' ? status.detail : null,
        collaborationLead: capabilities.collaborationTools === true,
        mcp: capabilities.integrations?.mcp === true,
        skills: capabilities.integrations?.skills === true,
        openThreads: this.runtime.threads.filter(thread => thread.harnessId === adapter.manifest.id).length,
      };
    });
  }

  threadCounts() {
    const counts = { total: this.runtime.threads.length, working: 0, interrupted: 0, ready: 0 };
    for (const thread of this.runtime.threads) {
      if (this.runtime.execution.isRunning(thread.id)) counts.working += 1;
      else if (thread.status === 'interrupted') counts.interrupted += 1;
      else counts.ready += 1;
    }
    return counts;
  }

  async snapshot() {
    const storage = await this.runtime.inspectStorage().catch(error => ({ error: String(error?.message ?? error) }));
    return {
      runtime: {
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        pid: process.pid,
        instance: this.instanceInfo(),
      },
      harnesses: this.harnesses(),
      threads: this.threadCounts(),
      sessions: this.runtime.sessions.size,
      storage,
      collaboration: this.runtime.collaboration.getPreferences(),
      crashReports: this.crashReports(),
      generatedAt: Date.now(),
    };
  }

  /** 重新对全部适配器执行握手探测（与 initialize 的探测路径一致）并返回新快照 */
  async refreshHarnesses() {
    const inspections = await Promise.all([...this.runtime.adapters.values()].map(async adapter => [adapter.manifest.id, await adapter.inspect().catch(error => ({ available: false, detail: error.message }))]));
    this.runtime.status = Object.fromEntries(inspections);
    return this.snapshot();
  }
}

module.exports = { HealthCenter };
