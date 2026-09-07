// Bounded line LCS; large inputs use a content-exact coarse replacement.
function diff(before = '', after = '') {
  const lines = s => s ? s.match(/[^\n]*\n|[^\n]+$/g) ?? [] : [];
  const a = lines(before), b = lines(after), rows = [];
  let old = 1, next = 1;
  const add = (kind, text) => rows.push({ kind, text: text.replace(/\r?\n$/, ''), old: kind === 'add' ? null : old++, next: kind === 'remove' ? null : next++ });
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { add('same', a[start]); start++; }
  let x = a.length, y = b.length;
  while (x > start && y > start && a[x - 1] === b[y - 1]) { x--; y--; }
  const n = x - start, m = y - start, coarse = n * m > 1_000_000;
  if (coarse) {
    a.slice(start, x).forEach(s => add('remove', s)); b.slice(start, y).forEach(s => add('add', s));
  } else {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { add('same', a[start + i++]); j++; }
      else if (j < m && (i === n || table[i][j + 1] > table[i + 1][j])) add('add', b[start + j++]);
      else add('remove', a[start + i++]);
    }
  }
  a.slice(x).forEach(s => add('same', s));
  return { rows, added: rows.filter(r => r.kind === 'add').length, removed: rows.filter(r => r.kind === 'remove').length, coarse };
}
module.exports = { diff };
