import type { CodexAccountSummary } from "@harnessmix/shared-contracts";

import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import {
  renderAccountResetCredits,
  renderAccountUsage,
  type AccountUsageDisplay,
  type AccountUsageViewState,
} from "./accounts-usage.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

// Sequence source for the per-account reset-details row ids; module-level so
// ids stay unique across re-renders within one settings session.
let resetDetailsSequence = 0;

export function isCodexAccountAuthenticated(account: CodexAccountSummary): boolean {
  return account.authenticated ?? Boolean(account.email);
}

// Marketing label for a Codex plan type; unknown/absent plans stay silent.
function accountPlanLabel(planType: CodexAccountSummary["planType"]): string | null {
  if (!planType || planType === "unknown") return null;
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro 20x",
    prolite: "Pro 5x",
    team: "Team",
    self_serve_business_prolite: "Business Pro Lite",
    self_serve_business_usage_based: "Business",
    business: "Business",
    edu: "Edu",
    edu_plus: "Edu Plus",
    edu_pro: "Edu Pro",
  };
  return labels[planType] ?? "Enterprise";
}

/**
 * Captures where keyboard focus sits inside the account table so it can be
 * restored after an async update swaps out the table body.
 */
export function accountListFocusRestorer(list: HTMLElement, fallback: HTMLElement): () => void {
  const active = (list.getRootNode() as Document | ShadowRoot).activeElement;
  if (!active || !list.contains(active)) return () => undefined;
  const focusKey = active.getAttribute("data-account-focus");
  const accountId = active.closest<HTMLElement>(".settings-account-row")?.dataset.accountId;
  return () => {
    const sameControl = focusKey
      ? list.querySelector<HTMLElement>(`[data-account-focus="${CSS.escape(focusKey)}"]`)
      : null;
    if (sameControl && !sameControl.matches(":disabled")) {
      sameControl.focus({ preventScroll: true });
      return;
    }
    // The focused action may be temporarily disabled or removed after its
    // action succeeded: keep focus on the same Account row when it still
    // exists, otherwise hand focus to the page-level fallback.
    const sameRow = accountId
      ? list.querySelector<HTMLElement>(
          `.settings-account-row[data-account-id="${CSS.escape(accountId)}"]`,
        )
      : null;
    (sameRow ?? fallback).focus({ preventScroll: true });
  };
}

export function createAccountsTable(document: Document, messages: RendererSettingsMessages) {
  const table = document.createElement("table");
  table.className = "settings-account-table";
  table.setAttribute("aria-label", messages.pageLabels.accounts);
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of [
    messages.accountColumnAccount,
    messages.accountColumnUsage,
    messages.accountResetCredits,
    messages.accountColumnActions,
  ]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  table.append(head, body);
  return { table, body };
}

interface RenderAccountRowsInput {
  usage: AccountUsageViewState | undefined;
  display: AccountUsageDisplay;
  actionsDisabled: boolean;
  usingReset: boolean;
  resetDisabled: boolean;
  resetExpanded: boolean;
  onActivate: () => void;
  onSignIn: () => void;
  onSignOut?: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onUseReset?: () => void;
  onResetExpanded: (open: boolean) => void;
}

function accountIdentityCell(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
): HTMLTableCellElement {
  const cell = document.createElement("td");
  const person = document.createElement("div");
  person.className = "settings-account-row__person";
  const mark = document.createElement("div");
  mark.className = "settings-account-row__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.append(createRendererSettingsIcon("terminal", 17));
  const identity = document.createElement("div");
  identity.className = "settings-account-row__identity";

  const title = document.createElement("div");
  title.className = "settings-account-title";
  const local = document.createElement("strong");
  local.className = "settings-account-email";
  local.textContent = codexAccountDisplayName(account).local;
  local.title = codexAccountDisplayName(account).full;
  title.append(local);
  if (account.active) {
    const badge = document.createElement("span");
    badge.className = "settings-account-active";
    badge.textContent = messages.accountDefaultBadge;
    title.append(badge);
  }
  identity.append(title);

  const metadata = document.createElement("div");
  metadata.className = "settings-account-metadata";
  const name = codexAccountDisplayName(account);
  if (name.domain) {
    const domain = document.createElement("span");
    domain.className = "settings-account-domain";
    domain.textContent = `@${name.domain}`;
    metadata.append(domain);
  }
  const planLabel = accountPlanLabel(account.planType);
  if (planLabel) {
    if (name.domain) {
      const separator = document.createElement("span");
      separator.className = "settings-account-plan-separator";
      separator.textContent = "·";
      separator.setAttribute("aria-hidden", "true");
      metadata.append(separator);
    }
    const plan = document.createElement("span");
    plan.className =
      account.planType === "pro" || account.planType === "prolite"
        ? "settings-account-plan settings-account-plan--highlighted"
        : "settings-account-plan";
    plan.textContent = planLabel;
    metadata.append(plan);
  }
  if (metadata.childElementCount > 0) identity.append(metadata);

  person.append(mark, identity);
  cell.append(person);
  return cell;
}

function accountActionsCell(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
  input: RenderAccountRowsInput,
): HTMLTableCellElement {
  const cell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "settings-account-actions";
  const actionButton = (
    kind: "activate" | "login" | "logout",
    label: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-account-action";
    button.textContent = label;
    button.dataset.accountFocus = `${account.accountId}:${kind}`;
    button.disabled = input.actionsDisabled;
    button.addEventListener("click", onClick);
    return button;
  };
  if (!account.active) {
    actions.append(actionButton("activate", messages.accountUse, input.onActivate));
  }
  if (!isCodexAccountAuthenticated(account)) {
    actions.append(actionButton("login", messages.accountSignIn, input.onSignIn));
  }
  if (account.management === "native" && isCodexAccountAuthenticated(account) && input.onSignOut) {
    actions.append(actionButton("logout", messages.accountSignOut, input.onSignOut));
  }
  // Deletion is hidden for the default Account: isDefault marks the protected
  // native Account home, while active only selects which Account new tasks
  // use. These are two distinct Host semantics and must not be conflated.
  if (!account.isDefault) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-icon-button settings-account-delete";
    remove.title = messages.accountDelete;
    remove.dataset.accountFocus = `${account.accountId}:delete`;
    remove.setAttribute("aria-label", `${messages.accountDelete}: ${codexAccountDisplayName(account).full}`);
    remove.disabled = input.actionsDisabled;
    remove.append(createRendererSettingsIcon("trash", 16));
    remove.addEventListener("click", input.onDelete);
    actions.append(remove);
  }
  cell.append(actions);
  return cell;
}

export function renderAccountRows(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
  input: RenderAccountRowsInput,
): HTMLTableRowElement[] {
  const row = document.createElement("tr");
  row.className = "settings-account-row";
  row.dataset.accountId = account.accountId;
  row.dataset.accountFocus = `${account.accountId}:row`;
  row.tabIndex = -1;
  row.setAttribute("aria-label", codexAccountDisplayName(account).full);

  const usageCell = document.createElement("td");
  const usage = renderAccountUsage(document, input.usage, messages, input.display, input.onRetry);
  if (usage) usageCell.append(usage);

  const resetCell = document.createElement("td");
  const resetLabel = document.createElement("span");
  resetLabel.className = "settings-account-mobile-label";
  resetLabel.textContent = messages.accountResetCredits;
  resetCell.append(resetLabel);

  row.append(accountIdentityCell(document, account, messages), usageCell, resetCell, accountActionsCell(document, account, messages, input));

  const reset =
    input.usage?.status === "ready"
      ? renderAccountResetCredits(document, input.usage.credits, messages, input)
      : null;
  if (!reset) {
    const unknown = document.createElement("span");
    unknown.className = "settings-account-unknown";
    unknown.textContent = "—";
    unknown.title = messages.accountResetCreditsUnknown;
    unknown.setAttribute("aria-label", messages.accountResetCreditsUnknown);
    resetCell.append(unknown);
    return [row];
  }

  // Expandable second row holding the reset-credit details.
  const detailsRow = document.createElement("tr");
  detailsRow.className = "settings-account-details-row";
  detailsRow.id = `settings-account-reset-${++resetDetailsSequence}`;
  detailsRow.hidden = !input.resetExpanded;
  const detailsCell = document.createElement("td");
  detailsCell.colSpan = 4;
  detailsCell.append(reset.details);
  detailsRow.append(detailsCell);
  reset.summary.dataset.accountFocus = `${account.accountId}:reset`;
  reset.summary.setAttribute("aria-controls", detailsRow.id);
  reset.summary.setAttribute("aria-expanded", String(input.resetExpanded));
  reset.summary.addEventListener("click", () => {
    detailsRow.hidden = !detailsRow.hidden;
    reset.summary.setAttribute("aria-expanded", String(!detailsRow.hidden));
    input.onResetExpanded(!detailsRow.hidden);
  });
  resetCell.append(reset.summary);
  return [row, detailsRow];
}
