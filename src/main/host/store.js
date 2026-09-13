const { promises: fs } = require("node:fs");
const path = require("node:path");

/** 线程记录的 JSON 持久化：折叠排队保存 + tmp 文件原子替换，避免中间状态内存堆积 */
class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "threads.json");
    this.writing = false;
    this.pendingData = null;
    this.pendingResolvers = [];
    this.pendingRejecters = [];
  }

  async load() {
    if (this.writing || this.pendingData) {
      await new Promise((resolve, reject) => {
        this.pendingResolvers.push(resolve);
        this.pendingRejecters.push(reject);
      });
    }
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

  save(threads) {
    this.pendingData = threads;
    const promise = new Promise((resolve, reject) => {
      this.pendingResolvers.push(resolve);
      this.pendingRejecters.push(reject);
    });
    void this.#drain();
    return promise;
  }

  async #drain() {
    if (this.writing) return;
    this.writing = true;
    while (this.pendingData) {
      const data = this.pendingData;
      this.pendingData = null;
      const resolvers = this.pendingResolvers;
      const rejecters = this.pendingRejecters;
      this.pendingResolvers = [];
      this.pendingRejecters = [];
      try {
        const contents = JSON.stringify(data, null, 2);
        await fs.mkdir(this.directory, { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, contents);
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(`${this.file}.tmp`, this.file); break; }
          catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        for (const r of resolvers) r();
      } catch (error) {
        for (const r of rejecters) r(error);
      }
    }
    this.writing = false;
  }
}

module.exports = { Store };
