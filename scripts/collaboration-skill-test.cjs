/**
 * 受管协作技能播种测试：installed → current → conflict 状态机、双技能 × 双目的地一致、
 * digest 稳定、原子写无残留临时文件。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  COLLABORATION_SKILL, CURRENT_DIGEST, AGENTTEAM_SKILL, AGENTTEAM_CURRENT_DIGEST, installCollaborationSkills,
} = require('../src/main/host/collaboration-skill');

async function main() {
  const home = await fs.mkdtemp(path.resolve('output/skill-home-'));
  const destination = (skill, directory) => path.join(home, directory, 'skills', skill, 'SKILL.md');
  const collabAgents = destination('harness-mix-collaboration', '.agents');
  const collabClaude = destination('harness-mix-collaboration', '.claude');
  const teamAgents = destination('agentteam', '.agents');
  const teamClaude = destination('agentteam', '.claude');
  try {
    // 1) 首次：双技能 × 双目的地全部 installed，内容与常量一致
    let results = await installCollaborationSkills({ homeDirectory: home });
    assert.deepEqual(results.map(r => r.status), ['installed', 'installed', 'installed', 'installed']);
    assert.equal(await fs.readFile(collabAgents, 'utf8'), COLLABORATION_SKILL);
    assert.equal(await fs.readFile(collabClaude, 'utf8'), COLLABORATION_SKILL, '协作技能双目的地内容一致');
    assert.equal(await fs.readFile(teamAgents, 'utf8'), AGENTTEAM_SKILL);
    assert.equal(await fs.readFile(teamClaude, 'utf8'), AGENTTEAM_SKILL, '组队技能双目的地内容一致');

    // 2) 幂等：current
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.deepEqual(results.map(r => r.status), ['current', 'current', 'current', 'current']);

    // 3) conflict：用户改过的副本不覆盖不报错，且不影响其余目的地
    await fs.writeFile(collabClaude, COLLABORATION_SKILL.replace('version: 2', 'version: 999') + '\nuser edit', 'utf8');
    await fs.writeFile(teamClaude, AGENTTEAM_SKILL.replace('# Execute the task', '# user rewrite'), 'utf8');
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.deepEqual(results.map(r => r.status), ['current', 'conflict', 'current', 'conflict'], '每技能独立判定 conflict');
    assert.match(await fs.readFile(collabClaude, 'utf8'), /user edit/, 'conflict 副本原样保留');
    assert.match(await fs.readFile(teamClaude, 'utf8'), /user rewrite/, 'conflict 副本原样保留');
    assert.equal(await fs.readFile(collabAgents, 'utf8'), COLLABORATION_SKILL, '受管副本不受 conflict 影响');
    assert.equal(await fs.readFile(teamAgents, 'utf8'), AGENTTEAM_SKILL, '受管副本不受 conflict 影响');

    // 4) 受管旧版升级：digest 在受管表内的内容会被 updated；未知 digest 视为 conflict
    const stale = COLLABORATION_SKILL.replace('version: 2', 'version: 0');
    const staleDigest = createHash('sha256').update(stale).digest('hex');
    // 直接用内部机制模拟：把旧 digest 注入受管表的办法只有改源码，这里改为验证
    // 「内容不同且不在受管表 → conflict」的边界：stale 的 digest 不在表中
    assert.notEqual(staleDigest, CURRENT_DIGEST);
    await fs.writeFile(collabAgents, stale, 'utf8');
    results = await installCollaborationSkills({ homeDirectory: home });
    assert.equal(results[0].status, 'conflict', '未知 digest 的历史副本同样视为 conflict');

    // 5) 原子性：无残留 tmp
    for (const dir of [collabAgents, collabClaude, teamAgents, teamClaude].map(file => path.dirname(file))) {
      const leftovers = (await fs.readdir(dir)).filter(name => name.includes('.tmp'));
      assert.deepEqual(leftovers, [], '无临时文件残留');
    }

    // 6) 内容自带 frontmatter 与关键用法约定
    assert.match(COLLABORATION_SKILL, /^---\nname: harness-mix-collaboration\nversion: 2\n/);
    assert.match(COLLABORATION_SKILL, /--help.*authoritative/s);
    assert.match(COLLABORATION_SKILL, /through stdin, not argv/);
    assert.match(AGENTTEAM_SKILL, /^---\nname: agentteam\nversion: 2\n/);
    assert.match(AGENTTEAM_SKILL, /exit code 2[\s\S]*Harness Mix-managed session/);
    assert.match(AGENTTEAM_SKILL, /templates` lists team templates[\s\S]*\.harness-mix\/teams\/\*\.md/);
    assert.match(AGENTTEAM_SKILL, /team create --name[\s\S]*agent_type/);
    assert.match(AGENTTEAM_SKILL, /at most six members/);
    assert.notEqual(CURRENT_DIGEST, AGENTTEAM_CURRENT_DIGEST, '两技能 digest 独立');

    // 7) 官方 Codex 隔离门卫：种子落在用户级目录，非受管会话必须自判不适用并
    //    回落原生能力，而不是跑 CLI 后死在 DISCOVERY
    for (const skill of [COLLABORATION_SKILL, AGENTTEAM_SKILL]) {
      assert.match(skill, /ONLY[\s\S]*?Harness Mix-managed sessions/, '描述声明仅受管会话适用');
      assert.match(skill, /"\[Harness Mix collaboration\]" instruction/, '给出可判定的会话标志');
      assert.match(skill, /native subagent/, '无指令时回落原生子代理');
    }
    assert.match(COLLABORATION_SKILL, /do not report a discovery error/);
    assert.match(AGENTTEAM_SKILL, /do not report a discovery error/);

    console.log('PASS: collaboration skill seeding — dual skills, installed/current/conflict states, dual destinations, atomic writes');
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
