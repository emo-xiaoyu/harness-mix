const fs = require('node:fs/promises');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');

const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTurn(rt, thread, text, attachments, timeoutMs) {
  let done = false, failure;
  const work = rt.send(thread.id, text, { attachments }).then(() => { done = true; }, error => { done = true; failure = error; });
  const until = Date.now() + timeoutMs;
  while ((!done || rt.execution.isRunning(thread.id) || thread.reviewPending) && Date.now() < until) {
    const pending = thread.pendingApprovals?.[0];
    if (pending) {
      await rt.cancel(thread.id);
      throw new Error(`waiting for native approval: ${pending.title || pending.requestId}`);
    }
    await delay(100);
  }
  if (!done || rt.execution.isRunning(thread.id)) {
    await rt.cancel(thread.id).catch(() => {});
    throw new Error(`turn did not settle within ${Math.ceil(timeoutMs / 1000)} seconds`);
  }
  await work;
  if (failure) throw failure;
  const turn = rt.execution.lastTurn(thread.id);
  if (!turn || turn.status !== 'completed') throw new Error(`terminal status: ${turn?.status || 'missing'}`);
  return rt.core.getItemsForTurn(turn.id).filter(i => i.type === 'agent_message').map(i => i.content || '').join('');
}

(async () => {
  const directory = path.resolve('output', 'harness-health', String(Date.now()));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const rt = new HostRuntime({ dataDirectory: path.join(directory, 'data') });
  const rows = [];
  try {
    await rt.initialize();
    const selected = new Set((option('harness') || '').split(',').filter(Boolean));
    const imagePath = option('image');
    const imageOnly = process.argv.includes('--image-only');
    const image = imagePath ? await fs.readFile(path.resolve(imagePath)) : null;
    for (const adapter of rt.snapshot().adapters) {
      const row = { harnessId: adapter.id, available: adapter.available, detail: adapter.detail,
        declaredImage: adapter.capabilities.attachments === true, lead: adapter.capabilities.collaborationTools === true };
      rows.push(row);
      if (!process.argv.includes('--live') || !adapter.available || selected.size && !selected.has(adapter.id)) continue;
      let thread;
      try {
        const runtimeAdapter = rt.adapters.get(adapter.id), nativeLead = runtimeAdapter.manifest.capabilities.collaborationTools;
        runtimeAdapter.manifest.capabilities.collaborationTools = false;
        try { thread = await rt.createThread({ harnessId: adapter.id, cwd: workspace, title: `Health ${adapter.id}` }); }
        finally { runtimeAdapter.manifest.capabilities.collaborationTools = nativeLead; }
        if (!imageOnly) {
          const text = await runTurn(rt, thread, 'Reply exactly HARNESS_MIX_HEALTH_OK. Do not use tools or modify files.', [], 180000);
          row.textSnippet = text.slice(0, 500);
          row.textTurn = text.trim() === 'HARNESS_MIX_HEALTH_OK' ? 'passed' : 'unexpected_text';
        }
        if (image && row.declaredImage) {
          const reply = await runTurn(rt, thread, 'Confirm that the attached image reached your native input, then reply exactly HARNESS_MIX_IMAGE_OK. Do not use tools or modify files.',
            [{ kind: 'image', name: path.basename(imagePath), mime: 'image/png', data: image.toString('base64'), size: image.length }], 180000);
          row.imageSnippet = reply.slice(0, 500);
          row.imageTurn = reply.trim() === 'HARNESS_MIX_IMAGE_OK' ? 'passed' : 'unexpected_text';
        }
      } catch (error) { row.error = error.message; row.terminalError = thread?.error || null; }
      finally { if (thread && rt.execution.isRunning(thread.id)) await rt.cancel(thread.id).catch(() => {}); }
    }
  } finally { await rt.close(); }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
  console.log(`Report: ${directory}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
