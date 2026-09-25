/**
 * Model-picker popup geometry: the menu opens upward from the trigger and
 * clamps itself inside the viewport with a fixed collision margin. Constants
 * are layout behavior; the helpers below are pure so tests can drive them
 * with synthetic rects.
 */
const GAP_ABOVE_TRIGGER = 8;
const COLLISION_MARGIN = 8;

export const RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH = 260;
export const RENDERER_MODEL_PICKER_THINKING_COLUMN_WIDTH = 176;
export const RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT = 360;

export interface RendererMenuRect {
  left: number;
  right: number;
  top: number;
}

export interface RendererViewport {
  width: number;
  height: number;
}

export interface RendererMenuPlacement {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Preferred width, shrunk to leave collision margins on both sides. */
function fitWithin(preferred: number, viewportWidth: number): number {
  return Math.max(COLLISION_MARGIN, Math.min(preferred, viewportWidth - COLLISION_MARGIN * 2));
}

/** 模型列 +（可选）思考强度列的单弹层总宽度，随视口收缩 */
export function rendererModelPickerMenuWidth(twoColumn: boolean, viewportWidth: number): number {
  const preferred = twoColumn
    ? RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH + RENDERER_MODEL_PICKER_THINKING_COLUMN_WIDTH
    : RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH;
  return fitWithin(preferred, viewportWidth);
}

export function rendererModelPickerMainMenuPlacement(
  triggerRect: RendererMenuRect,
  viewport: RendererViewport,
  width = RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
): RendererMenuPlacement {
  const rightMost = viewport.width - COLLISION_MARGIN - width;
  return {
    left: clamp(triggerRect.right - width, COLLISION_MARGIN, rightMost),
    width,
    // 弹层自触发器向上展开：可用高度 = 触发器顶部到视口顶部
    bottom: Math.max(COLLISION_MARGIN, viewport.height - triggerRect.top + GAP_ABOVE_TRIGGER),
    maxHeight: Math.max(
      COLLISION_MARGIN * 2,
      Math.min(
        RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT,
        triggerRect.top - GAP_ABOVE_TRIGGER - COLLISION_MARGIN,
      ),
    ),
  };
}
