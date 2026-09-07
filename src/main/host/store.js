const { promises: fs } = require("node:fs");
const path = require("node:path");

/** 线程记录的 JSON 持久化：排队串行写入 + tmp 文件原子替换 */
class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "threads.json");
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const threads = JSON.parse(await fs.readFile(this.file, "utf8"));
      return Array.isArray(threads) ? threads : [];
    } catch {
      return [];
    }
  }

  /** 串行保存；data 由调用方在入队时快照，避免写放大期间引用被继续修改 */
  save(threads) {
    const contents = JSON.stringify(threads, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.writeFile(`${this.file}.tmp`, contents);
      try {
        await fs.rename(`${this.file}.tmp`, this.file);
      } catch (error) {
        // Windows 上 rename 无法覆盖已存在的目标文件（EPERM），退化为先删后改名
        if (error.code !== "EPERM") throw error;
        await fs.rm(this.file, { force: true });
        await fs.rename(`${this.file}.tmp`, this.file);
      }
    });
    return this.queue;
  }
}

module.exports = { Store };
