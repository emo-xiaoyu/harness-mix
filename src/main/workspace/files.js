const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const OMIT = /^(node_modules|\.git|\.venv|venv|dist|build|output|__pycache__|\.next|\.idea)$/i;
const PRIVATE = /(^\.env($|\.)|^\.ssh$|^\.aws$|credentials|secrets?|^auth\.json$|^settings\.json$|^id_rsa|\.(pem|key|pfx|p12)$)/i;
const hash = data => createHash('sha256').update(data).digest('hex');
const inside = (root, target) => { const relative = path.relative(root, target); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

async function resolveFile(root, relative = '') {
  root = await fs.realpath(root);
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':')) throw Error('仅允许项目内相对路径');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw Error('路径超出项目范围');
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    if (PRIVATE.test(part) || OMIT.test(part)) throw Error('该路径不参与桌面文件预览与快照');
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw Error('不跟随符号链接或目录联接'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}

async function readText(root, relative) {
  const target = await resolveFile(root, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('仅预览 1 MB 以内文本文件');
  const buffer = await fs.readFile(target);
  const text = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(text).equals(buffer)) throw Error('二进制或非 UTF-8 文件不参与预览');
  return { text, hash: hash(buffer), mode: stat.mode };
}

async function list(root, relative = '') {
  const entries = await fs.readdir(await resolveFile(root, relative), { withFileTypes: true });
  return entries.filter(e => !e.isSymbolicLink() && !OMIT.test(e.name) && !PRIVATE.test(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 1500).map(e => ({ name: e.name, path: path.join(relative, e.name), directory: e.isDirectory() }));
}

async function snapshot(root) {
  const names = [], files = Object.create(null), skipped = [];
  let bytes = 0, entries = 0;
  async function walk(relative) {
    const all = await fs.readdir(await resolveFile(root, relative), { withFileTypes: true });
    for (const entry of all) {
      if (++entries > 15000) throw Error('项目超过 15,000 个目录项，未建立完整快照');
      if (OMIT.test(entry.name) || PRIVATE.test(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        names.push(file);
        try {
          const value = await readText(root, file);
          bytes += Buffer.byteLength(value.text);
          if (bytes > 24 * 1024 * 1024) throw Error('快照超过 24 MB');
          files[file] = value;
        } catch (e) { skipped.push(file); }
      }
    }
  }
  await walk('');
  return { names, files, skipped };
}
module.exports = { resolveFile, readText, list, snapshot, hash };
