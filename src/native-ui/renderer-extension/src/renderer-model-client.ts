import { createRendererIntegrationsClient, type RendererIntegrationsClient } from './renderer-integrations-client.js';
import {
  harnessAccountListResultSchema,
  type HarnessAccountListResult,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  codexAccountResetCreditConsumeParamsSchema,
  codexAccountResetCreditConsumeResultSchema,
  type CodexAccountUsageParams,
  type CodexAccountUsageResult,
  type CodexAccountResetCreditConsumeParams,
  type CodexAccountResetCreditConsumeResult,
  codexAccountActivateParamsSchema,
  codexAccountCreateParamsSchema,
  codexAccountDeleteParamsSchema,
  codexAccountDeleteResultSchema,
  codexAccountListResultSchema,
  codexAccountLoginCancelParamsSchema,
  codexAccountLoginCancelResultSchema,
  codexAccountLoginCompletedSchema,
  codexAccountLoginStartParamsSchema,
  codexAccountLoginStartResultSchema,
  codexAccountMutationResultSchema,
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
  harnessCommandCatalogSchema,
  harnessCommandsInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessPluginListResultSchema,
  type HarnessPluginListResult,
  harnessWebUiOpenParamsSchema,
  harnessWebUiOpenResultSchema,
  harnessModelSelectionStateSchema,
  hostThreadIdSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  threadDelegateParamsSchema,
  threadDelegationResultSchema,
  threadHarnessSwitchParamsSchema,
  threadHarnessSwitchResultSchema,
  threadMessageParamsSchema,
  threadModelSelectParamsSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  type ExternalThreadForkParams,
  type ExternalThreadForkResult,
  type CodexAccountActivateParams,
  type CodexAccountCreateParams,
  type CodexAccountDeleteParams,
  type CodexAccountDeleteResult,
  type CodexAccountListResult,
  type CodexAccountLoginCancelParams,
  type CodexAccountLoginCancelResult,
  type CodexAccountLoginCompleted,
  type CodexAccountLoginStartParams,
  type CodexAccountLoginStartResult,
  type CodexAccountMutationResult,
  type HarnessCommandCatalog,
  type HarnessCommandsInspectParams,
  type HarnessConfigurationState,
  type HarnessInspection,
  type HarnessInspectParams,
  type HarnessWebUiOpenParams,
  type HarnessModelSelectionState,
  type ThreadInspection,
  type ThreadInspectionParams,
  type ThreadCommandExecuteParams,
  type ThreadCommandExecuteResult,
  type ThreadCommandsInspectParams,
  type ThreadDelegateParams,
  type ThreadDelegationResult,
  type ThreadHarnessSwitchParams,
  type ThreadHarnessSwitchResult,
  type ThreadMessageParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
  type ThreadOwnershipListResult,
  type ThreadUsageInspection,
  type ThreadUsageInspectionParams,
  type UpdateCheckResult,
  type UpdateStartResult,
  type UpdateStatusResult,
} from "@harnessmix/shared-contracts";

import {
  createRendererRequestSender,
  RendererMethodUnavailableError,
} from "./renderer-request-sender.js";
import {
  createRendererSessionImportClient,
  type RendererSessionImportClient,
} from "./renderer-session-import-client.js";
import {
  createRendererPetsClient,
  type RendererPetsClient,
} from "./settings/pets-client.js";

export const HARNESS_INSPECT_METHOD = "harnessmix/harness/inspect";
export const HARNESS_INSTALL_METHOD = "harnessmix/harness/install";
export const HARNESS_PLUGIN_LIST_METHOD = "harnessmix/harness/plugins/list";
export const HARNESS_WEB_UI_OPEN_METHOD = "harnessmix/harness/web-ui/open";
export const THREAD_FORK_METHOD = "harnessmix/thread/fork";
export const THREAD_HARNESS_SWITCH_METHOD = "harnessmix/thread/harness/switch";
export const THREAD_INSPECT_METHOD = "harnessmix/thread/inspect";
export const HARNESS_COMMANDS_INSPECT_METHOD = "harnessmix/harness/commands/inspect";
export const THREAD_COMMANDS_INSPECT_METHOD = "harnessmix/thread/commands/inspect";
export const THREAD_COMMAND_EXECUTE_METHOD = "harnessmix/thread/command/execute";
export const THREAD_DELEGATE_METHOD = "harnessmix/thread/delegate";
export const THREAD_MESSAGE_METHOD = "harnessmix/thread/message";
export const THREAD_MODEL_SELECT_METHOD = "harnessmix/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "harnessmix/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD = "harnessmix/thread/permission-mode/select";
export const THREAD_OWNERSHIP_LIST_METHOD = "harnessmix/thread/ownership/list";
export const THREAD_USAGE_INSPECT_METHOD = "harnessmix/thread/usage/inspect";
export const THREAD_TEAM_INSPECT_METHOD = "harnessmix/thread/team/inspect";
export const THREAD_TEAM_TASK_CANCEL_METHOD = "harnessmix/thread/team/task/cancel";
export const THREAD_TEAM_TASK_REASSIGN_METHOD = "harnessmix/thread/team/task/reassign";
export const THREAD_TEAM_MESSAGE_SEND_METHOD = "harnessmix/thread/team/message/send";
export const THREAD_COLLABORATION_CONTINUE_METHOD = "harnessmix/thread/collaboration/continue";

// 看板用户操作：principal 是用户；授权与语义统一在 Host 的 collaboration.userAction 裁决。
export type CollaborationUserActionInput =
  | { action: "task/cancel"; threadId: string; teamId: string; taskId: string }
  | { action: "task/reassign"; threadId: string; teamId: string; taskId: string; memberId: string; note?: string }
  | { action: "message/send"; threadId: string; teamId: string; to?: string; message: string; kind?: string }
  | { action: "continue"; threadId: string; taskId?: string };
export const THREAD_USAGE_UPDATED_METHOD = "harnessmix/thread/usage/updated";
export const THREAD_TOKEN_USAGE_UPDATED_METHOD = "thread/tokenUsage/updated";
export const UPDATE_CHECK_METHOD = "harnessmix/update/check";
export const UPDATE_START_METHOD = "harnessmix/update/start";
export const UPDATE_STATUS_METHOD = "harnessmix/update/status";
export const RUNTIME_VERSION_METHOD = "harness-mix/runtime/version";
export const CODEX_ACCOUNT_LIST_METHOD = "harnessmix/account/list";
export const CODEX_ACCOUNT_REFRESH_METHOD = "harnessmix/account/refresh";
export const CODEX_ACCOUNT_CREATE_METHOD = "harnessmix/account/create";
export const CODEX_ACCOUNT_DELETE_METHOD = "harnessmix/account/delete";
export const CODEX_ACCOUNT_ACTIVATE_METHOD = "harnessmix/account/activate";
export const CODEX_ACCOUNT_LOGIN_START_METHOD = "harnessmix/account/login/start";
export const CODEX_ACCOUNT_LOGIN_CANCEL_METHOD = "harnessmix/account/login/cancel";
export const CODEX_ACCOUNT_LOGIN_COMPLETED_METHOD = "harnessmix/account/login/completed";
export const CODEX_ACCOUNT_RESET_CREDIT_CONSUME_METHOD =
  "harnessmix/account/rate-limit-reset/consume";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifiedThreadId(notification: unknown): ThreadUsageInspectionParams["threadId"] | null {
  if (
    !isRecord(notification) ||
    (notification.method !== THREAD_TOKEN_USAGE_UPDATED_METHOD &&
      notification.method !== THREAD_USAGE_UPDATED_METHOD)
  ) {
    return null;
  }
  const params = notification.params;
  if (!isRecord(params)) return null;
  const parsed = hostThreadIdSchema.safeParse(params.threadId);
  return parsed.success ? parsed.data : null;
}

interface RequestManagerCandidate {
  addNotificationCallback?: (
    method: string | readonly string[],
    callback: (notification: unknown) => void,
  ) => () => void;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: RequestManagerCandidate;
}

function notificationTarget(manager: RequestManagerCandidate): RequestManagerCandidate | null {
  if (typeof manager.addNotificationCallback === "function") return manager;
  const nested = manager.requestClient;
  return nested && typeof nested.addNotificationCallback === "function" ? nested : null;
}

export interface RendererModelClient extends Partial<RendererSessionImportClient>, Partial<RendererIntegrationsClient> {
  petsClient?: RendererPetsClient;
  inspectStorage?(): Promise<import('./settings/storage-page.js').RendererStorageInspection>;
  optimizeStorage?(): Promise<{ before: import('./settings/storage-page.js').RendererStorageInspection; after: import('./settings/storage-page.js').RendererStorageInspection }>;
  listCollaborationAgents?(): Promise<Array<{ id: string; name: string; available: boolean; lead: boolean }>>;
  getCollaborationPreferences?(): Promise<{ collaboration: boolean; agentTeam: boolean }>;
  saveCollaborationPreferences?(input: { collaboration?: boolean; agentTeam?: boolean }): Promise<{ collaboration: boolean; agentTeam: boolean }>;
  currentHostId?(): string | null;
  listHarnessPlugins?(): Promise<HarnessPluginListResult>;
  clientForHost?(hostId: string): RendererModelClient | null;
  forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult>;
  switchHarness(input: ThreadHarnessSwitchParams): Promise<ThreadHarnessSwitchResult>;
  inspectHarness(input: HarnessInspectParams): Promise<HarnessInspection>;
  installHarness?(input: { harnessId: string; terminal?: boolean | undefined }): Promise<{ success: boolean; command?: string; stdout?: string; stderr?: string; error?: string }>;
  loginHarnessAccount?(input: { harnessId: string }): Promise<{ success: boolean; command?: string; error?: string }>;
  openHarnessWebUi?(input: HarnessWebUiOpenParams): Promise<void>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
  inspectHarnessCommands(input: HarnessCommandsInspectParams): Promise<HarnessCommandCatalog>;
  inspectThreadCommands(input: ThreadCommandsInspectParams): Promise<HarnessCommandCatalog>;
  executeThreadCommand(input: ThreadCommandExecuteParams): Promise<ThreadCommandExecuteResult>;
  listThreadOwnership(input: ThreadOwnershipListParams): Promise<ThreadOwnershipListResult>;
  inspectThreadUsage(input: ThreadUsageInspectionParams): Promise<ThreadUsageInspection>;
  inspectThreadTeam?(input: { threadId: string; teamId?: string }): Promise<unknown>;
  collaborationUserAction?(input: CollaborationUserActionInput): Promise<unknown>;
  usageHistory?(input: { days?: number }): Promise<unknown>;
  usageSummary?(): Promise<unknown>;
  healthSnapshot?(): Promise<unknown>;
  healthRefresh?(): Promise<unknown>;
  subscribeThreadUsage?(listener: (update: ThreadUsageInspection) => void): () => void;
  selectThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadThinking(input: ThreadThinkingSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadPermissionMode(
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState>;
  checkUpdate(): Promise<UpdateCheckResult>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
  readCurrentVersion?(): Promise<{ version: string }>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  consumeCodexAccountResetCredit?(
    input: CodexAccountResetCreditConsumeParams,
  ): Promise<CodexAccountResetCreditConsumeResult>;
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts(): Promise<CodexAccountListResult>;
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
  subscribeCodexAccountLogin(listener: (result: CodexAccountLoginCompleted) => void): () => void;
}

export function createThreadUsageSubscriptionRelay(): {
  connect(client: Pick<RendererModelClient, "subscribeThreadUsage">): void;
  subscribe(listener: (update: ThreadUsageInspection) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(update: ThreadUsageInspection) => void>();
  let removeNotificationCallback: (() => void) | null = null;
  return {
    connect(client) {
      if (removeNotificationCallback || listeners.size === 0) return;
      try {
        removeNotificationCallback =
          client.subscribeThreadUsage?.((update) => {
            for (const listener of listeners) listener(update);
          }) ?? null;
      } catch {
        removeNotificationCallback = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        removeNotificationCallback?.();
        removeNotificationCallback = null;
      };
    },
    dispose() {
      removeNotificationCallback?.();
      removeNotificationCallback = null;
      listeners.clear();
    },
  };
}

/** Mutations that may legitimately outlive the default request timeout
 * (installs, forks, Harness handoffs, command execution, update downloads,
 * interactive Account login) keep the previous unbounded wait. */
const REQUEST_TIMEOUT_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  HARNESS_INSTALL_METHOD,
  THREAD_FORK_METHOD,
  THREAD_HARNESS_SWITCH_METHOD,
  THREAD_COMMAND_EXECUTE_METHOD,
  THREAD_DELEGATE_METHOD,
  THREAD_MESSAGE_METHOD,
  UPDATE_START_METHOD,
  CODEX_ACCOUNT_LOGIN_START_METHOD,
]);

export function createRendererModelClient(
  candidates: readonly RequestManagerCandidate[],
): RendererModelClient | null {
  const managers = candidates.filter(
    (
      candidate,
    ): candidate is RequestManagerCandidate &
      Required<Pick<RequestManagerCandidate, "sendRequest">> =>
      typeof candidate.sendRequest === "function",
  );
  const source = managers[0];
  if (managers.length !== 1 || !source) return null;
  const manager = {
    sendRequest: createRendererRequestSender(
      (method, params) => source.sendRequest(method, params),
      { isTimeoutExempt: (method) => REQUEST_TIMEOUT_EXEMPT_METHODS.has(method) },
    ),
  };

  const inspectHarness = async (input: HarnessInspectParams): Promise<HarnessInspection> => {
    const params = harnessInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params);
    return harnessInspectionSchema.parse(result);
  };
  const inspectHarnessCommands = async (
    input: HarnessCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = harnessCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const inspectThreadCommands = async (
    input: ThreadCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = threadCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const executeThreadCommand = async (
    input: ThreadCommandExecuteParams,
  ): Promise<ThreadCommandExecuteResult> => {
    const params = threadCommandExecuteParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMAND_EXECUTE_METHOD, params);
    return threadCommandExecuteResultSchema.parse(result);
  };
  const inspectThreadUsage = async (
    input: ThreadUsageInspectionParams,
  ): Promise<ThreadUsageInspection> => {
    const params = threadUsageInspectionParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_USAGE_INSPECT_METHOD, params);
    return threadUsageInspectionSchema.parse(result);
  };
  const selectThreadModel = async (
    input: ThreadModelSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadModelSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_MODEL_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadThinking = async (
    input: ThreadThinkingSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadThinkingSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_THINKING_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadPermissionMode = async (
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState> => {
    const params = threadPermissionModeSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_PERMISSION_MODE_SELECT_METHOD, params);
    return harnessConfigurationStateSchema.parse(result);
  };

  return Object.freeze({
    async inspectStorage() { return await manager.sendRequest('harnessmix/storage/inspect', {}) as import('./settings/storage-page.js').RendererStorageInspection; },
    async optimizeStorage() { return await manager.sendRequest('harnessmix/storage/optimize', {}) as { before: import('./settings/storage-page.js').RendererStorageInspection; after: import('./settings/storage-page.js').RendererStorageInspection }; },
    async listCollaborationAgents(): Promise<Array<{ id: string; name: string; available: boolean; lead: boolean }>> {
      const result = await manager.sendRequest('harnessmix/collaboration/agents', {});
      if (!Array.isArray(result) || !result.every(a => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.available === 'boolean' && typeof a.lead === 'boolean')) throw new Error('Invalid collaboration catalog');
      return result;
    },
    async getCollaborationPreferences(): Promise<{ collaboration: boolean; agentTeam: boolean }> {
      const result = await manager.sendRequest('harnessmix/collaboration/preferences', {});
      const value = result as { collaboration?: unknown; agentTeam?: unknown } | null;
      if (!value || typeof value.collaboration !== 'boolean' || typeof value.agentTeam !== 'boolean') throw new Error('Invalid collaboration preferences');
      return { collaboration: value.collaboration, agentTeam: value.agentTeam };
    },
    async saveCollaborationPreferences(input: { collaboration?: boolean; agentTeam?: boolean }): Promise<{ collaboration: boolean; agentTeam: boolean }> {
      const result = await manager.sendRequest('harnessmix/collaboration/preferences/save', input);
      const value = result as { collaboration?: unknown; agentTeam?: unknown } | null;
      if (!value || typeof value.collaboration !== 'boolean' || typeof value.agentTeam !== 'boolean') throw new Error('Invalid collaboration preferences');
      return { collaboration: value.collaboration, agentTeam: value.agentTeam };
    },
    ...createRendererIntegrationsClient((method, params) => manager.sendRequest(method, params)),
    ...createRendererSessionImportClient(async (method, params) =>
      manager.sendRequest(method, params),
    ),
    petsClient: createRendererPetsClient((method, params) => manager.sendRequest(method, params)),
    async forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult> {
      const params = externalThreadForkParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_FORK_METHOD, params);
      return externalThreadForkResultSchema.parse(result);
    },
    // 原地切换 Harness：历史保留在 Host 线程上，切换后首轮由 Host 附带一次性上下文信封
    async switchHarness(input: ThreadHarnessSwitchParams): Promise<ThreadHarnessSwitchResult> {
      const params = threadHarnessSwitchParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_HARNESS_SWITCH_METHOD, params);
      return threadHarnessSwitchResultSchema.parse(result);
    },
    // 跨 Harness 协作：委派新子任务 / 跟进既有子任务；等待链由父线程协作 Turn 承载
    async delegateThread(input: ThreadDelegateParams): Promise<ThreadDelegationResult> {
      const params = threadDelegateParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_DELEGATE_METHOD, params);
      return threadDelegationResultSchema.parse(result);
    },
    async messageThread(input: ThreadMessageParams): Promise<ThreadDelegationResult> {
      const params = threadMessageParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_MESSAGE_METHOD, params);
      return threadDelegationResultSchema.parse(result);
    },
    inspectHarness,
    async installHarness(input: { harnessId: string; terminal?: boolean | undefined }): Promise<{ success: boolean; command?: string; stdout?: string; stderr?: string; error?: string }> {
      const result = await manager.sendRequest(HARNESS_INSTALL_METHOD, input);
      return result as { success: boolean; command?: string; stdout?: string; stderr?: string; error?: string };
    },
    async loginHarnessAccount(input: { harnessId: string }): Promise<{ success: boolean; command?: string; error?: string }> {
      const result = await manager.sendRequest("harnessmix/harness/account/login", input);
      return result as { success: boolean; command?: string; error?: string };
    },
    async listHarnessPlugins(): Promise<HarnessPluginListResult> {
      return harnessPluginListResultSchema.parse(
        await manager.sendRequest(HARNESS_PLUGIN_LIST_METHOD, {}),
      );
    },
    async openHarnessWebUi(input: HarnessWebUiOpenParams): Promise<void> {
      const params = harnessWebUiOpenParamsSchema.parse(input);
      const result = await manager.sendRequest(HARNESS_WEB_UI_OPEN_METHOD, params);
      harnessWebUiOpenResultSchema.parse(result);
    },
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      let result: unknown;
      try {
        result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      } catch (error) {
        if (!(error instanceof RendererMethodUnavailableError)) throw error;

        // Stock Codex has no Host inspection API. Verify its native Thread on
        // this same connection; neither an RPC failure nor a missing Account
        // establishes ownership. Match the external markers used by the Host.
        const native = await manager.sendRequest("thread/read", {
          threadId: params.threadId,
          includeTurns: false,
        });
        const thread = isRecord(native) ? native.thread : null;
        if (
          !isRecord(thread) ||
          thread.id !== params.threadId ||
          typeof thread.modelProvider !== "string" ||
          !thread.modelProvider ||
          thread.modelProvider === "harnessmix" ||
          typeof thread.cliVersion !== "string" ||
          !thread.cliVersion ||
          thread.cliVersion === "harnessmix"
        ) {
          throw new Error("Native Thread response cannot establish Codex ownership");
        }
        return { owner: "codex", locked: true };
      }
      return threadInspectionSchema.parse(result);
    },
    inspectHarnessCommands,
    inspectThreadCommands,
    executeThreadCommand,
    async listThreadOwnership(
      input: ThreadOwnershipListParams,
    ): Promise<ThreadOwnershipListResult> {
      const params = threadOwnershipListParamsSchema.parse(input);
      const value = await manager.sendRequest(THREAD_OWNERSHIP_LIST_METHOD, params);
      const result = threadOwnershipListResultSchema.parse(value);
      if (
        result.threads.length !== params.threadIds.length ||
        result.threads.some((thread, index) => thread.threadId !== params.threadIds[index])
      ) {
        throw new Error("Thread ownership-list result does not match the requested IDs");
      }
      return result;
    },
    inspectThreadUsage,
    async inspectThreadTeam(input: { threadId: string; teamId?: string }): Promise<unknown> {
      const threadId = hostThreadIdSchema.parse(input.threadId);
      return manager.sendRequest(THREAD_TEAM_INSPECT_METHOD, { threadId, ...(input.teamId ? { teamId: input.teamId } : {}) });
    },
    async collaborationUserAction(input: CollaborationUserActionInput): Promise<unknown> {
      const threadId = hostThreadIdSchema.parse(input.threadId);
      const method = input.action === "task/cancel"
        ? THREAD_TEAM_TASK_CANCEL_METHOD
        : input.action === "task/reassign"
          ? THREAD_TEAM_TASK_REASSIGN_METHOD
          : input.action === "message/send"
            ? THREAD_TEAM_MESSAGE_SEND_METHOD
            : THREAD_COLLABORATION_CONTINUE_METHOD;
      const params: Record<string, unknown> = { threadId };
      for (const [key, value] of Object.entries(input)) {
        if (key !== "action" && key !== "threadId" && value !== undefined) params[key] = value;
      }
      return manager.sendRequest(method, params);
    },
    async usageHistory(input: { days?: number }): Promise<unknown> {
      return await manager.sendRequest('harnessmix/usage/history', input ?? {});
    },
    async usageSummary(): Promise<unknown> {
      return await manager.sendRequest('harnessmix/usage/summary', {});
    },
    async healthSnapshot(): Promise<unknown> {
      return await manager.sendRequest('harnessmix/health/snapshot', {});
    },
    async healthRefresh(): Promise<unknown> {
      return await manager.sendRequest('harnessmix/health/refresh', {});
    },
    subscribeThreadUsage(listener: (update: ThreadUsageInspection) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Usage notification callback is unavailable");
      }
      let disposed = false;
      const generations = new Map<ThreadUsageInspectionParams["threadId"], number>();
      const removeNotificationCallback = notifications.addNotificationCallback(
        [THREAD_TOKEN_USAGE_UPDATED_METHOD, THREAD_USAGE_UPDATED_METHOD],
        (notification) => {
          const threadId = notifiedThreadId(notification);
          if (!threadId) return;
          const generation = (generations.get(threadId) ?? 0) + 1;
          generations.set(threadId, generation);
          void inspectThreadUsage({ threadId })
            .then((update) => {
              if (!disposed && generations.get(threadId) === generation) listener(update);
            })
            .catch(() => undefined);
        },
      );
      return () => {
        if (disposed) return;
        disposed = true;
        generations.clear();
        removeNotificationCallback();
      };
    },
    selectThreadModel,
    selectThreadThinking,
    selectThreadPermissionMode,
    async checkUpdate(): Promise<UpdateCheckResult> {
      const result = await manager.sendRequest(
        UPDATE_CHECK_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateCheckResultSchema.parse(result);
    },
    async startUpdate(): Promise<UpdateStartResult> {
      const result = await manager.sendRequest(
        UPDATE_START_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStartResultSchema.parse(result);
    },
    async readUpdateStatus(): Promise<UpdateStatusResult> {
      const result = await manager.sendRequest(
        UPDATE_STATUS_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStatusResultSchema.parse(result);
    },
    async readCurrentVersion(): Promise<{ version: string }> {
      const result = await manager.sendRequest(RUNTIME_VERSION_METHOD, {});
      if (!isRecord(result) || typeof result.version !== "string" || !result.version.trim()) {
        throw new Error("Invalid Harness Mix version response");
      }
      return { version: result.version.trim() };
    },
    async inspectCodexAccountUsage(
      input: CodexAccountUsageParams,
    ): Promise<CodexAccountUsageResult> {
      const result = await manager.sendRequest(
        "harnessmix/account/usage/inspect",
        codexAccountUsageParamsSchema.parse(input),
      );
      return codexAccountUsageResultSchema.parse(result);
    },
    async consumeCodexAccountResetCredit(
      input: CodexAccountResetCreditConsumeParams,
    ): Promise<CodexAccountResetCreditConsumeResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_RESET_CREDIT_CONSUME_METHOD,
        codexAccountResetCreditConsumeParamsSchema.parse(input),
      );
      return codexAccountResetCreditConsumeResultSchema.parse(result);
    },
    async listHarnessAccounts(): Promise<HarnessAccountListResult> {
      return harnessAccountListResultSchema.parse(
        await manager.sendRequest("harnessmix/harness/accounts/list", {}),
      );
    },
    async listCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_LIST_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    async refreshCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_REFRESH_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    async createCodexAccount(input: CodexAccountCreateParams): Promise<CodexAccountMutationResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_CREATE_METHOD,
        codexAccountCreateParamsSchema.parse(input),
      );
      return codexAccountMutationResultSchema.parse(result);
    },
    async deleteCodexAccount(input: CodexAccountDeleteParams): Promise<CodexAccountDeleteResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_DELETE_METHOD,
        codexAccountDeleteParamsSchema.parse(input),
      );
      return codexAccountDeleteResultSchema.parse(result);
    },
    async activateCodexAccount(
      input: CodexAccountActivateParams,
    ): Promise<CodexAccountMutationResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_ACTIVATE_METHOD,
        codexAccountActivateParamsSchema.parse(input),
      );
      return codexAccountMutationResultSchema.parse(result);
    },
    async startCodexAccountLogin(
      input: CodexAccountLoginStartParams,
    ): Promise<CodexAccountLoginStartResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_LOGIN_START_METHOD,
        codexAccountLoginStartParamsSchema.parse(input),
      );
      return codexAccountLoginStartResultSchema.parse(result);
    },
    async cancelCodexAccountLogin(
      input: CodexAccountLoginCancelParams,
    ): Promise<CodexAccountLoginCancelResult> {
      const result = await manager.sendRequest(
        CODEX_ACCOUNT_LOGIN_CANCEL_METHOD,
        codexAccountLoginCancelParamsSchema.parse(input),
      );
      return codexAccountLoginCancelResultSchema.parse(result);
    },
    async logoutCodexAccount(): Promise<CodexAccountMutationResult> {
      const result = await manager.sendRequest("harnessmix/account/logout", {});
      return codexAccountMutationResultSchema.parse(result);
    },
    subscribeCodexAccountLogin(listener: (result: CodexAccountLoginCompleted) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Account login notification callback is unavailable");
      }
      return notifications.addNotificationCallback(
        CODEX_ACCOUNT_LOGIN_COMPLETED_METHOD,
        (notification) => {
          if (
            !isRecord(notification) ||
            notification.method !== CODEX_ACCOUNT_LOGIN_COMPLETED_METHOD
          ) {
            return;
          }
          const result = codexAccountLoginCompletedSchema.safeParse(notification.params);
          if (result.success) listener(result.data);
        },
      );
    },
  });
}
