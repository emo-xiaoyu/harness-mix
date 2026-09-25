/**
 * Codex account selection state for one Host connection. The override picks
 * an isolated account; when it no longer exists the active account takes
 * over. Only this Host's last snapshot is kept — a transient refresh failure
 * must not blank the picker.
 */
import type { CodexAccountSummary } from "@harnessmix/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";

export function resolveCodexAccountSelection(
  accounts: readonly CodexAccountSummary[],
  overrideAccountId: string | null,
): {
  activeAccountId: string | null;
  overrideAccountId: string | null;
  selectedAccountId: string | null;
} {
  const activeAccountId = accounts.find((account) => account.active)?.accountId ?? null;
  const validOverrideAccountId = accounts.some((account) => account.accountId === overrideAccountId)
    ? overrideAccountId
    : null;
  return {
    activeAccountId,
    overrideAccountId: validOverrideAccountId,
    selectedAccountId: validOverrideAccountId ?? activeAccountId,
  };
}

export function codexAccountRouteOverride(
  accounts: readonly CodexAccountSummary[],
  accountId: string | null | undefined,
): string | null {
  if (!accountId) return null;
  return accounts.find((account) => account.accountId === accountId)?.management === "isolated"
    ? accountId
    : null;
}

/** Owned by one Host and one concrete request client, never the active-route facade. */
export class RendererCodexAccountState {
  accounts: readonly CodexAccountSummary[] = [];
  overrideAccountId: string | null = null;
  switching = false;
  #request: Promise<void> | null = null;
  #loaded = false;

  constructor(readonly client: RendererModelClient) {}

  /** True once a refresh completed. Empty + not loaded means routing is still unknown. */
  get loaded(): boolean {
    return this.#loaded;
  }

  get selection(): ReturnType<typeof resolveCodexAccountSelection> {
    return resolveCodexAccountSelection(this.accounts, this.overrideAccountId);
  }

  refresh(): Promise<void> {
    if (this.#request) return this.#request;
    this.#request = Promise.resolve()
      .then(() => this.client.listCodexAccounts())
      .then((result) => {
        this.accounts = result.accounts;
        this.overrideAccountId = this.selection.overrideAccountId;
        this.#loaded = true;
      })
      .catch(() => {
        // Keep the last snapshot: a Host without the Account API stays empty
        // and the plain Codex option remains available.
      })
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }
}
