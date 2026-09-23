// cliSpawn Windows 解析回归：.exe 直启（不经 cmd.exe）、.cmd/.bat 经 cmd.exe 包装、
// PATH 目录顺序、带路径 bin 就地解析、未安装时的旧行为回退与参数脱敏。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliSpawn, resolveWindowsCli } = require('../src/main/host/jsonl');

if (process.platform !== 'win32') {
  const plain = cliSpawn('some-cli', ['--version', 42]);
  assert.equal(plain.command, 'some-cli');
  assert.deepEqual(plain.args, ['--version', '42']);
  console.log('PASS: cliSpawn non-Windows passthrough');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-clispawn-'));
  const binDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  for (const name of ['exe-only.exe', 'cmd-only.cmd', 'both.exe', 'both.cmd', 'bat-only.bat']) {
    fs.writeFileSync(path.join(binDir, name), 'rem stub');
  }
  // PATH 顺序必须生效：先命中目录里的 .cmd 先于后命中目录里的 .exe
  fs.writeFileSync(path.join(secondDir, 'ordered.exe'), 'rem stub');
  fs.writeFileSync(path.join(binDir, 'ordered.cmd'), 'rem stub');
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${secondDir}${path.delimiter}${originalPath}`;
  try {
    // .exe 命中 → 直接 spawn，不经过 cmd.exe
    const direct = cliSpawn('exe-only', ['--version', 42]);
    assert.equal(direct.command, path.join(binDir, 'exe-only.exe'));
    assert.deepEqual(direct.args, ['--version', '42']);

    // 同目录 .exe 与 .cmd 并存 → .exe 优先
    const both = cliSpawn('both', ['a']);
    assert.equal(both.command, path.join(binDir, 'both.exe'));
    assert.deepEqual(both.args, ['a']);

    // 仅 .cmd → cmd.exe 包装，且用解析出的绝对路径
    const wrapped = cliSpawn('cmd-only', ['--version']);
    assert.equal(wrapped.command, 'cmd.exe');
    assert.deepEqual(wrapped.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(wrapped.args[3].startsWith(path.join(binDir, 'cmd-only.cmd')));
    assert.ok(wrapped.args[3].includes('--version'));

    // 仅 .bat → 同样包装
    const bat = cliSpawn('bat-only', []);
    assert.equal(bat.command, 'cmd.exe');
    assert.ok(bat.args[3].startsWith(path.join(binDir, 'bat-only.bat')));

    // PATH 目录顺序优先于扩展名优先级
    const ordered = cliSpawn('ordered', []);
    assert.equal(ordered.command, 'cmd.exe');
    assert.ok(ordered.args[3].startsWith(path.join(binDir, 'ordered.cmd')));

    // 未安装 → 旧行为回退：<bin>.cmd 裸名经 cmd.exe，探测方拿到“未识别”错误
    const missing = cliSpawn('definitely-missing-hm-cli', ['x']);
    assert.equal(missing.command, 'cmd.exe');
    assert.ok(missing.args[3].startsWith('definitely-missing-hm-cli.cmd'));

    // 带路径、扩展名被剥离（acp.js / native-acp-command.js 的调用形态）→ 就地解析出 .cmd
    const stripped = cliSpawn(path.join(binDir, 'cmd-only'), ['--acp']);
    assert.equal(stripped.command, 'cmd.exe');
    assert.ok(stripped.args[3].includes(path.join(binDir, 'cmd-only.cmd')));

    // 带路径且含扩展名 → 原样使用
    const withExt = cliSpawn(path.join(binDir, 'exe-only.exe'), ['v']);
    assert.equal(withExt.command, path.join(binDir, 'exe-only.exe'));
    assert.deepEqual(withExt.args, ['v']);

    // 包装路径保留既有参数脱敏：cmd 元字符剥离并加引号，空格参数加引号
    const sanitized = cliSpawn('cmd-only', ['a&b', 'has space', '100%']);
    const line = sanitized.args[3];
    assert.ok(line.includes('"ab"'));
    assert.ok(line.includes('"has space"'));
    assert.ok(line.includes('"100"'));

    // resolveWindowsCli 直接语义
    assert.equal(resolveWindowsCli('exe-only'), path.join(binDir, 'exe-only.exe'));
    assert.equal(resolveWindowsCli('definitely-missing-hm-cli'), null);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS: cliSpawn Windows resolution (.exe direct, .cmd/.bat wrapped, PATH order, fallback, sanitizing)');
}
