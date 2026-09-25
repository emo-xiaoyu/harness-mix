/**
 * Shared, host-independent "chip" chrome for the small trailing-cluster
 * trigger buttons we own (Model, Permission mode, Credits, Usage).
 *
 * Codex's own composer button class names are private and can change between
 * Desktop releases, which would silently strip all chrome from these
 * controls. Our own stylesheet keeps the look stable: the base class carries
 * the pseudo-class behavior (`:hover`, `:disabled`, `[data-state="open"]`)
 * that inline styles cannot express; each control still sets inline
 * height/padding/font-size to size itself.
 */
const STYLE_ATTRIBUTE = "data-harnessmix-trigger-chip-style";
export const TRIGGER_CHIP_CLASS = "harnessmix-trigger-chip";

export function ensureRendererTriggerChipStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    .${TRIGGER_CHIP_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      border: 0;
      border-radius: 9999px;
      background: transparent;
      color: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    .${TRIGGER_CHIP_CLASS}:hover:not(:disabled) {
      background: rgba(127, 127, 127, 0.08);
    }
    .${TRIGGER_CHIP_CLASS}:active:not(:disabled) {
      background: rgba(127, 127, 127, 0.16);
    }
    .${TRIGGER_CHIP_CLASS}[data-state="open"] {
      background: rgba(127, 127, 127, 0.08);
    }
    .${TRIGGER_CHIP_CLASS}:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}
