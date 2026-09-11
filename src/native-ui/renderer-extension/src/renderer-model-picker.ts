import { projectModelIcon } from './harness-mix-icons.js';
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import {
  rendererModelPickerMainMenuPlacement,
  rendererModelPickerMenuWidth,
  RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
  RENDERER_MODEL_PICKER_THINKING_COLUMN_WIDTH,
} from "./renderer-model-picker-positioning.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const MENU_CLASSES =
  "fixed z-50 overflow-hidden rounded-xl bg-token-dropdown-background/90 text-token-foreground shadow-lg backdrop-blur-xl";

const SEARCH_INPUT_CLASSES =
  "mb-1 w-full shrink-0 rounded-lg border border-token-border bg-token-dropdown-background/95 px-2 py-1.5 text-sm text-token-foreground outline-none placeholder:text-token-text-tertiary disabled:cursor-not-allowed disabled:opacity-40";

const OPTION_CLASSES =
  "flex w-full cursor-interaction items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-token-foreground outline-none enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

const HEADING_CLASSES = "px-2 pb-1 pt-1.5 text-sm text-token-text-tertiary";
const MODEL_TRIGGER_MAX_WIDTH = "min(200px, 26vw)";
const MODEL_SCROLLBAR_STYLE_ATTRIBUTE = "data-codexhost-model-picker-scrollbar";

export interface RendererModelControlView {
  status: "idle" | "waitingForAdapter" | "loading" | "ready" | "selecting" | "empty" | "error";
  catalog?: HarnessModelCatalog;
  selected?: HarnessModelRef;
  selectedThinkingOptionId?: HarnessThinkingOptionId;
  resolvedModelLabel?: string;
  thinkingSelectionSupported?: boolean;
  error?: string;
}

export interface RendererModelPickerPresentation {
  modelLabel: string;
  thinkingLabel?: string;
  resolvedModelLabel?: string;
  thinkingOptions: HarnessThinkingOption[];
  showThinkingSection: boolean;
  thinkingSelectionEnabled: boolean;
}

interface ModelOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
  searchText: string;
}

interface ThinkingOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
}

export interface RendererModelPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  label: HTMLElement;
  thinkingLabel: HTMLElement;
  menu: HTMLElement;
  searchInput: HTMLInputElement;
  searchHeader: HTMLElement;
  searchEmpty: HTMLElement;
  options: Map<string, ModelOptionControl>;
  thinkingOptions: Map<string, ThinkingOptionControl>;
  thinkingExpanded: boolean;
  close(): void;
  dispose(): void;
}

function popoverOpen(menu: HTMLElement): boolean {
  return menu.matches(":popover-open");
}

function ensureModelScrollbarStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector(`style[${MODEL_SCROLLBAR_STYLE_ATTRIBUTE}]`)) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute(MODEL_SCROLLBAR_STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [data-codexhost-model-scrollable] {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-track {
      background: transparent;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb {
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.28);
      background-clip: padding-box;
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.42);
    }
    [data-codexhost-model-scrollable]::-webkit-scrollbar-button {
      display: none;
      width: 0;
      height: 0;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
}

export function thinkingOptionsForModel(
  catalog: HarnessModelCatalog | undefined,
  selected: HarnessModelRef | undefined,
): HarnessThinkingOption[] {
  const supported = catalog?.models.find(
    (model) => model.ref.id === selected?.id,
  )?.supportedThinkingOptionIds;
  if (!supported) return [];
  return catalog?.thinkingOptions.filter((option) => supported.includes(option.id)) ?? [];
}

export function isRendererModelPickerDisabled(view: RendererModelControlView): boolean {
  return (
    view.status === "waitingForAdapter" ||
    view.status === "loading" ||
    view.status === "selecting" ||
    view.status === "empty" ||
    view.catalog === undefined
  );
}

export function shouldCloseRendererModelPicker(view: RendererModelControlView): boolean {
  return isRendererModelPickerDisabled(view) && view.status !== "selecting";
}

function isTransientPickerState(view: RendererModelControlView): boolean {
  return view.status === "idle" || view.status === "loading";
}

export function rendererModelPickerPresentation(
  view: RendererModelControlView,
): RendererModelPickerPresentation {
  const selectedModel = view.catalog?.models.find((model) => model.ref.id === view.selected?.id);
  const thinkingOptions =
    view.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(view.catalog, view.selected);
  const selectedThinking = thinkingOptions.find(({ id }) => id === view.selectedThinkingOptionId);
  const showThinkingSection =
    thinkingOptions.length > 0 &&
    !(thinkingOptions.length === 1 && thinkingOptions[0]?.id === "off");
  const resolvedModelLabel = view.resolvedModelLabel ?? selectedModel?.resolvedModelLabel;
  let modelLabel = "Select model";
  if (selectedModel) modelLabel = selectedModel.label;
  else if (view.status === "waitingForAdapter" || view.status === "loading") {
    modelLabel = "Loading models...";
  } else if (view.status === "selecting") modelLabel = "Selecting...";
  else if (view.status === "empty") modelLabel = "No models";
  else if (view.status === "error") modelLabel = "Models unavailable";
  return {
    modelLabel,
    ...(resolvedModelLabel && resolvedModelLabel !== modelLabel ? { resolvedModelLabel } : {}),
    thinkingOptions,
    showThinkingSection,
    thinkingSelectionEnabled: thinkingOptions.length > 1,
    ...(showThinkingSection && selectedThinking ? { thinkingLabel: selectedThinking.label } : {}),
  };
}

function positionMenu(control: RendererModelPickerControl): void {
  const triggerRect = control.trigger.getBoundingClientRect();
  const thinkingColumn = control.menu.querySelector<HTMLElement>("[data-codexhost-thinking-column]");
  const twoColumn = control.thinkingExpanded && thinkingColumn !== null;
  if (thinkingColumn) thinkingColumn.style.display = twoColumn ? "flex" : "none";
  control.menu.dataset.twoColumn = String(twoColumn);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const placement = rendererModelPickerMainMenuPlacement(
    triggerRect,
    viewport,
    rendererModelPickerMenuWidth(twoColumn, viewport.width),
  );
  control.menu.style.setProperty("width", `${placement.width}px`, "important");
  control.menu.style.left = `${placement.left}px`;
  control.menu.style.maxWidth = `${placement.width}px`;
  control.menu.style.right = "auto";
  control.menu.style.top = "auto";
  control.menu.style.bottom = `${placement.bottom}px`;
  // 列内部滚动：弹层本身不滚动，模型列表在给定最大高度内滚动
  const listMaxHeight = placement.maxHeight ?? 320;
  for (const column of control.menu.querySelectorAll<HTMLElement>("[data-codexhost-model-scrollable]")) {
    column.style.maxHeight = `${listMaxHeight}px`;
  }
}

export function syncRendererModelTriggerClass(control: RendererModelPickerControl): void {
  // Keep codexhost controls independent from Codex's private utility classes.
  // Codex can rename or remove those between Desktop releases; our own
  // `TRIGGER_CHIP_CLASS` chrome (see renderer-trigger-chip-style.ts) does not.
  control.trigger.className = TRIGGER_CHIP_CLASS;
  control.trigger.style.width = "fit-content";
  control.trigger.style.maxWidth = MODEL_TRIGGER_MAX_WIDTH;
}

function createCheck(): HTMLElement {
  const check = document.createElement("span");
  check.textContent = "✓";
  check.setAttribute("aria-hidden", "true");
  check.className = "w-4 shrink-0 text-token-text-secondary";
  check.style.width = "16px";
  check.style.flex = "none";
  return check;
}

function createHeading(text: string): HTMLElement {
  const heading = document.createElement("div");
  heading.textContent = text;
  heading.className = HEADING_CLASSES;
  heading.setAttribute("role", "presentation");
  return heading;
}

export function syncRendererLabelText(
  element: { textContent: string | null },
  text: string,
): boolean {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

function applyModelSearchFilter(control: RendererModelPickerControl): void {
  const query = control.searchInput.value.trim().toLowerCase();
  let visibleCount = 0;
  for (const option of control.options.values()) {
    const matches = query.length === 0 || option.searchText.includes(query);
    option.button.hidden = !matches;
    if (matches) visibleCount += 1;
  }
  control.searchEmpty.hidden = query.length === 0 || visibleCount > 0;
}

export function mountRendererModelPicker(
  composerId: string,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
): RendererModelPickerControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.setAttribute("data-codexhost-model-control", composerId);
  root.className = "relative min-w-0";
  root.style.display = "none";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("data-state", "closed");
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.gap = "4px";
  trigger.style.font = "400 13px/18px system-ui, sans-serif";
  trigger.style.letterSpacing = "0";

  const label = document.createElement("span");
  label.style.color = "inherit";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";

  const thinkingLabel = document.createElement("span");
  thinkingLabel.style.color = "var(--color-text-tertiary, #8f8f8f)";
  thinkingLabel.style.flex = "none";
  thinkingLabel.style.maxWidth = "96px";
  thinkingLabel.style.overflow = "hidden";
  thinkingLabel.style.textOverflow = "ellipsis";
  thinkingLabel.style.whiteSpace = "nowrap";
  thinkingLabel.hidden = true;

  trigger.append(label, thinkingLabel);

  // 单一弹层、双列主从布局：左列模型列表（带搜索），右列当前选中模型的思考强度。
  // 之前是“Thinking 主弹层 + 悬停展开 Model 子弹层”的双浮层结构，层级倒置且错位。
  const menu = document.createElement("div");
  menu.id = `${composerId}-model-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Model and Thinking");
  // Dismissal is handled manually (onDocumentPointerDown / onDocumentKeyDown) so
  // search keystrokes and option clicks never trigger light-dismiss surprises.
  menu.setAttribute("popover", "manual");
  menu.className = MENU_CLASSES;
  ensureModelScrollbarStyle(document);
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.margin = "0";
  menu.style.padding = "4px";
  menu.style.border = "0";
  trigger.setAttribute("aria-controls", menu.id);

  const options = new Map<string, ModelOptionControl>();
  const thinkingOptions = new Map<string, ThinkingOptionControl>();
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search models";
  searchInput.setAttribute("aria-label", "Search models");
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.className = SEARCH_INPUT_CLASSES;
  const searchHeader = document.createElement("div");
  searchHeader.style.position = "sticky";
  searchHeader.style.top = "0";
  searchHeader.style.zIndex = "2";
  searchHeader.style.margin = "-4px";
  searchHeader.style.padding = "4px";
  searchHeader.style.backgroundColor = "Canvas";
  const searchEmpty = document.createElement("div");
  searchEmpty.dataset.codexhostModelSearchEmpty = "true";
  searchEmpty.textContent = "No matching models";
  searchEmpty.className = "block px-2 py-2 text-sm text-token-text-tertiary";
  searchEmpty.hidden = true;
  const onSearchInput = (): void => applyModelSearchFilter(control);
  searchInput.addEventListener("input", onSearchInput);
  // The search box lives in an injected popover. The harness's global keydown
  // and focus handling must never see keystrokes typed here, or it refocuses
  // the composer and yanks the cursor out of the box. Silence these events at
  // the input so they do not bubble to the harness (React event delegation).
  const silencedEventTypes = [
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "change",
  ] as const;
  const silenceForHarness = (event: Event): void => {
    event.stopPropagation();
  };
  for (const type of silencedEventTypes) {
    searchInput.addEventListener(type, silenceForHarness);
  }
  // Safety net: if the harness still manages to steal focus to the composer
  // (e.g. via an earlier capture-phase listener), pull the cursor back into the
  // search box as long as the menu remains open.
  const onSearchBlur = (): void => {
    if (!popoverOpen(menu)) return;
    const active = document.activeElement;
    const movedToComposer =
      active === document.body ||
      (active instanceof Element &&
        (active.matches('textarea, [contenteditable="true"], [role="textbox"]') ||
          active.closest('textarea, [contenteditable="true"], [role="textbox"]') !== null));
    if (!movedToComposer) return;
    requestAnimationFrame(() => {
      if (popoverOpen(menu) && searchInput.isConnected) searchInput.focus();
    });
  };
  searchInput.addEventListener("blur", onSearchBlur);
  const close = (): void => {
    if (popoverOpen(menu)) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("data-state", "closed");
    control.thinkingExpanded = false;
    if (searchInput.value !== "") {
      searchInput.value = "";
      applyModelSearchFilter(control);
    }
  };
  const open = (): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    menu.showPopover();
    positionMenu(control);
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("data-state", "open");
    control.searchInput.focus();
  };
  const onTriggerClick = (): void => {
    if (popoverOpen(menu)) close();
    else open();
  };
  const onToggle = (): void => {
    const openState = popoverOpen(menu);
    trigger.setAttribute("aria-expanded", String(openState));
    trigger.setAttribute("data-state", openState ? "open" : "closed");
  };
  const onMenuClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!target || target.disabled) return;
    if (target.dataset.thinkingOptionId) {
      close();
      trigger.focus();
      onSelectThinking(target.dataset.thinkingOptionId);
      return;
    }
    // Keep the model list open until the selected model's native catalog arrives.
    // The previous model's options cannot decide whether the next one supports thinking.
    if (target?.dataset.modelId) {
      const modelId = target.dataset.modelId;
      control.thinkingExpanded = true;
      onSelectModel(modelId);
      positionMenu(control);
    }
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!popoverOpen(menu)) return;
    const target = event.target instanceof Node ? event.target : null;
    if (target && (root.contains(target) || menu.contains(target))) {
      return;
    }
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!popoverOpen(menu)) return;
    event.preventDefault();
    close();
    trigger.focus();
  };
  const onViewportChange = (): void => {
    if (popoverOpen(menu)) positionMenu(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("toggle", onToggle);
  menu.addEventListener("click", onMenuClick);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  // Keep the popover in the document viewport's coordinate space. The native
  // composer toolbar can be affected by browser zoom or a transformed ancestor;
  // portaling the menu prevents fixed-position coordinates from being resolved
  // in that local coordinate space.
  root.append(trigger);
  document.body.append(menu);
  searchHeader.append(searchInput);

  const control: RendererModelPickerControl = {
    root,
    trigger,
    label,
    thinkingLabel,
    menu,
    searchInput,
    searchHeader,
    searchEmpty,
    options,
    thinkingOptions,
    thinkingExpanded: false,
    close,
    dispose() {
      close();
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("toggle", onToggle);
      menu.removeEventListener("click", onMenuClick);
      searchInput.removeEventListener("input", onSearchInput);
      for (const type of silencedEventTypes) {
        searchInput.removeEventListener(type, silenceForHarness);
      }
      searchInput.removeEventListener("blur", onSearchBlur);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      menu.remove();
      root.remove();
    },
  };
  syncRendererModelTriggerClass(control);
  return control;
}

function rebuildOptions(control: RendererModelPickerControl, view: RendererModelControlView): void {
  const presentation = rendererModelPickerPresentation(view);
  control.options.clear();
  control.thinkingOptions.clear();
  control.menu.dataset.twoColumn = String(presentation.showThinkingSection);
  control.menu.replaceChildren();

  // 左列：模型（搜索 + 列表，列表内部滚动）
  const modelColumn = document.createElement("div");
  modelColumn.className = "flex min-w-0 flex-col";
  modelColumn.style.display = "flex";
  modelColumn.style.flexDirection = "column";
  modelColumn.style.width = `${RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH}px`;
  modelColumn.style.minWidth = "0";
  const modelList = document.createElement("div");
  modelList.setAttribute("data-codexhost-model-scrollable", "true");
  modelList.style.overflowY = "auto";
  modelList.style.minHeight = "0";
  modelColumn.append(createHeading("Model"), control.searchHeader, control.searchEmpty, modelList);

  for (const model of view.catalog?.models ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelId = model.ref.id;
    button.setAttribute("role", "menuitemradio");
    button.className = OPTION_CLASSES;

    const text = document.createElement("span");
    text.textContent = model.label;
    text.className = "min-w-0 flex-1 truncate";
    text.title = model.label;
    const check = createCheck();
    button.append(projectModelIcon(model.label, button.ownerDocument), text, check);
    control.options.set(model.ref.id, {
      button,
      check,
      searchText: `${model.label} ${model.ref.id}`.toLowerCase(),
    });
    modelList.append(button);
  }

  const columns = document.createElement("div");
  columns.className = "flex items-stretch";
  columns.style.display = "flex";
  columns.style.alignItems = "stretch";
  columns.append(modelColumn);

  // 右列：当前选中模型适用的思考强度档位
  if (presentation.showThinkingSection) {
    const thinkingColumn = document.createElement("div");
    thinkingColumn.dataset.codexhostThinkingColumn = "true";
    thinkingColumn.className = "flex min-w-0 flex-col";
    thinkingColumn.style.display = control.thinkingExpanded ? "flex" : "none";
    thinkingColumn.style.flexDirection = "column";
    thinkingColumn.style.width = `${RENDERER_MODEL_PICKER_THINKING_COLUMN_WIDTH}px`;
    thinkingColumn.style.borderLeft = "1px solid var(--border-token-border, rgba(128, 128, 128, 0.25))";
    thinkingColumn.style.marginLeft = "4px";
    thinkingColumn.style.paddingLeft = "4px";
    thinkingColumn.append(createHeading("Thinking"));
    const thinkingList = document.createElement("div");
    thinkingList.setAttribute("data-codexhost-model-scrollable", "true");
    thinkingList.style.overflowY = "auto";
    thinkingList.style.minHeight = "0";
    for (const option of presentation.thinkingOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.thinkingOptionId = option.id;
      button.setAttribute("role", "menuitemradio");
      button.className = OPTION_CLASSES;

      const text = document.createElement("span");
      text.textContent = option.label;
      text.className = "min-w-0 flex-1 truncate";
      const check = createCheck();
      button.append(text, check);
      control.thinkingOptions.set(option.id, { button, check });
      thinkingList.append(button);
    }
    thinkingColumn.append(thinkingList);
    columns.append(thinkingColumn);
  }

  control.menu.append(columns);
  applyModelSearchFilter(control);
  // rebuildOptions replaced the menu children above, which moves the focused
  // search input out and back in and therefore drops focus; restore it while
  // the menu stays open.
  if (popoverOpen(control.menu)) control.searchInput.focus();
}

export function renderRendererModelPicker(
  control: RendererModelPickerControl,
  view: RendererModelControlView,
  visible: boolean,
): void {
  control.root.style.display = visible ? "inline-flex" : "none";
  control.root.style.alignItems = "center";
  control.root.style.alignSelf = "center";
  control.root.style.height = "28px";
  control.root.style.flex = "0 0 auto";
  control.root.style.verticalAlign = "middle";
  if (!visible) {
    control.close();
    return;
  }
  const presentation = rendererModelPickerPresentation(view);
  const catalogSignature = JSON.stringify({
    models: view.catalog?.models,
    thinkingOptions: presentation.thinkingOptions,
    showThinkingSection: presentation.showThinkingSection,
    modelLabel: presentation.modelLabel,
  });
  // While the popover is open and the picker passes through a transient state
  // (conversation target rebind or catalog reload during turn renders), keep the
  // already-rendered menu stable: do not rebuild it to an empty list or
  // force-close it under the pointer. It refreshes once a real catalog returns.
  const keepOpenMenu = popoverOpen(control.menu) && isTransientPickerState(view);
  if (control.root.dataset.catalogSignature !== catalogSignature && !keepOpenMenu) {
    rebuildOptions(control, view);
    control.root.dataset.catalogSignature = catalogSignature;
    if (popoverOpen(control.menu)) positionMenu(control);
  }

  syncRendererLabelText(control.label, presentation.modelLabel);
  control.label.title = presentation.modelLabel;
  const secondaryLabel = presentation.thinkingLabel ?? presentation.resolvedModelLabel;
  syncRendererLabelText(control.thinkingLabel, secondaryLabel ?? "");
  control.thinkingLabel.hidden = secondaryLabel === undefined;
  const accessibleLabel = secondaryLabel
    ? `${presentation.modelLabel}, ${secondaryLabel}`
    : presentation.modelLabel;
  control.trigger.title = view.error ?? accessibleLabel;
  control.trigger.setAttribute("aria-label", `Model: ${accessibleLabel}`);
  control.trigger.setAttribute(
    "aria-busy",
    String(view.status === "loading" || view.status === "selecting"),
  );
  control.trigger.disabled = isRendererModelPickerDisabled(view);
  if (shouldCloseRendererModelPicker(view) && !keepOpenMenu) control.close();
  // The search input must not mirror the trigger's disabled state: disabling a
  // focused element blurs it, which would drop the cursor out of the box during
  // transient states (e.g. "selecting"). Filtering is client-side and safe.

  for (const [modelId, option] of control.options) {
    const selected = modelId === view.selected?.id;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.button.disabled = control.trigger.disabled;
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
  for (const [thinkingOptionId, option] of control.thinkingOptions) {
    const selected = thinkingOptionId === view.selectedThinkingOptionId;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.classList.toggle("bg-token-list-hover-background", selected);
    option.button.disabled = control.trigger.disabled || !presentation.thinkingSelectionEnabled;
    option.check.style.visibility = selected ? "visible" : "hidden";
  }
}
