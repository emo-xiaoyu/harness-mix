const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 10 * 1024 * 1024;
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Convert Desktop input into the existing native adapter attachment contract.
async function prepareInput(input = [], cwd = process.cwd()) {
  if (!Array.isArray(input)) throw new Error('Invalid native input');
  const texts = [], attachments = [];
  for (const item of input) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text);
      continue;
    }
    if (!['localImage', 'image'].includes(item?.type)) throw new Error(`Unsupported native input type: ${item?.type}`);
    if (attachments.length >= 6) throw new Error('一次最多携带 6 个附件');
    let data, mime, name, sourcePath;
    if (item.type === 'localImage') {
      if (typeof item.path !== 'string' || !item.path) throw new Error('图片缺少本地路径');
      sourcePath = path.resolve(cwd, item.path);
      name = path.basename(sourcePath);
      mime = mimeTypes[path.extname(name).toLowerCase()];
      if (!mime) throw new Error(`不支持的图片格式：${name}`);
      const file = await fs.open(sourcePath, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`图片「${name}」必须是 10MB 以内的文件`);
        data = (await file.readFile()).toString('base64');
      } finally { await file.close(); }
    } else {
      const match = typeof item.url === 'string' && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
      if (!match) throw new Error('图片需要本地文件或 PNG/JPEG/GIF/WebP base64 数据');
      [, mime, data] = match;
      name = `image-${attachments.length + 1}.${mime.split('/')[1]}`;
    }
    if (!data || data.length > Math.ceil(MAX_BYTES / 3) * 4 || Buffer.from(data, 'base64').length > MAX_BYTES) throw new Error(`图片「${name}」为空或超过 10MB 上限`);
    attachments.push({ kind: 'image', name, mime, data, size: Buffer.from(data, 'base64').length, ...(sourcePath ? { path: sourcePath } : {}) });
  }
  return { text: texts.join('\n'), attachments };
}

module.exports = { prepareInput };
