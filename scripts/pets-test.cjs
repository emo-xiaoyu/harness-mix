'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createPetMarket,
  readAsarHeader,
  isWebpBuffer,
  validatePetMetadata,
  parseWindowsProxySettings,
  isLoopbackTarget,
  CURATED_COMMUNITY_PETS,
  PET_ID_PATTERN,
} = require('../src/main/native/pets');

function buildSyntheticAsar(targetPath, petNames, blobContent) {
  const names = Array.isArray(petNames) ? petNames : [petNames];
  const tree = {
    files: {
      webview: {
        files: {
          assets: {
            files: {},
          },
        },
      },
    },
  };
  for (const name of names) {
    tree.files.webview.files.assets.files[`${name}-spritesheet-v1-0123456789abcdef.webp`] = {
      size: blobContent.length,
      offset: '0',
    };
  }
  const jsonBuf = Buffer.from(JSON.stringify(tree), 'utf8');
  const jsonLen = jsonBuf.length;
  const padLen = (4 - (jsonLen % 4)) % 4;
  const pickleSize = 8 + jsonLen + padLen;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickleSize, 4);
  head.writeUInt32LE(jsonLen + 4, 8);
  head.writeUInt32LE(jsonLen, 12);
  const asarBuf = Buffer.concat([head, jsonBuf, Buffer.alloc(padLen), blobContent]);
  fs.writeFileSync(targetPath, asarBuf);
}

// 合法 WebP 容器头：RIFF + size + WEBP + VP8 块
function webpPayload(label) {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x20, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 ', 'latin1'),
    Buffer.from(`--${label}--`, 'latin1'),
  ]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-pets-test-'));
  const fakeAsarDir = path.join(testRoot, 'resources');
  fs.mkdirSync(fakeAsarDir, { recursive: true });
  const fakeAsarPath = path.join(fakeAsarDir, 'app.asar');
  const fakeCodexBin = path.join(fakeAsarDir, 'codex.exe');
  fs.writeFileSync(fakeCodexBin, '');

  const fakeSpriteBlob = Buffer.from('RIFF....WEBPVP8 ...fake-sprite-data...', 'utf8');
  // 同一个 asar 里放两只官方桌宠：synthetic-buddy 走常规流程，
  // rush 与内置清单里的社区桌宠撞 id，用来验证「原生自带优先、社区副本去重」
  buildSyntheticAsar(fakeAsarPath, ['synthetic-buddy', 'rush'], fakeSpriteBlob);

  const petsDir = path.join(testRoot, 'installed-pets');
  fs.mkdirSync(petsDir, { recursive: true });

  const env = {
    HARNESSMIX_STOCK_CODEX_PATH: fakeCodexBin,
    HARNESS_MIX_PETS_DIR: petsDir,
    HARNESSMIX_DATA_DIR: path.join(testRoot, 'data-dir'),
    // 显式禁用系统代理回落：测试永远不读宿主机的 WinINET 注册表
    HARNESS_MIX_SYSTEM_PROXY: 'none',
  };
  const selectionFile = path.join(env.HARNESSMIX_DATA_DIR, 'pet-selection.json');

  // 本地 HTTP 服务器模拟社区下载源，覆盖 成功/500/坏签名/超大/截断/慢响应 场景
  const communityQueries = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/pets') {
      // 在线社区接口 mock：记录出站查询串，返回两条在线数据
      communityQueries.push(url.searchParams.toString());
      const body = JSON.stringify({
        pets: [
          { id: 'guga', displayName: '咕嘎', description: 'online guga', spriteVersionNumber: 1, spritesheetUrl: 'https://example.com/guga.webp', previewUrl: 'https://example.com/guga-preview.webp', posterUrl: 'https://example.com/guga-poster.webp' },
          { id: 'community-pet', displayName: 'Community Pet', description: '', spriteVersionNumber: 1, spritesheetUrl: 'https://example.com/cp.webp' },
        ],
        total: 2,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (url.pathname === '/ok.webp') {
      const body = webpPayload('community');
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (url.pathname === '/bad-sig.webp') {
      const body = Buffer.from('NOT-A-REAL-WEBP-PAYLOAD', 'latin1');
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (url.pathname === '/huge.webp') {
      // 声明 64MB，应在读取 body 前被 content-length 预检拦截
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': 64 * 1024 * 1024 });
      res.end(webpPayload('huge'));
      return;
    }
    if (url.pathname === '/truncated.webp') {
      // 声明长度大于实际发送：客户端应下载失败
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': 1000 });
      try {
        res.end(Buffer.from('RIFF....WEBP', 'latin1'));
      } catch {
        res.destroy();
      }
      return;
    }
    if (url.pathname === '/slow.webp') {
      setTimeout(() => {
        const body = webpPayload('slow');
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': body.length });
        res.end(body);
      }, 300);
      return;
    }
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // 主 market 的社区接口指向必 500 的路径：所有 community() 调用走本地收录回落，测试不触网
  env.HARNESS_MIX_PETS_API = `${baseUrl}/community-down`;

  const leftoverArtifacts = () =>
    fs.readdirSync(petsDir).filter(name => name.startsWith('.tmp-') || name.startsWith('.bak-'));

  try {
    // 1. Verify readAsarHeader
    const asarInfo = readAsarHeader(fakeAsarPath);
    assert.ok(asarInfo.blobBase > 16, 'asar blobBase should be past header');
    const assetFiles = asarInfo.tree?.files?.webview?.files?.assets?.files;
    assert.ok(assetFiles && typeof assetFiles === 'object', 'asset tree found');

    // 2. Test createPetMarket catalog()
    const market = createPetMarket({ env });
    const catalog = market.catalog();
    assert.equal(catalog.officialAvailable, true, 'synthetic asar should be available');
    assert.equal(catalog.petsDir, petsDir, 'petsDir matches env override');

    const officialPet = catalog.data.find(p => p.id === 'synthetic-buddy');
    assert.ok(officialPet, 'synthetic-buddy should be present in catalog');
    assert.equal(officialPet.source, 'official');
    assert.equal(officialPet.installed, false);
    assert.equal(officialPet.displayName, 'Synthetic Buddy');

    // Curated community pets should also be listed
    const curatedSample = catalog.data.find(p => p.id === 'komi-shouko-pixel');
    assert.ok(curatedSample, 'curated community pet komi-shouko-pixel should be present');
    assert.equal(curatedSample.installed, false);

    // 2b. 原生自带去重：官方预载里也有 rush（与内置清单同 id）时，目录中只出现一次且按 official 归类
    const rushEntries = catalog.data.filter(p => p.id === 'rush');
    assert.equal(rushEntries.length, 1, 'pet colliding with official preload must appear exactly once');
    assert.equal(rushEntries[0].source, 'official', 'official preload wins over the curated community copy');

    // 2c. 内置收录清单结构校验：id 合法且唯一、字段齐全、直链全部指向 codex-pets.net CDN，
    // 且不包含官方预载（原生自带）桌宠 id
    const OFFICIAL_PRELOAD_IDS = new Set([
      'bsod', 'codex', 'dewey', 'fireball', 'hoots', 'null-signal', 'rocky', 'seedy', 'stacky',
    ]);
    const seenCuratedIds = new Set();
    for (const pet of CURATED_COMMUNITY_PETS) {
      assert.ok(PET_ID_PATTERN.test(pet.id), `curated pet id must be valid: ${pet.id}`);
      assert.ok(!seenCuratedIds.has(pet.id), `curated pet id must be unique: ${pet.id}`);
      seenCuratedIds.add(pet.id);
      assert.ok(!OFFICIAL_PRELOAD_IDS.has(pet.id), `curated list must not include official preload pet: ${pet.id}`);
      assert.equal(pet.source, 'community');
      assert.ok(typeof pet.displayName === 'string' && pet.displayName.trim(), `curated pet needs displayName: ${pet.id}`);
      assert.ok(Number.isInteger(pet.spriteVersionNumber) && pet.spriteVersionNumber >= 1, `curated pet needs spriteVersionNumber: ${pet.id}`);
      for (const field of ['spritesheetUrl', 'previewUrl', 'posterUrl']) {
        assert.ok(
          typeof pet[field] === 'string' && /^https:\/\/codex-pets\.net\/assets\/pets\//.test(pet[field]),
          `curated pet ${field} must be a codex-pets.net asset URL: ${pet.id}`,
        );
      }
    }
    assert.ok(CURATED_COMMUNITY_PETS.length >= 20, 'curated builtin list should stay populated');

    // 3. Test preview() for official pet
    const previewRes = market.preview({ id: 'synthetic-buddy' });
    assert.equal(previewRes.id, 'synthetic-buddy');
    assert.equal(previewRes.mime, 'image/webp');
    const previewBuf = Buffer.from(previewRes.dataBase64, 'base64');
    assert.equal(previewBuf.toString('utf8'), fakeSpriteBlob.toString('utf8'), 'preview base64 should match sprite blob');

    // Invalid pet id checks
    assert.throws(() => market.preview({ id: '../bad-pet' }), /Invalid pet id/);
    assert.throws(() => market.preview({ id: 'non-existent-pet' }), /Unknown pet/);

    // 4. Test install() of official pet（原子流程：临时目录 -> 校验 -> 切换）
    const installRes = await market.install({ id: 'synthetic-buddy' });
    assert.equal(installRes.id, 'synthetic-buddy');
    assert.equal(installRes.installed, true);
    assert.equal(installRes.alreadyInstalled, false);

    const installedDir = path.join(petsDir, 'synthetic-buddy');
    assert.ok(fs.existsSync(installedDir), 'pet directory created');
    const petJsonPath = path.join(installedDir, 'pet.json');
    const petSpritePath = path.join(installedDir, 'spritesheet.webp');
    assert.ok(fs.existsSync(petJsonPath), 'pet.json exists');
    assert.ok(fs.existsSync(petSpritePath), 'spritesheet.webp exists');
    assert.deepEqual(leftoverArtifacts(), [], 'no staging/backup dirs left after official install');

    const meta = JSON.parse(fs.readFileSync(petJsonPath, 'utf8'));
    assert.equal(meta.id, 'synthetic-buddy');
    assert.equal(meta.displayName, 'Synthetic Buddy');
    assert.equal(meta.spritesheetPath, 'spritesheet.webp');

    // Installing again should be a no-op returning alreadyInstalled: true
    const reinstallRes = await market.install({ id: 'synthetic-buddy' });
    assert.equal(reinstallRes.alreadyInstalled, true);

    // Catalog should now reflect installed: true
    const updatedCatalog = market.catalog();
    const installedEntry = updatedCatalog.data.find(p => p.id === 'synthetic-buddy');
    assert.ok(installedEntry, 'installed pet present');
    assert.equal(installedEntry.installed, true);
    assert.equal(installedEntry.source, 'installed');

    // 5. Test community() fallback and search（mock 接口 500，回落到内置收录清单）
    const communityRes = await market.community({ search: 'komi' });
    assert.ok(communityRes.total >= 1);
    assert.equal(communityRes.data[0].id, 'komi-shouko-pixel');

    // 6. Test uninstall()
    const uninstallRes = market.uninstall({ id: 'synthetic-buddy' });
    assert.equal(uninstallRes.id, 'synthetic-buddy');
    assert.equal(uninstallRes.removed, true);
    assert.ok(!fs.existsSync(installedDir), 'pet directory should be deleted');

    // Calling uninstall again should return removed: false
    const uninstallAgain = market.uninstall({ id: 'synthetic-buddy' });
    assert.equal(uninstallAgain.removed, false);

    // Catalog after uninstall reflects installed: false
    const catalogAfterUninstall = market.catalog();
    const uninstalledEntry = catalogAfterUninstall.data.find(p => p.id === 'synthetic-buddy');
    assert.equal(uninstalledEntry.installed, false);

    // 7. 社区下载安装成功路径（本地 HTTP 源），安装后无临时/备份目录残留
    const communityInstall = await market.install({
      id: 'community-pet',
      displayName: 'Community Pet',
      spritesheetUrl: `${baseUrl}/ok.webp`,
    });
    assert.equal(communityInstall.installed, true);
    assert.equal(communityInstall.alreadyInstalled, false);
    const communityDir = path.join(petsDir, 'community-pet');
    assert.ok(fs.existsSync(path.join(communityDir, 'pet.json')));
    assert.ok(fs.existsSync(path.join(communityDir, 'spritesheet.webp')));
    const communityMeta = JSON.parse(fs.readFileSync(path.join(communityDir, 'pet.json'), 'utf8'));
    assert.equal(communityMeta.displayName, 'Community Pet');
    assert.equal(communityMeta.spriteVersionNumber, 1);
    assert.deepEqual(leftoverArtifacts(), [], 'no staging/backup dirs left after community install');

    // 7b. community() 在线路径：mock 接口返回的数据被映射，已安装的 id 带 installed 标记；
    // 出站参数被清洗（trending 已下线回落 popular，pageSize 钳到接口上限，page 不小于 1）
    const onlineMarket = createPetMarket({ env: { ...env, HARNESS_MIX_PETS_API: `${baseUrl}/api/pets` } });
    const onlineRes = await onlineMarket.community({ sort: 'trending', pageSize: 500, page: 0 });
    assert.equal(onlineRes.source, 'online');
    assert.equal(onlineRes.total, 2);
    const onlineGuga = onlineRes.data.find(p => p.id === 'guga');
    assert.equal(onlineGuga.displayName, '咕嘎');
    assert.equal(onlineGuga.description, 'online guga');
    assert.equal(onlineGuga.source, 'community');
    assert.equal(onlineGuga.installed, false);
    assert.equal(onlineGuga.spritesheetUrl, 'https://example.com/guga.webp');
    const onlineInstalled = onlineRes.data.find(p => p.id === 'community-pet');
    assert.equal(onlineInstalled.installed, true, 'online listing marks locally installed pets');
    assert.equal(communityQueries.length, 1);
    const outbound = new URLSearchParams(communityQueries[0]);
    assert.equal(outbound.get('sort'), 'popular', 'invalid sort must be sanitized to popular');
    assert.equal(outbound.get('pageSize'), '60', 'pageSize must be clamped to the API cap');
    assert.equal(outbound.get('page'), '1', 'page must be clamped to >= 1');

    // 7c. 环回保护：HTTPS_PROXY 指向必然不通的死代理时，127.0.0.1 上的 mock 下载依然成功
    //（环回目标永不走代理；若误走死代理，这里会以 fetch failed 失败）
    const deadProxyEnv = {
      ...env,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HARNESS_MIX_PETS_API: `${baseUrl}/api/pets`,
    };
    const loopbackMarket = createPetMarket({ env: deadProxyEnv });
    const loopbackInstall = await loopbackMarket.install({
      id: 'loopback-pet',
      displayName: 'Loopback Pet',
      spritesheetUrl: `${baseUrl}/ok.webp`,
    });
    assert.equal(loopbackInstall.installed, true, 'loopback downloads bypass the configured proxy');
    const loopbackCommunity = await loopbackMarket.community({});
    assert.equal(loopbackCommunity.source, 'online', 'loopback community API bypasses the configured proxy');
    loopbackMarket.uninstall({ id: 'loopback-pet' });

    // 8. 下载失败（HTTP 500）：拒绝安装且不留下任何目录
    await assert.rejects(
      market.install({ id: 'dl-fail-pet', spritesheetUrl: `${baseUrl}/missing.webp` }),
      /Download failed \(500\)/,
    );
    assert.ok(!fs.existsSync(path.join(petsDir, 'dl-fail-pet')), 'failed install must not leave a pet dir');
    assert.deepEqual(leftoverArtifacts(), [], 'download failure must not leave staging dirs');

    // 9. 校验失败：坏 WebP 签名
    await assert.rejects(
      market.install({ id: 'bad-sig-pet', spritesheetUrl: `${baseUrl}/bad-sig.webp` }),
      /RIFF\/WEBP signature/,
    );
    assert.ok(!fs.existsSync(path.join(petsDir, 'bad-sig-pet')));
    assert.deepEqual(leftoverArtifacts(), [], 'signature failure must not leave staging dirs');

    // 10. 校验失败：content-length 超过大小上限（预检拦截）
    await assert.rejects(
      market.install({ id: 'huge-pet', spritesheetUrl: `${baseUrl}/huge.webp` }),
      /too large/,
    );
    assert.ok(!fs.existsSync(path.join(petsDir, 'huge-pet')));
    assert.deepEqual(leftoverArtifacts(), []);

    // 11. 下载截断（声明长度与实际不符）：拒绝安装且清理
    await assert.rejects(
      market.install({ id: 'truncated-pet', spritesheetUrl: `${baseUrl}/truncated.webp` }),
    );
    assert.ok(!fs.existsSync(path.join(petsDir, 'truncated-pet')));
    assert.deepEqual(leftoverArtifacts(), []);

    // 12. pet.json 必填字段校验：displayName 非法时在下载前拒绝，不创建目录
    await assert.rejects(
      market.install({ id: 'meta-bad-pet', displayName: 123, spritesheetUrl: `${baseUrl}/ok.webp` }),
      /displayName/,
    );
    assert.ok(!fs.existsSync(path.join(petsDir, 'meta-bad-pet')));
    assert.deepEqual(leftoverArtifacts(), []);

    // 13. 路径安全：目录穿越 / 斜杠注入 / 大写 id 一律拒绝
    await assert.rejects(market.install({ id: '../escape' }), /Invalid pet id/);
    await assert.rejects(market.install({ id: 'a/b' }), /Invalid pet id/);
    await assert.rejects(market.install({ id: 'a\\b' }), /Invalid pet id/);
    await assert.rejects(market.install({ id: 'UPPERCASE' }), /Invalid pet id/);
    assert.throws(() => market.uninstall({ id: '..\\evil' }), /Invalid pet id/);
    assert.throws(() => market.uninstall({ id: '../evil' }), /Invalid pet id/);
    assert.deepEqual(leftoverArtifacts(), []);
    assert.ok(!fs.existsSync(path.join(testRoot, 'escape')), 'nothing written outside pets root');

    // 14. 并发防护：同一 pet 安装进行中，第二个安装与卸载都被拒绝
    const slowInstall = market.install({ id: 'conc-pet', spritesheetUrl: `${baseUrl}/slow.webp` });
    await assert.rejects(
      market.install({ id: 'conc-pet', spritesheetUrl: `${baseUrl}/slow.webp` }),
      /in progress/,
    );
    assert.throws(() => market.uninstall({ id: 'conc-pet' }), /in progress/);
    const slowResult = await slowInstall;
    assert.equal(slowResult.installed, true);
    assert.deepEqual(leftoverArtifacts(), []);
    // 操作释放后可以正常卸载
    const concUninstall = market.uninstall({ id: 'conc-pet' });
    assert.equal(concUninstall.removed, true);

    // 15. 修复损坏目录：已有目录缺少精灵图时，走 备份->切换 流程完成安装且不残留 .bak
    const brokenDir = path.join(petsDir, 'broken-pet');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'pet.json'), '{"id":"broken-pet"}');
    const fixRes = await market.install({
      id: 'broken-pet',
      displayName: 'Broken Pet',
      spritesheetUrl: `${baseUrl}/ok.webp`,
    });
    assert.equal(fixRes.alreadyInstalled, false);
    assert.ok(fs.existsSync(path.join(brokenDir, 'spritesheet.webp')), 'spritesheet repaired');
    const fixedMeta = JSON.parse(fs.readFileSync(path.join(brokenDir, 'pet.json'), 'utf8'));
    assert.equal(fixedMeta.displayName, 'Broken Pet');
    assert.deepEqual(leftoverArtifacts(), [], 'swap with existing dir must not leave backup dirs');

    // 16. 已安装列表不容忍损坏目录：pet.json 无法解析或缺少精灵图的目录不出现
    const badJsonDir = path.join(petsDir, 'bad-json-pet');
    fs.mkdirSync(badJsonDir);
    fs.writeFileSync(path.join(badJsonDir, 'pet.json'), '{not json');
    fs.writeFileSync(path.join(badJsonDir, 'spritesheet.webp'), webpPayload('x'));
    const noSheetDir = path.join(petsDir, 'no-sheet-pet');
    fs.mkdirSync(noSheetDir);
    fs.writeFileSync(path.join(noSheetDir, 'pet.json'), JSON.stringify({ id: 'no-sheet-pet' }));
    const robustCatalogIds = market.catalog().data.map(p => p.id);
    assert.ok(!robustCatalogIds.includes('bad-json-pet'), 'unparseable pet.json excluded');
    assert.ok(!robustCatalogIds.includes('no-sheet-pet'), 'missing spritesheet excluded');
    assert.ok(robustCatalogIds.includes('community-pet'), 'healthy install still listed');
    assert.ok(robustCatalogIds.includes('broken-pet'), 'repaired install now listed');

    // 17. 崩溃残留清扫：超过年龄的 .tmp-* / .bak-* 在下一次安装/卸载时被清理
    const staleTmp = path.join(petsDir, '.tmp-stale-pet-0-0-aaaaaa');
    const staleBak = path.join(petsDir, '.bak-stale-pet-0-0-bbbbbb');
    fs.mkdirSync(staleTmp);
    fs.mkdirSync(staleBak);
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(staleTmp, oldTime, oldTime);
    fs.utimesSync(staleBak, oldTime, oldTime);
    market.uninstall({ id: 'no-such-pet' });
    assert.ok(!fs.existsSync(staleTmp), 'stale .tmp dir swept');
    assert.ok(!fs.existsSync(staleBak), 'stale .bak dir swept');

    // 18. 校验辅助函数单元测试
    assert.equal(isWebpBuffer(webpPayload('t')), true);
    assert.equal(isWebpBuffer(Buffer.from('RIFF....WEBP', 'latin1')), true);
    assert.equal(isWebpBuffer(Buffer.from('RIFF....AVIF', 'latin1')), false);
    assert.equal(isWebpBuffer(Buffer.from('WEBP....RIFF', 'latin1')), false);
    assert.equal(isWebpBuffer(Buffer.from('RIFF', 'latin1')), false);
    assert.equal(isWebpBuffer(Buffer.alloc(0)), false);

    // Windows 系统代理解析（reg query 输出 -> 代理 URL）
    const regHeader = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`),
      'http://127.0.0.1:7890',
      'bare host:port gains the http scheme',
    );
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http://proxy.corp:8080\n`),
      'http://proxy.corp:8080',
      'proxied URL with scheme is preserved',
    );
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891\r\n`),
      'http://127.0.0.1:7891',
      'per-protocol ProxyServer prefers the https entry',
    );
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:7890\r\n`),
      'http://127.0.0.1:7890',
      'per-protocol ProxyServer falls back to the http entry',
    );
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\r\n    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`),
      null,
      'disabled system proxy yields no proxy',
    );
    assert.equal(
      parseWindowsProxySettings(`${regHeader}\r\n    ProxyEnable    REG_DWORD    0x1\r\n    AutoConfigURL    REG_SZ    https://pac.corp/proxy.pac\r\n`),
      null,
      'PAC-only configuration yields no proxy',
    );
    assert.equal(parseWindowsProxySettings(''), null, 'empty reg output yields no proxy');

    // 环回目标判定：本地地址不走代理
    assert.equal(isLoopbackTarget('http://127.0.0.1:8080/x'), true);
    assert.equal(isLoopbackTarget('http://localhost:3000/y'), true);
    assert.equal(isLoopbackTarget('http://[::1]:9000/z'), true);
    assert.equal(isLoopbackTarget('https://codex-pets.net/assets/pets/a.webp'), false);
    assert.equal(isLoopbackTarget('not a url'), false);

    assert.throws(() => validatePetMetadata(null, 'x'), /must be an object/);
    assert.throws(
      () => validatePetMetadata({ id: 'y', displayName: 'A', spriteVersionNumber: 1, spritesheetPath: 'spritesheet.webp' }, 'x'),
      /id mismatch/,
    );
    assert.throws(
      () => validatePetMetadata({ id: 'x', displayName: '  ', spriteVersionNumber: 1, spritesheetPath: 'spritesheet.webp' }, 'x'),
      /displayName/,
    );
    assert.throws(
      () => validatePetMetadata({ id: 'x', displayName: 'A', spriteVersionNumber: 0, spritesheetPath: 'spritesheet.webp' }, 'x'),
      /spriteVersionNumber/,
    );
    assert.throws(
      () => validatePetMetadata({ id: 'x', displayName: 'A', spriteVersionNumber: 1, spritesheetPath: '../evil.webp' }, 'x'),
      /spritesheetPath/,
    );
    assert.equal(
      validatePetMetadata({ id: 'x', displayName: 'A', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }, 'x').id,
      'x',
    );

    // 19. 选择状态：空选择 -> 设置官方预载 -> 持久化跨实例 -> 非法/未知 id 拒绝 -> 清除
    assert.deepEqual(market.selection(), { id: null }, 'no selection initially');

    const officialSelection = market.select({ id: 'synthetic-buddy' });
    assert.equal(officialSelection.id, 'synthetic-buddy');
    assert.equal(officialSelection.displayName, 'Synthetic Buddy');
    assert.deepEqual(market.selection(), officialSelection, 'selection round-trips');

    // 持久化文件落在数据目录内，包含渲染所需的 displayName，且无临时文件残留
    const persisted = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
    assert.equal(persisted.id, 'synthetic-buddy');
    assert.equal(persisted.displayName, 'Synthetic Buddy');
    assert.ok(typeof persisted.selectedAt === 'string' && persisted.selectedAt, 'selectedAt recorded');
    assert.ok(!fs.existsSync(`${selectionFile}.tmp`), 'atomic tmp file renamed away');

    // 跨实例持久化：同一 env 新建 market 能读到选择
    const marketReboot = createPetMarket({ env });
    assert.deepEqual(marketReboot.selection(), officialSelection, 'selection survives a new market instance');

    // 已安装宠物可选，选择随之切换
    const installedSelection = market.select({ id: 'community-pet' });
    assert.equal(installedSelection.id, 'community-pet');
    assert.equal(installedSelection.displayName, 'Community Pet');
    assert.equal(market.selection().id, 'community-pet');

    // 非法 id / 未知 id 一律拒绝，且不影响当前选择
    assert.throws(() => market.select({ id: '../evil' }), /Invalid pet id/);
    assert.throws(() => market.select({ id: 'UPPERCASE' }), /Invalid pet id/);
    assert.throws(() => market.select({ id: 'a/b' }), /Invalid pet id/);
    assert.throws(() => market.select({ id: 'ghost-pet' }), /Unknown pet: ghost-pet/);
    assert.equal(market.selection().id, 'community-pet', 'rejected selects keep current selection');
    assert.ok(!fs.existsSync(path.join(testRoot, 'evil')), 'selection cannot escape the data dir');

    // 清除选择
    assert.deepEqual(market.select({ id: null }), { id: null });
    assert.deepEqual(market.selection(), { id: null });
    assert.equal(JSON.parse(fs.readFileSync(selectionFile, 'utf8')).id, null);

    // 卸载当前选中的桌宠会自动清除选择
    market.select({ id: 'community-pet' });
    assert.equal(market.selection().id, 'community-pet');
    market.uninstall({ id: 'community-pet' });
    assert.deepEqual(market.selection(), { id: null }, 'uninstalling the selected pet clears selection');
    assert.equal(JSON.parse(fs.readFileSync(selectionFile, 'utf8')).id, null);

    // 过期容忍：持久化的选择指向外部删除的宠物时按无选择处理
    market.select({ id: 'broken-pet' });
    assert.equal(market.selection().id, 'broken-pet');
    fs.rmSync(path.join(petsDir, 'broken-pet'), { recursive: true, force: true });
    assert.deepEqual(market.selection(), { id: null }, 'stale selection resolves to no selection');

    // rename 失败（目标路径被同名目录占用）时抛错且不残留 .tmp 暂存文件
    const blockedDataDir = path.join(testRoot, 'blocked-data');
    fs.mkdirSync(path.join(blockedDataDir, 'pet-selection.json'), { recursive: true });
    const blockedMarket = createPetMarket({ env: { ...env, HARNESSMIX_DATA_DIR: blockedDataDir } });
    assert.throws(() => blockedMarket.select({ id: 'synthetic-buddy' }));
    assert.ok(
      !fs.existsSync(path.join(blockedDataDir, 'pet-selection.json.tmp')),
      'rename failure must not leave a tmp file behind',
    );

    console.log('Pets market native tests passed successfully!');
  } finally {
    try { server.closeAllConnections(); } catch { /* Node < 18.2 无此 API */ }
    server.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})();
