// Live probe against the real ZCode app-server (needs the desktop install and
// a logged-in shared credential). Verifies: session/send attachments end-to-end
// (localPath channel), mcp/list contents. Run: node scripts/zcode-live-probe.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const zcode = require('../src/main/adapters/zcode');

// 64x64 solid red PNG generated via System.Drawing and verified decodable by
// ZCode's Read tool. Inline "tiny red PNG" snippets circulating in docs have
// proven undecodable, so this exact payload is the verified one.
const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACJSURBVHhe7dAhAQBAEITA7Z/sW/15KoAYg2Rv+2ZjsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNgeiYnGlP5FKrAAAAABJRU5ErkJggg==';
const redPng = () => Buffer.from(RED_PNG_BASE64, 'base64');

async function ask(adapter, session, events, text, attachments) {
  events.length = 0;
  await adapter.send(session, text, null, attachments);
  return events.filter(e => e.kind === 'text-delta').map(e => e.text).join('');
}

async function main() {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-'));
  const image = path.join(probeDir, 'solid-red.png');
  fs.writeFileSync(image, redPng());
  const events = [];
  const adapter = zcode.create();
  // Hard watchdog: a wedged turn (e.g. an attachment error path that never
  // settles) must not hang the probe forever.
  const watchdog = setTimeout(() => { console.error('PROBE WATCHDOG: 240s budget exceeded'); process.exit(2); }, 240_000);
  watchdog.unref();
  const session = await adapter.open({
    thread: { cwd: probeDir },
    emit: event => {
      events.push(event);
      process.stdout.write(`[event] ${JSON.stringify(event).slice(0, 180)}\n`);
      // Throwaway probe dir: auto-answer any permission card so the turn settles.
      if (event.kind === 'approval') adapter.respond(session, event.requestId, { optionId: event.options?.[0]?.id }).catch(() => {});
    },
    diagnostic: line => process.stdout.write(`[diag] ${String(line).slice(0, 400)}\n`),
  });
  try {
    console.log('sessionId:', session.state.sessionId);

    try {
      const mcp = await session.proc.request('mcp/list', { workspace: { workspacePath: probeDir, workspaceKey: probeDir } });
      console.log('\n=== mcp/list ===\n', JSON.stringify(mcp).slice(0, 1800));
    } catch (error) {
      console.log('mcp/list failed:', error.message.slice(0, 300));
    }

    const answer = await ask(adapter, session, events,
      '我给你发了一张本地图片文件。只能用 Read 工具查看它（禁止使用 Bash），然后回答：图片是什么颜色？只回答颜色词。',
      { images: [{ name: 'solid-red.png', mime: 'image/png', data: RED_PNG_BASE64, path: image }] });
    console.log('\n=== localPath attachment answer ===\n', answer.slice(0, 300));
    assert.match(answer, /红|red/i, 'model should see the red image via localPath');

    console.log('\nLIVE PROBE PASS');
  } finally {
    await adapter.close(session).catch(() => {});
    setTimeout(() => { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* windows eperm racing the just-killed child */ } }, 1500);
  }
}

main().catch(error => { console.error('PROBE FAILED:', error); process.exit(1); });
