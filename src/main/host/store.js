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
    await this.queue;
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const threads = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(threads)) throw new Error('Invalid thread store; original file preserved');
      return threads;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** 串行保存；data 由调用方在入队时快照，避免写放大期间引用被继续修改 */
  save(threads) {
    const contents = JSON.stringify(threads, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.writeFile(`${this.file}.tmp`, contents);
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(`${this.file}.tmp`, this.file); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    });
    return this.queue;
  }
}

module.exports = { Store };
