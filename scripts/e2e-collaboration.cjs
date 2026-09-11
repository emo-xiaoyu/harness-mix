// Real model-driven collaboration. Arguments: --lead=pi --worker=pi
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HostRuntime } = require('../src/main/host/runtime');
const { git } = require('../src/main/host/collaboration-worktree');
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
async function main() {
  await fs.mkdir('output', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output/collaboration-live-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  const project = path.join(root, 'project'); await fs.mkdir(project);
  await git(project, ['init']); await fs.writeFile(path.join(project, 'README.md'), 'Isolated collaboration verification.\n');
  await git(project, ['add', '.']); await git(project, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  const from = arg('lead', 'pi'), worker = arg('worker', 'pi');
  const cycle = process.argv.includes('--cycle');
  rt.subscribe(e => { if (e.type === 'toast') console.log(e.level, String(e.text).slice(0, 220)); });
  try {
    await rt.initialize();
    const lead = await rt.createThread({ harnessId: from, cwd: project, title: 'Native collaboration verification' });
    const prompt = cycle
      ? `这是一个协作流程验收夹具，所有文件只在当前测试目录内。你是协调者，禁止自己编写或修复文件。先用 update_agent_plan 建立计划。用 delegate_to_agent 委派 @${worker} 创建 answer.cjs，内容为 module.exports = 41;（这是故意准备的错误样本，供下一步审查）。等待完成后，另委派 @pi 作为独立只读审查者：读取 answer.cjs，检查导出值是否严格等于 42，不符合时回复 REVIEW_FAIL 和原因。两位协作者均使用默认共享工作目录，不要指定 isolation。收齐审查后通过 message_agent 把问题交回原开发者，要求修为 42。等待修复完成，再通过 message_agent 让原审查者重新读取并执行检查，正确时回复 REVIEW_PASS。必须复用原来的两个子会话。全部完成后更新计划，汇总结果，最终包含 COLLAB_CYCLE_VERIFIED。`
      : `使用 Harness Mix 的 delegate_to_agent，显式指定 isolation=worktree，委派两个独立任务给 @${worker}。任务一只回复 COLLAB_ALPHA，任务二只回复 COLLAB_BETA。不要执行 shell 或编辑文件。请使用 get_delegation_status 等待两个结果，然后你自己最终回复两条结果和 COLLAB_VERIFIED。`;
    let done = false, failure;
    void rt.send(lead.id, prompt).then(() => { done = true; }, error => { done = true; failure = error; });
    const until = Date.now() + (cycle ? 480000 : 180000);
    while ((!done || rt.execution.isRunning(lead.id) || lead.reviewPending) && Date.now() < until) {
      const approval = rt.threads.flatMap(t => t.pendingApprovals ?? [])[0];
      if (approval) throw new Error(`Native approval required: ${approval.title ?? approval.requestId}. Verification does not auto-approve.`);
      await new Promise(r => setTimeout(r, 200));
    }
    if (failure) throw failure;
    if (rt.execution.isRunning(lead.id)) throw new Error(cycle ? 'Live review cycle did not finish within eight minutes' : 'Live model did not finish within three minutes');
    const jobs = [...rt.collaboration.jobs.values()].filter(j => j.owner === lead.id);
    const final = rt.core.getItemsForTurn(rt.execution.lastTurn(lead.id).id).filter(i => i.type === 'agent_message').map(i => i.content).join('\n');
    console.log(JSON.stringify({ lead: from, worker, jobs: jobs.map(j => rt.collaboration.view(j)), final }, null, 2));
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(j => j.status === 'completed'));
    if (cycle) {
      assert.ok(jobs.every(j => j.workspace.mode === 'shared' && j.workspace.cwd === project));
      assert.equal(require(path.join(project, 'answer.cjs')), 42);
      assert.match(final, /COLLAB_CYCLE_VERIFIED/);
      const children = jobs.map(j => rt.threads.find(t => t.id === j.childId));
      assert.ok(children.every(t => t.messages.filter(m => m.role === 'user').length >= 2), 'Both native sessions were followed up');
      const transcript = children.flatMap(t => t.messages.filter(m => m.role === 'assistant').map(m => m.text || '')).join('\n');
      assert.match(transcript, /REVIEW_FAIL/); assert.match(transcript, /REVIEW_PASS/);
      const items = rt.core.getItemsForTurn(rt.execution.lastTurn(lead.id).id);
      assert.ok(items.some(i => i.type === 'plan' && i.entries.every(e => e.status === 'completed')));
      assert.ok(items.filter(i => i.collaboration).length >= 4);
    } else {
      assert.ok(jobs.every(j => j.workspace.mode === 'worktree' && j.workspace.cwd !== project));
      assert.notEqual(jobs[0].workspace.cwd, jobs[1].workspace.cwd);
      assert.match(final, /COLLAB_ALPHA/); assert.match(final, /COLLAB_BETA/); assert.match(final, /COLLAB_VERIFIED/);
    }
    console.log('PASS: native lead called tools, spawned two native workers, collected results and synthesized its final answer');
  } finally { await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
