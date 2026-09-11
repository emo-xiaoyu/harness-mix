import { projectIcon } from './harness-mix-icons.js';

export function collaborationIcon(id: string, name: string, size = 22): HTMLElement {
  const aliases: Record<string, string> = { 'claude-code': 'claude', 'deepseek-harness': 'dsh', 'codex-harness': 'codex' };
  const key = id.toLowerCase();
  const icon = projectIcon('harnesses', aliases[key] ?? key, size, document);
  if (icon) return icon;
  const fallback = document.createElement('span');
  fallback.textContent = name.slice(0, 1).toUpperCase();
  fallback.setAttribute('aria-hidden', 'true');
  fallback.style.cssText = `display:inline-grid;place-items:center;width:${size}px;height:${size}px;flex:none;border-radius:6px;background:#8882;font-size:12px`;
  return fallback;
}
