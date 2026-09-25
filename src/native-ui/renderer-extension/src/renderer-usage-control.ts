import type { ThreadUsageSnapshot } from "@harnessmix/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CLOSE_GRACE_MS = 140;
const RING_HOT_THRESHOLD = 90;
const RING_WARN_THRESHOLD = 70;
const RING_HOT_COLOR = "#c45c4a";
const RING_WARN_COLOR = "#c9a227";
const RING_OK_COLOR = "#3d9a64";

export interface RendererUsageControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  label: HTMLSpanElement;
  locale: RendererSettingsLocale;
  onOpen: (() => void) | null;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

interface RendererUsageMessages {
  readonly usage: string;
  readonly account: string;
  readonly context: string;
  readonly recordedCredits: string;
  readonly latestCacheHit: string;
  readonly outputSpeed: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly reasoning: string;
  readonly totalTokens: string;
  readonly inputOutput: string;
  readonly sessionCostEstimate: string;
  readonly threadUsage: string;
  readonly threadUsageDetails: string;
  readonly tokensSummary: string;
  readonly tokensPerSecond: string;
}

const ENGLISH_USAGE_MESSAGES: RendererUsageMessages = Object.freeze({
  usage: "Usage",
  account: "Account",
  context: "Context",
  recordedCredits: "Recorded usage",
  latestCacheHit: "Latest cache hit",
  outputSpeed: "Output speed",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  reasoning: "Reasoning",
  totalTokens: "Total tokens",
  inputOutput: "Input / output",
  sessionCostEstimate: "Session cost estimate",
  threadUsage: "Thread Usage",
  threadUsageDetails: "Thread Usage details",
  tokensSummary: "tokens",
  tokensPerSecond: "tok/s",
});

const CHINESE_USAGE_MESSAGES: RendererUsageMessages = Object.freeze({
  usage: "用量",
  account: "账号",
  context: "上下文",
  recordedCredits: "已记录消耗",
  latestCacheHit: "最近缓存命中率",
  outputSpeed: "输出速度",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  reasoning: "推理",
  totalTokens: "Token 总数",
  inputOutput: "输入 / 输出",
  sessionCostEstimate: "会话费用估算",
  threadUsage: "对话用量",
  threadUsageDetails: "对话用量详情",
  tokensSummary: "Token",
  tokensPerSecond: "Token/秒",
});

export function rendererUsageMessages(locale: RendererSettingsLocale): RendererUsageMessages {
  return locale === "zh-CN" ? CHINESE_USAGE_MESSAGES : ENGLISH_USAGE_MESSAGES;
}

/** Fixed-precision decimal with meaningless trailing zeros (and a lone dot) removed. */
function fixedDecimal(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.?0+$/u, "");
}

export function formatRendererCacheHitRate(value: number): string {
  return `CH ${fixedDecimal(value, 1)}%`;
}

export function formatRendererCost(value: number): string {
  return `$${value.toFixed(3)}`;
}

export function formatRendererCredits(value: number): string {
  return `${value > 0 && value < 0.001 ? "<0.001" : fixedDecimal(value, 3)} credits`;
}

export function formatRendererTokenRate(
  value: number,
  locale: RendererSettingsLocale = "en",
): string {
  return `${fixedDecimal(value, 1)} ${rendererUsageMessages(locale).tokensPerSecond}`;
}

export function formatRendererTokenCount(value: number): string {
  const magnitude = Math.abs(value);
  const magnitudeLabel =
    magnitude < 1_000
      ? `${Math.round(magnitude)}`
      : magnitude < 1_000_000
        ? `${fixedDecimal(magnitude / 1_000, 1)}k`
        : magnitude < 1_000_000_000
          ? `${fixedDecimal(magnitude / 1_000_000, 1)}M`
          : `${fixedDecimal(magnitude / 1_000_000_000, 1)}B`;
  return `${value < 0 ? "-" : ""}${magnitudeLabel}`;
}

export function formatRendererContextSummary(usedTokens: number, windowTokens: number): string {
  return `${fixedDecimal((usedTokens / windowTokens) * 100, 1)}% / ${formatRendererTokenCount(windowTokens)}`;
}

export function formatRendererCreditsPercent(value: number): string {
  return `${fixedDecimal(value, 1)}%`;
}

export interface RendererUsageRingOptions {
  size: number;
  strokeWidth: number;
  color: string;
  trackColor?: string;
}

/** Radial 0-100 progress indicator reused by the Usage and Credits pills/popovers. */
export function createRendererUsageRing(
  percent: number,
  options: RendererUsageRingOptions,
): SVGSVGElement {
  const size = options.size;
  const strokeWidth = options.strokeWidth;
  const ringColor = options.color;
  const trackColor = options.trackColor ?? "color-mix(in srgb, currentColor 18%, transparent)";
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);
  const mid = size / 2;

  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.display = "block";
  svg.style.flex = "0 0 auto";
  svg.style.transform = "rotate(-90deg)";

  const circle = (stroke: string, extra: (node: SVGCircleElement) => void): SVGCircleElement => {
    const node = document.createElementNS(SVG_NAMESPACE, "circle");
    node.setAttribute("cx", String(mid));
    node.setAttribute("cy", String(mid));
    node.setAttribute("r", String(radius));
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", stroke);
    node.setAttribute("stroke-width", String(strokeWidth));
    extra(node);
    return node;
  };

  svg.append(
    circle(trackColor, () => {}),
    circle(ringColor, (node) => {
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("stroke-dasharray", String(circumference));
      node.setAttribute("stroke-dashoffset", String(dashOffset));
    }),
  );
  return svg;
}

export function formatRendererPlanReset(
  unixSeconds: number,
  locale?: RendererSettingsLocale,
): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : undefined, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRendererPlanWindow(
  usedPercent: number,
  resetsAtUnix?: number,
  locale?: RendererSettingsLocale,
): string {
  const percent = formatRendererCreditsPercent(usedPercent);
  if (resetsAtUnix === undefined) return percent;
  const reset = formatRendererPlanReset(resetsAtUnix, locale);
  return reset.length > 0 ? `${percent} · ${reset}` : percent;
}

export function rendererUsageTriggerMaxWidth(): string {
  return "min(180px, 30vw)";
}

/** True when the snapshot carries at least one field the Usage popover can display. */
export function rendererUsageHasDisplayData(usage: ThreadUsageSnapshot | null): boolean {
  if (!usage) return false;
  return (
    usage.cacheHitRatePercent !== undefined ||
    usage.outputTokensPerSecond !== undefined ||
    usage.totalCostUsd !== undefined ||
    usage.totalCredits !== undefined ||
    usage.contextUsagePercent !== undefined ||
    (usage.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined) ||
    usage.totalTokens !== undefined ||
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.cacheWriteInputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.reasoningOutputTokens !== undefined
  );
}

/**
 * Common card look for the Usage/Credits popovers. `Canvas`/`CanvasText` keep the
 * palette tied to the host page, and `light-dark()` picks per-theme elevation:
 * light surfaces stay near-white with a soft tight shadow, dark surfaces are
 * tinted toward the foreground with a deeper, softer shadow. Mixing the two
 * recipes (tinting a light fill, or reusing the tight shadow on dark) produces
 * flat grey or smudged halos, hence the split.
 */
export function applyRendererPopoverChrome(popover: HTMLElement): void {
  popover.style.border =
    "1px solid light-dark(rgba(15, 23, 42, 0.10), color-mix(in srgb, CanvasText 16%, transparent))";
  popover.style.borderRadius = "14px";
  popover.style.backgroundColor = "light-dark(Canvas, color-mix(in srgb, Canvas 88%, white 12%))";
  popover.style.color = "CanvasText";
  popover.style.boxShadow =
    "light-dark(0 10px 24px rgba(15, 23, 42, 0.12), 0 20px 45px rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";
}

function contextRingColor(contextPercent: number): string {
  if (contextPercent >= RING_HOT_THRESHOLD) return RING_HOT_COLOR;
  if (contextPercent >= RING_WARN_THRESHOLD) return RING_WARN_COLOR;
  return RING_OK_COLOR;
}

function appendDetailRow(
  popover: HTMLDivElement,
  label: string,
  value: string,
  allowWrap = false,
): void {
  const row = document.createElement("div");
  row.style.display = "grid";
  row.style.gridTemplateColumns = allowWrap ? "auto minmax(0, 1fr)" : "minmax(0, 1fr) auto";
  row.style.gap = "20px";
  row.style.padding = "4px 0";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  labelNode.style.color = "color-mix(in srgb, currentColor 68%, transparent)";
  const valueNode = document.createElement("span");
  valueNode.textContent = value;
  valueNode.style.fontVariantNumeric = "tabular-nums";
  valueNode.style.textAlign = "right";
  if (allowWrap) {
    valueNode.style.overflowWrap = "anywhere";
    valueNode.title = value;
  }
  row.append(labelNode, valueNode);
  popover.append(row);
}

function contextDetailText(usage: ThreadUsageSnapshot): string {
  if (usage.contextUsagePercent !== undefined) {
    return `${fixedDecimal(usage.contextUsagePercent, 1)}%`;
  }
  if (usage.contextUsedTokens === undefined || usage.contextWindowTokens === undefined) {
    return "";
  }
  if (usage.contextWindowTokens <= 0) {
    return `/${formatRendererTokenCount(usage.contextWindowTokens)}`;
  }
  const percent = (usage.contextUsedTokens / usage.contextWindowTokens) * 100;
  return `${fixedDecimal(percent, 1)}% / ${formatRendererTokenCount(usage.contextWindowTokens)}`;
}

function rebuildDetails(
  popover: HTMLDivElement,
  usage: ThreadUsageSnapshot | null,
  messages: RendererUsageMessages,
  locale: RendererSettingsLocale,
  accountName: string | null,
): void {
  popover.replaceChildren();
  const heading = document.createElement("div");
  heading.textContent = messages.usage;
  heading.style.fontWeight = "600";
  heading.style.marginBottom = "6px";
  popover.append(heading);

  if (accountName) appendDetailRow(popover, messages.account, accountName, true);

  const contextText = usage ? contextDetailText(usage) : "";
  if (contextText) appendDetailRow(popover, messages.context, contextText);

  if (usage?.cacheHitRatePercent !== undefined) {
    appendDetailRow(
      popover,
      messages.latestCacheHit,
      formatRendererCacheHitRate(usage.cacheHitRatePercent),
    );
  }
  if (usage?.outputTokensPerSecond !== undefined) {
    appendDetailRow(
      popover,
      messages.outputSpeed,
      formatRendererTokenRate(usage.outputTokensPerSecond, locale),
    );
  }
  if (usage?.cachedInputTokens !== undefined) {
    appendDetailRow(popover, messages.cacheRead, formatRendererTokenCount(usage.cachedInputTokens));
  }
  if (usage?.cacheWriteInputTokens !== undefined) {
    appendDetailRow(
      popover,
      messages.cacheWrite,
      formatRendererTokenCount(usage.cacheWriteInputTokens),
    );
  }
  if (usage?.reasoningOutputTokens !== undefined) {
    appendDetailRow(
      popover,
      messages.reasoning,
      formatRendererTokenCount(usage.reasoningOutputTokens),
    );
  }
  if (usage?.totalTokens !== undefined) {
    appendDetailRow(popover, messages.totalTokens, formatRendererTokenCount(usage.totalTokens));
  }
  if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
    const inputPart =
      usage.inputTokens === undefined ? "-" : formatRendererTokenCount(usage.inputTokens);
    const outputPart =
      usage.outputTokens === undefined ? "-" : formatRendererTokenCount(usage.outputTokens);
    appendDetailRow(popover, messages.inputOutput, `${inputPart} / ${outputPart}`);
  }
  if (usage?.totalCostUsd !== undefined) {
    appendDetailRow(popover, messages.sessionCostEstimate, formatRendererCost(usage.totalCostUsd));
  }
  if (usage?.totalCredits !== undefined) {
    appendDetailRow(popover, messages.recordedCredits, formatRendererCredits(usage.totalCredits));
  }
}

function isPopoverVisible(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function alignAboveTrigger(trigger: HTMLButtonElement, popover: HTMLDivElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(320, Math.max(260, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.right = "auto";
  popover.style.top = "auto";
  popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

function hidePopoverNow(trigger: HTMLButtonElement, popover: HTMLDivElement): void {
  if (isPopoverVisible(popover) && typeof popover.hidePopover === "function") {
    popover.hidePopover();
  }
  popover.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

/**
 * Popover open/close state machine shared by the Usage and Credits pills.
 * Wraps the native popover API when present and always mirrors state onto
 * `aria-expanded`; the returned guard defers closing by a grace period so the
 * pointer can travel between trigger and popover without collapsing it.
 */
function createPopoverSession(
  trigger: HTMLButtonElement,
  popover: HTMLDivElement,
  onOpen?: () => void,
) {
  const isOpenFlag = (): boolean => trigger.getAttribute("aria-expanded") === "true";
  const hide = (): void => hidePopoverNow(trigger, popover);

  const show = (): void => {
    const wasOpen = isOpenFlag();
    alignAboveTrigger(trigger, popover);
    popover.hidden = false;
    if (typeof popover.showPopover === "function" && !isPopoverVisible(popover)) {
      popover.showPopover();
    }
    trigger.setAttribute("aria-expanded", "true");
    if (!wasOpen) onOpen?.();
  };

  const toggle = (): void => {
    if (isOpenFlag()) hide();
    else show();
  };

  let graceTimer: number | null = null;
  const keepOpen = (): void => {
    if (graceTimer === null) return;
    window.clearTimeout(graceTimer);
    graceTimer = null;
  };
  const requestClose = (): void => {
    keepOpen();
    graceTimer = window.setTimeout(() => {
      graceTimer = null;
      if (!trigger.matches(":hover") && !popover.matches(":hover")) hide();
    }, CLOSE_GRACE_MS);
  };

  return { hide, show, toggle, keepOpen, requestClose };
}

function buildUsageTrigger(messages: RendererUsageMessages): {
  trigger: HTMLButtonElement;
  label: HTMLSpanElement;
} {
  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", messages.threadUsage);
  trigger.title = messages.threadUsage;
  // Secondary metadata, so the pill keeps the muted look of the old Composer
  // integration and never leans on Codex-internal chip class names.
  trigger.style.color = "var(--color-text-tertiary, #8f8f8f)";
  trigger.style.gap = "4px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  // The neighboring Model/Permission-mode/Agent triggers are all 28px tall; a
  // shorter box misaligns the row by a few px under both flex and inline layout.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

  const ringSlot = document.createElement("span");
  ringSlot.dataset.harnessmixUsageRing = "";
  ringSlot.style.display = "inline-flex";
  ringSlot.style.flex = "0 0 auto";
  ringSlot.style.alignItems = "center";

  const label = document.createElement("span");
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(ringSlot, label);
  return { trigger, label };
}

function buildUsagePopover(composerId: string, messages: RendererUsageMessages): HTMLDivElement {
  const popover = document.createElement("div");
  popover.id = `${composerId}-usage-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", messages.threadUsageDetails);
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.boxSizing = "border-box";
  popover.style.margin = "0";
  popover.style.inset = "auto";
  popover.style.width = "260px";
  popover.style.maxWidth = "min(320px, calc(100vw - 24px))";
  popover.style.padding = "10px 12px";
  applyRendererPopoverChrome(popover);
  popover.style.font = "13px/1.35 system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";
  return popover;
}

export function mountRendererUsageControl(
  composerId: string,
  locale: RendererSettingsLocale = "en",
): RendererUsageControl {
  ensureRendererTriggerChipStyle(document);
  const messages = rendererUsageMessages(locale);

  const root = document.createElement("div");
  root.dataset.harnessmixUsageControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.flex = "0 0 auto";
  root.style.verticalAlign = "middle";

  const { trigger, label } = buildUsageTrigger(messages);
  const popover = buildUsagePopover(composerId, messages);
  trigger.setAttribute("aria-controls", popover.id);

  let placedBefore: Element | null = null;
  const control: RendererUsageControl = {
    root,
    trigger,
    popover,
    anchor: null,
    label,
    locale,
    onOpen: null,
    dispose() {
      session.hide();
      session.keepOpen();
      root.remove();
      popover.remove();
      placedBefore = null;
    },
    place(anchor) {
      if (!anchor?.parentElement) return false;
      const host = anchor.parentElement;
      if (
        control.anchor === anchor &&
        placedBefore === anchor &&
        root.parentElement === host &&
        root.nextElementSibling === anchor
      ) {
        return true;
      }
      control.anchor = anchor;
      placedBefore = anchor;
      host.insertBefore(root, anchor);
      return true;
    },
  };

  const session = createPopoverSession(trigger, popover, () => control.onOpen?.());
  trigger.addEventListener("click", () => session.toggle());
  trigger.addEventListener("pointerenter", () => {
    session.keepOpen();
    session.show();
  });
  trigger.addEventListener("pointerleave", () => session.requestClose());
  trigger.addEventListener("focus", () => {
    session.keepOpen();
    session.show();
  });
  trigger.addEventListener("blur", () => session.requestClose());
  popover.addEventListener("pointerenter", () => session.keepOpen());
  popover.addEventListener("pointerleave", () => session.requestClose());
  popover.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(isPopoverVisible(popover)));
  });
  root.append(trigger);
  document.body.append(popover);

  return control;
}

function resolvedContextPercent(
  usage: ThreadUsageSnapshot | null,
  hasContext: boolean,
): number | undefined {
  if (usage?.contextUsagePercent !== undefined) return usage.contextUsagePercent;
  if (!hasContext || usage?.contextWindowTokens === undefined || usage.contextWindowTokens <= 0) {
    return undefined;
  }
  return (
    Math.round((100 * (usage.contextUsedTokens ?? 0)) / usage.contextWindowTokens * 10) / 10
  );
}

export function renderRendererUsageControl(
  control: RendererUsageControl,
  usage: ThreadUsageSnapshot | null,
  locale: RendererSettingsLocale = control.locale,
  accountName: string | null = null,
): boolean {
  control.locale = locale;
  const messages = rendererUsageMessages(locale);
  control.popover.setAttribute("aria-label", messages.threadUsageDetails);

  const hasContext =
    usage?.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined;
  const hasTokenUsage =
    usage?.totalTokens !== undefined ||
    usage?.inputTokens !== undefined ||
    usage?.cachedInputTokens !== undefined ||
    usage?.cacheWriteInputTokens !== undefined ||
    usage?.outputTokens !== undefined ||
    usage?.reasoningOutputTokens !== undefined;
  const visible = rendererUsageHasDisplayData(usage) || Boolean(accountName);
  control.root.style.display = visible ? "inline-flex" : "none";
  if (!visible) {
    hidePopoverNow(control.trigger, control.popover);
    return false;
  }

  const contextPercent = resolvedContextPercent(usage, hasContext);
  const ringSlot = control.trigger.querySelector<HTMLElement>("[data-harnessmix-usage-ring]");
  if (contextPercent !== undefined) {
    if (ringSlot) {
      ringSlot.replaceChildren(
        createRendererUsageRing(contextPercent, {
          size: 14,
          strokeWidth: 2.4,
          color: contextRingColor(contextPercent),
        }),
      );
    }
  } else if (ringSlot) {
    ringSlot.replaceChildren();
  }

  const percentLabel =
    contextPercent !== undefined ? `${fixedDecimal(contextPercent, 1)}%` : null;
  const summaryParts = [
    percentLabel,
    usage?.totalCredits !== undefined ? formatRendererCredits(usage.totalCredits) : null,
    usage?.cacheHitRatePercent !== undefined
      ? formatRendererCacheHitRate(usage.cacheHitRatePercent)
      : null,
    usage?.outputTokensPerSecond !== undefined
      ? formatRendererTokenRate(usage.outputTokensPerSecond, locale)
      : null,
    usage?.totalCostUsd !== undefined ? formatRendererCost(usage.totalCostUsd) : null,
  ].filter((part): part is string => part !== null);

  if (
    summaryParts.length === 0 &&
    hasContext &&
    usage?.contextWindowTokens !== undefined &&
    usage.contextWindowTokens > 0
  ) {
    summaryParts.push(
      formatRendererContextSummary(usage.contextUsedTokens ?? 0, usage.contextWindowTokens),
    );
  }
  if (summaryParts.length === 0 && usage?.totalTokens !== undefined) {
    summaryParts.push(`${formatRendererTokenCount(usage.totalTokens)} ${messages.tokensSummary}`);
  }
  if (summaryParts.length === 0 && hasTokenUsage) {
    summaryParts.push(
      `${formatRendererTokenCount((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))} ${messages.tokensSummary}`,
    );
  }

  const compactSummary = summaryParts.join(" · ") || messages.usage;
  const accessibleSummary = `${messages.threadUsage}: ${compactSummary}${
    contextPercent !== undefined ? `; ${messages.context} ${fixedDecimal(contextPercent, 1)}%` : ""
  }`;
  control.trigger.style.maxWidth = rendererUsageTriggerMaxWidth();
  control.trigger.setAttribute("aria-label", accessibleSummary);
  control.trigger.title = accessibleSummary;
  control.label.textContent = compactSummary;
  rebuildDetails(control.popover, usage, messages, locale, accountName);
  return true;
}
