// Project-owned assets compiled by scripts/build-native.cjs.
export function projectIcon(kind: 'harnesses' | 'models', id: string, size: number, doc: Document): HTMLImageElement | null {
  const globals = globalThis as any;
  const svg = globals.__HARNESS_MIX_ICONS__?.[kind]?.[id === 'codex-harness' ? 'codex' : id]?.svg;
  if (!svg) return null;
  const image = doc.createElement('img');
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // An SVG loaded as an image cannot inherit the surrounding text color.
  // Mask monochrome marks so they remain visible when the desktop theme changes.
  if (svg.includes('fill="currentColor"')) {
    const mask = `url("${image.src}")`;
    image.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/%3E';
    Object.assign(image.style, { backgroundColor: 'currentColor', maskImage: mask, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' });
  }
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
