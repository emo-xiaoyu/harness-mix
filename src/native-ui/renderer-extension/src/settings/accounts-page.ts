import type {
  CodexAccountActivateParams,
  CodexAccountCreateParams,
  CodexAccountDeleteParams,
  CodexAccountDeleteResult,
  CodexAccountListResult,
  CodexAccountLoginCancelParams,
  CodexAccountLoginCancelResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartParams,
  CodexAccountLoginStartResult,
  CodexAccountMutationResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  CodexAccountResetCreditConsumeParams,
  CodexAccountResetCreditConsumeResult,
} from "@harnessmix/shared-contracts";

import {
  accountListFocusRestorer,
  createAccountsTable,
  isCodexAccountAuthenticated,
  renderAccountRows,
} from "./accounts-list.js";
import { mountHarnessAccounts, type RendererHarnessAccountClient } from "./harness-accounts.js";
import type { AccountUsageDisplay, AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCodexAccountClient extends RendererHarnessAccountClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  consumeCodexAccountResetCredit?(
    input: CodexAccountResetCreditConsumeParams,
  ): Promise<CodexAccountResetCreditConsumeResult>;
  createCodexAccount(input: CodexAccountCreateParams): Promise<CodexAccountMutationResult>;
  deleteCodexAccount(input: CodexAccountDeleteParams): Promise<CodexAccountDeleteResult>;
  activateCodexAccount(input: CodexAccountActivateParams): Promise<CodexAccountMutationResult>;
  startCodexAccountLogin(
    input: CodexAccountLoginStartParams,
  ): Promise<CodexAccountLoginStartResult>;
  cancelCodexAccountLogin(
    input: CodexAccountLoginCancelParams,
  ): Promise<CodexAccountLoginCancelResult>;
  logoutCodexAccount?(): Promise<CodexAccountMutationResult>;
  subscribeCodexAccountLogin?(listener: (result: CodexAccountLoginCompleted) => void): () => void;
}

// The Desktop renderer exposes an Electron bridge for opening links in the
// user's real browser; the device-code link prefers it over a raw navigation.
interface CodexDesktopLinkWindow extends Window {
  electronBridge?: {
    sendMessageFromView(message: unknown): unknown;
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function buildAccountHeader(
  document: Document,
  messages: RendererSettingsMessages,
): { header: HTMLElement; addButton: HTMLButtonElement } {
  const header = document.createElement("div");
  header.className = "settings-account-header";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "settings-account-eyebrow";
  eyebrow.textContent = "ACCOUNT MANAGEMENT";
  const heading = document.createElement("h1");
  heading.className = "settings-section-label";
  heading.textContent = messages.pageLabels.accounts;
  const description = document.createElement("p");
  description.className = "settings-page-description";
  description.textContent = messages.accountsDescription;
  copy.append(eyebrow, heading, description);
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "settings-command-button";
  addButton.append(createRendererSettingsIcon("add", 16), messages.accountAdd);
  header.append(copy, addButton);
  return { header, addButton };
}

function buildLoginHelpRow(
  document: Document,
  messages: RendererSettingsMessages,
): { helpRow: HTMLElement; deviceCodeNote: HTMLElement } {
  const helpRow = document.createElement("div");
  helpRow.className = "settings-account-help-row";
  const taskHint = document.createElement("p");
  taskHint.className = "settings-account-task-hint";
  const taskHintText = document.createElement("span");
  taskHintText.textContent = messages.accountTaskHint;
  taskHint.append(createRendererSettingsIcon("info", 16), taskHintText);
  const help = document.createElement("button");
  help.type = "button";
  help.className = "settings-account-help-button";
  help.append(createRendererSettingsIcon("help", 16), messages.accountLoginHelp);
  help.setAttribute("aria-expanded", "false");
  help.setAttribute("aria-controls", "settings-account-login-help");
  const deviceCodeNote = document.createElement("p");
  deviceCodeNote.id = "settings-account-login-help";
  deviceCodeNote.className = "settings-account-device-code-note";
  deviceCodeNote.textContent = messages.accountDeviceCodePrerequisite;
  deviceCodeNote.hidden = true;
  help.addEventListener("click", () => {
    deviceCodeNote.hidden = !deviceCodeNote.hidden;
    help.setAttribute("aria-expanded", String(!deviceCodeNote.hidden));
  });
  helpRow.append(taskHint, help);
  return { helpRow, deviceCodeNote };
}

export function createAccountsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCodexAccountClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "accounts",
    label: messages.pageLabels.accounts,
    icon: "accounts",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;

      // ---- page chrome -------------------------------------------------
      const { header, addButton } = buildAccountHeader(document, messages);
      const status = document.createElement("p");
      status.className = "settings-account-status";
      status.setAttribute("aria-live", "polite");
      const { helpRow, deviceCodeNote } = buildLoginHelpRow(document, messages);

      // ---- mutable state ----------------------------------------------
      let accounts: readonly CodexAccountSummary[] = [];
      let accountCreating = false;
      let accountActivating = false;
      let deletingAccountId: string | null = null;
      let login: CodexAccountLoginStartResult | null = null;
      let loginStartingAccountId: string | null = null;
      let loginMessage: string | null = null;
      let loginRefreshTimer: number | undefined;
      const usageByAccountId = new Map<string, AccountUsageViewState>();
      let usingResetAccountId: string | null = null;
      let usageDisplay: AccountUsageDisplay = "remaining";
      const expandedResetAccounts = new Set<string>();
      let harnessAccounts: ReturnType<typeof mountHarnessAccounts> | undefined;

      // All mutations funnel through one runLatest slot, so any second action
      // must wait: otherwise it would abort the completion handler of a login,
      // deletion, or reset-credit redemption still in flight.
      const mutationInFlight = (): boolean =>
        accountCreating ||
        accountActivating ||
        deletingAccountId !== null ||
        login !== null ||
        loginStartingAccountId !== null ||
        usingResetAccountId !== null;

      const client = (): RendererCodexAccountClient => {
        const value = getClient();
        if (!value) throw new Error(messages.runtimeCapabilityNotInstalled);
        return value;
      };

      // ---- toolbar ------------------------------------------------------
      const toolbar = document.createElement("div");
      toolbar.className = "settings-account-toolbar";
      const connected = document.createElement("div");
      connected.className = "settings-account-count";
      const connectedLabel = document.createElement("span");
      connectedLabel.textContent = messages.accountConnected;
      const connectedCount = document.createElement("span");
      connected.append(connectedLabel, connectedCount);
      const searchWrapper = document.createElement("label");
      searchWrapper.className = "settings-account-search";
      const search = document.createElement("input");
      search.type = "search";
      search.name = "account-search";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.placeholder = messages.accountSearch;
      search.setAttribute("aria-label", messages.accountSearch);
      searchWrapper.append(createRendererSettingsIcon("search", 16), search);
      const displayControls = document.createElement("div");
      displayControls.className = "settings-account-display-controls";
      const displayButtons = new Map<AccountUsageDisplay, HTMLButtonElement>();
      for (const display of ["used", "remaining"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent =
          display === "used" ? messages.accountCreditsUsed : messages.accountCreditsRemaining;
        button.addEventListener("click", () => {
          usageDisplay = display;
          render();
        });
        displayButtons.set(display, button);
        displayControls.append(button);
      }
      const refreshUsage = document.createElement("button");
      refreshUsage.type = "button";
      refreshUsage.className = "settings-icon-button";
      refreshUsage.title = messages.accountCreditsRefresh;
      refreshUsage.setAttribute("aria-label", messages.accountCreditsRefresh);
      refreshUsage.append(createRendererSettingsIcon("refresh", 16));
      refreshUsage.addEventListener("click", () => {
        usageByAccountId.clear();
        loadUsage(accounts);
        void harnessAccounts?.refresh();
      });
      search.addEventListener("input", () => render());
      toolbar.append(connected, searchWrapper, displayControls, refreshUsage);

      const list = document.createElement("div");
      list.className = "settings-account-list";
      const { table, body } = createAccountsTable(document, messages);
      list.append(table);
      context.content.append(header, helpRow, deviceCodeNote, status, toolbar, list);

      // ---- login polling ------------------------------------------------
      const stopLoginRefresh = (): void => {
        if (loginRefreshTimer === undefined) return;
        document.defaultView?.clearTimeout(loginRefreshTimer);
        loginRefreshTimer = undefined;
      };

      const pollLoginUntilSignedIn = (): void => {
        stopLoginRefresh();
        if (!login || context.signal.aborted) return;
        loginRefreshTimer = document.defaultView?.setTimeout(() => {
          loginRefreshTimer = undefined;
          if (!login || context.signal.aborted) return;
          void context.runLatest(
            () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
            {
              success(result) {
                const signedIn = result.accounts.some(
                  (account) => account.accountId === login?.accountId && account.email,
                );
                if (signedIn) {
                  login = null;
                  loginMessage = messages.accountLoginSucceeded;
                }
                setAccounts(result.accounts);
                pollLoginUntilSignedIn();
              },
              failure() {
                pollLoginUntilSignedIn();
              },
            },
          );
        }, 750);
      };

      // ---- rendering ----------------------------------------------------
      const appendDeviceCodeRow = (): void => {
        const pendingLogin = login;
        if (!pendingLogin) return;
        const verification = document.createElement("div");
        verification.className = "settings-account-verification";
        const prompt = document.createElement("span");
        prompt.textContent = messages.accountVerificationDescription;
        const link = document.createElement("a");
        link.href = pendingLogin.verificationUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = pendingLogin.verificationUrl;
        link.addEventListener("click", (event) => {
          const bridge = (document.defaultView as CodexDesktopLinkWindow | null)
            ?.electronBridge;
          if (typeof bridge?.sendMessageFromView !== "function") return;
          event.preventDefault();
          void Promise.resolve(
            bridge.sendMessageFromView({
              type: "open-in-browser",
              url: login?.verificationUrl ?? link.href,
              initiator: "open_in_browser_bridge",
              openTarget: "external-browser",
              source: "manual",
            }),
          ).catch(() => undefined);
        });
        const code = document.createElement("code");
        code.textContent = pendingLogin.userCode;
        const copyCode = document.createElement("button");
        copyCode.type = "button";
        copyCode.className = "settings-command-button settings-command-button--secondary";
        copyCode.textContent = messages.accountCopyCode;
        copyCode.addEventListener("click", () => {
          void document.defaultView?.navigator.clipboard
            ?.writeText(login?.userCode ?? "")
            .then(() => {
              copyCode.textContent = messages.accountCopied;
            });
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = messages.accountLoginCancel;
        cancel.addEventListener("click", () =>
          cancelLogin(login?.accountId ?? "", login?.loginId ?? ""),
        );
        verification.append(prompt, link, code, copyCode, cancel);
        const verificationRow = document.createElement("tr");
        const verificationCell = document.createElement("td");
        verificationCell.colSpan = 4;
        verificationCell.append(verification);
        verificationRow.append(verificationCell);
        body.append(verificationRow);
      };

      const render = (): void => {
        const restoreFocus = accountListFocusRestorer(list, search);
        body.replaceChildren();
        status.textContent = loginMessage ?? "";
        connectedCount.textContent = String(accounts.filter(isCodexAccountAuthenticated).length);
        search.disabled = login !== null || loginStartingAccountId !== null;
        for (const [display, button] of displayButtons) {
          button.setAttribute("aria-pressed", String(display === usageDisplay));
        }
        refreshUsage.disabled =
          ((!getClient()?.inspectCodexAccountUsage || !accounts.some(isCodexAccountAuthenticated)) &&
            !getClient()?.listHarnessAccounts) ||
          harnessAccounts?.refreshing === true ||
          [...usageByAccountId.values()].some((usage) => usage.status === "loading") ||
          mutationInFlight();
        const query = search.value.trim().toLocaleLowerCase();
        harnessAccounts?.update(query, usageDisplay);
        const visibleAccounts = accounts.filter((account) =>
          `${account.email ?? ""} ${account.label}`.toLocaleLowerCase().includes(query),
        );
        if (visibleAccounts.length === 0) {
          const emptyRow = document.createElement("tr");
          const emptyCell = document.createElement("td");
          emptyCell.colSpan = 4;
          emptyCell.className = "settings-account-empty";
          emptyCell.textContent = query ? messages.accountNoMatches : messages.accountEmpty;
          emptyRow.append(emptyCell);
          body.append(emptyRow);
        }
        // The stock/default Codex account stays protected here; extra Accounts
        // are native Codex profiles kept apart through CODEX_HOME.
        addButton.hidden = false;
        addButton.disabled = mutationInFlight();
        for (const account of visibleAccounts) {
          body.append(
            ...renderAccountRows(document, account, messages, {
              usage: usageByAccountId.get(account.accountId),
              display: usageDisplay,
              actionsDisabled: mutationInFlight(),
              usingReset: usingResetAccountId === account.accountId,
              resetDisabled: mutationInFlight(),
              resetExpanded: expandedResetAccounts.has(account.accountId),
              onActivate: () =>
                mutate(() => client().activateCodexAccount({ accountId: account.accountId })),
              onSignIn: () => startLogin(account.accountId),
              ...(account.management === "native" && getClient()?.logoutCodexAccount
                ? { onSignOut: () => signOut() }
                : {}),
              onDelete: () => deleteAccount(account.accountId),
              onRetry: () => {
                usageByAccountId.delete(account.accountId);
                loadUsage(accounts);
              },
              onResetExpanded: (open) => {
                if (open) expandedResetAccounts.add(account.accountId);
                else expandedResetAccounts.delete(account.accountId);
              },
              ...(getClient()?.consumeCodexAccountResetCredit
                ? { onUseReset: () => useReset(account.accountId) }
                : {}),
            }),
          );
          if (login?.accountId === account.accountId) {
            appendDeviceCodeRow();
          }
        }
        restoreFocus();
      };

      // ---- data loading -------------------------------------------------
      const loadUsage = (nextAccounts: readonly CodexAccountSummary[]): void => {
        const inspect = getClient()?.inspectCodexAccountUsage;
        const signedIn = nextAccounts.filter(isCodexAccountAuthenticated);
        const stillTracked = new Set(signedIn.map((account) => account.accountId));
        for (const accountId of [...usageByAccountId.keys()]) {
          if (!stillTracked.has(accountId)) usageByAccountId.delete(accountId);
        }
        const pending = signedIn.filter((account) => !usageByAccountId.has(account.accountId));
        if (!inspect || pending.length === 0) {
          render();
          return;
        }
        const requests = pending.map((account) => {
          const loading: AccountUsageViewState = { status: "loading" };
          usageByAccountId.set(account.accountId, loading);
          return { account, loading };
        });
        render();
        void Promise.all(
          requests.map(async ({ account, loading }) => {
            try {
              const result = await inspect({ accountId: account.accountId });
              // Skip when the page was unmounted or a newer request replaced
              // this placeholder while the inspection was in flight.
              if (context.signal.aborted || usageByAccountId.get(account.accountId) !== loading)
                return;
              usageByAccountId.set(
                account.accountId,
                result.accountCredits
                  ? { status: "ready", credits: result.accountCredits }
                  : { status: "empty" },
              );
            } catch {
              if (context.signal.aborted || usageByAccountId.get(account.accountId) !== loading)
                return;
              usageByAccountId.set(account.accountId, { status: "error" });
            }
            render();
          }),
        );
      };

      const setAccounts = (nextAccounts: readonly CodexAccountSummary[]): void => {
        accounts = nextAccounts;
        for (const accountId of expandedResetAccounts) {
          if (!accounts.some((account) => account.accountId === accountId))
            expandedResetAccounts.delete(accountId);
        }
        loadUsage(nextAccounts);
      };

      const refreshInBackground = (): void => {
        if (!client().refreshCodexAccounts) return;
        void context.runLatest(
          () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
          {
            success(result) {
              setAccounts(result.accounts);
            },
            failure() {
              // A failed live-metadata refresh keeps the cached list visible.
            },
          },
        );
      };

      const load = (): void => {
        void context.runLatest(() => client().listCodexAccounts(), {
          success(result) {
            loginMessage = null;
            setAccounts(result.accounts);
            refreshInBackground();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };

      // ---- mutations ----------------------------------------------------
      const mutate = (operation: () => Promise<CodexAccountMutationResult>): void => {
        if (mutationInFlight()) return;
        accountActivating = true;
        render();
        void context.runLatest(() => operation(), {
          success(result) {
            accountActivating = false;
            loginMessage = null;
            setAccounts(
              accounts.map((account) => ({
                ...(account.accountId === result.account.accountId ? result.account : account),
                active: account.accountId === result.account.accountId,
              })),
            );
          },
          failure(error) {
            accountActivating = false;
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };

      const startLogin = (accountId: string): void => {
        if (mutationInFlight()) return;
        loginStartingAccountId = accountId;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().startCodexAccountLogin({ accountId }), {
          success(result) {
            loginStartingAccountId = null;
            login = result;
            loginMessage = null;
            render();
            pollLoginUntilSignedIn();
          },
          failure(error) {
            loginStartingAccountId = null;
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
      };

      const signOut = (): void => {
        const logout = getClient()?.logoutCodexAccount;
        if (!logout || mutationInFlight()) return;
        if (document.defaultView?.confirm?.(messages.accountSignOutConfirm) === false) return;
        accountActivating = true;
        loginMessage = messages.accountSigningOut;
        render();
        void context.runLatest(() => logout(), {
          success(result) {
            accountActivating = false;
            loginMessage = messages.accountSignedOut;
            usageByAccountId.clear();
            setAccounts([result.account]);
          },
          failure(error) {
            accountActivating = false;
            loginMessage = errorMessage(error, messages.accountSignOutFailed);
            render();
          },
        });
      };

      const createAndLogin = (): void => {
        if (mutationInFlight()) return;
        accountCreating = true;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().createCodexAccount({}), {
          success(result) {
            accountCreating = false;
            loginMessage = null;
            search.value = "";
            setAccounts([
              ...accounts.filter(({ accountId }) => accountId !== result.account.accountId),
              result.account,
            ]);
            startLogin(result.account.accountId);
          },
          failure(error) {
            accountCreating = false;
            loginMessage = errorMessage(error, messages.accountCreateFailed);
            render();
          },
        });
      };

      const resetOutcomeMessage = (
        outcome: CodexAccountResetCreditConsumeResult["outcome"],
      ): string => {
        if (outcome === "reset") return messages.accountResetCreditsSucceeded;
        if (outcome === "nothingToReset") return messages.accountResetCreditsNothingToReset;
        if (outcome === "noCredit") return messages.accountResetCreditsNoCredit;
        return messages.accountResetCreditsAlreadyRedeemed;
      };

      const useReset = (accountId: string): void => {
        const consume = getClient()?.consumeCodexAccountResetCredit;
        if (!consume || mutationInFlight()) return;
        if (document.defaultView?.confirm?.(messages.accountResetCreditsConfirm) === false) return;
        usingResetAccountId = accountId;
        loginMessage = messages.accountResetCreditsUsing;
        render();
        void context.runLatest(() => consume({ accountId, idempotencyKey: crypto.randomUUID() }), {
          success(result) {
            usingResetAccountId = null;
            loginMessage = resetOutcomeMessage(result.outcome);
            if (result.accountCredits) {
              usageByAccountId.set(accountId, {
                status: "ready",
                credits: result.accountCredits,
              });
            } else if (result.outcome === "reset") {
              usageByAccountId.delete(accountId);
              loadUsage(accounts);
            }
            render();
          },
          failure(error) {
            usingResetAccountId = null;
            loginMessage = errorMessage(error, messages.accountResetCreditsFailed);
            render();
          },
        });
      };

      const deleteAccount = (accountId: string): void => {
        const account = accounts.find((candidate) => candidate.accountId === accountId);
        if (!account || account.isDefault || mutationInFlight()) return;
        if (document.defaultView?.confirm?.(messages.accountDeleteConfirm) === false) return;
        deletingAccountId = accountId;
        loginMessage = messages.accountDeleting;
        render();
        void context.runLatest(() => client().deleteCodexAccount({ accountId }), {
          success() {
            deletingAccountId = null;
            loginMessage = null;
            // Deleting the active Account re-selects the default one; other
            // Accounts keep their selection state untouched.
            setAccounts(
              accounts
                .filter((candidate) => candidate.accountId !== accountId)
                .map((candidate) => ({
                  ...candidate,
                  active: account.active ? candidate.isDefault : candidate.active,
                })),
            );
          },
          failure(error) {
            deletingAccountId = null;
            loginMessage = errorMessage(error, messages.accountDeleteFailed);
            render();
          },
        });
      };

      const cancelLogin = (accountId: string, loginId: string): void => {
        void context.runLatest(() => client().cancelCodexAccountLogin({ accountId, loginId }), {
          success() {
            stopLoginRefresh();
            login = null;
            loginMessage = null;
            render();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
      };

      // ---- wiring ---------------------------------------------------------
      addButton.addEventListener("click", createAndLogin);
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = getClient()?.subscribeCodexAccountLogin?.((result) => {
          if (result.loginId !== login?.loginId) return;
          stopLoginRefresh();
          login = null;
          loginMessage = result.success
            ? messages.accountLoginSucceeded
            : (result.error ?? messages.accountLoginFailed);
          render();
          if (result.success) load();
        });
      } catch {
        // Device-code login still works when subscription is unavailable.
      }
      harnessAccounts = mountHarnessAccounts(context, messages, getClient, render);
      void harnessAccounts.refresh();
      load();
      return () => {
        stopLoginRefresh();
        unsubscribe?.();
      };
    },
  });
}
