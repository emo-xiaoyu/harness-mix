import { projectIcon } from "../harness-mix-icons.js";

// 设置页共享的 Harness 品牌图标：优先用真实品牌 SVG（projectIcon，含单色 mask 处理），
// 找不到时回退为首字母圆角徽标，保证任何 id 都有一个可用的视觉锚点。

export function createHarnessIconElement(
  ownerDocument: Document,
  harnessId: string,
  displayName: string,
  size = 16,
): HTMLElement {
  const icon = projectIcon("harnesses", harnessId, size, ownerDocument);
  if (icon) return icon;
  const badge = ownerDocument.createElement("span");
  const label = (displayName || harnessId || "?").trim().slice(0, 1).toUpperCase();
  badge.textContent = label;
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
