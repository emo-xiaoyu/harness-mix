const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createWorkspace, reviewWorkspace, applyWorkspace, git } = require('../src/main/host/collaboration-worktree');
const { Collaboration } = require('../src/main/host/collaboration');
const { HostRuntime } = require('../src/main/host/runtime');
const { SessionHistory } = require('../src/main/host/session-history');
const { NativeProtocol } = require('../src/main/native/protocol');

async function main() {
  const root = await fs.mkdtemp(path.resolve('output/collab-recovery-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'core.autocrlf', 'false']); await fs.writeFile(path.join(repo, 'file.txt'), 'initial\n');
  await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); await git(repo, ['add', 'file.txt']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'unstaged\n'); await fs.writeFile(path.join(repo, 'untracked.txt'), 'keep\n');
  const staged = await git(repo, ['diff', '--cached', '--binary']);
  const workspace = await createWorkspace(repo, randomUUID());
  assert.equal(workspace.mode, 'worktree');
  assert.equal(await fs.readFile(path.join(workspace.cwd, 'file.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await fs.readFile(path.join(workspace.cwd, 'untracked.txt'), 'utf8'), 'keep\n');
  assert.equal(await git(repo, ['diff', '--cached', '--binary']), staged, 'Source index preserved');
  assert.equal((await reviewWorkspace(workspace)).patch, '', 'Seed changes are not worker changes');
  await fs.writeFile(path.join(workspace.cwd, 'file.txt'), 'worker\n');
  await fs.writeFile(path.join(workspace.cwd, 'new.txt'), 'worker new\n');
  const review = await reviewWorkspace(workspace);
  assert.match(review.patch, /worker/);
  assert.doesNotMatch(review.patch, /untracked.txt/);
  await assert.rejects(applyWorkspace(workspace, 'stale'), /重新审查/);
  await fs.writeFile(path.join(repo, 'file.txt'), 'conflicting edit\n');
  await assert.rejects(applyWorkspace(workspace, review.digest));
  assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'conflicting edit\n');
  assert.equal(await fs.stat(path.join(repo, 'new.txt')).catch(() => null), null, 'Conflict applies no partial patch');
  await fs.writeFile(path.join(repo, 'file.txt'), 'unstaged\n');
  await applyWorkspace(workspace, review.digest);
  assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'worker\n');
  assert.equal(await git(repo, ['diff', '--cached', '--binary']), staged);

  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') }); await rt.store.load();
  await rt.collaboration.initialize();
  rt.collaboration.jobs.set('saved', { id: 'saved', owner: 'parent', agent: 'pi', childId: 'child', status: 'running', task: 'continue', workspace });
  rt.collaboration.jobs.set('finished', { id: 'finished', owner: 'parent', agent: 'pi', childId: 'done', status: 'completed', result: 'kept' });
  await rt.collaboration.save();
  const restarted = new Collaboration(rt); await restarted.initialize();
  assert.equal(restarted.jobs.get('saved').status, 'interrupted');
  assert.equal(restarted.jobs.get('saved').childId, 'child');
  assert.equal(restarted.jobs.get('saved').workspace.cwd, workspace.cwd);
  assert.equal(restarted.jobs.get('finished').result, 'kept');
  assert.equal(restarted.keys.size, 0, 'No session authorization keys persisted');
  // Resume must reuse the durable child identity, rather than spawn a replacement.
  const parent = { id: 'parent', cwd: repo, title: 'Lead' }, child = { id: 'child', parentThreadId: 'parent', cwd: workspace.cwd };
  let received, active = false;
  const fake = { store: rt.store, threads: [parent, child], adapters: new Map([['pi', { manifest: { name: 'Pi' } }]]),
    execution: { isRunning: id => id === 'parent' || active, lastTurn: () => ({ id: 'turn', status: 'completed' }) },
    core: { getItemsForTurn: () => [{ type: 'agent_message', phase: 'final', content: 'resumed' }] },
    emitCollaboration() {}, async send(id, task) { assert.equal(id, 'child'); received = task; },
    async createThread() { throw new Error('Duplicate child created'); }, async cancel() {} };
  restarted.runtime = fake;
  await restarted.call('parent', 'resume_delegation', { task_id: 'saved' });
  await restarted.jobs.get('saved').done;
  assert.match(received, /do not repeat completed side effects/);
  assert.equal(restarted.jobs.get('saved').result, 'resumed');
  assert.equal(restarted.jobs.get('saved').childId, 'child');
  const nativeReview = await restarted.call('parent', 'review_delegation_changes', { task_id: 'saved' });
  assert.equal(nativeReview.digest, review.digest); assert.match(nativeReview.patch, /worker/);
  rt.collaboration.jobs.clear();
  const calls = [];
  rt.adapters.set('pi', { manifest: { id: 'pi', name: 'Pi', capabilities: {} } }); rt.status.pi = { available: true };
  rt.history = new SessionHistory(rt, {
    async listNative() { calls.push('list'); return [{ nativeSessionId: 'native-id', title: 'Native history', cwd: repo, updatedAt: 10, running: null }]; },
    async readNative() { calls.push('read'); return [{ id: 'u', role: 'user', text: 'old question', at: 1 }, { id: 'a', role: 'assistant', text: 'old answer', at: 2 }]; },
  });
  const protocol = new NativeProtocol(rt, () => {});
  const rows = await protocol.request('codexhost/harness/session-import/list', { harnessId: 'all-harnesses', query: 'Native' });
  assert.equal(rows.total, 1);
  const params = { harnessId: 'all-harnesses', nativeSessionId: rows.candidates[0].nativeSessionId };
  const context = await rt.history.context(params);
  assert.equal(context.harnessId, 'pi'); assert.match(context.transcript, /User: old question[\s\S]*Assistant: old answer/);
  assert.equal(rt.sessions.size, 0, 'Referencing history does not launch or import a model session');
  const [one, two] = await Promise.all([rt.history.import(params), rt.history.import(params)]);
  assert.equal(one.threadId, two.threadId); assert.equal(calls.filter(c => c === 'read').length, 2);
  assert.equal(rt.sessions.size, 0, 'Browsing/importing history does not launch model sessions');
  const imported = rt.threads.find(t => t.id === one.threadId);
  assert.equal(imported.nativeSessionId, 'native-id'); assert.equal(imported.restore, true);
  assert.match(JSON.stringify(rt.core.getItemsForTurn(rt.execution.lastTurn(imported.id).id)), /old answer/);
  await assert.rejects(rt.history.import({ harnessId: 'pi', nativeSessionId: '../outside' }), /no longer exists/);
  protocol.close(); await restarted.close(); await rt.close();
  console.log('PASS: dirty worktree isolation, source index preservation, digest/conflict-safe apply, durable recovery identity, unified history search/import/dedup and lazy native resume');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
