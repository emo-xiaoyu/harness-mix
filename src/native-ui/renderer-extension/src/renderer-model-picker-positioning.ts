const MAIN_MENU_SIDE_OFFSET = 8;
const COLLISION_PADDING = 8;

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

function clampPosition(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function fitWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.max(
    COLLISION_PADDING,
    Math.min(preferredWidth, viewportWidth - COLLISION_PADDING * 2),
  );
}

// 模型列 +（可选）思考强度列的单弹层总宽度，随视口收缩
export function rendererModelPickerMenuWidth(twoColumn: boolean, viewportWidth: number): number {
  const preferred = twoColumn
    ? RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH + RENDERER_MODEL_PICKER_THINKING_COLUMN_WIDTH
    : RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH;
  return fitWidth(preferred, viewportWidth);
}

export function rendererModelPickerMainMenuPlacement(
  triggerRect: RendererMenuRect,
  viewport: RendererViewport,
  width = RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
): RendererMenuPlacement {
  const maxLeft = viewport.width - COLLISION_PADDING - width;
  return {
    left: clampPosition(triggerRect.right - width, COLLISION_PADDING, maxLeft),
    width,
    bottom: Math.max(COLLISION_PADDING, viewport.height - triggerRect.top + MAIN_MENU_SIDE_OFFSET),
    // 弹层自触发器向上展开：可用高度 = 触发器顶部到视口顶部
    maxHeight: Math.max(
      COLLISION_PADDING * 2,
      Math.min(
        RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT,
        triggerRect.top - MAIN_MENU_SIDE_OFFSET - COLLISION_PADDING,
      ),
    ),
  };
}
