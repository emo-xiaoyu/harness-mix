// P0-10 / §55：Architecture Guard —— 静态检查 Core 边界，防止 Harness 泄漏。
// 规则：
//   1. protocol-core/ 与 shared-contracts/ 不得 import adapters/*
//   2. 上述目录不得出现 'pi' / 'claude' / 'dsh' 字面量（Harness 名称分支）
//   3. harness-adapter/event-normalizer 同样保持 Harness 名称零感知
const { readdirSync, statSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const GUARDED_DIRS = ['src/main/protocol-core', 'src/main/shared-contracts', 'src/main/harness-adapter'];
const FORBIDDEN_PATTERNS = [
  { re: /require\(['"`][^'"`]*adapters[/-]/, label: 'import from adapters/*' },
  { re: /require\(['"`][^'"`]*renderer[/-]/, label: 'import from renderer/*' },
  { re: /(['"`])(pi|claude|dsh)\1/, label: 'harness name literal' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.js$/.test(entry)) yield full;
  }
}

let violations = 0;
for (const dir of GUARDED_DIRS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf8');
    for (const { re, label } of FORBIDDEN_PATTERNS) {
      const match = source.match(re);
      if (match) {
        violations++;
        console.error(`VIOLATION ${relative('.', file)}: ${label} (${match[0]})`);
      }
    }
  }
}

for (const file of walk('src/main/adapters')) {
  if (/require\(['"`][^'"`]*renderer[/-]/.test(readFileSync(file, 'utf8'))) {
    violations++; console.error(`VIOLATION ${file}: adapter imports Renderer`);
  }
}
const renderer = readFileSync('src/renderer/transcript.js', 'utf8');
if (/assistantMessageEvent|sessionUpdate|extension_ui_request|tool_execution_start/.test(renderer)) {
  violations++; console.error('VIOLATION Renderer consumes native protocol');
}

for (const file of walk('src')) {
  if (/require\(['"`][^'"`]*(?:legacy[-/]|scripts\/support)/.test(readFileSync(file, 'utf8'))) {
    violations++; console.error(`VIOLATION ${file}: production imports legacy test oracle`);
  }
}
for (const file of ['src/main/host/runtime.js', 'src/renderer/transcript.js']) {
  if (/(['"`])(pi|claude|dsh)\1/.test(readFileSync(file, 'utf8'))) {
    violations++; console.error(`VIOLATION ${file}: execution branches on harness name`);
  }
}
if (/PROTOCOL_CORE_(SHADOW|RENDERER)|finishMessage|ensureAssistantMessage/.test(readFileSync('src/main/host/runtime.js', 'utf8'))) {
  violations++; console.error('VIOLATION Runtime retains legacy execution path');
}

if (violations) {
  console.error(`architecture: ${violations} violation(s)`);
  process.exitCode = 1;
} else {
  console.log(`architecture: core boundaries clean (${GUARDED_DIRS.join(', ')})`);
}
