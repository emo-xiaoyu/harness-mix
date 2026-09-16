'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPetMarket, readAsarHeader } = require('../src/main/native/pets');

function buildSyntheticAsar(targetPath, petName, blobContent) {
  const tree = {
    files: {
      webview: {
        files: {
          assets: {
            files: {
              [`${petName}-spritesheet-v1-0123456789abcdef.webp`]: {
                size: blobContent.length,
                offset: '0',
              },
            },
          },
        },
      },
    },
  };
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

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-pets-test-'));
  const fakeAsarDir = path.join(testRoot, 'resources');
  fs.mkdirSync(fakeAsarDir, { recursive: true });
  const fakeAsarPath = path.join(fakeAsarDir, 'app.asar');
  const fakeCodexBin = path.join(fakeAsarDir, 'codex.exe');
  fs.writeFileSync(fakeCodexBin, '');

  const fakeSpriteBlob = Buffer.from('RIFF....WEBPVP8 ...fake-sprite-data...', 'utf8');
  buildSyntheticAsar(fakeAsarPath, 'synthetic-buddy', fakeSpriteBlob);

  const petsDir = path.join(testRoot, 'installed-pets');
  fs.mkdirSync(petsDir, { recursive: true });

  const env = {
    CODEXHOST_STOCK_CODEX_PATH: fakeCodexBin,
    HARNESS_MIX_PETS_DIR: petsDir,
  };

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

    // 3. Test preview() for official pet
    const previewRes = market.preview({ id: 'synthetic-buddy' });
    assert.equal(previewRes.id, 'synthetic-buddy');
    assert.equal(previewRes.mime, 'image/webp');
    const previewBuf = Buffer.from(previewRes.dataBase64, 'base64');
    assert.equal(previewBuf.toString('utf8'), fakeSpriteBlob.toString('utf8'), 'preview base64 should match sprite blob');

    // Invalid pet id checks
    assert.throws(() => market.preview({ id: '../bad-pet' }), /Invalid pet id/);
    assert.throws(() => market.preview({ id: 'non-existent-pet' }), /Unknown pet/);

    // 4. Test install() of official pet
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

    // 5. Test community() fallback and search
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

    console.log('Pets market native tests passed successfully!');
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})();
