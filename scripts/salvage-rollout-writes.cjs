// One-off salvage: extract Write/Edit tool-call payloads for out/ paths from a
// ZCode model-io rollout journal and replay the write+edit chain to rebuild
// final file contents. Used to recover the promo-video generation scripts
// after the workspace out/ tree was deleted. Not part of any suite.
const fs = require('node:fs');
const path = require('node:path');

const journal = process.argv[2];
const destRoot = process.argv[3];
if (!journal || !destRoot) {
  console.error('usage: node salvage-rollout-writes.cjs <rollout.jsonl> <destRoot>');
  process.exit(1);
}

const lines = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean);
const occurrences = []; // {fp, tool, lineIdx, content?, old?, new?} in journal order

const normalize = fp => String(fp).replace(/\\/g, '/').replace(/^[A-Za-z]:\/+/, '').replace(new RegExp(`^${path.basename(process.cwd())}/`), '');

function scan(node, lineIdx) {
  if (Array.isArray(node)) { for (const x of node) scan(x, lineIdx); return; }
  if (!node || typeof node !== 'object') return;
  const isToolCall = (node.type === 'tool_use') || (typeof node.id === 'string' && node.id.startsWith('call_') && typeof node.name === 'string' && node.input && typeof node.input === 'object');
  if (isToolCall && node.input && typeof node.input.file_path === 'string') {
    const fp = normalize(node.input.file_path);
    if (/(^|\/)out\//.test(fp)) {
      occurrences.push({
        fp, tool: node.name, lineIdx,
        content: node.input.content != null ? String(node.input.content) : null,
        old: node.input.old_string != null ? String(node.input.old_string) : null,
        next: node.input.new_string != null ? String(node.input.new_string) : null,
        replaceAll: node.input.replace_all === true,
      });
    }
  }
  for (const v of Object.values(node)) scan(v, lineIdx);
}

let idx = 0;
for (const line of lines) {
  idx += 1;
  try { scan(JSON.parse(line), idx); } catch { /* malformed line */ }
}

// Replay: last Write wins as the base, then Edits that appear AFTER it in order.
// Edits before the last Write are already baked into that Write's content.
const byPath = new Map();
for (const occ of occurrences) {
  if (!byPath.has(occ.fp)) byPath.set(occ.fp, []);
  byPath.get(occ.fp).push(occ);
}

const summary = [];
for (const [fp, chain] of byPath) {
  const lastWriteIdx = chain.map(o => o.tool === 'Write').lastIndexOf(true);
  if (lastWriteIdx === -1) { summary.push(`SKIP (no Write captured)\t${fp}`); continue; }
  let text = chain[lastWriteIdx].content;
  let applied = 0, skipped = 0;
  for (const occ of chain.slice(lastWriteIdx + 1)) {
    if (occ.tool !== 'Edit' || occ.old == null || occ.next == null) continue;
    const count = text.split(occ.old).length - 1;
    if (count === 0 || (!occ.replaceAll && count > 1)) { skipped += 1; continue; }
    text = occ.replaceAll ? text.split(occ.old).join(occ.next) : text.replace(occ.old, occ.next);
    applied += 1;
  }
  const abs = path.join(destRoot, fp);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  summary.push(`OK\tline ${chain[lastWriteIdx].lineIdx} (+${applied}edits, ${skipped}skipped)\t${fp}\t${text.length} chars`);
}
console.log(summary.join('\n'));
console.log(`FILES ${summary.filter(s => s.startsWith('OK')).length} / paths ${byPath.size}`);
