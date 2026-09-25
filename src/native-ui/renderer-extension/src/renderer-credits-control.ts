import type { AccountCreditsSnapshot } from "@harnessmix/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

import {
  applyRendererPopoverChrome,
  createRendererUsageRing,
  formatRendererCreditsPercent,
} from "./renderer-usage-control.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

const CLOSE_GRACE_MS = 140;
const TONE_HOT_PERCENT = 90;
const TONE_WARN_PERCENT = 70;
const TONE_HOT_COLOR = "#c45c4a";
const TONE_WARN_COLOR = "#c9a227";
const TONE_OK_COLOR = "#3d9a64";

export interface RendererCreditsControl {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  popover: HTMLDivElement;
  anchor: HTMLElement | null;
  dispose(): void;
  place(anchor: HTMLElement | null): boolean;
}

export type RendererCreditsTone = "ok" | "warn" | "hot";

export function rendererCreditsTone(usedPercent: number): RendererCreditsTone {
  if (usedPercent >= TONE_HOT_PERCENT) return "hot";
  if (usedPercent >= TONE_WARN_PERCENT) return "warn";
  return "ok";
}

interface RendererCreditsMessages {
  readonly remaining: string;
  readonly resets: string;
  readonly details: string;
  readonly weekly: string;
  readonly monthly: string;
  readonly fiveHour: string;
  readonly sevenDay: string;
  readonly account: string;
}

const ENGLISH_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "Remaining",
  resets: "Resets",
  details: "Account limit details",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
  fiveHour: "5-hour limit",
  sevenDay: "7-day limit",
  account: "Account limit",
});

const CHINESE_CREDITS_MESSAGES: RendererCreditsMessages = Object.freeze({
  remaining: "剩余",
  resets: "重置",
  details: "账号额度详情",
  weekly: "周额度",
  monthly: "月额度",
  fiveHour: "5 小时额度",
  sevenDay: "7 天额度",
  account: "账号额度",
});

function rendererCreditsMessages(locale: RendererSettingsLocale): RendererCreditsMessages {
  return locale === "zh-CN" ? CHINESE_CREDITS_MESSAGES : ENGLISH_CREDITS_MESSAGES;
}

/**
 * Render the source string's minute precision, but collapse same-day resets to
 * a plain clock time; both locales flow through the same single formatter.
 */
export function formatRendererCreditsReset(
  value: string,
  now: Date = new Date(),
  locale: RendererSettingsLocale = "en",
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameCalendarDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameCalendarDay) {
    const clock = date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return locale === "zh-CN" ? `今天 ${clock}` : `${clock} today`;
  }
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : undefined, {
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function creditsPeriodLabel(
  periodType: AccountCreditsSnapshot["periodType"],
  locale: RendererSettingsLocale = "en",
): string {
  const messages = rendererCreditsMessages(locale);
  if (periodType === "weekly") return messages.weekly;
  if (periodType === "monthly") return messages.monthly;
  if (periodType === "five_hour") return messages.fiveHour;
  if (periodType === "seven_day") return messages.sevenDay;
  return messages.account;
}

function productLabel(product: string, locale: RendererSettingsLocale): string {
  if (product === "GrokBuild") return "Build";
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  const messages = rendererCreditsMessages(locale);
  if (product === "5-hour window" || product === "5h window") return messages.fiveHour;
  if (product === "7-day window" || product === "7d window") return messages.sevenDay;
  if (product === "Weekly window" || product === "weekly window") return messages.weekly;
  if (product.endsWith(" · 5-hour window") || product.endsWith(" · 5h window")) {
    const prefix = product.replace(/ · 5(-hour|h) window$/i, "");
    return `${prefix} · ${messages.fiveHour}`;
  }
  if (product.endsWith(" · 7-day window") || product.endsWith(" · 7d window")) {
    const prefix = product.replace(/ · 7(-day|d) window$/i, "");
    return `${prefix} · ${messages.sevenDay}`;
  }
  if (product.endsWith(" · Weekly window") || product.endsWith(" · weekly window")) {
    const prefix = product.replace(/ · (weekly|Weekly) window$/i, "");
    return `${prefix} · ${messages.weekly}`;
  }
  return product;
}

function toneColor(tone: RendererCreditsTone): string {
  if (tone === "hot") return TONE_HOT_COLOR;
  if (tone === "warn") return TONE_WARN_COLOR;
  return TONE_OK_COLOR;
}

function percentColor(usedPercent: number): string {
  return toneColor(rendererCreditsTone(usedPercent));
}

function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

function buildProgressBar(fillPercent: number, color: string): HTMLDivElement {
  const bar = document.createElement("div");
  bar.dataset.harnessmixCreditsBar = "";
  bar.style.height = "6px";
  bar.style.borderRadius = "9999px";
  bar.style.background = "color-mix(in srgb, currentColor 12%, transparent)";
  bar.style.overflow = "hidden";
  const fill = document.createElement("span");
  fill.style.display = "block";
  fill.style.height = "100%";
  fill.style.borderRadius = "9999px";
  fill.style.width = `${Math.min(100, Math.max(0, fillPercent))}%`;
  fill.style.background = color;
  fill.style.transition = "width 0.25s ease";
  bar.append(fill);
  return bar;
}

function resetsLine(
  resetsAt: string,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): string {
  const formatted = formatRendererCreditsReset(resetsAt, new Date(), locale);
  return locale === "zh-CN"
    ? `${formatted} ${messages.resets}`
    : `${messages.resets} ${formatted}`;
}

/** Shared skeleton for the header card and each product tile: label+reset left, remaining right, bar below. */
function assembleLimitCard(options: {
  headingTag: "div" | "span";
  heading: string;
  headingFontSize: string;
  headingFontWeight: string;
  resetFontSize: string;
  resetsAt?: string | undefined;
  valueNodes: HTMLElement[];
  barPercent: number;
  barColor: string;
  topGap: string;
  wrapperStyles: Partial<CSSStyleDeclaration>;
  wrapperBorder: string;
  wrapperBackground: string;
  locale: RendererSettingsLocale;
  messages: RendererCreditsMessages;
}): HTMLDivElement {
  const card = document.createElement("div");
  Object.assign(card.style, options.wrapperStyles);
  card.style.border = options.wrapperBorder;
  card.style.background = options.wrapperBackground;

  const top = document.createElement("div");
  top.style.display = "flex";
  top.style.alignItems = "flex-start";
  top.style.justifyContent = "space-between";
  top.style.gap = "12px";
  top.style.marginBottom = options.topGap;

  const leftColumn = document.createElement("div");
  const heading = document.createElement(options.headingTag);
  heading.textContent = options.heading;
  heading.style.fontSize = options.headingFontSize;
  heading.style.fontWeight = options.headingFontWeight;
  leftColumn.append(heading);
  if (options.resetsAt) {
    const reset = document.createElement("div");
    reset.textContent = resetsLine(options.resetsAt, options.locale, options.messages);
    reset.style.fontSize = options.resetFontSize;
    reset.style.color = "color-mix(in srgb, currentColor 62%, transparent)";
    reset.style.marginTop = "2px";
    leftColumn.append(reset);
  }

  top.append(leftColumn, ...options.valueNodes);
  card.append(top, buildProgressBar(options.barPercent, options.barColor));
  return card;
}

function renderCreditsHeader(
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
): HTMLDivElement {
  const color = percentColor(credits.usedPercent);
  const remaining = remainingPercent(credits.usedPercent);

  const bigValue = document.createElement("span");
  bigValue.style.display = "inline-flex";
  bigValue.style.alignItems = "baseline";
  bigValue.style.gap = "4px";
  bigValue.style.whiteSpace = "nowrap";
  bigValue.style.color = color;
  const valueCaption = document.createElement("span");
  valueCaption.textContent = `${messages.remaining} `;
  valueCaption.style.fontSize = "11px";
  valueCaption.style.fontWeight = "600";
  valueCaption.style.opacity = "0.8";
  const valueNumber = document.createElement("span");
  valueNumber.textContent = formatRendererCreditsPercent(remaining);
  valueNumber.style.fontSize = "24px";
  valueNumber.style.fontWeight = "700";
  valueNumber.style.fontVariantNumeric = "tabular-nums";
  bigValue.append(valueCaption, valueNumber);

  return assembleLimitCard({
    headingTag: "div",
    heading: creditsPeriodLabel(credits.periodType, locale),
    headingFontSize: "13px",
    headingFontWeight: "600",
    resetFontSize: "11px",
    resetsAt: credits.resetsAt,
    valueNodes: [bigValue],
    barPercent: remaining,
    barColor: color,
    topGap: "6px",
    wrapperStyles: {
      marginBottom: "10px",
      padding: "8px 10px",
      borderRadius: "10px",
    },
    wrapperBorder: "1px solid color-mix(in srgb, currentColor 7%, transparent)",
    wrapperBackground: "color-mix(in srgb, currentColor 5%, transparent)",
    locale,
    messages,
  });
}

function renderCreditsTile(
  label: string,
  usagePercent: number,
  locale: RendererSettingsLocale,
  messages: RendererCreditsMessages,
  resetsAt?: string,
): HTMLDivElement {
  const color = percentColor(usagePercent);
  const remaining = remainingPercent(usagePercent);

  const value = document.createElement("span");
  value.textContent = `${messages.remaining} ${formatRendererCreditsPercent(remaining)}`;
  value.style.fontSize = "12px";
  value.style.fontWeight = "600";
  value.style.fontVariantNumeric = "tabular-nums";
  value.style.color = color;

  return assembleLimitCard({
    headingTag: "span",
    heading: label,
    headingFontSize: "12px",
    headingFontWeight: "500",
    resetFontSize: "10.5px",
    resetsAt,
    valueNodes: [value],
    barPercent: remaining,
    barColor: color,
    topGap: "5px",
    wrapperStyles: {
      marginBottom: "7px",
      padding: "7px 9px",
      borderRadius: "8px",
    },
    wrapperBorder: "1px solid color-mix(in srgb, currentColor 6%, transparent)",
    wrapperBackground: "color-mix(in srgb, currentColor 4%, transparent)",
    locale,
    messages,
  });
}

function rebuildPopover(
  popover: HTMLDivElement,
  credits: AccountCreditsSnapshot,
  locale: RendererSettingsLocale,
): void {
  const messages = rendererCreditsMessages(locale);
  const glow = percentColor(credits.usedPercent);
  popover.style.backgroundImage = `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${glow} 20%, transparent), transparent 70%)`;
  popover.setAttribute("aria-label", messages.details);
  popover.replaceChildren();
  popover.append(renderCreditsHeader(credits, locale, messages));
  const tiles = (credits.productUsage ?? []).map((product) =>
    renderCreditsTile(
      productLabel(product.product, locale),
      product.usagePercent,
      locale,
      messages,
      product.resetsAt,
    ),
  );
  const lastTile = tiles.at(-1);
  if (lastTile) lastTile.style.marginBottom = "0";
  popover.append(...tiles);
}

function isPopoverShown(popover: HTMLDivElement): boolean {
  try {
    return popover.matches(":popover-open");
  } catch {
    return !popover.hidden;
  }
}

function dismissPopover(trigger: HTMLButtonElement, popover: HTMLDivElement): void {
  if (isPopoverShown(popover) && typeof popover.hidePopover === "function") {
    popover.hidePopover();
  }
  popover.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
}

function anchorAboveTrigger(trigger: HTMLButtonElement, popover: HTMLDivElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(280, Math.max(220, window.innerWidth - 24));
  const left = Math.max(12, Math.min(triggerRect.left, window.innerWidth - width - 12));
  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.right = "auto";
  popover.style.top = "auto";
  popover.style.bottom = `${Math.max(12, window.innerHeight - triggerRect.top + 8)}px`;
}

export function mountRendererCreditsControl(composerId: string): RendererCreditsControl {
  ensureRendererTriggerChipStyle(document);

  const root = document.createElement("div");
  root.dataset.harnessmixCreditsControl = composerId;
  root.className = "relative min-w-0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.height = "28px";
  root.style.flex = "0 0 auto";
  root.style.verticalAlign = "middle";

  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CHIP_CLASS;
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Account limit");
  trigger.title = "Account limit";
  trigger.style.gap = "5px";
  trigger.style.width = "fit-content";
  trigger.style.maxWidth = "min(72px, 18vw)";
  // 28px matches the Model/Permission-mode/Agent chips in the same row so the
  // pill never drops a few px below its neighbors under flex or inline layout.
  trigger.style.height = "28px";
  trigger.style.padding = "0 8px";
  trigger.style.verticalAlign = "middle";
  trigger.style.fontSize = "12px";
  trigger.style.lineHeight = "16px";
  trigger.style.fontVariantNumeric = "tabular-nums";
  trigger.style.letterSpacing = "0";

  const ringSlot = document.createElement("span");
  ringSlot.dataset.harnessmixCreditsRing = "";
  ringSlot.style.display = "inline-flex";
  ringSlot.style.flex = "0 0 auto";

  const label = document.createElement("span");
  label.dataset.harnessmixCreditsLabel = "";
  label.style.display = "inline-block";
  label.style.maxWidth = "100%";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  trigger.append(ringSlot, label);

  const popover = document.createElement("div");
  popover.id = `${composerId}-credits-popover`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account limit details");
  popover.setAttribute("popover", "auto");
  popover.hidden = typeof popover.showPopover !== "function";
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.width = "240px";
  popover.style.maxWidth = "min(280px, calc(100vw - 24px))";
  popover.style.padding = "10px 12px";
  applyRendererPopoverChrome(popover);
  popover.style.font = "13px/1.35 system-ui, sans-serif";
  popover.style.letterSpacing = "0";
  popover.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", popover.id);

  let placedBefore: Element | null = null;
  let closeTimer: number | null = null;
  const cancelPendingClose = (): void => {
    if (closeTimer === null) return;
    window.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const closeNow = (): void => dismissPopover(trigger, popover);
  const openNow = (): void => {
    anchorAboveTrigger(trigger, popover);
    popover.hidden = false;
    if (typeof popover.showPopover === "function" && !isPopoverShown(popover)) {
      popover.showPopover();
    }
    trigger.setAttribute("aria-expanded", "true");
  };
  const scheduleClose = (): void => {
    cancelPendingClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (!trigger.matches(":hover") && !popover.matches(":hover")) closeNow();
    }, CLOSE_GRACE_MS);
  };

  const control: RendererCreditsControl = {
    root,
    trigger,
    popover,
    anchor: null,
    dispose() {
      closeNow();
      cancelPendingClose();
      root.remove();
      popover.remove();
      placedBefore = null;
    },
    place(anchor) {
      // The pill is anchored to the renderer-owned permission-mode picker and
      // inserted immediately before it. Deriving the spot from a stable,
      // already-tracked element survives the host page's late DOM settling,
      // unlike re-walking ancestors from the Usage control's position.
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
      if (root !== anchor) host.insertBefore(root, anchor);
      return true;
    },
  };

  trigger.addEventListener("click", () => {
    if (trigger.getAttribute("aria-expanded") === "true") closeNow();
    else openNow();
  });
  trigger.addEventListener("pointerenter", () => {
    cancelPendingClose();
    openNow();
  });
  trigger.addEventListener("pointerleave", scheduleClose);
  trigger.addEventListener("focus", () => {
    cancelPendingClose();
    openNow();
  });
  trigger.addEventListener("blur", scheduleClose);
  popover.addEventListener("pointerenter", cancelPendingClose);
  popover.addEventListener("pointerleave", scheduleClose);
  popover.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(isPopoverShown(popover)));
  });
  root.append(trigger);
  document.body.append(popover);
  return control;
}

export function renderRendererCreditsControl(
  control: RendererCreditsControl,
  accountCredits: AccountCreditsSnapshot | null,
  locale: RendererSettingsLocale = "en",
): boolean {
  if (accountCredits === null) {
    control.root.style.display = "none";
    dismissPopover(control.trigger, control.popover);
    return false;
  }
  const remaining = remainingPercent(accountCredits.usedPercent);
  const percent = formatRendererCreditsPercent(remaining);
  const title = `${creditsPeriodLabel(accountCredits.periodType)} ${percent}`;
  const tone = rendererCreditsTone(accountCredits.usedPercent);
  const ringSlot = control.trigger.querySelector<HTMLElement>("[data-harnessmix-credits-ring]");
  const label = control.trigger.querySelector<HTMLElement>("[data-harnessmix-credits-label]");
  if (ringSlot) {
    ringSlot.replaceChildren(
      createRendererUsageRing(remaining, {
        size: 14,
        strokeWidth: 2.4,
        color: toneColor(tone),
      }),
    );
  }
  if (label) label.textContent = percent;
  control.root.style.display = "inline-flex";
  control.trigger.setAttribute("aria-label", title);
  control.trigger.title = title;
  rebuildPopover(control.popover, accountCredits, locale);
  return true;
}
