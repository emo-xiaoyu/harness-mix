import type { HarnessAccountListResult } from "@harnessmix/shared-contracts";
import { KNOWN_RENDERER_AGENTS } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { createRendererSettingsIcon } from "./icons.js";
import { renderAccountUsage, type AccountUsageDisplay } from "./accounts-usage.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererHarnessAccountClient {
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
  loginHarnessAccount?(input: { harnessId: string }): Promise<{ success: boolean; command?: string | undefined; error?: string | undefined }>;
}

/**
 * Read-only listing of accounts owned by the native Harnesses themselves.
 * Kept strictly apart from Codex Account ids and their mutation flows.
 */
export function mountHarnessAccounts(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => RendererHarnessAccountClient | null,
  onChange: () => void,
) {
  const document = context.content.ownerDocument;
  const section = document.createElement("section");
  section.className = "settings-harness-accounts";
  section.hidden = true;
  const heading = document.createElement("h2");
  heading.className = "settings-harness-accounts__title";
  heading.textContent = messages.harnessAccountsPageTitle || messages.harnessAccountsTitle;
  const list = document.createElement("div");
  list.className = "settings-account-list";
  section.append(heading, list);
  context.content.append(section);

  let accounts: HarnessAccountListResult["accounts"] = [];
  let refreshing = false;
  let query = "";
  let display: AccountUsageDisplay = "remaining";
  let refresh: () => Promise<void>;

  const appendSeparator = (parent: HTMLElement): void => {
    const separator = document.createElement("span");
    separator.textContent = "·";
    separator.setAttribute("aria-hidden", "true");
    parent.append(separator);
  };

  const harnessRow = (account: HarnessAccountListResult["accounts"][number]): HTMLElement => {
    const row = document.createElement("article");
    row.className = "settings-harness-account";
    row.dataset.harnessId = account.harnessId;

    const identity = document.createElement("div");
    identity.className = "settings-harness-account__identity";
    const name = document.createElement("strong");
    name.className = "settings-account-email";
    const accountName = account.email ?? account.label;
    name.textContent = accountName ?? account.harnessName;
    name.title = name.textContent;
    identity.append(name);

    const metadata = document.createElement("div");
    metadata.className = "settings-account-metadata";
    if (accountName) {
      const harness = document.createElement("span");
      harness.textContent = account.harnessName;
      metadata.append(harness);
    }
    if (account.plan) {
      if (accountName) appendSeparator(metadata);
      const plan = document.createElement("span");
      plan.className = "settings-account-plan";
      plan.textContent = account.plan;
      metadata.append(plan);
    }
    if (account.status) {
      if (accountName || account.plan) appendSeparator(metadata);
      const statusBadge = document.createElement("span");
      statusBadge.className = `settings-harness-account__badge settings-harness-account__badge--${account.status}`;
      statusBadge.textContent =
        account.status === "ready"
          ? messages.harnessAccountStatusReady
          : account.status === "not_installed"
            ? messages.harnessAccountStatusNotInstalled
            : messages.harnessAccountStatusUnconfigured;
      metadata.append(statusBadge);
    }
    if (metadata.childElementCount) identity.append(metadata);

    if (account.configHint) {
      const configHint = document.createElement("div");
      configHint.className = "settings-harness-account__config-hint";
      configHint.title = account.configHint;
      const label = document.createElement("span");
      label.textContent = `${messages.harnessAccountConfigGuide}: `;
      const code = document.createElement("code");
      code.textContent = account.configHint;
      configHint.append(label, code);
      identity.append(configHint);
    }

    const usage = account.credits
      ? renderAccountUsage(
          document,
          { status: "ready", credits: account.credits },
          messages,
          display,
          () => undefined,
        )
      : null;

    const person = document.createElement("div");
    person.className = "settings-account-row__person";
    const agent = KNOWN_RENDERER_AGENTS.find((candidate) => candidate === account.harnessId);
    if (agent) {
      const logo = document.createElement("div");
      logo.className = "settings-harness-account__logo";
      logo.setAttribute("aria-hidden", "true");
      logo.append(createRendererAgentIcon(agent, 28, document));
      person.append(logo);
    }
    person.append(identity);
    row.append(person);
    if (usage) row.append(usage);

    const actions = document.createElement("div");
    actions.className = "settings-harness-account__actions";
    if (account.loginCommand) {
      actions.append(loginButton(account));
    }
    if (actions.childElementCount > 0) {
      row.append(actions);
    }
    return row;
  };

  const loginButton = (
    account: HarnessAccountListResult["accounts"][number],
  ): HTMLButtonElement => {
    const loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = "settings-command-button settings-command-button--secondary settings-harness-account__login-btn";
    loginBtn.append(createRendererSettingsIcon("external-link", 14), messages.harnessAccountLogin);
    loginBtn.title = account.loginCommand!;
    loginBtn.addEventListener("click", () => {
      const client = getClient();
      if (!client?.loginHarnessAccount) return;
      loginBtn.disabled = true;
      loginBtn.textContent = messages.harnessAccountLoginStarted;
      // The native login flow opens outside the dialog; restore the button
      // and re-read the account list a moment after it settles.
      void client.loginHarnessAccount({ harnessId: account.harnessId }).finally(() => {
        document.defaultView?.setTimeout(() => {
          loginBtn.disabled = false;
          loginBtn.replaceChildren(createRendererSettingsIcon("external-link", 14), messages.harnessAccountLogin);
          void refresh();
        }, 3000);
      });
    });
    return loginBtn;
  };

  const render = (): void => {
    section.hidden = accounts.length === 0;
    list.replaceChildren();
    const visible = accounts.filter((account) =>
      `${account.harnessName} ${account.email ?? ""} ${account.label ?? ""} ${account.plan ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    );
    for (const account of visible) {
      list.append(harnessRow(account));
    }
    if (accounts.length && !visible.length) {
      const empty = document.createElement("p");
      empty.className = "settings-account-empty";
      empty.textContent = messages.accountNoMatches;
      list.append(empty);
    }
  };

  refresh = async (): Promise<void> => {
    if (refreshing || context.signal.aborted) return;
    const client = getClient();
    if (!client?.listHarnessAccounts) return;
    refreshing = true;
    onChange();
    try {
      const result = await client.listHarnessAccounts();
      if (!context.signal.aborted) accounts = result.accounts;
    } catch {
      // Hosts without the capability (or without readable auth) simply show
      // no read-only rows instead of failing the whole page.
      if (!context.signal.aborted) accounts = [];
    } finally {
      refreshing = false;
      if (!context.signal.aborted) {
        render();
        onChange();
      }
    }
  };

  return {
    get refreshing() {
      return refreshing;
    },
    update(nextQuery: string, nextDisplay: AccountUsageDisplay) {
      query = nextQuery;
      display = nextDisplay;
      render();
    },
    refresh,
  };
}
