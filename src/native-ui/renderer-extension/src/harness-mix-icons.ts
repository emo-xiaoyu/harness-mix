// Project-owned assets compiled by scripts/build-native.cjs.
function isMonochromeSvg(svg: string): boolean {
  const fills = Array.from(svg.matchAll(/\bfill\s*=\s*["']([^"']+)["']/gi), match => match[1]?.trim().toLowerCase() ?? '');
  return fills.includes('currentcolor') && fills.every(fill => fill === 'currentcolor' || fill === 'none');
}

export function projectIcon(kind: 'harnesses' | 'models', id: string, size: number, doc: Document): HTMLImageElement | null {
  const globals = globalThis as any;
  const svg = globals.__HARNESS_MIX_ICONS__?.[kind]?.[id === 'codex-harness' ? 'codex' : id]?.svg;
  if (!svg) return null;
  const image = doc.createElement('img');
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // An SVG loaded as an image cannot inherit the surrounding text color.
  // Mask monochrome marks so they remain visible when the desktop theme changes.
  // Keep multi-color brand marks as images so explicit fills (for example
  // Qoder's green path) are not flattened to the current text color.
  if (isMonochromeSvg(svg)) {
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
