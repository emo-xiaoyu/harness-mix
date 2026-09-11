const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = new Set(Object.keys(packageJson.scripts || {}));
const shellFence = /^(powershell|pwsh|bash|sh|shell|cmd|console)?$/i;

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
  });
}

const files = [path.join(root, 'README.md'), ...markdownFiles(path.join(root, 'docs'))];
const missing = [];
let checked = 0;

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inShellFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([^`]*)\s*$/);
    if (fence) {
      if (inShellFence) inShellFence = false;
      else inShellFence = shellFence.test(fence[1].trim());
      continue;
    }
    if (!inShellFence || /^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/\bnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      checked += 1;
      if (!scripts.has(match[1])) {
        missing.push(`${path.relative(root, file)}:${index + 1} npm run ${match[1]}`);
      }
    }
  }
}

if (missing.length) {
  console.error('Documented npm scripts missing from package.json:');
  for (const item of missing) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(`docs-command: ${checked} runnable npm commands verified across ${files.length} files`);
}
