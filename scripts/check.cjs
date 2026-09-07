// 递归对 src/ 与 scripts/ 下所有 JS 做语法检查
const { execFileSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|cjs)$/.test(entry)) yield full;
  }
}

let count = 0;
for (const root of ['src', 'scripts']) {
  for (const file of walk(root)) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    count++;
    console.log('ok', file);
  }
}
console.log(`${count} files passed syntax check`);
