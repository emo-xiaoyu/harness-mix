import { projectIcon } from "../harness-mix-icons.js";

// Shared brand mark for harnesses across the settings pages. When the real
// branded SVG is unavailable (unknown id, masked artwork), fall back to a
// rounded initial-letter badge so every harness keeps a recognizable anchor.
export function createHarnessIconElement(
  ownerDocument: Document,
  harnessId: string,
  displayName: string,
  size = 16,
): HTMLElement {
  const branded = projectIcon("harnesses", harnessId, size, ownerDocument);
  if (branded) return branded;
  const badge = ownerDocument.createElement("span");
  const initial = (displayName || harnessId || "?").trim().slice(0, 1).toUpperCase();
  badge.textContent = initial;
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.width = `${size}px`;
  badge.style.height = `${size}px`;
  badge.style.flex = "none";
  badge.style.borderRadius = "4px";
  badge.style.background = "color-mix(in srgb, CanvasText 10%, transparent)";
  badge.style.color = "CanvasText";
  badge.style.font = `600 ${Math.max(9, Math.round(size * 0.58))}px/1 system-ui, sans-serif`;
  return badge;
}
