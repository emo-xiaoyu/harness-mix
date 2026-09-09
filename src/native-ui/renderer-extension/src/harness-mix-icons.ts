// Project-owned assets compiled by scripts/build-native.cjs.
export function projectIcon(kind: 'harnesses' | 'models', id: string, size: number, doc: Document): HTMLImageElement | null {
  const globals = globalThis as any;
  const svg = globals.__HARNESS_MIX_ICONS__?.[kind]?.[id]?.svg;
  if (!svg) return null;
  const image = doc.createElement('img');
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  image.alt = '';
  image.draggable = false;
  image.dataset.harnessMixIcon = `${kind}/${id}`;
  Object.assign(image.style, { width: `${size}px`, height: `${size}px`, flex: 'none', objectFit: 'contain' });
  return image;
}
export function projectModelIcon(label: string, doc: Document): HTMLImageElement {
  const family = ((globalThis as any).__HARNESS_MIX_MODEL_FAMILIES__ ?? []).find((f: any) => new RegExp(f.pattern, 'i').test(label));
  return projectIcon('models', family?.id ?? 'astra', 18, doc)!;
}
