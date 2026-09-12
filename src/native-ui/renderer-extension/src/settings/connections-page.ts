import type { CodexhostError, HarnessInspection } from "@codexhost/shared-contracts";

import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
  type AgentGroupSection,
} from "../agent-group-preference.js";
import type { ExternalRendererAgent, RendererAgentAvailability } from "../agent-selection-state.js";
import {
  readNewThreadExternalConfigurationPreference,
  writeNewThreadExternalConfigurationPreference,
} from "../renderer-new-thread-preference.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "../renderer-agent-icon.js";
import type { RendererAdapterStatus } from "../versioned-renderer-adapter.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export const CODEXHOST_GITHUB_ISSUES_NEW_URL =
  "https://github.com/BytePioneer-AI/codex-host/issues/new";

export const HARNESS_INSTALL_COMMANDS: Readonly<Partial<Record<ExternalRendererAgent, { command: string }>>> = Object.freeze({
  qoder: { command: "npm install -g @qoder-ai/qodercli" },
  codex: { command: "npm install -g @openai/codex" },
  pi: { command: "npm install -g @mariozechner/pi-coding-agent" },
  "claude-code": { command: "npm install -g @anthropic-ai/claude-code" },
  "deepseek-harness": { command: "pip install deepseek-harness" },
  opencode: { command: "npm install -g opencode-ai" },
  grok: { command: "npm install -g @xai/grok-cli" },
  omp: { command: "npm install -g @oh-my-prompt/omp" },
  antigravity: { command: "npm install -g @google/antigravity-cli" },
  openclaw: { command: "npm install -g openclaw" },
  hermes: { command: "pip install hermes-agent" },
  "codex-harness": { command: "npm install -g @openai/codex" },
});

const HARNESS_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = Object.freeze({
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://deepseek-harness.github.io/deepseek-harness/",
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
  'cursor-cli': "https://cursor.com/docs/cli/installation",
  'codex-harness': 'https://developers.openai.com/codex/',
});

export interface RendererConnectionAgentSnapshot {
  readonly agent: ExternalRendererAgent;
  readonly availability: RendererAgentAvailability;
  readonly error: CodexhostError | null;
  readonly webUiAvailable?: true;
}

export interface RendererConnectionHostSnapshot {
  readonly hostId: string;
  readonly active: boolean;
  readonly agents: readonly RendererConnectionAgentSnapshot[];
}

export interface RendererConnectionSnapshot {
  readonly adapter: RendererAdapterStatus;
  readonly hosts: readonly RendererConnectionHostSnapshot[];
}

export interface RendererConnectionDiagnostics {
  snapshot(): RendererConnectionSnapshot;
  refresh(): Promise<void>;
  openWebUi?(hostId: string, agent: ExternalRendererAgent): Promise<void>;
  inspectHarness?(hostId: string, agent: ExternalRendererAgent): Promise<HarnessInspection>;
  installHarness?(hostId: string, agent: ExternalRendererAgent): Promise<{ success: boolean; command?: string; stdout?: string; stderr?: string; error?: string }>;
  subscribe(listener: () => void): () => void;
}

type ConnectionAvailability = RendererAgentAvailability | RendererAdapterStatus["state"];
type ConnectionTone = "ready" | "checking" | "setup" | "failed";

interface ConnectionListItem {
  readonly key: string;
  readonly name: string;
  readonly availability: ConnectionAvailability;
  readonly error: CodexhostError | null;
  readonly agentSnapshot?: RendererConnectionAgentSnapshot;
  readonly openWebUi?: () => Promise<void>;
}

function connectionStatusLabel(
  availability: ConnectionAvailability,
  messages: RendererSettingsMessages,
  hasError = false,
): string {
  if (hasError && availability !== "notInstalled") return messages.connectionStatusError;
  if (availability === "ready") return messages.connectionStatusReady;
  if (availability === "checking") return messages.connectionStatusChecking;
  if (availability === "notInstalled") return messages.connectionStatusNotInstalled;
  if (availability === "unavailable" || availability === "error") {
    return availability === "error"
      ? messages.connectionStatusError
      : messages.connectionStatusUnavailable;
  }
  return availability === "installing"
    ? messages.connectionStatusInstalling
    : messages.connectionStatusUnsupported;
}

function connectionStatusTone(
  availability: ConnectionAvailability,
  hasError = false,
): ConnectionTone {
  if (hasError && availability !== "notInstalled") return "failed";
  if (availability === "ready") return "ready";
  if (availability === "checking" || availability === "installing") return "checking";
  if (availability === "notInstalled") return "setup";
  return "failed";
}

function diagnosticText(
  hostId: string,
  item: Pick<ConnectionListItem, "name" | "availability" | "error">,
): string {
  const error = item.error;
  return [
    "codexhost connection diagnostics",
    `host: ${hostId}`,
    `agent: ${item.name}`,
    `status: ${item.availability}`,
    ...(error
      ? [
          `error.code: ${error.code}`,
          `error.message: ${error.message}`,
          `retryable: ${error.retryable}`,
          ...(error.stage ? [`stage: ${error.stage}`] : []),
          ...(error.durationMs !== undefined ? [`durationMs: ${error.durationMs}`] : []),
          ...(error.diagnostic ? [`diagnostic: ${error.diagnostic}`] : []),
          ...(error.stderrTail ? [`stderr:\n${error.stderrTail}`] : []),
        ]
      : []),
  ].join("\n");
}

function detailLine(document: Document, label: string, value: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "settings-connection-detail-line";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("code");
  content.textContent = value;
  line.append(name, content);
  return line;
}

function setCopyButtonLabel(button: HTMLButtonElement, label: string): void {
  button.replaceChildren(createRendererSettingsIcon("copy", 16), label);
}

function showCopyButtonFeedback(
  button: HTMLButtonElement,
  label: string,
  restoreLabel: string,
): void {
  setCopyButtonLabel(button, label);
  button.ownerDocument.defaultView?.setTimeout(() => {
    setCopyButtonLabel(button, restoreLabel);
  }, 2_000);
}

function copyDiagnosticsToClipboard(
  document: Document,
  button: HTMLButtonElement,
  report: string,
  messages: RendererSettingsMessages,
  restoreLabel: string,
): void {
  const clipboard = document.defaultView?.navigator.clipboard;
  if (!clipboard) {
    showCopyButtonFeedback(button, messages.connectionCopyFailed, restoreLabel);
    return;
  }
  void clipboard.writeText(report).then(
    () => showCopyButtonFeedback(button, messages.connectionCopied, restoreLabel),
    () => showCopyButtonFeedback(button, messages.connectionCopyFailed, restoreLabel),
  );
}

function connectionHostName(hostId: string, messages: RendererSettingsMessages): string {
  if (hostId === "local") return messages.connectionLocalHost;
  const separator = hostId.lastIndexOf(":");
  const encodedName = separator >= 0 ? hostId.slice(separator + 1) : hostId;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function createHostScrollButton(
  document: Document,
  direction: "left" | "right",
  messages: RendererSettingsMessages,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-connection-host-scroll";
  button.dataset.connectionHostScroll = direction;
  const label =
    direction === "left" ? messages.connectionHostsScrollLeft : messages.connectionHostsScrollRight;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(
    createRendererSettingsIcon(direction === "left" ? "chevron-left" : "chevron-right", 16),
  );
  return button;
}

function configureHostScroller(
  document: Document,
  strip: HTMLElement,
  tabs: HTMLElement,
  left: HTMLButtonElement,
  right: HTMLButtonElement,
): () => void {
  const maxScrollLeft = (): number =>
    Math.max(0, (tabs.scrollWidth || 0) - (tabs.clientWidth || 0));
  const updateButtons = (): void => {
    const maximum = maxScrollLeft();
    strip.dataset.connectionHostOverflow = String(maximum > 1);
    left.disabled = tabs.scrollLeft <= 1;
    right.disabled = maximum <= 1 || tabs.scrollLeft >= maximum - 1;
  };
  const scroll = (direction: -1 | 1): void => {
    const distance = Math.max(180, Math.round((tabs.clientWidth || 250) * 0.72));
    if (typeof tabs.scrollBy === "function") {
      tabs.scrollBy({ left: direction * distance, behavior: "smooth" });
    } else {
      tabs.scrollLeft += direction * distance;
      updateButtons();
    }
  };
  const onLeft = (): void => scroll(-1);
  const onRight = (): void => scroll(1);
  const onWheel = (event: WheelEvent): void => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const maximum = maxScrollLeft();
    const canScroll = delta < 0 ? tabs.scrollLeft > 1 : tabs.scrollLeft < maximum - 1;
    if (!delta || maximum <= 1 || !canScroll) return;
    event.preventDefault();
    tabs.scrollLeft += delta;
  };
  left.addEventListener("click", onLeft);
  right.addEventListener("click", onRight);
  tabs.addEventListener("scroll", updateButtons, { passive: true });
  tabs.addEventListener("wheel", onWheel, { passive: false });
  const ownerWindow = document.defaultView;
  ownerWindow?.addEventListener("resize", updateButtons);
  ownerWindow?.setTimeout(updateButtons, 0);
  updateButtons();
  return () => {
    left.removeEventListener("click", onLeft);
    right.removeEventListener("click", onRight);
    tabs.removeEventListener("scroll", updateButtons);
    tabs.removeEventListener("wheel", onWheel);
    ownerWindow?.removeEventListener("resize", updateButtons);
  };
}

function createConnectionIdentityIcon(
  document: Document,
  item: ConnectionListItem,
  size: number,
): HTMLElement {
  const container = document.createElement("span");
  container.className = item.agentSnapshot
    ? "settings-connection-row__mark settings-connection-row__mark--logo"
    : "settings-connection-row__mark";
  container.setAttribute("aria-hidden", "true");
  if (item.agentSnapshot) {
    container.append(createRendererAgentIcon(item.agentSnapshot.agent, size, document));
  } else {
    container.textContent = "CH";
  }
  return container;
}

interface ConnectionRowGroupController {
  readonly section: AgentGroupSection;
  readonly moveLabel: string;
  readonly dragHandleTitle: string;
  toggleSection(): void;
  onDragStart(event: DragEvent): void;
  onDragOver(event: DragEvent): void;
  onDragLeave(event: DragEvent): void;
  onDrop(event: DragEvent): void;
  onDragEnd(event: DragEvent): void;
}

function createConnectionRow(
  document: Document,
  item: ConnectionListItem,
  messages: RendererSettingsMessages,
  selected: boolean,
  select: () => void,
  group: ConnectionRowGroupController | null = null,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-connection-row";
  row.dataset.connectionItem = item.key;
  row.dataset.connectionSelected = String(selected);
  row.tabIndex = selected ? 0 : -1;
  row.setAttribute("role", "row");

  const identity = document.createElement("div");
  identity.className = "settings-connection-row__identity";
  identity.setAttribute("role", "cell");
  if (group) {
    const handle = document.createElement("span");
    handle.className = "settings-connection-row__handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = group.dragHandleTitle;
    handle.append(createRendererSettingsIcon("grip-vertical", 15));
    identity.append(handle);
  }
  const label = document.createElement("strong");
  label.textContent = item.name;
  identity.append(createConnectionIdentityIcon(document, item, 19), label);

  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.dataset.connectionTone = connectionStatusTone(item.availability, item.error !== null);
  status.setAttribute("role", "cell");
  status.textContent = connectionStatusLabel(item.availability, messages, item.error !== null);

  const action = document.createElement("div");
  action.className = "settings-connection-row__action";
  action.setAttribute("role", "cell");
  if (item.agentSnapshot?.availability === "notInstalled") {
    const install = document.createElement("a");
    install.className = "settings-connection-install-link";
    install.href = HARNESS_INSTALL_URLS[item.agentSnapshot.agent];
    install.target = "_blank";
    install.rel = "noopener noreferrer";
    install.setAttribute("aria-label", `${messages.connectionOpenInstallation}: ${item.name}`);
    install.title = messages.connectionOpenInstallation;
    install.append(createRendererSettingsIcon("download", 17));
    action.append(install);
  } else if (item.error) {
    const viewError = document.createElement("button");
    viewError.type = "button";
    viewError.className = "settings-connection-view-error";
    viewError.textContent = messages.connectionViewError;
    viewError.addEventListener("click", (event) => {
      event.stopPropagation();
      select();
    });
    action.append(viewError);
  }
  if (group) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "settings-connection-row__group-toggle";
    toggle.title = group.moveLabel;
    toggle.setAttribute("aria-label", group.moveLabel);
    toggle.append(
      createRendererSettingsIcon(group.section === "main" ? "chevron-down" : "chevron-up", 15),
    );
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      group.toggleSection();
    });
    action.append(toggle);
  }

  row.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("a")) return;
    select();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    select();
  });
  if (group) {
    row.draggable = true;
    row.dataset.connectionGroupSection = group.section;
    row.addEventListener("dragstart", group.onDragStart);
    row.addEventListener("dragover", group.onDragOver);
    row.addEventListener("dragleave", group.onDragLeave);
    row.addEventListener("drop", group.onDrop);
    row.addEventListener("dragend", group.onDragEnd);
  }
  row.append(identity, status, action);
  return row;
}

function createInspectorHeader(
  document: Document,
  item: ConnectionListItem,
  messages: RendererSettingsMessages,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-connection-inspector__header";
  const identity = document.createElement("div");
  identity.className = "settings-connection-inspector__identity";
  const title = document.createElement("strong");
  title.textContent = item.name;
  identity.append(createConnectionIdentityIcon(document, item, 20), title);
  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.dataset.connectionTone = connectionStatusTone(item.availability, item.error !== null);
  status.textContent = connectionStatusLabel(item.availability, messages, item.error !== null);
  header.append(identity, status);
  return header;
}

function renderOneClickInstallSection(
  document: Document,
  container: HTMLElement,
  agent: ExternalRendererAgent,
  name: string,
  hostId: string,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
): void {
  const section = document.createElement("div");
  section.className = "settings-connection-install-callout";

  const head = document.createElement("div");
  head.className = "settings-connection-install-head";
  const icon = document.createElement("span");
  icon.className = "settings-connection-install-callout__icon";
  icon.append(createRendererSettingsIcon("download", 18));
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${messages.connectionInstall} ${name}`;
  const description = document.createElement("p");
  description.textContent = messages.connectionInstallDescription;
  copy.append(title, description);
  head.append(icon, copy);

  const commandInfo = HARNESS_INSTALL_COMMANDS[agent];
  const commandBox = document.createElement("div");
  commandBox.className = "settings-install-command-box";
  commandBox.hidden = !commandInfo;
  const commandLabel = document.createElement("span");
  commandLabel.className = "settings-install-command-label";
  commandLabel.textContent = messages.installCommandLabel;
  const commandRow = document.createElement("div");
  commandRow.className = "settings-install-command-row";
  const code = document.createElement("code");
  code.textContent = commandInfo?.command ?? `npm install -g ${agent}`;
  commandRow.append(code);
  commandBox.append(commandLabel, commandRow);

  const actions = document.createElement("div");
  actions.className = "settings-install-actions";

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.hidden = !commandInfo;
  installBtn.disabled = !commandInfo;
  installBtn.className = "settings-command-button";
  installBtn.append(createRendererSettingsIcon("download", 15), messages.oneClickInstall);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.hidden = !commandInfo;
  copyBtn.className = "settings-command-button settings-command-button--secondary";
  copyBtn.append(createRendererSettingsIcon("copy", 15), messages.copyInstallCommand);

  const downloadLink = document.createElement("a");
  downloadLink.className = "settings-command-button settings-command-button--secondary";
  downloadLink.href = HARNESS_INSTALL_URLS[agent];
  downloadLink.target = "_blank";
  downloadLink.rel = "noopener noreferrer";
  downloadLink.append(createRendererSettingsIcon("external-link", 15), messages.officialDownload);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "settings-command-button settings-command-button--secondary";
  refreshBtn.append(createRendererSettingsIcon("diagnose", 15), messages.refreshDetection);

  const feedback = document.createElement("div");
  feedback.className = "settings-install-feedback";

  copyBtn.addEventListener("click", () => {
    const text = commandInfo?.command ?? `npm install -g ${agent}`;
    const clipboard = document.defaultView?.navigator?.clipboard;
    if (clipboard) {
      void clipboard.writeText(text).then(() => {
        copyBtn.textContent = messages.installCommandCopied;
        document.defaultView?.setTimeout(() => {
          copyBtn.replaceChildren(createRendererSettingsIcon("copy", 15), messages.copyInstallCommand);
        }, 2000);
      });
    }
  });

  refreshBtn.addEventListener("click", () => {
    void diagnostics?.refresh();
  });

  installBtn.addEventListener("click", () => {
    if (installBtn.disabled) return;
    installBtn.disabled = true;
    installBtn.replaceChildren(createRendererSettingsIcon("download", 15), messages.oneClickInstalling);
    feedback.textContent = "";
    feedback.className = "settings-install-feedback";

    const run = async () => {
      if (!diagnostics?.installHarness) {
        const text = commandInfo?.command ?? `npm install -g ${agent}`;
        await document.defaultView?.navigator?.clipboard?.writeText(text);
        feedback.className = "settings-install-feedback settings-feedback-warning";
        feedback.textContent = messages.oneClickInstallFailed;
        installBtn.disabled = false;
        installBtn.replaceChildren(createRendererSettingsIcon("download", 15), messages.oneClickInstall);
        return;
      }
      try {
        const result = await diagnostics.installHarness(hostId, agent);
        if (result.success) {
          feedback.className = "settings-install-feedback settings-feedback-success";
          feedback.textContent = messages.oneClickInstallSuccess;
          installBtn.replaceChildren(createRendererSettingsIcon("check", 15), messages.oneClickInstallSuccess);
          document.defaultView?.setTimeout(() => {
            void diagnostics.refresh();
          }, 1000);
        } else {
          feedback.className = "settings-install-feedback settings-feedback-error";
          feedback.textContent = `${messages.oneClickInstallFailed} ${result.error ?? ""}`;
          installBtn.disabled = false;
          installBtn.replaceChildren(createRendererSettingsIcon("download", 15), messages.oneClickInstall);
        }
      } catch (err: unknown) {
        feedback.className = "settings-install-feedback settings-feedback-error";
        feedback.textContent = `${messages.oneClickInstallFailed} ${err instanceof Error ? err.message : String(err)}`;
        installBtn.disabled = false;
        installBtn.replaceChildren(createRendererSettingsIcon("download", 15), messages.oneClickInstall);
      }
    };
    void run();
  });

  actions.append(installBtn, copyBtn, downloadLink, refreshBtn);
  section.append(head, commandBox, actions, feedback);
  container.append(section);
}

function renderModelConfigurationSection(
  document: Document,
  container: HTMLElement,
  agent: ExternalRendererAgent,
  hostId: string,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
): void {
  const card = document.createElement("div");
  card.className = "settings-model-config-panel";

  const cardHead = document.createElement("div");
  cardHead.className = "settings-model-config-head";
  const title = document.createElement("strong");
  title.className = "settings-model-config-title";
  title.textContent = messages.modelConfigurationTitle;
  const description = document.createElement("p");
  description.className = "settings-model-config-description";
  description.textContent = messages.modelConfigurationDescription;
  cardHead.append(title, description);
  card.append(cardHead);

  const loading = document.createElement("div");
  loading.className = "settings-model-config-loading";
  loading.textContent = messages.loadingModels;
  card.append(loading);
  container.append(card);

  if (!diagnostics?.inspectHarness) {
    loading.textContent = messages.notAvailable;
    return;
  }

  void diagnostics.inspectHarness(hostId, agent).then(
    (inspection) => {
      loading.remove();
      if (inspection.status !== "ready") {
        const empty = document.createElement("div");
        empty.className = "settings-model-config-empty";
        empty.textContent = inspection.error?.message ?? messages.noModelsAvailable;
        card.append(empty);
        return;
      }
      const catalog = inspection.catalog;
      if (!catalog || !catalog.models || catalog.models.length === 0) {
        const empty = document.createElement("div");
        empty.className = "settings-model-config-empty";
        empty.textContent = messages.noModelsAvailable;
        card.append(empty);
        return;
      }

      const pref = readNewThreadExternalConfigurationPreference(
        agent,
        catalog,
        inspection.permissionModes,
      );

      const form = document.createElement("div");
      form.className = "settings-model-config-form";

      // Model Select
      const modelField = document.createElement("div");
      modelField.className = "settings-model-config-field";
      const modelLabel = document.createElement("label");
      modelLabel.className = "settings-model-config-label";
      modelLabel.textContent = messages.modelSelectLabel;
      const modelSelect = document.createElement("select");
      modelSelect.className = "settings-model-config-select";

      const initialModelId = pref?.model.id ?? catalog.defaultModel?.id ?? catalog.models[0]?.ref.id;
      for (const m of catalog.models) {
        const option = document.createElement("option");
        option.value = m.ref.id;
        option.textContent = m.label || m.ref.id;
        if (m.ref.id === initialModelId) option.selected = true;
        modelSelect.append(option);
      }
      modelField.append(modelLabel, modelSelect);
      form.append(modelField);

      // Thinking Select (if supported)
      const thinkingField = document.createElement("div");
      thinkingField.className = "settings-model-config-field";
      const thinkingLabel = document.createElement("label");
      thinkingLabel.className = "settings-model-config-label";
      thinkingLabel.textContent = messages.thinkingSelectLabel;
      const thinkingSelect = document.createElement("select");
      thinkingSelect.className = "settings-model-config-select";
      thinkingField.append(thinkingLabel, thinkingSelect);

      const updateThinkingOptions = () => {
        const currentModel = catalog.models.find((m) => m.ref.id === modelSelect.value);
        const supportedIds = currentModel?.supportedThinkingOptionIds ?? catalog.thinkingOptions?.map((o) => o.id) ?? [];
        thinkingSelect.replaceChildren();

        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = messages.thinkingOptionDefault;
        thinkingSelect.append(defaultOption);

        const availableThinking = (catalog.thinkingOptions ?? []).filter((o) => supportedIds.includes(o.id));
        if (availableThinking.length === 0) {
          thinkingField.style.display = "none";
          return;
        }
        thinkingField.style.display = "flex";
        for (const opt of availableThinking) {
          const option = document.createElement("option");
          option.value = opt.id;
          option.textContent = opt.label || opt.id;
          if (opt.id === (pref?.thinkingOptionId ?? catalog.defaultThinkingOptionId)) {
            option.selected = true;
          }
          thinkingSelect.append(option);
        }
      };

      updateThinkingOptions();
      modelSelect.addEventListener("change", updateThinkingOptions);
      form.append(thinkingField);

      // Buttons & Feedback
      const actions = document.createElement("div");
      actions.className = "settings-model-config-actions";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "settings-command-button";
      saveBtn.append(createRendererSettingsIcon("check", 15), messages.saveModelPreference);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "settings-command-button settings-command-button--secondary";
      resetBtn.append(createRendererSettingsIcon("undo", 15), messages.resetModelPreference);

      const feedback = document.createElement("span");
      feedback.className = "settings-model-config-feedback";

      saveBtn.addEventListener("click", () => {
        const targetModel = catalog.models.find((m) => m.ref.id === modelSelect.value);
        if (!targetModel) return;
        const thinkingOpt = catalog.thinkingOptions?.find((o) => o.id === thinkingSelect.value);
        const thinkingVal = thinkingOpt?.id;
        writeNewThreadExternalConfigurationPreference(agent, targetModel.ref, thinkingVal);
        feedback.className = "settings-model-config-feedback settings-feedback-success";
        feedback.textContent = messages.preferenceSaved;
        document.defaultView?.setTimeout(() => {
          feedback.textContent = "";
        }, 3500);
      });

      resetBtn.addEventListener("click", () => {
        const defaultRef = catalog.defaultModel ?? catalog.models[0]?.ref;
        if (!defaultRef) return;
        writeNewThreadExternalConfigurationPreference(agent, defaultRef, catalog.defaultThinkingOptionId);
        modelSelect.value = defaultRef.id;
        updateThinkingOptions();
        if (catalog.defaultThinkingOptionId) thinkingSelect.value = catalog.defaultThinkingOptionId;
        feedback.className = "settings-model-config-feedback settings-feedback-info";
        feedback.textContent = messages.preferenceReset;
        document.defaultView?.setTimeout(() => {
          feedback.textContent = "";
        }, 3500);
      });

      actions.append(saveBtn, resetBtn, feedback);
      form.append(actions);
      card.append(form);
    },
    (err: unknown) => {
      loading.textContent = `${messages.connectionErrorTitle}: ${err instanceof Error ? err.message : String(err)}`;
    },
  );
}

function renderConnectionInspector(
  document: Document,
  inspector: HTMLElement,
  item: ConnectionListItem,
  hostId: string,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null = null,
): void {
  inspector.replaceChildren(createInspectorHeader(document, item, messages));
  const body = document.createElement("div");
  body.className = "settings-connection-inspector__body";

  if (item.agentSnapshot && (item.agentSnapshot.availability === "notInstalled" || item.agentSnapshot.availability === "unavailable")) {
    renderOneClickInstallSection(
      document,
      body,
      item.agentSnapshot.agent,
      item.name,
      hostId,
      messages,
      diagnostics,
    );
  } else if (item.error) {
    const summary = document.createElement("div");
    summary.className = "settings-connection-error-summary";
    const title = document.createElement("strong");
    title.textContent = messages.connectionErrorTitle;
    const description = document.createElement("p");
    description.textContent = item.error.message;
    summary.append(title, description);

    const metadata = document.createElement("div");
    metadata.className = "settings-connection-error-metadata";
    metadata.append(
      detailLine(document, messages.connectionErrorCode, item.error.code),
      detailLine(document, messages.connectionRetryable, String(item.error.retryable)),
    );
    if (item.error.stage) {
      metadata.append(detailLine(document, messages.connectionFailureStage, item.error.stage));
    }
    if (item.error.durationMs !== undefined) {
      metadata.append(
        detailLine(document, messages.connectionDuration, `${item.error.durationMs} ms`),
      );
    }
    if (item.error.diagnostic) {
      metadata.append(detailLine(document, messages.connectionDiagnostic, item.error.diagnostic));
    }

    const logHeader = document.createElement("div");
    logHeader.className = "settings-connection-error-log-header";
    const logTitle = document.createElement("strong");
    logTitle.textContent = messages.connectionErrorLog;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "settings-command-button settings-command-button--secondary";
    setCopyButtonLabel(copy, messages.connectionCopyDetails);
    const report = diagnosticText(hostId, item);
    copy.addEventListener("click", () => {
      copyDiagnosticsToClipboard(document, copy, report, messages, messages.connectionCopyDetails);
    });
    logHeader.append(logTitle, copy);
    const log = document.createElement("pre");
    log.className = "settings-connection-stderr";
    log.textContent = item.error.stderrTail ?? item.error.diagnostic ?? report;

    const actions = document.createElement("div");
    actions.className = "settings-connection-error-actions";
    const issue = document.createElement("a");
    issue.className = "settings-command-button settings-command-button--secondary";
    issue.href = CODEXHOST_GITHUB_ISSUES_NEW_URL;
    issue.target = "_blank";
    issue.rel = "noopener noreferrer";
    issue.append(messages.connectionOpenIssue, createRendererSettingsIcon("external-link", 14));
    actions.append(issue);
    const issueNote = document.createElement("p");
    issueNote.className = "settings-connection-issue-note";
    issueNote.textContent = messages.connectionIssueDescription;
    body.append(summary, metadata, logHeader, log, actions, issueNote);
  } else {
    const status = document.createElement("div");
    status.className = "settings-connection-state-summary";
    const title = document.createElement("strong");
    title.textContent = connectionStatusLabel(item.availability, messages);
    const description = document.createElement("p");
    description.textContent =
      item.availability === "ready"
        ? messages.connectionReadyDescription
        : messages.connectionUnavailableDescription;
    status.append(title, description);
    body.append(status);

    if (item.openWebUi) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "settings-command-button settings-command-button--secondary";
      open.dataset.connectionAction = "open-web-ui";
      open.append(
        messages.connectionOpenHarnessWeb,
        createRendererSettingsIcon("external-link", 14),
      );
      open.addEventListener("click", () => {
        if (open.disabled) return;
        open.disabled = true;
        void item
          .openWebUi?.()
          .catch(() => undefined)
          .finally(() => {
            open.disabled = false;
          });
      });
      body.append(open);
    }

    if (item.agentSnapshot && item.availability === "ready") {
      renderModelConfigurationSection(
        document,
        body,
        item.agentSnapshot.agent,
        hostId,
        messages,
        diagnostics,
      );
    }
  }

  inspector.append(body);
}

function connectionItems(
  snapshot: RendererConnectionSnapshot,
  host: RendererConnectionHostSnapshot,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
): ConnectionListItem[] {
  return [
    {
      key: "renderer-adapter",
      name: messages.connectionAdapter,
      availability: snapshot.adapter.state,
      error: null,
    },
    ...host.agents.map((agent): ConnectionListItem => ({
      key: agent.agent,
      name: RENDERER_AGENT_LABELS[agent.agent],
      availability: agent.availability,
      error: agent.availability === "notInstalled" ? null : agent.error,
      agentSnapshot: agent,
      ...(host.hostId === "local" && agent.webUiAvailable && diagnostics?.openWebUi
        ? {
            openWebUi: () => diagnostics.openWebUi?.(host.hostId, agent.agent) ?? Promise.resolve(),
          }
        : {}),
    })),
  ];
}

// Lets another surface (currently: the Agent picker's error indicator, see
// renderer-agent-picker.ts) ask the Connections page to focus a specific
// Agent's row the next time it mounts, instead of falling back to "the
// first Agent that needs attention". Consumed once, then cleared — if the
// requested Agent isn't present under whichever Host tab is selected by
// default, this silently falls through to the existing fallback below.
let pendingFocusAgent: string | null = null;

export function requestConnectionsPageFocus(agentKey: string): void {
  pendingFocusAgent = agentKey;
}

function createGroupDivider(
  document: Document,
  messages: RendererSettingsMessages,
  count: number,
): HTMLElement {
  const divider = document.createElement("div");
  divider.className = "settings-connection-group-divider";
  divider.setAttribute("role", "presentation");
  divider.textContent = `${messages.connectionGroupMoreLabel} (${count})`;
  return divider;
}

function createGroupMoreHint(document: Document, messages: RendererSettingsMessages): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "settings-connection-group-hint";
  hint.setAttribute("role", "presentation");
  const title = document.createElement("strong");
  title.textContent = messages.connectionGroupMoreHintTitle;
  const body = document.createElement("span");
  body.textContent = messages.connectionGroupMoreHintBody;
  hint.append(title, body);
  return hint;
}

function createGroupResetButton(
  document: Document,
  messages: RendererSettingsMessages,
  onReset: () => void,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-connection-group-reset";
  button.append(createRendererSettingsIcon("undo", 14), messages.connectionGroupReset);
  button.addEventListener("click", onReset);
  return button;
}

export function createConnectionsSettingsPage(
  messages: RendererSettingsMessages,
  getDiagnostics: () => RendererConnectionDiagnostics | null,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "connections",
    label: messages.pageLabels.connections,
    icon: "connections",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-connection-page-header";
      const headingCopy = document.createElement("div");
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.connections;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.connectionsDescription;
      headingCopy.append(heading, description);
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "settings-command-button settings-command-button--secondary";
      refresh.dataset.connectionAction = "refresh";
      refresh.append(createRendererSettingsIcon("diagnose", 16), messages.connectionRefresh);
      header.append(headingCopy, refresh);
      const content = document.createElement("div");
      content.className = "settings-connections-content";
      context.content.append(header, content);

      let pending = false;
      let selectedHostId: string | null = null;
      let selectedItemKey: string | null = null;
      let latestSnapshot: RendererConnectionSnapshot | null = null;
      let disposeHostScroller = (): void => undefined;

      const diagnostics = getDiagnostics();
      const runRefresh = (): void => {
        if (pending || !diagnostics) return;
        pending = true;
        refresh.disabled = true;
        refresh.replaceChildren(
          createRendererSettingsIcon("diagnose", 16),
          messages.connectionRefreshing,
        );
        void context.runLatest(() => diagnostics.refresh(), {
          success() {
            pending = false;
            refresh.disabled = false;
            refresh.replaceChildren(
              createRendererSettingsIcon("diagnose", 16),
              messages.connectionRefresh,
            );
            render(diagnostics.snapshot());
          },
          failure(error) {
            pending = false;
            refresh.disabled = false;
            refresh.replaceChildren(
              createRendererSettingsIcon("diagnose", 16),
              messages.connectionRefresh,
            );
            const snapshot = diagnostics.snapshot();
            render({
              ...snapshot,
              hosts: snapshot.hosts.map((host) => ({
                ...host,
                agents: host.agents.map((agent) => ({
                  ...agent,
                  availability: "error",
                  error: {
                    code: "internalError",
                    message: error instanceof Error ? error.message : String(error),
                    retryable: true,
                    stage: "request",
                  },
                })),
              })),
            });
          },
        });
      };

      const render = (snapshot: RendererConnectionSnapshot | null): void => {
        latestSnapshot = snapshot;
        disposeHostScroller();
        disposeHostScroller = () => undefined;
        content.replaceChildren();
        if (!snapshot) {
          const empty = document.createElement("div");
          empty.className = "settings-empty";
          empty.textContent = messages.connectionNoRuntime;
          content.append(empty);
          return;
        }
        const selectedHost =
          (selectedHostId
            ? snapshot.hosts.find((host) => host.hostId === selectedHostId)
            : undefined) ??
          snapshot.hosts.find((host) => host.active) ??
          snapshot.hosts.find((host) => host.hostId === "local") ??
          snapshot.hosts[0];
        if (!selectedHost) return;
        selectedHostId = selectedHost.hostId;

        const layout = document.createElement("div");
        layout.className = "settings-connections-layout";
        const list = document.createElement("section");
        list.className = "settings-connection-list";
        const hostStrip = document.createElement("div");
        hostStrip.className = "settings-connection-host-strip";
        const scrollLeft = createHostScrollButton(document, "left", messages);
        const tabs = document.createElement("div");
        tabs.className = "settings-connection-host-tabs";
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", messages.connectionHosts);
        const scrollRight = createHostScrollButton(document, "right", messages);
        const panelId = "codexhost-settings-connection-host-panel";

        snapshot.hosts.forEach((host, index) => {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.className = "settings-connection-host-tab";
          tab.dataset.connectionHostTab = host.hostId;
          tab.dataset.connectionHostActive = String(host.active);
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", panelId);
          tab.setAttribute("aria-selected", String(host.hostId === selectedHost.hostId));
          tab.tabIndex = host.hostId === selectedHost.hostId ? 0 : -1;
          const hostName = connectionHostName(host.hostId, messages);
          tab.textContent = hostName;
          tab.title = host.active ? `${hostName} · ${messages.connectionActiveHost}` : hostName;
          tab.addEventListener("click", () => {
            selectedHostId = host.hostId;
            render(latestSnapshot);
          });
          tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const next =
              snapshot.hosts[(index + direction + snapshot.hosts.length) % snapshot.hosts.length];
            if (!next) return;
            selectedHostId = next.hostId;
            render(latestSnapshot);
            const nextTab = [
              ...content.querySelectorAll<HTMLButtonElement>("[data-connection-host-tab]"),
            ].find((candidate) => candidate.dataset.connectionHostTab === next.hostId);
            nextTab?.focus();
          });
          tabs.append(tab);
        });
        hostStrip.append(scrollLeft, tabs, scrollRight);

        const tableHeader = document.createElement("div");
        tableHeader.className = "settings-connection-table-header";
        tableHeader.setAttribute("role", "row");
        const componentHeading = document.createElement("span");
        componentHeading.textContent = messages.connectionComponent;
        componentHeading.setAttribute("role", "columnheader");
        const statusHeading = document.createElement("span");
        statusHeading.textContent = messages.connectionStatus;
        statusHeading.setAttribute("role", "columnheader");
        const actionHeading = document.createElement("span");
        actionHeading.setAttribute("aria-hidden", "true");
        tableHeader.append(componentHeading, statusHeading, actionHeading);

        const rows = document.createElement("div");
        rows.className = "settings-connection-rows";
        rows.id = panelId;
        rows.dataset.connectionHost = selectedHost.hostId;
        rows.setAttribute("role", "rowgroup");
        const inspector = document.createElement("aside");
        inspector.className = "settings-connection-inspector";
        inspector.setAttribute("aria-live", "polite");
        const items = connectionItems(snapshot, selectedHost, messages, diagnostics);
        if (!items.some((item) => item.key === selectedItemKey)) {
          const requestedFocus = pendingFocusAgent;
          pendingFocusAgent = null;
          selectedItemKey =
            (requestedFocus && items.some((item) => item.key === requestedFocus)
              ? requestedFocus
              : undefined) ??
            items.find(
              (item) => item.agentSnapshot?.availability === "notInstalled" || item.error !== null,
            )?.key ??
            items[0]?.key ??
            null;
        }
        const rowElements = new Map<string, HTMLElement>();
        const selectItem = (item: ConnectionListItem): void => {
          selectedItemKey = item.key;
          for (const [key, row] of rowElements) {
            const selected = key === item.key;
            row.dataset.connectionSelected = String(selected);
            row.tabIndex = selected ? 0 : -1;
          }
          renderConnectionInspector(document, inspector, item, selectedHost.hostId, messages, diagnostics);
        };

        const pinnedItem = items.find((item) => item.key === "renderer-adapter");
        if (pinnedItem) {
          const row = createConnectionRow(
            document,
            pinnedItem,
            messages,
            pinnedItem.key === selectedItemKey,
            () => selectItem(pinnedItem),
          );
          rowElements.set(pinnedItem.key, row);
          rows.append(row);
        }

        // Only real, switchable external Agents participate in the
        // Main / More grouping — the Renderer adapter above stays pinned.
        const groupableItems = items.filter(
          (item): item is ConnectionListItem & { agentSnapshot: RendererConnectionAgentSnapshot } =>
            item.agentSnapshot !== undefined,
        );
        const agentByKey = new Map(groupableItems.map((item) => [item.key, item]));
        const preferenceOrder = groupPreference
          .list()
          .filter((entry) => agentByKey.has(entry.agent));
        for (const item of groupableItems) {
          if (!preferenceOrder.some((entry) => entry.agent === item.key)) {
            preferenceOrder.push({ agent: item.key as ExternalRendererAgent, section: "main" });
          }
        }
        const mainEntries = preferenceOrder.filter((entry) => entry.section === "main");
        const moreEntries = preferenceOrder.filter((entry) => entry.section === "more");
        const nextInSection = (
          section: AgentGroupSection,
          agent: ExternalRendererAgent,
        ): ExternalRendererAgent | null => {
          const list = section === "main" ? mainEntries : moreEntries;
          const index = list.findIndex((entry) => entry.agent === agent);
          return index >= 0 ? (list[index + 1]?.agent ?? null) : null;
        };

        let draggingAgent: ExternalRendererAgent | null = null;
        // Assigned below only when there is at least one groupable Agent to
        // show a More zone for; guarded everywhere it's read.
        let moreZone: HTMLElement | null = null;
        const clearDropIndicators = (): void => {
          for (const row of rowElements.values()) row.dataset.connectionDropIndicator = "";
          if (moreZone) moreZone.dataset.connectionDragOver = "false";
        };
        const dropTargetSection = (
          agent: ExternalRendererAgent,
          event: DragEvent,
        ): { before: boolean; beforeAgent: ExternalRendererAgent | null } => {
          const row = rowElements.get(agent);
          const rect =
            row && typeof row.getBoundingClientRect === "function"
              ? row.getBoundingClientRect()
              : null;
          const before = rect ? event.clientY - rect.top < rect.height / 2 : true;
          const section = (row?.dataset.connectionGroupSection ?? "main") as AgentGroupSection;
          return { before, beforeAgent: before ? agent : nextInSection(section, agent) };
        };
        const createGroupController = (
          agent: ExternalRendererAgent,
          section: AgentGroupSection,
        ): ConnectionRowGroupController => ({
          section,
          moveLabel:
            section === "main"
              ? messages.connectionGroupMoveToMore
              : messages.connectionGroupMoveToMain,
          dragHandleTitle: messages.connectionGroupDragHandle,
          toggleSection() {
            groupPreference.moveAgent(agent, section === "main" ? "more" : "main", null);
          },
          onDragStart(event) {
            draggingAgent = agent;
            event.dataTransfer?.setData("text/plain", agent);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            const row = rowElements.get(agent);
            if (row) row.dataset.connectionDragging = "true";
          },
          onDragOver(event) {
            if (!draggingAgent || draggingAgent === agent) return;
            event.preventDefault();
            const row = rowElements.get(agent);
            if (!row) return;
            const { before } = dropTargetSection(agent, event);
            clearDropIndicators();
            row.dataset.connectionDropIndicator = before ? "before" : "after";
          },
          onDragLeave() {
            const row = rowElements.get(agent);
            if (row) row.dataset.connectionDropIndicator = "";
          },
          onDrop(event) {
            event.preventDefault();
            if (!draggingAgent) return;
            const { beforeAgent } = dropTargetSection(agent, event);
            groupPreference.moveAgent(draggingAgent, section, beforeAgent);
            draggingAgent = null;
            clearDropIndicators();
          },
          onDragEnd() {
            draggingAgent = null;
            const row = rowElements.get(agent);
            if (row) row.dataset.connectionDragging = "false";
            clearDropIndicators();
          },
        });

        const appendGroupRow = (agent: ExternalRendererAgent, section: AgentGroupSection): void => {
          const item = agentByKey.get(agent);
          if (!item) return;
          const row = createConnectionRow(
            document,
            item,
            messages,
            item.key === selectedItemKey,
            () => selectItem(item),
            createGroupController(agent, section),
          );
          rowElements.set(item.key, row);
          rows.append(row);
        };

        for (const entry of mainEntries) appendGroupRow(entry.agent, "main");

        if (groupableItems.length > 0) {
          rows.append(createGroupDivider(document, messages, moreEntries.length));
          const zone = document.createElement("div");
          moreZone = zone;
          zone.className = "settings-connection-group-more";
          zone.setAttribute("role", "presentation");
          zone.addEventListener("dragover", (event) => {
            if (!draggingAgent) return;
            event.preventDefault();
            zone.dataset.connectionDragOver = "true";
          });
          zone.addEventListener("dragleave", () => {
            zone.dataset.connectionDragOver = "false";
          });
          zone.addEventListener("drop", (event) => {
            event.preventDefault();
            zone.dataset.connectionDragOver = "false";
            if (!draggingAgent) return;
            groupPreference.moveAgent(draggingAgent, "more", null);
            draggingAgent = null;
            clearDropIndicators();
          });
          if (moreEntries.length === 0) {
            zone.append(createGroupMoreHint(document, messages));
          } else {
            for (const entry of moreEntries) {
              const item = agentByKey.get(entry.agent);
              if (!item) continue;
              const row = createConnectionRow(
                document,
                item,
                messages,
                item.key === selectedItemKey,
                () => selectItem(item),
                createGroupController(entry.agent, "more"),
              );
              rowElements.set(item.key, row);
              zone.append(row);
            }
          }
          rows.append(zone);

          rows.append(
            createGroupResetButton(document, messages, () => {
              groupPreference.resetToDefault();
            }),
          );
        }

        const selectedItem = items.find((item) => item.key === selectedItemKey) ?? items[0];
        if (selectedItem) selectItem(selectedItem);
        list.append(hostStrip, tableHeader, rows);
        layout.append(list, inspector);
        content.append(layout);
        disposeHostScroller = configureHostScroller(
          document,
          hostStrip,
          tabs,
          scrollLeft,
          scrollRight,
        );
        const selectedTab = [...tabs.children].find(
          (child) => child.getAttribute("aria-selected") === "true",
        ) as HTMLElement | undefined;
        selectedTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };

      render(diagnostics?.snapshot() ?? null);
      // Keep the Main / More grouping in sync with any other open picker or
      // settings instance (e.g. the Agent picker's "Manage" shortcut).
      const unsubscribeGroup = groupPreference.subscribe(() =>
        render(diagnostics?.snapshot() ?? latestSnapshot),
      );
      if (!diagnostics) {
        refresh.disabled = true;
        return () => {
          disposeHostScroller();
          unsubscribeGroup();
        };
      }
      refresh.addEventListener("click", runRefresh);
      const unsubscribe = diagnostics.subscribe(() => render(diagnostics.snapshot()));
      return () => {
        disposeHostScroller();
        unsubscribe();
        unsubscribeGroup();
      };
    },
  });
}
