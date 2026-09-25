import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
} from "./agent-group-preference.js";
import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import type { CodexAccountSummary } from "@harnessmix/shared-contracts";
import {
  createRendererCodexAccountGroup,
  type RendererCodexAccountGroupControl,
  type RendererCodexAccountOptionControl,
} from "./renderer-codex-account-options.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import { requestConnectionsPageFocus } from "./settings/connections-page.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

interface PickerCopy {
  readonly locale: RendererSettingsLocale;
  readonly pickerMoreAgentsLabel: string;
  readonly pickerManageLink: string;
  readonly pickerHideUnusedAgentsCta: string;
  readonly codexAccountsLabel: string;
  readonly manageCodexAccountsLabel: string;
  readonly ownershipErrorLabel: string;
}

// The picker's own strings (labels, tooltips, "Install ...") stay hardcoded
// English as this file has always done. Only the Main/More grouping copy is
// localized, because it mirrors text the Connections settings page already
// shows translated.
function pickerCopy(): PickerCopy {
  const languages = typeof navigator !== "undefined" ? navigator.languages : [];
  const messages = rendererSettingsMessages(resolveRendererSettingsLocale(languages));
  const chinese = messages.locale === "zh-CN";
  return {
    locale: messages.locale,
    pickerMoreAgentsLabel: messages.pickerMoreAgentsLabel,
    pickerManageLink: messages.pickerManageLink,
    pickerHideUnusedAgentsCta: messages.pickerHideUnusedAgentsCta,
    codexAccountsLabel: "Codex",
    manageCodexAccountsLabel: chinese ? "管理 Codex 账号" : "Manage Codex Accounts",
    ownershipErrorLabel: chinese
      ? "无法确认会话的 Agent；重新聚焦窗口以重试"
      : "Unable to determine the Thread Agent; refocus the window to retry",
  };
}

// The settings shell mounts a handle on the window (settings/shell.ts) under
// `window.__harnessmixSettingsShellV1`; before that surface exists the handle
// is simply absent and opening is a no-op. It is read through a local
// structural type so this module never needs the settings import.
interface SettingsShellEntry {
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
}

function revealSettingsPage(pageId: "accounts" | "connections", opener?: HTMLElement): void {
  const shell = (window as unknown as { __harnessmixSettingsShellV1?: SettingsShellEntry })
    .__harnessmixSettingsShellV1;
  shell?.openSettings(opener, pageId);
}

function revealConnectionsSettings(opener?: HTMLElement): void {
  revealSettingsPage("connections", opener);
}

export const RENDERER_AGENT_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = {
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://github.com/deepseek-ai/deepseek-harness",
  opencode: "https://opencode.ai/docs/",
  grok: "https://grok.com/",
  omp: "https://github.com/can1357/oh-my-pi",
  antigravity: "https://antigravity.google/product/antigravity-cli",
  "kiro-cli": "https://kiro.dev/docs/cli/",
  openclaw: "https://docs.openclaw.ai/",
  hermes: "https://hermes-agent.nousresearch.com/",
  qoder: "https://qoder.com/",
  codebuddy: "https://www.codebuddy.ai/docs/cli/overview",
  zcode: "https://zcode.z.ai/",
  trae: "https://www.trae.ai/",
  "cursor-cli": "https://cursor.com/docs/cli/installation",
  cline: "https://docs.cline.bot/usage/cli-overview",
  "codex-harness": "https://developers.openai.com/codex/",
};

type AgentAvailabilityMap = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;

export const CONTROL_ATTRIBUTE = "data-harnessmix-agent-control";
const AGENT_MENU_WIDTH = 224;
// Grouping only pays for itself once enough Harnesses are enabled; below this
// count the picker stays a flat list.
const AGENT_GROUP_CTA_THRESHOLD = 5;

interface PickerOptionControl {
  row: HTMLElement;
  button: HTMLButtonElement;
  check: HTMLElement;
  // One shared 24x24 slot at the row's trailing edge: a "+" install action for
  // an Agent that is not installed, or a red "!" action after a failure —
  // never both, since `RendererAgentAvailability` is a single enum. The error
  // state carries no inline detail (the picker sees only that coarse enum,
  // never a full `HarnessMixError`), so it points at Settings → Connections.
  action: HTMLButtonElement | null;
}

export interface RendererAgentPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  iconSlot: HTMLElement;
  spinner: HTMLElement;
  ownershipError: HTMLElement;
  handoffBadge: HTMLElement;
  modeHeading: HTMLElement;
  menu: HTMLElement;
  agents: readonly RendererAgent[];
  options: Partial<Record<RendererAgent, PickerOptionControl>>;
  codexAccounts: readonly CodexAccountSummary[];
  codexAccountOptions: Map<string, RendererCodexAccountOptionControl>;
  codexAccountContainer: HTMLElement;
  codexAccountGroup: RendererCodexAccountGroupControl;
  selectCodexAccount(accountId: string): void;
  close(): void;
  dispose(): void;
}

export interface RendererAgentPickerView {
  label: string;
  triggerDisabled: boolean;
  nativeModelHidden: boolean;
  optionDisabled: Partial<Record<RendererAgent, boolean>>;
  downloadVisible: Partial<Record<ExternalRendererAgent, boolean>>;
  /** True while availability is `error`. In-flight retries must keep that state instead of flashing back to `checking`. */
  errorVisible: Partial<Record<ExternalRendererAgent, boolean>>;
}

export function rendererAgentMenuPlacement(
  triggerRect: Pick<DOMRectReadOnly, "right" | "top">,
  viewport: { width: number; height: number },
  windowZoom: number,
): { left: number; bottom: number } {
  const zoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  const viewportWidth = viewport.width / zoom;
  const viewportHeight = viewport.height / zoom;
  const left = Math.max(
    8,
    Math.min(triggerRect.right / zoom - AGENT_MENU_WIDTH, viewportWidth - AGENT_MENU_WIDTH - 8),
  );
  return {
    left,
    bottom: Math.max(8, viewportHeight - triggerRect.top / zoom + 6),
  };
}

export function rendererAgentPickerTooltip(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  activeAccount: CodexAccountSummary | undefined,
): string {
  const account =
    state.agent === "codex" && activeAccount
      ? ` · ${activeAccount.email ?? activeAccount.label}`
      : "";
  return `Agent: ${RENDERER_AGENT_LABELS[state.agent]}${account}${state.phase === "locked" ? " (locked)" : ""}`;
}

export function rendererAgentPickerView(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  agents: readonly RendererAgent[],
  availability: AgentAvailabilityMap = {},
  codexAccountCount = 0,
): RendererAgentPickerView {
  const handoffMode = state.phase === "locked" && state.agent !== "codex";
  const optionDisabled = Object.fromEntries(
    agents.map((agent) => [
      agent,
      switching ||
        (state.phase === "locked" &&
          (!handoffMode || agent === "codex" || agent === state.agent)) ||
        (agent !== "codex" && (adapterState !== "ready" || availability[agent] !== "ready")),
    ]),
  ) as Partial<Record<RendererAgent, boolean>>;
  const downloadVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "notInstalled"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  const errorVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "error"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  return {
    label: RENDERER_AGENT_LABELS[state.agent],
    triggerDisabled:
      switching ||
      (state.phase === "locked"
        ? !handoffMode || !agents.some((agent) => optionDisabled[agent] === false)
        : agents.length < 2 && codexAccountCount < 2),
    nativeModelHidden: switching || state.agent !== "codex",
    optionDisabled,
    downloadVisible,
    errorVisible,
  };
}

function menuIsOpen(menu: HTMLElement): boolean {
  try {
    return menu.matches(":popover-open");
  } catch {
    return !menu.hidden;
  }
}

function applyMenuPosition(control: RendererAgentPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const zoomToken = getComputedStyle(document.documentElement)
    .getPropertyValue("--codex-window-zoom")
    .trim();
  const placement = rendererAgentMenuPlacement(
    rect,
    { width: window.innerWidth, height: window.innerHeight },
    Number.parseFloat(zoomToken),
  );
  control.menu.style.left = `${placement.left}px`;
  control.menu.style.bottom = `${placement.bottom}px`;
}

function bindHoverBackground(
  target: HTMLElement,
  idle: string,
  hovered: string,
  isEnabled: () => boolean = () => true,
): void {
  target.addEventListener("pointerenter", () => {
    if (isEnabled()) target.style.background = hovered;
  });
  target.addEventListener("pointerleave", () => {
    target.style.background = idle;
  });
}

interface TriggerChrome {
  trigger: HTMLButtonElement;
  iconSlot: HTMLElement;
  spinner: HTMLElement;
  ownershipError: HTMLElement;
  handoffBadge: HTMLElement;
}

function buildTriggerChrome(): TriggerChrome {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.style.position = "relative";
  trigger.style.display = "inline-flex";
  trigger.style.alignItems = "center";
  trigger.style.justifyContent = "center";
  trigger.style.width = "30px";
  trigger.style.height = "28px";
  trigger.style.padding = "0";
  trigger.style.border = "0";
  trigger.style.borderRadius = "6px";
  trigger.style.background = "rgba(127, 127, 127, 0.08)";
  trigger.style.color = "inherit";
  trigger.style.cursor = "pointer";
  bindHoverBackground(
    trigger,
    "rgba(127, 127, 127, 0.08)",
    "rgba(127, 127, 127, 0.16)",
    () => !trigger.disabled,
  );

  const iconSlot = document.createElement("span");
  iconSlot.style.display = "inline-flex";
  iconSlot.style.alignItems = "center";
  iconSlot.style.justifyContent = "center";
  iconSlot.style.width = "20px";
  iconSlot.style.height = "20px";

  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  spinner.style.display = "none";
  spinner.style.width = "16px";
  spinner.style.height = "16px";
  spinner.style.border = "2px solid currentColor";
  spinner.style.borderTopColor = "transparent";
  spinner.style.borderRadius = "50%";
  spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
    duration: 800,
    iterations: Infinity,
  });

  const ownershipError = document.createElement("span");
  ownershipError.textContent = "!";
  ownershipError.setAttribute("aria-hidden", "true");
  ownershipError.style.display = "none";
  ownershipError.style.font = "bold 16px/1 system-ui, sans-serif";

  const handoffBadge = document.createElement("span");
  handoffBadge.textContent = "↗";
  handoffBadge.setAttribute("aria-hidden", "true");
  handoffBadge.style.display = "none";
  handoffBadge.style.position = "absolute";
  handoffBadge.style.right = "1px";
  handoffBadge.style.bottom = "0";
  handoffBadge.style.width = "11px";
  handoffBadge.style.height = "11px";
  handoffBadge.style.borderRadius = "999px";
  handoffBadge.style.background = "#4f7ff0";
  handoffBadge.style.color = "white";
  handoffBadge.style.font = "700 9px/11px system-ui, sans-serif";
  handoffBadge.style.textAlign = "center";

  trigger.append(iconSlot, spinner, ownershipError, handoffBadge);
  return { trigger, iconSlot, spinner, ownershipError, handoffBadge };
}

function buildMenuShell(composerId: string): HTMLElement {
  const menu = document.createElement("div");
  menu.id = `${composerId}-agent-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Agent");
  menu.setAttribute("popover", "auto");
  menu.hidden = typeof menu.showPopover !== "function";
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.width = `${AGENT_MENU_WIDTH}px`;
  menu.style.padding = "4px";
  menu.style.border = "0";
  menu.style.borderRadius = "6px";
  menu.style.background = "Canvas";
  menu.style.color = "CanvasText";
  menu.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.28)";
  menu.style.boxSizing = "border-box";
  menu.style.maxHeight = "min(420px, calc(100vh - 16px))";
  menu.style.overflowX = "hidden";
  menu.style.overflowY = "auto";
  menu.style.zIndex = "2147483647";
  return menu;
}

function buildModeHeading(): HTMLElement {
  const modeHeading = document.createElement("div");
  modeHeading.hidden = true;
  modeHeading.style.padding = "6px 8px 7px";
  modeHeading.style.font = "600 11px/1 system-ui, sans-serif";
  modeHeading.style.opacity = "0.58";
  return modeHeading;
}

function interactiveMenuButtons(menu: HTMLElement): HTMLButtonElement[] {
  return [
    ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'),
  ].filter((button) => !button.disabled && !button.closest<HTMLElement>("[hidden]"));
}

function focusMenuButton(menu: HTMLElement, position: "first" | "last" | "selected"): void {
  const buttons = interactiveMenuButtons(menu);
  const checked = buttons.find((button) => button.getAttribute("aria-checked") === "true");
  const target =
    position === "last" ? buttons.at(-1) : position === "selected" ? checked : buttons[0];
  target?.focus();
}

interface AgentRowHooks {
  onPicked(agent: RendererAgent, alreadySelected: boolean): void;
  onTrailingAction(agent: ExternalRendererAgent, mode: "error" | "install"): void;
}

function buildAgentOptionRow(agent: RendererAgent, hooks: AgentRowHooks): PickerOptionControl {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.agent = agent;
  button.setAttribute("role", "menuitemradio");
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.gap = "8px";
  button.style.minWidth = "0";
  button.style.width = "100%";
  button.style.flex = "1 1 auto";
  button.style.height = "36px";
  button.style.padding = "0 34px 0 8px";
  button.style.border = "0";
  button.style.borderRadius = "4px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "500 13px/1 system-ui, sans-serif";
  button.style.letterSpacing = "0";
  button.style.textAlign = "left";
  button.style.cursor = "pointer";
  const updateHighlight = (active: boolean): void => {
    const selected = button.getAttribute("aria-checked") === "true";
    button.style.background =
      selected || (active && !button.disabled)
        ? `rgba(127, 127, 127, ${selected ? "0.16" : "0.1"})`
        : "transparent";
  };
  button.addEventListener("pointerenter", () => updateHighlight(true));
  button.addEventListener("pointerleave", () => updateHighlight(false));
  button.addEventListener("focus", () => updateHighlight(true));
  button.addEventListener("blur", () => updateHighlight(false));

  const check = document.createElement("span");
  check.textContent = "\u2713";
  check.setAttribute("aria-hidden", "true");
  check.style.width = "24px";
  check.style.flex = "none";
  check.style.textAlign = "center";
  check.style.visibility = "hidden";

  const label = document.createElement("span");
  label.textContent = RENDERER_AGENT_LABELS[agent];
  label.style.minWidth = "0";
  label.style.flex = "1 1 auto";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  button.append(createRendererAgentIcon(agent), label);
  button.addEventListener("click", () => {
    const alreadySelected = button.getAttribute("aria-pressed") === "true";
    hooks.onPicked(agent, alreadySelected);
  });

  const action =
    agent === "codex"
      ? null
      : (() => {
          const control = document.createElement("button");
          control.type = "button";
          control.style.position = "absolute";
          control.style.inset = "0";
          control.style.display = "inline-flex";
          control.style.alignItems = "center";
          control.style.justifyContent = "center";
          control.style.width = "24px";
          control.style.height = "24px";
          control.style.flex = "none";
          control.style.padding = "0";
          control.style.border = "0";
          control.style.borderRadius = "4px";
          control.style.background = "transparent";
          control.style.cursor = "pointer";
          bindHoverBackground(
            control,
            "transparent",
            "rgba(127, 127, 127, 0.16)",
            () => !control.disabled,
          );
          control.addEventListener("click", (event) => {
            event.stopPropagation();
            // "error" has nothing more to say inline — the picker knows only
            // the coarse availability enum, not the full `HarnessMixError` —
            // so it defers to Settings, which does. `requestConnectionsPageFocus`
            // makes Settings land on *this* Agent's row, not just the page.
            hooks.onTrailingAction(
              agent,
              control.dataset.mode === "error" ? "error" : "install",
            );
          });
          return control;
        })();

  const row = document.createElement("div");
  row.style.position = "relative";
  row.style.display = "flex";
  row.style.alignItems = "center";
  const actionSlot = document.createElement("span");
  actionSlot.style.position = "absolute";
  actionSlot.style.top = "6px";
  actionSlot.style.right = "4px";
  actionSlot.style.zIndex = "1";
  actionSlot.style.display = "inline-block";
  actionSlot.style.width = "24px";
  actionSlot.style.height = "24px";
  actionSlot.style.pointerEvents = "none";
  actionSlot.append(check);
  if (action) actionSlot.append(action);
  row.append(button, actionSlot);
  return { row, button, check, action };
}

interface MoreDisclosure {
  toggle: HTMLButtonElement;
  panel: HTMLElement;
  rows: HTMLDivElement;
  arrow: HTMLElement;
  label: HTMLElement;
  cta: HTMLButtonElement;
}

function buildMoreDisclosure(copy: PickerCopy, onManage: () => void): MoreDisclosure {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.style.display = "none";
  toggle.style.alignItems = "center";
  toggle.style.gap = "6px";
  toggle.style.width = "100%";
  toggle.style.height = "32px";
  toggle.style.marginTop = "2px";
  toggle.style.padding = "0 8px";
  toggle.style.border = "0";
  toggle.style.borderRadius = "4px";
  toggle.style.background = "transparent";
  toggle.style.color = "inherit";
  toggle.style.font = "500 12px/1 system-ui, sans-serif";
  toggle.style.opacity = "0.72";
  toggle.style.cursor = "pointer";
  bindHoverBackground(toggle, "transparent", "rgba(127, 127, 127, 0.1)");

  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.style.width = "12px";
  arrow.style.flex = "none";
  arrow.textContent = "▸";
  const label = document.createElement("span");
  toggle.append(arrow, label);

  const panel = document.createElement("div");
  panel.style.display = "none";
  panel.style.flexDirection = "column";
  panel.style.gap = "2px";
  panel.style.paddingLeft = "8px";
  const rows = document.createElement("div");
  rows.style.display = "flex";
  rows.style.flexDirection = "column";
  rows.style.gap = "2px";
  const manageLink = document.createElement("button");
  manageLink.type = "button";
  manageLink.textContent = `${copy.pickerManageLink} →`;
  manageLink.style.display = "flex";
  manageLink.style.width = "100%";
  manageLink.style.height = "28px";
  manageLink.style.marginTop = "2px";
  manageLink.style.padding = "0 12px";
  manageLink.style.border = "0";
  manageLink.style.borderRadius = "4px";
  manageLink.style.background = "transparent";
  manageLink.style.color = "#6d9fff";
  manageLink.style.font = "500 11px/1 system-ui, sans-serif";
  manageLink.style.cursor = "pointer";
  manageLink.addEventListener("click", onManage);
  panel.append(rows, manageLink);

  const cta = document.createElement("button");
  cta.type = "button";
  cta.style.display = "none";
  cta.style.alignItems = "center";
  cta.style.gap = "6px";
  cta.style.width = "100%";
  cta.style.height = "32px";
  cta.style.marginTop = "2px";
  cta.style.padding = "0 8px";
  cta.style.borderWidth = "1px 0 0 0";
  cta.style.borderStyle = "solid";
  cta.style.borderColor = "rgba(127, 127, 127, 0.16)";
  cta.style.background = "transparent";
  cta.style.color = "inherit";
  cta.style.font = "500 12px/1 system-ui, sans-serif";
  cta.style.opacity = "0.72";
  cta.style.cursor = "pointer";
  cta.textContent = `⚙ ${copy.pickerHideUnusedAgentsCta} →`;
  bindHoverBackground(cta, "transparent", "rgba(127, 127, 127, 0.1)");
  cta.addEventListener("click", onManage);

  return { toggle, panel, rows, arrow, label, cta };
}

// Split enabled Agents into Main/More sections. Codex is pinned to Main — the
// always-on default is absent from Connections' grouping list — and the
// remaining order follows the preference store, so drag-reordering on the
// Connections page is reflected here too. Anything the store has not recorded
// lands in Main so it still renders.
function splitAgentGroups(
  enabledAgents: readonly RendererAgent[],
  preference: AgentGroupPreferenceStore,
): { main: RendererAgent[]; more: RendererAgent[] } {
  const enabled = new Set(enabledAgents);
  const placed = new Set<RendererAgent>();
  const main: RendererAgent[] = [];
  const more: RendererAgent[] = [];
  if (enabled.has("codex")) {
    main.push("codex");
    placed.add("codex");
  }
  for (const entry of preference.list()) {
    const agent = entry.agent as RendererAgent;
    if (!enabled.has(agent) || placed.has(agent)) continue;
    placed.add(agent);
    (entry.section === "more" ? more : main).push(agent);
  }
  for (const agent of enabledAgents) {
    if (placed.has(agent)) continue;
    placed.add(agent);
    main.push(agent);
  }
  return { main, more };
}

export function mountRendererAgentPicker(
  composerId: string,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onSelectCodexAccount: (accountId: string) => void,
  onOpen?: () => void,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
): RendererAgentPickerControl {
  const root = document.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.verticalAlign = "middle";
  root.style.width = "30px";
  root.style.height = "28px";
  root.style.marginInline = "4px";
  root.style.color = "inherit";

  const { trigger, iconSlot, spinner, ownershipError, handoffBadge } = buildTriggerChrome();
  const menu = buildMenuShell(composerId);
  trigger.setAttribute("aria-controls", menu.id);

  const options: Partial<Record<RendererAgent, PickerOptionControl>> = {};
  const rowsByAgent = new Map<RendererAgent, HTMLDivElement>();
  const copy = pickerCopy();
  const modeHeading = buildModeHeading();

  const close = (): void => {
    if (!menuIsOpen(menu)) return;
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const codexAccountGroup = createRendererCodexAccountGroup({
    ownerDocument: document,
    accountsLabel: copy.codexAccountsLabel,
    manageAccountsLabel: copy.manageCodexAccountsLabel,
    onSelect(accountId) {
      close();
      trigger.focus();
      onSelectCodexAccount(accountId);
    },
    onManage() {
      close();
      revealSettingsPage("accounts", trigger);
    },
  });
  const codexAccountOptions = codexAccountGroup.options;
  const codexAccountContainer = codexAccountGroup.root;
  trigger.append(codexAccountGroup.badge);

  const open = (focus: "first" | "last" | "selected" = "selected"): void => {
    if (trigger.disabled || menuIsOpen(menu)) return;
    applyMenuPosition(control);
    if (typeof menu.showPopover === "function") menu.showPopover();
    else menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen?.();
    queueMicrotask(() => focusMenuButton(menu, focus));
  };

  const hooks: AgentRowHooks = {
    onPicked(agent, alreadySelected) {
      close();
      trigger.focus();
      if (!alreadySelected) onSelect(agent);
    },
    onTrailingAction(agent, mode) {
      if (mode === "error") {
        requestConnectionsPageFocus(agent);
        revealConnectionsSettings(trigger);
      } else {
        onDownload(agent);
      }
    },
  };
  for (const agent of enabledAgents) {
    const option = buildAgentOptionRow(agent, hooks);
    options[agent] = option;
    rowsByAgent.set(agent, option.row as HTMLDivElement);
  }

  // "Main" carries every enabled Agent until the user folds the unused ones
  // into "More" from the Connections settings page; Codex itself always stays
  // pinned to Main.
  const mainGroup = document.createElement("div");
  mainGroup.style.display = "flex";
  mainGroup.style.flexDirection = "column";
  mainGroup.style.gap = "2px";

  let moreOpen = false;
  const more = buildMoreDisclosure(copy, () => revealConnectionsSettings(trigger));
  const regroup = (): void => {
    const groups = splitAgentGroups(enabledAgents, groupPreference);
    const mainChildren: HTMLElement[] = [];
    for (const agent of groups.main) {
      const row = rowsByAgent.get(agent);
      if (row) mainChildren.push(row);
      if (agent === "codex") mainChildren.push(codexAccountContainer);
    }
    mainGroup.replaceChildren(...mainChildren);
    more.rows.replaceChildren(
      ...groups.more
        .map((agent) => rowsByAgent.get(agent))
        .filter((element): element is HTMLDivElement => !!element),
    );
    const showMoreGroup = groups.more.length > 0;
    const showCta = !showMoreGroup && enabledAgents.length > AGENT_GROUP_CTA_THRESHOLD;
    more.toggle.style.display = showMoreGroup ? "flex" : "none";
    more.panel.style.display = showMoreGroup && moreOpen ? "flex" : "none";
    more.cta.style.display = showCta ? "flex" : "none";
    more.label.textContent = `${copy.pickerMoreAgentsLabel} (${groups.more.length})`;
    more.arrow.textContent = moreOpen ? "▾" : "▸";
  };
  more.toggle.addEventListener("click", () => {
    moreOpen = !moreOpen;
    regroup();
  });
  regroup();
  const unsubscribeGroup = groupPreference.subscribe(regroup);

  menu.append(modeHeading, mainGroup, more.toggle, more.panel, more.cta);
  root.append(trigger, menu);

  const onTriggerClick = (): void => {
    if (menuIsOpen(menu)) close();
    else open();
  };
  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowUp" ? "last" : "first");
  };
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    const buttons = interactiveMenuButtons(menu);
    const current = event.target instanceof Element ? event.target.closest("button") : null;
    const index = buttons.indexOf(current as HTMLButtonElement);
    if (event.key === "Escape") {
      close();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : event.key === "ArrowDown"
            ? buttons[(index + 1 + buttons.length) % buttons.length]
            : buttons[(index - 1 + buttons.length) % buttons.length];
    target?.focus();
  };
  const onToggle = (): void => {
    trigger.setAttribute("aria-expanded", String(menuIsOpen(menu)));
  };
  const onViewportChange = (): void => {
    if (menuIsOpen(menu)) applyMenuPosition(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("keydown", onMenuKeyDown);
  menu.addEventListener("toggle", onToggle);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const control: RendererAgentPickerControl = {
    root,
    trigger,
    iconSlot,
    spinner,
    ownershipError,
    handoffBadge,
    modeHeading,
    menu,
    agents: [...enabledAgents],
    options,
    codexAccounts: [],
    codexAccountOptions,
    codexAccountContainer,
    codexAccountGroup,
    selectCodexAccount: onSelectCodexAccount,
    close,
    dispose() {
      close();
      unsubscribeGroup();
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      root.remove();
    },
  };
  return control;
}

function paintAgentOption(
  agent: RendererAgent,
  option: PickerOptionControl,
  view: RendererAgentPickerView,
  selected: boolean,
): void {
  option.button.disabled = view.optionDisabled[agent] ?? true;
  option.button.setAttribute("aria-checked", String(selected));
  option.button.setAttribute("aria-pressed", String(selected));
  option.button.style.background = selected ? "rgba(127, 127, 127, 0.16)" : "transparent";
  option.button.style.cursor = option.button.disabled ? "not-allowed" : "pointer";
  option.button.style.opacity = option.button.disabled && !selected ? "0.5" : "1";
  option.check.style.visibility = selected ? "visible" : "hidden";
  const action = option.action;
  if (!action) return;
  const showInstall = view.downloadVisible[agent as ExternalRendererAgent] === true;
  const showError = view.errorVisible[agent as ExternalRendererAgent] === true;
  const visible = showInstall || showError;
  action.hidden = false;
  action.disabled = !visible;
  action.style.display = "inline-flex";
  action.style.visibility = visible ? "visible" : "hidden";
  action.style.pointerEvents = visible ? "auto" : "none";
  if (showError) {
    action.dataset.mode = "error";
    action.textContent = "!";
    action.style.color = "#f87171";
    action.style.font = "800 13px/1 system-ui, sans-serif";
    action.style.opacity = "1";
    const label = `${RENDERER_AGENT_LABELS[agent]} connection error — open Settings for details`;
    action.setAttribute("aria-label", label);
    action.title = label;
  } else {
    action.dataset.mode = "install";
    action.textContent = "+";
    action.style.color = "inherit";
    action.style.font = "600 18px/1 system-ui, sans-serif";
    action.style.opacity = "0.72";
    const label = `Install ${RENDERER_AGENT_LABELS[agent]}`;
    action.setAttribute("aria-label", label);
    action.title = label;
  }
  action.setAttribute("aria-hidden", String(!visible));
}

export function renderRendererAgentPicker(
  control: RendererAgentPickerControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: AgentAvailabilityMap = {},
  codexAccounts: readonly CodexAccountSummary[] = [],
  ownershipError = false,
): RendererAgentPickerView {
  control.codexAccounts = [...codexAccounts];
  const codexOption = control.options.codex;
  if (codexOption) codexOption.row.hidden = codexAccounts.length > 0;
  const view = rendererAgentPickerView(
    state,
    adapterState,
    switching,
    control.agents,
    availability,
    codexAccounts.length,
  );
  if (control.iconSlot.dataset.agent !== state.agent) {
    control.iconSlot.replaceChildren(createRendererAgentIcon(state.agent));
    control.iconSlot.dataset.agent = state.agent;
  }
  const copy = pickerCopy();
  const handoffMode = state.phase === "locked" && state.agent !== "codex";
  control.trigger.disabled = view.triggerDisabled || ownershipError;
  control.trigger.setAttribute("aria-busy", String(switching));
  control.trigger.setAttribute(
    "aria-label",
    ownershipError
      ? copy.ownershipErrorLabel
      : state.phase === "locked"
        ? state.agent === "codex"
          ? `Agent: ${view.label}`
          : `Hand off task from ${view.label}`
        : `Select Agent, current ${view.label}`,
  );
  const activeAccount = codexAccounts.find(({ active }) => active);
  control.codexAccountGroup.render({
    accounts: codexAccounts,
    selectedAccountId: state.agent === "codex" ? (activeAccount?.accountId ?? null) : null,
    disabled: switching || state.phase === "locked",
    showBadge: state.agent === "codex" && codexAccounts.length > 1,
  });
  control.trigger.title = ownershipError
    ? copy.ownershipErrorLabel
    : handoffMode
      ? `Hand off this task from ${view.label} to another Harness`
      : rendererAgentPickerTooltip(state, activeAccount);
  control.trigger.style.cursor = control.trigger.disabled ? "not-allowed" : "pointer";
  control.trigger.style.opacity = control.trigger.disabled && !switching ? "0.72" : "1";
  control.iconSlot.style.display = switching || ownershipError ? "none" : "inline-flex";
  control.spinner.style.display = switching ? "block" : "none";
  control.ownershipError.style.display = ownershipError && !switching ? "block" : "none";
  control.handoffBadge.style.display =
    handoffMode && !switching && !ownershipError ? "block" : "none";
  control.modeHeading.hidden = !handoffMode;
  control.modeHeading.textContent =
    copy.locale === "zh-CN" ? `接力到其他 Harness` : "Hand off to another Harness";
  if (control.trigger.disabled) control.close();

  for (const agent of control.agents) {
    const option = control.options[agent];
    if (!option) continue;
    paintAgentOption(agent, option, view, agent === state.agent);
  }
  return view;
}
