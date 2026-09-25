'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 桌宠市场数据源（只读官方资产，不随 Harness Mix 分发）：
// - 官方预载：Codex Desktop 安装包 app.asar 内嵌的 *-spritesheet-vN-<hash>.webp，运行时按需提取；
// - 已安装：~/.codex/pets/<id>/{pet.json, spritesheet.webp}（官方 Pets 设置页读取同一目录）。
// 账号级 accessory_id 始终留给官方 Pets 设置页 / /pet 指令，Harness Mix 不代理账号 API；
// Harness Mix 自己的选择状态（selection/select）是数据目录下的本地 JSON，只驱动 Harness Mix 自有展示面。

const PET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPRITESHEET_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)-spritesheet-v\d+-[0-9a-f]+\.webp$/;
const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024;
const WEBP_MIN_BYTES = 12; // RIFF(4) + size(4) + WEBP(4)
const TEMP_DIR_MAX_AGE_MS = 10 * 60 * 1000; // 超过该年龄的 .tmp-*/.bak-* 视为崩溃残留
const RENAME_RETRY_DELAYS_MS = [0, 80, 160, 320, 640]; // Windows 上目录被占用时 rename 可能 EPERM/EBUSY，做有限重试

function titleCase(id) {
  if (id === 'bsod') return 'BSOD';
  return id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function petsDirectory(env = process.env) {
  return env.HARNESS_MIX_PETS_DIR || path.join(os.homedir(), '.codex', 'pets');
}

// 桌宠选择是 Harness Mix 本地状态（不是账号级 accessory_id），持久化在数据目录下的小 JSON 里
function harnessMixDataDirectory(env = process.env) {
  return env.HARNESSMIX_DATA_DIR || path.join(os.homedir(), '.harness-mix');
}

function petSelectionFile(env = process.env) {
  return path.join(harnessMixDataDirectory(env), 'pet-selection.json');
}

// HARNESSMIX_STOCK_CODEX_PATH 指向安装包内的 codex CLI（win: <root>/app/resources/codex.exe，
// mac: <root>/Contents/Resources/codex），app.asar 与其同目录。Host 进程由 Shim 启动时该变量已注入；
// 缺失时按平台探测（Windows 走 AppX 查询，macOS 检查标准 .app 路径），结果进程内缓存。
let resolvedAsarPath;
function resolveAsarPath(env = process.env) {
  if (resolvedAsarPath !== undefined) return resolvedAsarPath;
  const candidates = [];
  if (typeof env.HARNESSMIX_STOCK_CODEX_PATH === 'string' && env.HARNESSMIX_STOCK_CODEX_PATH) {
    candidates.push(path.join(path.dirname(env.HARNESSMIX_STOCK_CODEX_PATH), 'app.asar'));
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

// WebP 容器魔数：bytes 0-3 = 'RIFF'，bytes 8-11 = 'WEBP'
function isWebpBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= WEBP_MIN_BYTES
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP';
}

// pet.json 最小必需字段：id（与目录一致）、displayName、spriteVersionNumber、安全的 spritesheetPath
function validatePetMetadata(meta, expectedId) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('pet.json metadata must be an object');
  if (meta.id !== expectedId || !PET_ID_PATTERN.test(String(meta.id))) throw new Error(`pet.json id mismatch for "${expectedId}"`);
  if (typeof meta.displayName !== 'string' || !meta.displayName.trim()) throw new Error('pet.json requires a non-empty displayName');
  if (meta.description !== undefined && typeof meta.description !== 'string') throw new Error('pet.json description must be a string');
  if (!Number.isInteger(meta.spriteVersionNumber) || meta.spriteVersionNumber < 1) throw new Error('pet.json requires a positive integer spriteVersionNumber');
  const sheet = meta.spritesheetPath;
  if (typeof sheet !== 'string' || !sheet || sheet.includes('..') || path.isAbsolute(sheet) || sheet.includes('/') || sheet.includes('\\')) {
    throw new Error('pet.json spritesheetPath must be a plain file name');
  }
  return meta;
}

// 安装目录必须始终解析在 pets 根目录内（PET_ID_PATTERN 已拒绝 .. / 斜杠 / 绝对路径，这里做纵深防御）
function resolvePetDir(root, id) {
  const targetDir = path.join(root, id);
  const relative = path.relative(root, targetDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid pet directory');
  return targetDir;
}

// 清理崩溃残留的 .tmp-* / .bak-* 目录（只动超过 maxAgeMs 的，避免误删其他进程正在进行的安装）
function sweepStaleArtifacts(root, { maxAgeMs = TEMP_DIR_MAX_AGE_MS, now = Date.now() } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('.tmp-') && !entry.name.startsWith('.bak-')) continue;
    const full = path.join(root, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* best effort：清理失败不影响主流程 */ }
  }
}

async function renameWithRetry(from, to) {
  let lastError;
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (!err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
    }
  }
  throw lastError;
}

function createPetMarket({ env = process.env } = {}) {
  const headerCache = new Map(); // asarPath -> { mtimeMs, header }
  const previewCache = new Map(); // cacheKey -> { mime, dataBase64 }
  const pendingOperations = new Map(); // pet id -> 'install' | 'uninstall'

  // 同一 pet 的并发安装/卸载互斥（Host 端兜底，renderer 另有按钮禁用）
  function claimOperation(id, op) {
    const running = pendingOperations.get(id);
    if (running) throw new Error(`Cannot ${op} pet ${id}: ${running} already in progress`);
    pendingOperations.set(id, op);
  }

  function releaseOperation(id) {
    pendingOperations.delete(id);
  }

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

  // 可选中的宠物：已安装或官方预载（选择状态只是 Harness Mix 本地展示状态，不要求已安装）
  function findSelectablePet(id) {
    const installed = installedPets().find(pet => pet.id === id);
    if (installed) return installed;
    return officialPets().pets.find(pet => pet.id === id) ?? null;
  }

  // 读取持久化的选择；文件缺失/损坏/id 非法一律视为无选择
  function readPersistedSelection() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(petSelectionFile(env), 'utf8')); } catch { return null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || !PET_ID_PATTERN.test(raw.id)) return null;
    const displayName = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : titleCase(raw.id);
    const spriteVersionNumber = Number.isInteger(raw.spriteVersionNumber) && raw.spriteVersionNumber >= 1 ? raw.spriteVersionNumber : undefined;
    return { id: raw.id, displayName, spriteVersionNumber };
  }

  // 原子写入（tmp + rename，与 config.js 的 saveNativeSettings 一致）；selection 为 null 表示清除
  function writePersistedSelection(selection) {
    const dir = harnessMixDataDirectory(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = petSelectionFile(env);
    const payload = selection
      ? { id: selection.id, displayName: selection.displayName, spriteVersionNumber: selection.spriteVersionNumber, selectedAt: new Date().toISOString() }
      : { id: null, selectedAt: new Date().toISOString() };
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
    try {
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      // rename 失败（如文件占用）时清理暂存文件，避免数据目录残留 .tmp
      try { fs.rmSync(`${file}.tmp`, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  }

  // 选择结果的渲染描述：id + displayName + spriteVersionNumber，调用方无需二次查询即可渲染
  function describeSelection(pet) {
    return { id: pet.id, displayName: pet.displayName, spriteVersionNumber: pet.spriteVersionNumber ?? 2 };
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
      const root = petsDirectory(env);
      const targetDir = resolvePetDir(root, id);
      const petJsonPath = path.join(targetDir, 'pet.json');
      const spritesheetPath = path.join(targetDir, 'spritesheet.webp');
      claimOperation(id, 'install');
      try {
        if (fs.existsSync(petJsonPath) && fs.existsSync(spritesheetPath)) {
          return { id, path: targetDir, installed: true, alreadyInstalled: true };
        }

        const curated = CURATED_COMMUNITY_PETS.find(p => p.id === id);
        const targetUrl = spritesheetUrl || curated?.spritesheetUrl;
        // 先构造并校验 pet.json 元数据，字段不合法直接拒绝，不产生任何文件
        const metadata = validatePetMetadata({
          id,
          displayName: displayName || curated?.displayName || titleCase(id),
          description: description !== undefined ? description : (curated?.description || ''),
          spriteVersionNumber: spriteVersionNumber || curated?.spriteVersionNumber || 1,
          spritesheetPath: 'spritesheet.webp',
        }, id);

        // 1) 获取精灵图字节：社区走 HTTPS 下载，官方从 app.asar 按需提取
        let buffer;
        if (targetUrl) {
          const res = await fetchWithProxy(targetUrl, { signal: AbortSignal.timeout(30000) }, env);
          if (!res.ok) throw new Error(`Download failed (${res.status})`);
          const lengthHeader = res.headers.get('content-length');
          const declaredLength = lengthHeader !== null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : null;
          if (declaredLength !== null && declaredLength > MAX_SPRITESHEET_BYTES) {
            try { await res.body?.cancel(); } catch { /* 中断下载失败可忽略 */ }
            throw new Error(`Spritesheet too large (${declaredLength} bytes)`);
          }
          buffer = Buffer.from(await res.arrayBuffer());
          if (declaredLength !== null && buffer.length !== declaredLength) {
            throw new Error(`Download incomplete (${buffer.length}/${declaredLength} bytes)`);
          }
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

        // 2) 资源校验：大小上限 + WebP 签名（RIFF....WEBP）
        if (buffer.length > MAX_SPRITESHEET_BYTES) throw new Error('Spritesheet too large');
        if (!isWebpBuffer(buffer)) throw new Error('Invalid spritesheet: missing RIFF/WEBP signature');

        // 3) 写入 pets 根目录下的同级临时目录（同盘，保证 rename 可用）
        fs.mkdirSync(root, { recursive: true });
        sweepStaleArtifacts(root);
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const stagingDir = path.join(root, `.tmp-${id}-${token}`);
        fs.mkdirSync(stagingDir, { recursive: true });
        try {
          fs.writeFileSync(path.join(stagingDir, 'spritesheet.webp'), buffer);
          fs.writeFileSync(path.join(stagingDir, 'pet.json'), `${JSON.stringify(metadata, null, 2)}\n`);

          // 4) 回读校验临时目录：pet.json 可解析且字段齐全，精灵图大小/签名与下载内容一致
          const writtenMeta = JSON.parse(fs.readFileSync(path.join(stagingDir, 'pet.json'), 'utf8'));
          validatePetMetadata(writtenMeta, id);
          const writtenSheet = fs.readFileSync(path.join(stagingDir, 'spritesheet.webp'));
          if (writtenSheet.length !== buffer.length || !isWebpBuffer(writtenSheet)) {
            throw new Error('Staged spritesheet verification failed');
          }

          // 5) 原子切换：旧目录先移为备份，再 rename 临时目录为正式目录；失败回滚旧版本
          const backupDir = fs.existsSync(targetDir) ? path.join(root, `.bak-${id}-${token}`) : null;
          try {
            if (backupDir) await renameWithRetry(targetDir, backupDir);
            try {
              await renameWithRetry(stagingDir, targetDir);
            } catch (swapError) {
              if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
                try {
                  await renameWithRetry(backupDir, targetDir);
                } catch (rollbackError) {
                  throw new Error(`Install swap failed (${swapError.message}); rollback also failed (${rollbackError.message})`);
                }
              }
              throw swapError;
            }
          } finally {
            if (backupDir) {
              try { fs.rmSync(backupDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 旧版本清理失败不影响安装结果 */ }
            }
          }
        } catch (err) {
          // 任何一步失败都清理临时目录；正式目录只在全部校验通过后才被替换
          try { fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
          throw err;
        }
        previewCache.delete(id);
        return { id, path: targetDir, installed: true, alreadyInstalled: false };
      } finally {
        releaseOperation(id);
      }
    },

    uninstall({ id } = {}) {
      if (!PET_ID_PATTERN.test(String(id || ''))) throw new Error('Invalid pet id');
      const root = petsDirectory(env);
      const targetDir = resolvePetDir(root, id);
      claimOperation(id, 'uninstall');
      try {
        sweepStaleArtifacts(root);
        if (!fs.existsSync(targetDir)) return { id, removed: false };
        fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (fs.existsSync(targetDir)) throw new Error(`Failed to remove pet directory: ${targetDir}`);
        previewCache.delete(id);
        // 卸载当前选中的桌宠时自动清除选择，避免悬空的过期选择
        const persisted = readPersistedSelection();
        if (persisted && persisted.id === id) writePersistedSelection(null);
        return { id, removed: true };
      } finally {
        releaseOperation(id);
      }
    },

    // 当前 Harness Mix 桌宠选择；持久化的选择指向已不可用的宠物时按无选择处理（过期容忍）
    selection() {
      const persisted = readPersistedSelection();
      if (!persisted) return { id: null };
      const pet = findSelectablePet(persisted.id);
      if (!pet) return { id: null };
      return describeSelection(pet);
    },

    // 设置/清除选择：{ id } 选中（必须已安装或为官方预载），{ id: null } 清除
    select({ id } = {}) {
      if (id === null || id === undefined) {
        writePersistedSelection(null);
        return { id: null };
      }
      if (!PET_ID_PATTERN.test(String(id))) throw new Error('Invalid pet id');
      const pet = findSelectablePet(id);
      if (!pet) throw new Error(`Unknown pet: ${id}`);
      const selection = describeSelection(pet);
      writePersistedSelection(selection);
      return selection;
    },
  };
}

module.exports = { createPetMarket, readAsarHeader, isWebpBuffer, validatePetMetadata };
