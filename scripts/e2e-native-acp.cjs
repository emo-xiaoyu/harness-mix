const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const directory = path.resolve('output', 'native-acp-live', String(Date.now()));
  fs.mkdirSync(directory, { recursive: true });
  const reports = [];
  const selected = process.argv.find(a => a.startsWith('--harness='))?.slice(10);
  for (const file of (selected ? selected.split(',') : ['codebuddy', 'kiro', 'cursor', 'qoder', 'zcode', 'trae'])) {
    const mod = require('../src/main/adapters/' + file), adapter = mod.create();
    const report = { harnessId: mod.manifest.id, inspection: await adapter.inspect(), live: false };
    reports.push(report);
    if (!report.inspection.available) continue;
    let s;
    const texts = [];
    const emit = e => { if (e.kind === 'text-delta') texts.push(e.text); if (e.kind === 'approval') report.approvalRequired = true; };
    const deadline = setTimeout(() => adapter.close(s).catch(() => {}), 60000);
    try {
      s = await adapter.open({ thread: { cwd: directory }, emit });
      const catalog = await adapter.describeFor(s);
      report.models = catalog.models.length;
      report.thinkingLevels = catalog.thinkingLevels.map(v => v.id);
      report.modes = catalog.permissionModes.map(v => v.id);
      if (process.argv.includes('--live')) {
        await adapter.send(s, 'Reply exactly HARNESS_MIX_ACP_OK. Do not use tools or modify files.', { emit });
        report.live = texts.join('').trim() === 'HARNESS_MIX_ACP_OK';
        report.text = texts.join('').slice(0, 500);
        const nativeSessionId = s.nativeSessionId;
        await adapter.close(s);
        s = await adapter.open({ thread: { cwd: directory, nativeSessionId, restore: true }, emit });
        texts.length = 0;
        await adapter.send(s, 'Reply exactly HARNESS_MIX_RESUME_OK. Do not use tools or modify files.', { emit });
        report.resume = s.nativeSessionId === nativeSessionId && texts.join('').trim() === 'HARNESS_MIX_RESUME_OK';
      }
    } catch (error) { report.error = error.message; }
    finally { clearTimeout(deadline); await adapter.close(s); }
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
  console.log('Report: ' + directory);
  if (reports.some(r => r.error || (process.argv.includes('--live') && r.inspection.available && (!r.live || !r.resume)))) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
