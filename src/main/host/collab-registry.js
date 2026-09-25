/**
 * 协作 CLI 的发现注册表：按 cwd 暴露「本 Host 实例的控制面地址 + 每线程 key」。
 *
 * 设计约束（docs/cli-collaboration-design.md §3.2）：
 * - 注册表是 best-effort 通道：写入失败静默降级，绝不阻塞协作主链路；
 * - key 只落在用户级目录（~/.harness-mix/collab），不进日志、不进 argv；
 * - 崩溃残留由 7 天清扫回收；CLI 拿到过期 key 时控制面以 403 拒绝，无副作用。
 */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STALE_INSTANCE_MS = 7 * 24 * 60 * 60 * 1000;
const INSTANCE_FILE_PATTERN = /^instance-[\w-]+\.json$/u;

function dataBase(env = process.env, platform = process.platform, home = os.homedir()) {
  // 与 src/main/native/platform.js 的 dataBase 保持同构：CLI 与 Host 必须算出同一路径
  if (platform === 'win32') return env.APPDATA || home;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
}

function defaultDirectory() {
  // 覆盖口优先（测试与 CLI 共用），其次显式数据根，最后平台数据目录
  if (process.env.HARNESS_MIX_COLLAB_REGISTRY_DIR) return process.env.HARNESS_MIX_COLLAB_REGISTRY_DIR;
  if (process.env.HARNESSMIX_DATA_DIR) return path.join(process.env.HARNESSMIX_DATA_DIR, 'collab-registry');
  return path.join(dataBase(), 'harnessmix', 'collab-registry');
}

/** Host 侧派生：注册表与 runtime 数据目录同级（生产=平台数据目录；测试=各自的临时根） */
function registryDirectoryFor(dataDirectory) {
  return path.join(path.dirname(path.resolve(String(dataDirectory))), 'collab-registry');
}

function normalizeCwd(cwd) {
  const resolved = path.resolve(String(cwd));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

class CollabRegistry {
  constructor(directory = defaultDirectory()) {
    this.directory = directory;
    this.instanceFile = null;
    this.state = null; // { pid, startedAt, url, cwds }
    this.writing = null; // 串行化原子重写，避免并发 upsert 交错
  }

  async start(url) {
    await fsp.mkdir(this.directory, { recursive: true });
    this.instanceFile = path.join(this.directory, `instance-${randomUUID()}.json`);
    this.state = { pid: process.pid, startedAt: Date.now(), url, cwds: {} };
    await this.#write();
  }

  async sweep() {
    let names;
    try { names = await fsp.readdir(this.directory); } catch { return; }
    const now = Date.now();
    for (const name of names) {
      if (!INSTANCE_FILE_PATTERN.test(name)) {
        // 崩溃/竞态残留的原子写临时文件一并回收
        if (/\.tmp$/u.test(name)) await fsp.rm(path.join(this.directory, name), { force: true }).catch(() => {});
        continue;
      }
      const file = path.join(this.directory, name);
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!parsed?.startedAt || now - parsed.startedAt > STALE_INSTANCE_MS) await fsp.rm(file, { force: true });
      } catch {
        // 残缺实例文件按陈旧处理，直接回收
        await fsp.rm(file, { force: true }).catch(() => {});
      }
    }
  }

  async upsert(thread, key) {
    if (!this.state) return;
    const threadId = String(thread.id);
    const cwdKey = normalizeCwd(thread.cwd);
    // 线程移动目录后旧 cwd 条目必须迁走：按 threadId 全表去重再落新桶
    for (const [cwd, entries] of Object.entries(this.state.cwds)) {
      if (cwd === cwdKey) continue;
      delete entries[threadId];
      if (!Object.keys(entries).length) delete this.state.cwds[cwd];
    }
    this.state.cwds[cwdKey] ??= {};
    this.state.cwds[cwdKey][threadId] = {
      key,
      title: thread.title ?? '',
      harnessId: thread.harnessId,
      kind: thread.parentThreadId ? 'worker' : 'lead',
      updatedAt: Date.now(),
    };
    await this.#write();
  }

  async remove(threadId) {
    if (!this.state) return;
    const id = String(threadId);
    for (const [cwd, entries] of Object.entries(this.state.cwds)) {
      delete entries[id];
      if (!Object.keys(entries).length) delete this.state.cwds[cwd];
    }
    await this.#write();
  }

  async stop() {
    await this.writing;
    if (this.instanceFile) await fsp.rm(this.instanceFile, { force: true }).catch(() => {});
    this.instanceFile = null;
    this.state = null;
  }

  async #write() {
    // 目标路径捕获一次：stop() 置空后不再允许新写入，在途写入也不指向 null
    const target = this.instanceFile;
    if (!target || !this.state) return;
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const run = (this.writing ?? Promise.resolve()).then(async () => {
      await fsp.writeFile(tmp, JSON.stringify(this.state), 'utf8');
      await fsp.rename(tmp, target);
    });
    this.writing = run.catch(() => {});
    await run;
  }
}

/**
 * CLI 侧发现：枚举注册目录中匹配 cwd 的条目。读侧不校验实例新旧——过期 key 由
 * 控制面 403 兜底。lead 条目优先、其次按更新时间倒序，供「唯一 lead 自动选用 /
 * 多候选报歧义」的解析规则使用。
 */
async function discoverRegistry({ cwd, directory = defaultDirectory() } = {}) {
  const target = normalizeCwd(cwd ?? process.cwd());
  let names;
  try { names = await fsp.readdir(directory); } catch { return { url: null, entries: [] }; }
  const found = [];
  for (const name of names) {
    if (!INSTANCE_FILE_PATTERN.test(name)) continue;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'));
      const bucket = parsed?.cwds?.[target];
      if (!parsed?.url || !bucket) continue;
      for (const [threadId, entry] of Object.entries(bucket)) {
        if (entry?.key) found.push({ instance: name, url: parsed.url, threadId, ...entry });
      }
    } catch {
      // 残缺实例文件跳过
    }
  }
  found.sort((a, b) => (b.kind === 'lead') - (a.kind === 'lead') || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { url: found[0]?.url ?? null, entries: found };
}

module.exports = { CollabRegistry, discoverRegistry, registryDirectoryFor };
