'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 桌宠市场数据源（只读官方资产，不随 Harness Mix 分发）：
// - 官方预载：Codex Desktop 安装包 app.asar 内嵌的 *-spritesheet-vN-<hash>.webp，运行时按需提取；
// - 已安装：~/.codex/pets/<id>/{pet.json, spritesheet.webp}（官方 Pets 设置页读取同一目录）。
// 选择动作始终留给官方 Pets 设置页 / /pet 指令，Harness Mix 不代理账号级 accessory_id。

const PET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPRITESHEET_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)-spritesheet-v\d+-[0-9a-f]+\.webp$/;
const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024;

function titleCase(id) {
  if (id === 'bsod') return 'BSOD';
  return id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function petsDirectory(env = process.env) {
  return env.HARNESS_MIX_PETS_DIR || path.join(os.homedir(), '.codex', 'pets');
}

// CODEXHOST_STOCK_CODEX_PATH 指向安装包内的 codex CLI（win: <root>/app/resources/codex.exe，
// mac: <root>/Contents/Resources/codex），app.asar 与其同目录。Host 进程由 Shim 启动时该变量已注入；
// 缺失时按平台探测（Windows 走 AppX 查询，macOS 检查标准 .app 路径），结果进程内缓存。
let resolvedAsarPath;
function resolveAsarPath(env = process.env) {
  if (resolvedAsarPath !== undefined) return resolvedAsarPath;
  const candidates = [];
  if (typeof env.CODEXHOST_STOCK_CODEX_PATH === 'string' && env.CODEXHOST_STOCK_CODEX_PATH) {
    candidates.push(path.join(path.dirname(env.CODEXHOST_STOCK_CODEX_PATH), 'app.asar'));
  }
  if (typeof env.HARNESS_MIX_DESKTOP_APP === 'string' && env.HARNESS_MIX_DESKTOP_APP) {
    candidates.push(path.join(env.HARNESS_MIX_DESKTOP_APP, 'Contents', 'Resources', 'app.asar'));
  }
  resolvedAsarPath = candidates.find(file => fs.existsSync(file)) ?? null;
  if (resolvedAsarPath) return resolvedAsarPath;
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const root = execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], { encoding: 'utf8', windowsHide: true }).trim();
      if (root) resolvedAsarPath = [path.join(root, 'app', 'resources', 'app.asar')].find(file => fs.existsSync(file)) ?? null;
    } else if (process.platform === 'darwin') {
      resolvedAsarPath = ['/Applications/Codex.app', path.join(os.homedir(), 'Applications', 'Codex.app')]
        .map(app => path.join(app, 'Contents', 'Resources', 'app.asar'))
        .find(file => fs.existsSync(file)) ?? null;
    }
  } catch { /* 未安装或无权查询时按无官方源处理 */ }
  return resolvedAsarPath;
}

// 最小 asar 读取器：| u32:4 | u32:pickleSize | u32:jsonSizeField | u32:jsonSize | json | pad | blobs |
// blob 起始 = 8 + pickleSize（已用真实 Codex app.asar 的 RIFF/WEBP 魔数验证）
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error('asar header too short');
    const pickleSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) throw new Error('asar header JSON size out of range');
    const buffer = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, buffer, 0, jsonSize, 16) !== jsonSize) throw new Error('asar header JSON truncated');
    return { tree: JSON.parse(buffer.toString('utf8')), blobBase: 8 + pickleSize };
  } finally {
    fs.closeSync(fd);
  }
}

function assetEntries(header) {
  const files = header.tree?.files?.webview?.files?.assets?.files;
  return files && typeof files === 'object' ? files : {};
}

const CURATED_COMMUNITY_PETS = [
  {
    id: 'komi-shouko-pixel',
    displayName: '古见硝子·像素Q版',
    description: 'Pixel chibi Komi Shouko with long purple-black hair, a navy school uniform and shy gestures. Unofficial fan art.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789522011437/komi-shouko-pixel/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789522011437/komi-shouko-pixel/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789522011437/komi-shouko-pixel/poster.webp',
    source: 'community',
  },
  {
    id: 'rush',
    displayName: 'Rush',
    description: 'A confident training companion who meets every task with energy, focus, and a friendly smile.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789517766302/rush/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789517766302/rush/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789517766302/rush/poster.webp',
    source: 'community',
  },
  {
    id: 'itasca',
    displayName: 'Itasca',
    description: 'A cute cat with a larger-than-life personality who loves nothing more than attention, going outside, and his little toy worm.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789484963415/itasca/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789484963415/itasca/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789484963415/itasca/poster.webp',
    source: 'community',
  },
  {
    id: 'milk-mochi-soft',
    displayName: 'Milk Mochi (牛奶麻薯)',
    description: '말랑하게 걷고, 키보드로 일하고, 서류를 읽는 작은 우유떡 친구.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789458022939/milk-mochi-soft/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789458022939/milk-mochi-soft/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789458022939/milk-mochi-soft/poster.webp',
    source: 'community',
  },
  {
    id: 'yuanyuan',
    displayName: 'Yuanyuan (圆圆)',
    description: 'A black-and-white Jack Russell puppy with a red collar.',
    spriteVersionNumber: 1,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789465085706/yuanyuan/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789465085706/yuanyuan/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789465085706/yuanyuan/poster.webp',
    source: 'community',
  },
  {
    id: 'jaehyun-next-door',
    displayName: 'Jaehyun Next Door',
    description: 'An unofficial, fan-made desktop companion inspired by BOYNEXTDOOR Myung Jaehyun.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789469671052/jaehyun-next-door/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789469671052/jaehyun-next-door/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789469671052/jaehyun-next-door/poster.webp',
    source: 'community',
  },
  {
    id: 'iu-beside-you',
    displayName: 'IU Beside You',
    description: 'An unofficial, fan-made desktop companion inspired by IU.',
    spriteVersionNumber: 2,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789469620585/iu-beside-you/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789469620585/iu-beside-you/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789469620585/iu-beside-you/poster.webp',
    source: 'community',
  },
  {
    id: 'haaap',
    displayName: 'Haaap',
    description: '작업 중 바람을 계속 빨아들이는 분홍색 펫. 일반 동작 9개.',
    spriteVersionNumber: 1,
    spritesheetUrl: 'https://codex-pets.net/assets/pets/v/1789453516001/haaap/spritesheet.webp',
    previewUrl: 'https://codex-pets.net/assets/pets/v/1789453516001/haaap/preview.webp',
    posterUrl: 'https://codex-pets.net/assets/pets/v/1789453516001/haaap/poster.webp',
    source: 'community',
  },
];

function getProxyDispatcher(env = process.env) {
  const proxy = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;
  if (!proxy) return undefined;
  try {
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(proxy);
  } catch {
    return undefined;
  }
}

async function fetchWithProxy(url, options = {}, env = process.env) {
  const dispatcher = getProxyDispatcher(env);
  const opts = { ...options };
  if (dispatcher) opts.dispatcher = dispatcher;
  return fetch(url, opts);
}

function createPetMarket({ env = process.env } = {}) {
  const headerCache = new Map(); // asarPath -> { mtimeMs, header }
  const previewCache = new Map(); // cacheKey -> { mime, dataBase64 }

  function asarHeader() {
    const asarPath = resolveAsarPath(env);
    if (!asarPath) return null;
    const mtimeMs = fs.statSync(asarPath).mtimeMs;
    const cached = headerCache.get(asarPath);
    if (cached && cached.mtimeMs === mtimeMs) return { asarPath, header: cached.header };
    const header = readAsarHeader(asarPath);
    headerCache.set(asarPath, { mtimeMs, header });
    return { asarPath, header };
  }

  function officialPets() {
    const resolved = asarHeader();
    if (!resolved) return { asarPath: null, header: null, pets: [] };
    const pets = [];
    for (const [name, entry] of Object.entries(assetEntries(resolved.header))) {
      const match = name.match(SPRITESHEET_PATTERN);
      if (!match || entry?.unpacked === true) continue;
      const size = Number(entry.size);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_SPRITESHEET_BYTES) continue;
      const id = match[1];
      pets.push({
        id,
        displayName: titleCase(id),
        description: 'Codex 官方内置桌宠',
        source: 'official',
        spritesheet: { name, size, offset: String(entry.offset ?? '0') },
      });
    }
    pets.sort((a, b) => a.id.localeCompare(b.id));
    return { asarPath: resolved.asarPath, header: resolved.header, pets };
  }

  function installedPets() {
    const dir = petsDirectory(env);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const pets = [];
    for (const entry of names) {
      if (!entry.isDirectory() || !PET_ID_PATTERN.test(entry.name)) continue;
      const petJsonPath = path.join(dir, entry.name, 'pet.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(petJsonPath, 'utf8')); } catch { continue; }
      const spritesheet = typeof meta.spritesheetPath === 'string' && meta.spritesheetPath ? meta.spritesheetPath : 'spritesheet.webp';
      if (spritesheet.includes('..') || path.isAbsolute(spritesheet) || spritesheet.includes('/') || spritesheet.includes('\\')) continue;
      if (!fs.existsSync(path.join(dir, entry.name, spritesheet))) continue;
      pets.push({
        id: entry.name,
        displayName: typeof meta.displayName === 'string' && meta.displayName ? meta.displayName : titleCase(entry.name),
        description: typeof meta.description === 'string' ? meta.description : '',
        source: 'installed',
        spriteVersionNumber: meta.spriteVersionNumber || 1,
        spritesheet: { name: spritesheet },
      });
    }
    pets.sort((a, b) => a.id.localeCompare(b.id));
    return pets;
  }

  return {
    catalog() {
      const official = officialPets();
      const installed = installedPets();
      const installedIds = new Set(installed.map(pet => pet.id));
      const data = [
        ...installed,
        ...official.pets.filter(pet => !installedIds.has(pet.id)).map(pet => ({ ...pet, installed: false })),
        ...CURATED_COMMUNITY_PETS.filter(pet => !installedIds.has(pet.id) && !official.pets.some(o => o.id === pet.id)).map(pet => ({ ...pet, installed: false })),
      ];
      for (const pet of data) pet.installed = pet.installed ?? installedIds.has(pet.id);
      return {
        data,
        officialAvailable: official.asarPath !== null,
        petsDir: petsDirectory(env),
      };
    },

    async community({ page = 1, pageSize = 24, sort = 'trending', search = '' } = {}) {
      const installed = installedPets();
      const installedIds = new Set(installed.map(p => p.id));
      const queryParams = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sort: String(sort || 'trending'),
      });
      if (search && String(search).trim()) queryParams.set('search', String(search).trim());
      const apiUrl = `https://codex-pets.net/api/pets?${queryParams.toString()}`;
      try {
        const res = await fetchWithProxy(apiUrl, { signal: AbortSignal.timeout(8000) }, env);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pets = (json.pets || []).map(p => ({
          id: p.id,
          displayName: p.displayName || p.id,
          description: p.description || '',
          source: 'community',
          spriteVersionNumber: p.spriteVersionNumber || 1,
          spritesheetUrl: p.spritesheetUrl,
          previewUrl: p.previewUrl,
          posterUrl: p.posterUrl,
          downloadUrl: p.downloadUrl,
          installed: installedIds.has(p.id),
        }));
        return { data: pets, total: json.total || pets.length, source: 'online' };
      } catch {
        let filtered = CURATED_COMMUNITY_PETS;
        if (search && String(search).trim()) {
          const q = String(search).trim().toLowerCase();
          filtered = filtered.filter(p => p.id.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
        }
        return {
          data: filtered.map(p => ({ ...p, installed: installedIds.has(p.id) })),
          total: filtered.length,
          source: 'curated-fallback',
        };
      }
    },

    preview({ id } = {}) {
      if (!PET_ID_PATTERN.test(String(id || ''))) throw new Error('Invalid pet id');
      const cached = previewCache.get(id);
      if (cached) return cached;
      const local = installedPets().find(pet => pet.id === id);
      let buffer;
      if (local) {
        buffer = fs.readFileSync(path.join(petsDirectory(env), id, local.spritesheet.name));
      } else {
        const official = officialPets();
        const pet = official.pets.find(entry => entry.id === id);
        if (!pet) throw new Error(`Unknown pet: ${id}`);
        const fd = fs.openSync(official.asarPath, 'r');
        try {
          buffer = Buffer.alloc(pet.spritesheet.size);
          const position = official.header.blobBase + Number(pet.spritesheet.offset);
          if (fs.readSync(fd, buffer, 0, pet.spritesheet.size, position) !== pet.spritesheet.size) {
            throw new Error('Spritesheet truncated');
          }
        } finally {
          fs.closeSync(fd);
        }
      }
      if (buffer.length > MAX_SPRITESHEET_BYTES) throw new Error('Spritesheet too large');
      const result = { id, mime: 'image/webp', dataBase64: buffer.toString('base64') };
      previewCache.set(id, result);
      if (previewCache.size > 24) previewCache.delete(previewCache.keys().next().value);
      return result;
    },

    async install({ id, displayName, description, spritesheetUrl, spriteVersionNumber } = {}) {
      if (!PET_ID_PATTERN.test(String(id || ''))) throw new Error('Invalid pet id');
      const targetDir = path.join(petsDirectory(env), id);
      const petJsonPath = path.join(targetDir, 'pet.json');
      const spritesheetPath = path.join(targetDir, 'spritesheet.webp');
      if (fs.existsSync(petJsonPath) && fs.existsSync(spritesheetPath)) {
        return { id, path: targetDir, installed: true, alreadyInstalled: true };
      }

      const curated = CURATED_COMMUNITY_PETS.find(p => p.id === id);
      const targetUrl = spritesheetUrl || curated?.spritesheetUrl;
      const targetName = displayName || curated?.displayName || titleCase(id);
      const targetDesc = description !== undefined ? description : (curated?.description || '');
      const targetVer = spriteVersionNumber || curated?.spriteVersionNumber || 1;

      let buffer;
      if (targetUrl) {
        const res = await fetchWithProxy(targetUrl, { signal: AbortSignal.timeout(30000) }, env);
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const arrayBuf = await res.arrayBuffer();
        buffer = Buffer.from(arrayBuf);
      } else {
        const official = officialPets();
        const pet = official.pets.find(entry => entry.id === id);
        if (!pet) throw new Error(official.asarPath ? `桌宠 ${id} 不在官方预载目录中` : '未找到 Codex Desktop 安装，无法获取官方桌宠');
        const fd = fs.openSync(official.asarPath, 'r');
        try {
          buffer = Buffer.alloc(pet.spritesheet.size);
          const position = official.header.blobBase + Number(pet.spritesheet.offset);
          if (fs.readSync(fd, buffer, 0, pet.spritesheet.size, position) !== pet.spritesheet.size) {
            throw new Error('Spritesheet truncated');
          }
        } finally {
          fs.closeSync(fd);
        }
      }

      if (buffer.length > MAX_SPRITESHEET_BYTES) throw new Error('Spritesheet too large');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(spritesheetPath, buffer);
      fs.writeFileSync(petJsonPath, `${JSON.stringify({
        id,
        displayName: targetName,
        description: targetDesc,
        spriteVersionNumber: targetVer,
        spritesheetPath: 'spritesheet.webp',
      }, null, 2)}\n`);
      previewCache.delete(id);
      return { id, path: targetDir, installed: true, alreadyInstalled: false };
    },

    uninstall({ id } = {}) {
      if (!PET_ID_PATTERN.test(String(id || ''))) throw new Error('Invalid pet id');
      const root = petsDirectory(env);
      const targetDir = path.join(root, id);
      if (path.relative(root, targetDir).startsWith('..')) throw new Error('Invalid pet directory');
      if (!fs.existsSync(targetDir)) return { id, removed: false };
      fs.rmSync(targetDir, { recursive: true, force: true });
      previewCache.delete(id);
      return { id, removed: true };
    },
  };
}

module.exports = { createPetMarket, petsDirectory, resolveAsarPath, readAsarHeader, CURATED_COMMUNITY_PETS };
