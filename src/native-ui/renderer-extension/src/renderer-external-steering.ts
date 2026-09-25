import { threadOwnershipListResultSchema } from "@harnessmix/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RendererMethod = (...args: unknown[]) => unknown;
interface SteeringManager {
  sendRequest: RendererMethod;
  steerTurn: RendererMethod;
  startTurn: RendererMethod;
  getTurnCoordinator: RendererMethod;
  getStreamRole?: RendererMethod;
}

function isSteeringManager(value: unknown): value is SteeringManager {
  return (
    isRecord(value) &&
    ["sendRequest", "steerTurn", "startTurn", "getTurnCoordinator"].every(
      (key) => typeof value[key] === "function",
    )
  );
}

interface SubmissionHostBinding {
  getActiveTurnId(threadId: string): unknown;
  hasPendingTurnStart(threadId: string): unknown;
}

function resolveSubmissionHost(manager: SteeringManager): SubmissionHostBinding {
  const coordinator = manager.getTurnCoordinator();
  const options = isRecord(coordinator) ? coordinator.options : null;
  const host = isRecord(options) ? options.submissionHost : null;
  if (
    !isRecord(host) ||
    typeof host.getActiveTurnId !== "function" ||
    typeof host.hasPendingTurnStart !== "function"
  ) {
    throw new Error("Desktop turn submission binding is unavailable");
  }
  return {
    getActiveTurnId: (threadId) => (host.getActiveTurnId as RendererMethod).call(host, threadId),
    hasPendingTurnStart: (threadId) =>
      (host.hasPendingTurnStart as RendererMethod).call(host, threadId),
  };
}

type PatchedMethodName = "sendRequest" | "steerTurn";
const PATCHED_METHODS = ["sendRequest", "steerTurn"] as const;

/**
 * Swap `sendRequest`/`steerTurn` on the manager without ever touching its
 * class prototype or creating forbidden own properties on RpcTarget-backed
 * instances: inherited methods are shadowed through a private intermediate
 * prototype inserted only while needed, and removed again on restore.
 */
function patchSteeringMethods(
  manager: SteeringManager,
  replacements: Record<PatchedMethodName, RendererMethod>,
): (name: PatchedMethodName) => void {
  const basePrototype: object | null = Object.getPrototypeOf(manager);
  const shadowPrototype: object = Object.create(basePrototype);
  const ownDescriptors = new Map(
    PATCHED_METHODS.map((name) => [name, Object.getOwnPropertyDescriptor(manager, name)]),
  );
  for (const name of PATCHED_METHODS) {
    const own = ownDescriptors.get(name);
    Object.defineProperty(own ? manager : shadowPrototype, name, {
      configurable: own?.configurable ?? true,
      enumerable: own?.enumerable ?? false,
      writable: true,
      value: replacements[name],
    });
  }
  if (PATCHED_METHODS.some((name) => !ownDescriptors.get(name))) {
    Object.setPrototypeOf(manager, shadowPrototype);
  }
  return (name) => {
    const own = ownDescriptors.get(name);
    const holder = own ? manager : shadowPrototype;
    if (Reflect.get(holder, name) === replacements[name]) {
      if (own) Object.defineProperty(manager, name, own);
      else Reflect.deleteProperty(shadowPrototype, name);
    }
    if (
      Object.getPrototypeOf(manager) === shadowPrototype &&
      PATCHED_METHODS.every((key) => !Object.hasOwn(shadowPrototype, key))
    ) {
      Object.setPrototypeOf(manager, basePrototype);
    }
  };
}

const INTERRUPTED_QUEUE_REASON = "Interrupted before the steer was accepted.";

/**
 * Snapshot the follow-up queue before the old Turn is cancelled, and hand back
 * a callback that unpauses exactly the entries the cancellation paused (any
 * message that was already paused before us keeps its own reason).
 */
async function preserveQueuedFollowUps(
  manager: SteeringManager,
  threadId: string,
): Promise<() => void> {
  const coordinator = manager.getTurnCoordinator();
  if (
    !isRecord(coordinator) ||
    typeof coordinator.loadMessages !== "function" ||
    typeof coordinator.readMessages !== "function" ||
    typeof coordinator.mutate !== "function"
  ) {
    throw new Error("Desktop follow-up queue binding is unavailable");
  }
  await coordinator.loadMessages.call(coordinator, threadId);
  const messages: unknown = coordinator.readMessages.call(coordinator, threadId);
  if (!Array.isArray(messages)) throw new Error("Desktop follow-up queue is unavailable");
  const pausedBeforeUs = new Set(
    messages
      .filter((message) => isRecord(message) && message.pausedReason != null)
      .map((message) => (message as Record<string, unknown>).id),
  );
  return () => {
    (coordinator.mutate as RendererMethod).call(coordinator, threadId, (current: unknown) => {
      if (!Array.isArray(current)) return current;
      return current.map((message) => {
        if (
          !isRecord(message) ||
          pausedBeforeUs.has(message.id) ||
          message.pausedReason !== INTERRUPTED_QUEUE_REASON
        ) {
          return message;
        }
        const resumed = { ...message };
        delete resumed.pausedReason;
        return resumed;
      });
    });
  };
}

/**
 * Route external-Thread direction changes through Desktop's ordinary start
 * presentation first; only the outgoing start RPC is rewritten into a steer.
 * Stopping, waiting, and starting remain owned by the Host. Official Threads
 * keep the untouched steer implementation and its response semantics.
 */
export function installRendererExternalSteering(target: unknown): (() => void) | null {
  if (!isSteeringManager(target)) return null;
  const manager = target;
  const originalSteer = manager.steerTurn;
  const originalSend = manager.sendRequest;
  const startRoutes = new Map<string, { threadId: string; expectedTurnId: string }>();
  const pendingReplacements = new Map<
    string,
    { messageId: string; fingerprint: string; promise: Promise<unknown> }
  >();
  let disposed = false;

  const send: RendererMethod = function (method, params, options) {
    const messageId = isRecord(params) ? params.clientUserMessageId : null;
    const route =
      typeof messageId === "string" && isRecord(params)
        ? startRoutes.get(`${params.threadId}\u0000${messageId}`)
        : undefined;
    if (
      method !== "turn/start" ||
      !isRecord(params) ||
      !route ||
      route.threadId !== params.threadId
    ) {
      return originalSend.call(manager, method, params, options);
    }
    if (disposed) return Promise.reject(new Error("External steering binding was disposed"));
    return Promise.resolve(
      originalSend.call(
        manager,
        "turn/steer",
        {
          threadId: route.threadId,
          expectedTurnId: route.expectedTurnId,
          clientUserMessageId: messageId,
          input: params.input,
          additionalContext: params.additionalContext,
          responsesapiClientMetadata: params.responsesapiClientMetadata,
        },
        options,
      ),
    ).then((response) => {
      if (!isRecord(response) || typeof response.turnId !== "string" || !response.turnId) {
        throw new Error("External steering returned no replacement Turn identity");
      }
      return {
        turn: {
          id: response.turnId,
          status: "inProgress",
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          itemsView: "full",
        },
      };
    });
  };

  const steer: RendererMethod = async function (...args) {
    const [
      threadId,
      input,
      restoreMessage,
      serviceTier,
      attachments,
      clientUserMessageId,
      additionalContext,
      toolOutput,
      onMessageAdded,
    ] = args;
    if (typeof threadId !== "string") return originalSteer.apply(manager, args);
    const initialRole = manager.getStreamRole?.(threadId);
    // A follower window forwards to its owner; the owner's own manager does
    // the replacement, so stay out of the way here.
    if (isRecord(initialRole) && initialRole.role === "follower") {
      return originalSteer.apply(manager, args);
    }
    let host: ReturnType<typeof resolveSubmissionHost> | null = null;
    let expectedTurnId: unknown;
    try {
      host = resolveSubmissionHost(manager);
      expectedTurnId = host.getActiveTurnId(threadId);
    } catch {
      // Official steering must keep working even when this extra binding is missing.
    }
    const ownership = threadOwnershipListResultSchema.parse(
      await originalSend.call(manager, "harnessmix/thread/ownership/list", {
        threadIds: [threadId],
      }),
    );
    const owner = ownership.threads.find((thread) => thread.threadId === threadId)?.owner;
    if (!owner) throw new Error("Thread ownership could not be resolved for steering");
    if (disposed) throw new Error("External steering binding was disposed");
    if (owner === "codex") return originalSteer.apply(manager, args);
    if (!host) throw new Error("Desktop turn submission binding is unavailable");
    const roleNow = manager.getStreamRole?.(threadId);
    if (isRecord(roleNow) && roleNow.role === "follower") return originalSteer.apply(manager, args);
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.some(
        (item) => !isRecord(item) || !(
          item.type === "text" && typeof item.text === "string" ||
          item.type === "localImage" && typeof item.path === "string" && item.path.length > 0 ||
          item.type === "image" && typeof item.url === "string" && item.url.startsWith("data:image/")
        ),
      ) ||
      !input.some((item) => isRecord(item) && (item.type !== "text" || typeof item.text === "string" && item.text.trim()))
    ) {
      throw new Error("External steering requires non-empty text input or images");
    }
    if (toolOutput != null) throw new Error("External steering cannot replace a tool response");
    if (!isRecord(restoreMessage) || !isRecord(restoreMessage.context)) {
      throw new Error("Desktop steering message context is unavailable");
    }
    const messageId =
      typeof clientUserMessageId === "string" && clientUserMessageId
        ? clientUserMessageId
        : typeof restoreMessage.id === "string" && restoreMessage.id
          ? restoreMessage.id
          : crypto.randomUUID();
    const fingerprint = JSON.stringify(input);
    const existing = pendingReplacements.get(threadId);
    if (existing) {
      if (existing.messageId === messageId && existing.fingerprint === fingerprint)
        return existing.promise;
      throw new Error("This Thread is already changing direction");
    }
    if (expectedTurnId != null && (typeof expectedTurnId !== "string" || !expectedTurnId)) {
      throw new Error("Desktop active Turn identity is invalid");
    }
    if (expectedTurnId == null && host.hasPendingTurnStart(threadId)) {
      throw new Error("Previous Turn submission has not been confirmed yet");
    }
    const context = restoreMessage.context;
    const routeKey = `${threadId}\u0000${messageId}`;
    if (typeof expectedTurnId === "string") {
      startRoutes.set(routeKey, { threadId, expectedTurnId });
    }
    const promise = Promise.resolve()
      .then(async () => {
        if (disposed) throw new Error("External steering binding was disposed");
        const resumeQueue = await preserveQueuedFollowUps(manager, threadId);
        if (disposed) throw new Error("External steering binding was disposed");
        const response = await manager.startTurn(
          threadId,
          {
            request: {
              threadId,
              input,
              clientUserMessageId: messageId,
              additionalContext,
              responsesapiClientMetadata: restoreMessage.responsesapiClientMetadata,
              cwd: restoreMessage.cwd,
              serviceTier,
              model: null,
              effort: null,
              collaborationMode: context.collaborationMode ?? null,
            },
            context: {
              attachments: attachments ?? [],
              commentAttachments: context.commentAttachments ?? [],
              mcpAppModelContextAttachments: context.mcpAppModelContextAttachments,
              useAppServerPermissionDefault: true,
            },
          },
          onMessageAdded,
        );
        if (
          !isRecord(response) ||
          !isRecord(response.turn) ||
          typeof response.turn.id !== "string"
        ) {
          throw new Error("Desktop returned no replacement Turn identity");
        }
        try {
          resumeQueue();
        } catch {
          // The input was already accepted; a resume failure must not turn it
          // into a failed delivery (which would invite a duplicate retry).
          console.error("harnessmix could not restore follow-up queue state after steering");
        }
        return { turnId: response.turn.id };
      })
      .finally(() => {
        startRoutes.delete(routeKey);
        pendingReplacements.delete(threadId);
      });
    pendingReplacements.set(threadId, { messageId, fingerprint, promise });
    return promise;
  };

  const restoreMethod = patchSteeringMethods(manager, { sendRequest: send, steerTurn: steer });
  return () => {
    disposed = true;
    restoreMethod("steerTurn");
    // Starts still in flight must fail closed rather than silently becoming
    // plain start RPCs, so sendRequest stays patched until they settle.
    if (pendingReplacements.size === 0) {
      restoreMethod("sendRequest");
    } else {
      void Promise.allSettled([...pendingReplacements.values()].map(({ promise }) => promise)).then(() => {
        restoreMethod("sendRequest");
      });
    }
  };
}
