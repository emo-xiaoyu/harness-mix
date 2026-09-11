const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const antigravity = require('../src/main/adapters/antigravity');

(async () => {
  const { manifest, create, parseModelsOutput, parseUsage, formatPrompt, prepareImageAttachments, ANTIGRAVITY_PERMISSION_MODES } = antigravity;

  // 1. Manifest
  assert.equal(manifest.id, 'antigravity');
  assert.equal(manifest.name, 'Antigravity');
  assert.equal(manifest.icon, 'antigravity-color.svg');
  assert.equal(manifest.capabilities.streaming, true);
  assert.equal(manifest.capabilities.thinking, true);
  assert.equal(manifest.capabilities.tools, true);
  assert.equal(manifest.capabilities.approvals, true);
  assert.equal(manifest.capabilities.questions, true);
  assert.equal(manifest.capabilities.models, true);
  assert.equal(manifest.capabilities.thinkingLevels, true);
  assert.equal(manifest.capabilities.permissionModes, true);
  assert.equal(manifest.capabilities.resume, true);
  assert.equal(manifest.capabilities.fork, true);
  assert.equal(manifest.capabilities.attachments, true);

  // 2. parseModelsOutput
  const sampleModelsOutput = `
Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;
  const models = parseModelsOutput(sampleModelsOutput);
  assert.ok(models.length >= 4);

  const flash = models.find(m => m.id === 'gemini-3.8-flash');
  assert.ok(flash);
  assert.equal(flash.name, 'Gemini 3.8 Flash');
  assert.equal(flash.provider, 'google');
  assert.equal(flash.efforts.length, 3);
  assert.equal(flash.efforts[0].id, 'low');
  assert.equal(flash.efforts[2].id, 'high');
  assert.equal(flash.defaultEffort, 'high');
  assert.equal(flash.contextWindow, 1_048_576);

  const claude = models.find(m => m.id === 'claude-sonnet-4-6');
  assert.ok(claude);
  assert.equal(claude.provider, 'anthropic');
  assert.equal(claude.contextWindow, 200_000);

  // 3. parseUsage
  const usage = parseUsage({
    input_tokens: 1200,
    output_tokens: 300,
    thinking_tokens: 150,
    total_tokens: 1650,
    context_used_tokens: 25000,
  }, 'gemini-3.8-flash');
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 300);
  assert.equal(usage.reasoningOutputTokens, 150);
  assert.equal(usage.contextWindow, 1_048_576);
  assert.equal(usage.tokens, 25000);
  assert.ok(usage.contextPercent > 2.3 && usage.contextPercent < 2.5);

  // 4. formatPrompt
  const rawPrompt = '帮我修改 app.js';
  const formatted = formatPrompt(rawPrompt);
  assert.ok(formatted.includes('write_to_file'));
  assert.ok(formatted.includes('replace_file_content'));
  assert.ok(formatted.includes(rawPrompt));

  // Slash commands / already instruction formatted should not duplicate
  assert.equal(formatPrompt('/usage'), '/usage');
  assert.equal(formatPrompt(formatted), formatted);

  // 5. Adapter lifecycle and Session
  const adapter = create(() => {});
  assert.equal(typeof adapter.open, 'function');
  assert.equal(typeof adapter.send, 'function');
  assert.equal(typeof adapter.cancel, 'function');
  assert.equal(typeof adapter.close, 'function');
  assert.equal(typeof adapter.respond, 'function');
  assert.equal(typeof adapter.fork, 'function');
  assert.equal(typeof adapter.listModelsFor, 'function');
  assert.equal(typeof adapter.setModel, 'function');
  assert.equal(typeof adapter.setThinkingLevel, 'function');
  assert.equal(typeof adapter.setPermissionMode, 'function');

  // 6. Inspect
  const inspection = await adapter.inspect();
  assert.ok(typeof inspection.available === 'boolean');
  assert.ok(typeof inspection.detail === 'string');

  // 7. Open session
  const openEvents = [];
  const session = await adapter.open({
    thread: {
      id: 'thread-1',
      nativeSessionId: 'conv-12345',
      cwd: 'E:\\harness-mix',
      restore: true,
      options: {
        model: { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        thinking: 'medium',
        permissionMode: 'desktop',
      },
    },
    emit: (event) => openEvents.push(event),
    diagnostic: () => {},
  });
  assert.equal(session.nativeSessionId, 'conv-12345');
  assert.equal(session.thinkingLevel, 'medium');
  assert.equal(session.permissionMode, 'desktop');
  assert.ok(openEvents.some(e => e.kind === 'session' && e.nativeSessionId === 'conv-12345'));

  // 8. setModel, setThinkingLevel, setPermissionMode
  await adapter.setModel(session, { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' });
  assert.equal(session.model.id, 'gemini-3.1-pro');
  await adapter.setThinkingLevel(session, 'high');
  assert.equal(session.thinkingLevel, 'high');
  await adapter.setPermissionMode(session, 'skip');
  assert.equal(session.permissionMode, 'skip');

  // 9. Describe
  const desc = await adapter.describe();
  assert.ok(Array.isArray(desc.models));
  assert.equal(desc.thinkingLevels.length, 3);
  assert.equal(desc.permissionModes.length, 3);

  // 10. Fork session
  const forkEvents = [];
  const forked = await adapter.fork({
    id: 'thread-1',
    nativeSessionId: 'conv-12345',
    cwd: 'E:\\harness-mix',
    model: { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    options: { thinking: 'high', permissionMode: 'default' },
  }, {
    emit: (e) => forkEvents.push(e),
    diagnostic: () => {},
  });
  assert.ok(forked.nativeSessionId);
  assert.notEqual(forked.nativeSessionId, 'conv-12345');
  assert.equal(forked.session.nativeSessionId, forked.nativeSessionId);
  assert.ok(forkEvents.some(e => e.kind === 'session' && e.nativeSessionId === forked.nativeSessionId));

  // 11. Image attachments
  const tmpRoot = path.join(os.tmpdir(), `agy-attach-test-${Date.now()}`);
  await fs.promises.mkdir(tmpRoot, { recursive: true });
  const localImg = path.join(tmpRoot, 'test.png');
  await fs.promises.writeFile(localImg, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const prepared = await prepareImageAttachments([
    { name: 'test.png', path: localImg },
    { name: 'inline.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
  ], tmpRoot);
  assert.equal(prepared.imageEntries.length, 2);
  assert.equal(prepared.imageEntries[0].name, 'test.png');
  assert.equal(prepared.imageEntries[0].path, localImg.replace(/\\/g, '/'));
  assert.ok(fs.existsSync(prepared.imageEntries[1].path));
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  // 12. Close session
  await adapter.close(session);

  console.log('antigravity adapter: manifest, models catalog, usage projection, prompt formatting, image attachments, session lifecycle, model switching, describe and fork passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
