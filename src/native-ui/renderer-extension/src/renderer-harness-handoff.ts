import type { ExternalRendererAgent } from "./agent-selection-state.js";
import type { HarnessHandoffIncludes, HarnessHandoffIntent } from "@harnessmix/shared-contracts";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export const HARNESS_HANDOFF_NOTE_MAX_LENGTH = 2000;

const INTENT_VALUES = ["continue", "execute-plan", "review", "reanalyze"] as const;
const INCLUDE_KEYS = ["conversation", "plan", "evidence", "files", "unresolved"] as const;

export interface RendererHarnessHandoffRequest {
  from: ExternalRendererAgent;
  to: ExternalRendererAgent;
  note: string;
  intent: HarnessHandoffIntent;
  includes: HarnessHandoffIncludes;
}

export interface RendererHarnessHandoffControl {
  dialog: HTMLDialogElement;
  note: HTMLTextAreaElement;
  intent: HTMLSelectElement;
  includeInputs: Record<keyof HarnessHandoffIncludes, HTMLInputElement>;
  confirm: HTMLButtonElement;
  cancel: HTMLButtonElement;
  error: HTMLElement;
  open(from: ExternalRendererAgent, to: ExternalRendererAgent, locale: RendererSettingsLocale): void;
  close(): void;
  setSubmitting(submitting: boolean): void;
  showError(message: string): void;
  dispose(): void;
}

export function rendererHarnessHandoffMessages(locale: RendererSettingsLocale) {
  return locale === "zh-CN"
    ? {
        title: "接力当前任务",
        description: "保留此任务窗口、对话记录和文件现场，只更换继续执行的 Harness。",
        noteLabel: "交接说明（可选）",
        intentLabel: "接力方式",
        intentOptions: { continue: "继续执行", "execute-plan": "执行上一方案", review: "独立审查", reanalyze: "重新分析" },
        includeLabel: "将要交接",
        includeOptions: { conversation: "近期对话", plan: "当前计划", evidence: "测试与工具证据", files: "文件变更", unresolved: "未解决问题" },
        notePlaceholder: "例如：按上面的方案继续实现，先核对当前文件状态和未完成步骤",
        context: "确认后会先连接目标 Harness，失败将自动恢复。下一条消息会携带已选的近期对话、最新方案、计划和变更文件。",
        running: "若当前回合仍在运行，请先停止或等待完成。",
        cancel: "取消",
        confirm: "确认接力",
        submitting: "正在切换…",
      }
    : {
        title: "Hand off this task",
        description: "Keep this task, transcript, and working tree; only change the Harness that continues it.",
        noteLabel: "Handoff note (optional)",
        intentLabel: "Handoff mode",
        intentOptions: { continue: "Continue", "execute-plan": "Execute prior plan", review: "Independent review", reanalyze: "Reanalyze" },
        includeLabel: "Include",
        includeOptions: { conversation: "Recent conversation", plan: "Current plan", evidence: "Test and tool evidence", files: "File changes", unresolved: "Open issues" },
        notePlaceholder: "For example: implement the plan above; verify the working tree and remaining steps first",
        context: "The target Harness is connected before the switch commits; failures roll back automatically. Your next message carries the selected recent conversation, latest solution, plan, and changed files.",
        running: "If a turn is still running, stop it or wait for it to finish first.",
        cancel: "Cancel",
        confirm: "Hand off",
        submitting: "Switching…",
      };
}

function paintActionButton(button: HTMLButtonElement, primary = false): void {
  button.style.height = "34px";
  button.style.padding = "0 14px";
  button.style.border = primary ? "1px solid color-mix(in srgb, #5b8cff 70%, CanvasText 30%)" : "1px solid color-mix(in srgb, CanvasText 18%, transparent)";
  button.style.borderRadius = "7px";
  button.style.background = primary ? "#4f7ff0" : "color-mix(in srgb, Canvas 94%, CanvasText 6%)";
  button.style.color = primary ? "white" : "CanvasText";
  button.style.font = "500 13px/1 system-ui, sans-serif";
  button.style.cursor = "pointer";
}

export function mountRendererHarnessHandoff(
  composerId: string,
  onConfirm: (request: RendererHarnessHandoffRequest) => void,
): RendererHarnessHandoffControl {
  const dialog = document.createElement("dialog");
  dialog.id = `${composerId}-harness-handoff`;
  dialog.setAttribute("aria-modal", "true");
  dialog.style.width = "min(440px, calc(100vw - 32px))";
  dialog.style.boxSizing = "border-box";
  dialog.style.padding = "0";
  dialog.style.border = "1px solid color-mix(in srgb, CanvasText 18%, transparent)";
  dialog.style.borderRadius = "14px";
  dialog.style.background = "Canvas";
  dialog.style.color = "CanvasText";
  dialog.style.boxShadow = "0 24px 70px rgba(0, 0, 0, 0.42)";
  dialog.style.font = "13px/1.45 system-ui, sans-serif";
  dialog.style.zIndex = "2147483647";

  const frame = document.createElement("div");
  frame.style.display = "flex";
  frame.style.flexDirection = "column";
  frame.style.gap = "14px";
  frame.style.padding = "20px";

  const title = document.createElement("h2");
  title.style.margin = "0";
  title.style.font = "600 17px/1.25 system-ui, sans-serif";
  const description = document.createElement("p");
  description.style.margin = "-6px 0 0";
  description.style.opacity = "0.72";

  const route = document.createElement("div");
  route.style.display = "grid";
  route.style.gridTemplateColumns = "1fr auto 1fr";
  route.style.alignItems = "center";
  route.style.gap = "10px";
  route.style.padding = "12px";
  route.style.borderRadius = "10px";
  route.style.background = "color-mix(in srgb, CanvasText 6%, transparent)";
  const fromBox = document.createElement("div");
  const toBox = document.createElement("div");
  for (const box of [fromBox, toBox]) {
    box.style.display = "flex";
    box.style.alignItems = "center";
    box.style.gap = "8px";
    box.style.minWidth = "0";
    box.style.fontWeight = "600";
  }
  const arrow = document.createElement("span");
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  arrow.style.opacity = "0.55";
  route.append(fromBox, arrow, toBox);

  const intentLabel = document.createElement("label");
  intentLabel.style.display = "flex";
  intentLabel.style.flexDirection = "column";
  intentLabel.style.gap = "7px";
  const intentLabelText = document.createElement("span");
  intentLabelText.style.fontWeight = "600";
  const intent = document.createElement("select");
  intent.style.height = "36px";
  intent.style.padding = "0 10px";
  intent.style.border = "1px solid color-mix(in srgb, CanvasText 20%, transparent)";
  intent.style.borderRadius = "8px";
  intent.style.background = "Canvas";
  intent.style.color = "CanvasText";
  intent.style.font = "13px/1 system-ui, sans-serif";
  for (const value of INTENT_VALUES) {
    const option = document.createElement("option");
    option.value = value;
    intent.append(option);
  }
  intentLabel.append(intentLabelText, intent);

  const includeSection = document.createElement("fieldset");
  includeSection.style.margin = "0";
  includeSection.style.padding = "10px 11px";
  includeSection.style.border = "1px solid color-mix(in srgb, CanvasText 14%, transparent)";
  includeSection.style.borderRadius = "8px";
  const includeLegend = document.createElement("legend");
  includeLegend.style.padding = "0 5px";
  includeLegend.style.fontWeight = "600";
  includeSection.append(includeLegend);
  const includeGrid = document.createElement("div");
  includeGrid.style.display = "grid";
  includeGrid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
  includeGrid.style.gap = "8px 12px";
  const includeInputs = {} as Record<keyof HarnessHandoffIncludes, HTMLInputElement>;
  const includeLabels = {} as Record<keyof HarnessHandoffIncludes, Text>;
  for (const key of INCLUDE_KEYS) {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "7px";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    const label = document.createTextNode("");
    row.append(input, label);
    includeGrid.append(row);
    includeInputs[key] = input;
    includeLabels[key] = label;
  }
  includeSection.append(includeGrid);

  const noteLabel = document.createElement("label");
  noteLabel.style.display = "flex";
  noteLabel.style.flexDirection = "column";
  noteLabel.style.gap = "7px";
  const noteLabelText = document.createElement("span");
  noteLabelText.style.fontWeight = "600";
  const note = document.createElement("textarea");
  note.rows = 3;
  note.maxLength = HARNESS_HANDOFF_NOTE_MAX_LENGTH;
  note.style.boxSizing = "border-box";
  note.style.width = "100%";
  note.style.minHeight = "76px";
  note.style.resize = "vertical";
  note.style.padding = "10px 11px";
  note.style.border = "1px solid color-mix(in srgb, CanvasText 20%, transparent)";
  note.style.borderRadius = "8px";
  note.style.outline = "none";
  note.style.background = "color-mix(in srgb, Canvas 96%, CanvasText 4%)";
  note.style.color = "CanvasText";
  note.style.font = "13px/1.45 system-ui, sans-serif";
  noteLabel.append(noteLabelText, note);

  const context = document.createElement("p");
  context.style.margin = "0";
  context.style.padding = "9px 10px";
  context.style.borderRadius = "8px";
  context.style.background = "color-mix(in srgb, #5b8cff 10%, transparent)";
  const running = document.createElement("p");
  running.style.margin = "-8px 0 0";
  running.style.opacity = "0.65";

  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  error.hidden = true;
  error.style.margin = "-8px 0 0";
  error.style.color = "#ef6666";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  const cancel = document.createElement("button");
  cancel.type = "button";
  paintActionButton(cancel);
  const confirm = document.createElement("button");
  confirm.type = "button";
  paintActionButton(confirm, true);
  actions.append(cancel, confirm);
  frame.append(title, description, route, intentLabel, includeSection, noteLabel, context, running, error, actions);
  dialog.append(frame);
  document.body.append(dialog);

  let from: ExternalRendererAgent = "pi";
  let to: ExternalRendererAgent = "claude-code";
  let locale: RendererSettingsLocale = "en";
  let submitting = false;

  const render = (): void => {
    const messages = rendererHarnessHandoffMessages(locale);
    title.textContent = messages.title;
    description.textContent = messages.description;
    noteLabelText.textContent = messages.noteLabel;
    intentLabelText.textContent = messages.intentLabel;
    includeLegend.textContent = messages.includeLabel;
    for (const [value, label] of Object.entries(messages.intentOptions)) {
      const option = [...intent.options].find((candidate) => candidate.value === value);
      if (option) option.textContent = label;
    }
    for (const key of Object.keys(includeInputs) as Array<keyof HarnessHandoffIncludes>) {
      includeLabels[key].data = messages.includeOptions[key];
    }
    note.placeholder = messages.notePlaceholder;
    context.textContent = messages.context;
    running.textContent = messages.running;
    cancel.textContent = messages.cancel;
    confirm.textContent = submitting ? messages.submitting : messages.confirm;
    fromBox.replaceChildren(createRendererAgentIcon(from, 24), document.createTextNode(RENDERER_AGENT_LABELS[from]));
    toBox.replaceChildren(createRendererAgentIcon(to, 24), document.createTextNode(RENDERER_AGENT_LABELS[to]));
    note.disabled = submitting;
    intent.disabled = submitting;
    includeSection.disabled = submitting;
    cancel.disabled = submitting;
    confirm.disabled = submitting;
    cancel.style.cursor = submitting ? "not-allowed" : "pointer";
    confirm.style.cursor = submitting ? "wait" : "pointer";
    confirm.setAttribute("aria-busy", String(submitting));
  };

  const close = (): void => {
    if (submitting) return;
    if (dialog.open) dialog.close();
  };
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", () => {
    if (submitting) return;
    onConfirm({
      from,
      to,
      note: note.value.trim(),
      intent: intent.value as HarnessHandoffIntent,
      includes: Object.fromEntries(
        Object.entries(includeInputs).map(([key, input]) => [key, input.checked]),
      ) as unknown as HarnessHandoffIncludes,
    });
  });
  note.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !submitting) {
      event.preventDefault();
      confirm.click();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    if (submitting) event.preventDefault();
  });

  const control: RendererHarnessHandoffControl = {
    dialog,
    note,
    intent,
    includeInputs,
    confirm,
    cancel,
    error,
    open(nextFrom, nextTo, nextLocale) {
      from = nextFrom;
      to = nextTo;
      locale = nextLocale;
      submitting = false;
      note.value = "";
      intent.value = "continue";
      for (const input of Object.values(includeInputs)) input.checked = true;
      error.hidden = true;
      error.textContent = "";
      render();
      if (!dialog.open) dialog.showModal();
      queueMicrotask(() => note.focus());
    },
    close,
    setSubmitting(nextSubmitting) {
      submitting = nextSubmitting;
      render();
    },
    showError(message) {
      error.textContent = message;
      error.hidden = false;
    },
    dispose() {
      submitting = false;
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
  render();
  return control;
}
