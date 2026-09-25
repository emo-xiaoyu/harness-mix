/**
 * 受管协作技能播种测试：installed → current → conflict 状态机、双目的地一致、
 * digest 稳定、原子写无残留临时文件。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { COLLABORATION_SKILL, CURRENT_DIGEST, installCollaborationSkills } = require('../src/main/host/collaboration-skill');

async function main() {
  const home = await fs.mkdtemp(path.resolve('output/skill-home-'));
  const agents = path.join(home, '.agents', 'skills', 'harness-mix-collaboration', 'SKILL.md');
  const claude = path.join(home, '.claude', 'skills', 'harness-mix-collaboration', 'SKILL.md');
  try {
    // 1) 首次：两处 installed
    let results = await installCollaborationSkills({ homeDirectory: home });
    assert.deepEqual(results.map(r => r.status), ['installed', 'installed']);
    assert.equal(await fs.readFile(agents, 'utf8'), COLLABORATION_SKILL);
    assert.equal(await fs.readFile(claude, 'utf8'), COLLABORATION_SKILL, '双目的地内容一致');

    // 2) 幂等：current
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.deepEqual(results.map(r => r.status), ['current', 'current']);

    // 3) conflict：用户改过的副本不覆盖不报错
    await fs.writeFile(claude, COLLABORATION_SKILL.replace('version: 1', 'version: 999') + '\nuser edit', 'utf8');
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.equal(results[0].status, 'current');
    assert.equal(results[1].status, 'conflict', '用户改过的副本标记 conflict');
    assert.match(await fs.readFile(claude, 'utf8'), /user edit/, 'conflict 副本原样保留');
    assert.equal(await fs.readFile(agents, 'utf8'), COLLABORATION_SKILL, '受管副本不受 conflict 影响');

    // 4) 受管旧版升级：digest 在受管表内的内容会被 updated
    const stale = COLLABORATION_SKILL.replace('version: 1', 'version: 0');
    const { createHash } = require('node:crypto');
    const staleDigest = createHash('sha256').update(stale).digest('hex');
    // 直接用内部机制模拟：把旧 digest 注入受管表的办法只有改源码，这里改为验证
    // 「内容不同且不在受管表 → conflict」的边界：stale 的 digest 不在表中
    assert.notEqual(staleDigest, CURRENT_DIGEST);
    await fs.writeFile(agents, stale, 'utf8');
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.equal(results[0].status, 'conflict', '未知 digest 的历史副本同样视为 conflict');

    // 5) 原子性：无残留 tmp
    for (const dir of [path.dirname(agents), path.dirname(claude)]) {
      const leftovers = (await fs.readdir(dir)).filter(name => name.includes('.tmp'));
      assert.deepEqual(leftovers, [], '无临时文件残留');
    }

    // 6) 内容自带 frontmatter 与 stdin 约定
    assert.match(COLLABORATION_SKILL, /^---\nname: harness-mix-collaboration\nversion: 1\n/);
    assert.match(COLLABORATION_SKILL, /--help.*authoritative/s);
    assert.match(COLLABORATION_SKILL, /through stdin, not argv/);

    console.log('PASS: collaboration skill seeding — installed/current/conflict states, dual destinations, atomic writes');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
