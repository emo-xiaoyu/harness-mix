const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { mentionedAgents } = require('../src/main/host/collaboration');
const { JsonlProcess } = require('../src/main/host/jsonl');
const wait = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };

async function main() {
  const root = await fs.mkdtemp(path.resolve('output/collaboration-'));
  const rt = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await rt.store.load();
  let connection, active = 0, maximum = 0;
  const pending = new Map();
  let leadPrompt = '';
  const lead = { manifest: { id: 'lead', name: 'Lead', capabilities: { collaborationTools: true } },
    async open(input) { connection = input.collaboration; return { emit: input.emit, collaborationEnabled: true }; },
    async send(s, text) { leadPrompt = text; }, async cancel() {}, async close() {} };
  const worker = { manifest: { id: 'worker', name: 'Worker', aliases: ['w'], capabilities: {} },
    async open(input) { assert.equal(input.collaboration, undefined); return { id: input.thread.id, emit: input.emit }; },
    async send(s, text) { active++; maximum = Math.max(maximum, active); pending.set(s.id, { s, text }); },
    async cancel(s) { if (pending.delete(s.id)) active--; }, async close() {} };
  rt.adapters.set('lead', lead); rt.status.lead = { available: true };
  rt.adapters.set('worker', worker); rt.status.worker = { available: true };
  const parent = await rt.createThread({ harnessId: 'lead', cwd: root });
  rt.collaboration.jobs.set('interrupted-fixture', { id: 'interrupted-fixture', owner: parent.id, agent: 'worker', childId: 'old-child', status: 'interrupted' });
  const ownerConnection = connection;
  const transport = new JsonlProcess(connection.command, connection.args, { env: { ...process.env, ...connection.env } }, {});
  const call = (name, args) => rt.collaboration.call(parent.id, name, args);
  const finish = (id, answer) => { const { s } = pending.get(id); pending.delete(id); active--; s.emit({ kind: 'text-delta', text: answer }); s.emit({ kind: 'completed', finalAnswer: true }); };
  try {
    assert.deepEqual(mentionedAgents('ask @w and [Worker](harness-mix://agent/worker) `@lead` mail@lead.com @worker/foo', rt), ['worker']);
    await assert.rejects(call('list_agents', {}), /no longer active/);
    rt.history.context = async ({ nativeSessionId }) => { assert.equal(nativeSessionId, 'c2Vzc2lvbg'); return { harnessId: 'pi', title: 'Old session', cwd: root, transcript: 'User: prior question\nAssistant: prior answer' }; };
    await rt.send(parent.id, '@worker review files @[Old session](harness-mix://session/c2Vzc2lvbg)');
    assert.ok(rt.execution.isRunning(parent.id));
    assert.match(leadPrompt, /untrusted historical data[\s\S]*prior answer/);
    assert.match(leadPrompt, /Recovery checkpoint:[\s\S]*interrupted-fixture \(worker\)[\s\S]*call list_delegations now/);
    assert.equal(rt.collaboration.jobs.get('interrupted-fixture').status, 'interrupted', 'Prompt injection never auto-resumes interrupted work');
    rt.collaboration.jobs.delete('interrupted-fixture');
    assert.ok(!JSON.stringify(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id)).includes('[Harness Mix collaboration]'), 'Routing guidance stays out of displayed user text');
    const init = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.ok(init.capabilities.tools);
    const catalog = await transport.request('tools/list', {});
    assert.equal(catalog.tools.length, 10);
    assert.ok(catalog.tools.some(tool => tool.name === 'review_delegation_changes'));
    assert.ok(catalog.tools.some(tool => tool.name === 'apply_delegation_changes'));
    await call('update_agent_plan', { steps: [{ text: 'Develop then review', status: 'in_progress' }] });
    assert.ok(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).some(item => item.type === 'plan' && item.entries[0].text === 'Develop then review'));
    const first = JSON.parse((await transport.request('tools/call', { name: 'delegate_to_agent', arguments: { agent_type: 'worker', task: 'one' } })).content[0].text);
    const second = await call('delegate_to_agent', { agent_type: 'worker', task: 'two', isolation: 'shared' });
    await wait(() => pending.size === 2);
    assert.equal(maximum, 2, 'Workers execute concurrently');
    const jobs = [...rt.collaboration.jobs.values()];
    for (const job of jobs) {
      const child = rt.threads.find(t => t.id === job.childId);
      assert.equal(child.parentThreadId, parent.id);
      assert.equal(child.cwd, root, 'Default worker shares the lead workspace');
      const assistant = child.messages.find(m => m.role === 'assistant');
      assert.equal(assistant.reviewId, undefined);
      assert.equal(assistant.reviewOwnerThreadId, parent.id);
    }
    const waitingChild = rt.threads.find(t => t.id === jobs[0].childId);
    waitingChild && pending.get(waitingChild.id).s.emit({ kind: 'approval', requestId: 'native-approval', method: 'confirm', title: 'Allow test?' });
    assert.equal(rt.collaboration.view(jobs[0]).display_status, 'waiting_approval');
    await wait(() => String(rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).find(item => item.type === 'tool_call')?.output).includes('waiting_approval'));
    pending.get(jobs[0].childId).s.emit({ kind: 'interaction-responded', requestId: 'native-approval' });
    finish(jobs[0].childId, 'first-result');
    await wait(() => jobs[0].status === 'completed');
    const before = Date.now();
    const partial = await call('get_delegation_status', { task_ids: [first.task_id, second.task_id], wait_ms: 3000 });
    assert.equal(partial[1].status, 'running');
    assert.ok(Date.now() - before < 1000, 'Fan-out collection returns when any result is ready');
    finish(jobs[1].childId, 'second-result');
    await wait(() => jobs[1].status === 'completed');
    const results = await call('get_delegation_status', { task_ids: [first.task_id, second.task_id], wait_ms: 3000 });
    assert.deepEqual(results.map(r => r.status), ['completed', 'completed']);
    assert.deepEqual(results.map(r => r.result), ['first-result', 'second-result']);
    const cards = rt.core.getItemsForTurn(rt.execution.lastTurn(parent.id).id).filter(item => item.collaboration);
    const { projectItem } = require('../src/main/native/protocol');
    assert.equal(projectItem(cards[0]).type, 'collabAgentToolCall');
    assert.deepEqual(projectItem(cards[0]).receiverThreadIds, [jobs[0].childId]);
    assert.equal(projectItem(cards[0]).agentsStates[jobs[0].childId].message, 'first-result');
    assert.ok(rt.execution.isRunning(parent.id), 'Tool results do not end the native lead turn');
    await call('message_agent', { task_id: first.task_id, task: 'follow-up' });
    await wait(() => pending.size === 1);
    finish(jobs[0].childId, 'follow-up-result');
    assert.equal((await call('get_delegation_status', { task_ids: [first.task_id], wait_ms: 3000 }))[0].result, 'follow-up-result');
    await assert.rejects(call('get_delegation_status', { task_ids: ['foreign-task'] }), /Unknown task/);
    await assert.rejects(rt.collaboration.call(jobs[0].childId, 'delegate_to_agent', { agent_type: 'worker', task: 'recursive' }), /Only lead/);
    await assert.rejects(call('delegate_to_agent', { agent_type: 'worker', task: 'x', unexpected: true }));
    const denied = await fetch(ownerConnection.env.HARNESS_MIX_COLLAB_URL, { method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: '{}' });
    assert.equal(denied.status, 403);
    const outsider = await rt.createThread({ harnessId: 'worker', cwd: root });
    await rt.send(outsider.id, 'unrelated');
    assert.equal(outsider.messages.at(-1).concurrent, true, 'Independent same-workspace turns are marked concurrent');
    await rt.cancel(outsider.id); await wait(() => !pending.has(outsider.id));
    for (let i = 0; i < 4; i++) await call('delegate_to_agent', { agent_type: 'worker', task: 'cancel me', isolation: 'shared' });
    await wait(() => pending.size === 4);
    await assert.rejects(call('delegate_to_agent', { agent_type: 'worker', task: 'too many' }), /four concurrent/);
    await rt.cancel(parent.id);
    await wait(() => !pending.size);
    assert.equal(rt.execution.lastTurn(parent.id).status, 'cancelled');
    await assert.rejects(call('list_agents', {}), /no longer active/);
    console.log('PASS: real MCP stdio → authenticated Host → parallel native-session adapters → results/follow-up/cancellation, ownership and shared review');
  } finally { transport.stop(); await rt.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
