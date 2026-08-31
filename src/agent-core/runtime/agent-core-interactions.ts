import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AGENT_CORE_INTERACTION_SCHEMA_VERSION,
  type AgentCoreInteractionRequest,
  type AgentCoreInteractionResolution,
  type AgentCoreInteractionResolutionResult,
  type AgentCoreInteractionResolutionSource,
} from "../interactions/agent-core-interaction-types";
import type { AgentCoreQueryLoopResult } from "../query-loop/agent-core-query-types";
import type { MlloInteractionRecord } from "../runtime-state/mllo-interaction-records";
import type { MlloStateStore } from "../runtime-state/mllo-state-store";
import type { AgentCoreJsonlSessionStore } from "../session/agent-core-jsonl-session-store";
import type { AgentCoreSessionHandle } from "../session/agent-core-session-types";
import {
  redactAgentCorePermissionCallInput,
  redactAgentCoreToolCallInput,
} from "./agent-core-permission-input-redaction";
import type { AgentCorePreparedRunSession } from "./agent-core-run-session";

type AgentCoreWaitingInteractionResult = Extract<
  AgentCoreQueryLoopResult,
  { status: "waiting-for-permission" | "waiting-for-elicitation" }
>;

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function interactionRequestFromResult(
  result: AgentCoreWaitingInteractionResult,
): AgentCoreInteractionRequest {
  if (result.status === "waiting-for-permission") {
    return {
      kind: "permission",
      call: redactAgentCorePermissionCallInput({
        call: result.call,
        decision: result.decision,
      }),
      decision: result.decision,
    };
  }
  return {
    kind: "elicitation",
    call: redactAgentCoreToolCallInput({
      call: result.call,
    }),
    request: result.request,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResolution(
  interaction: MlloInteractionRecord,
  resolution: unknown,
): string | undefined {
  if (!isRecord(resolution) || resolution.kind !== interaction.kind) {
    return `Resolution kind must match ${interaction.kind}.`;
  }
  const decision = resolution.decision;
  if (!isRecord(decision)) {
    return "Resolution decision must be an object.";
  }
  if (interaction.kind === "permission") {
    if (decision.status === "allow") {
      return undefined;
    }
    if (decision.status === "deny" && typeof decision.reason === "string") {
      return undefined;
    }
    return "Permission resolution must be allow or deny with a reason.";
  }
  if (decision.status === "answer" && typeof decision.answer === "string") {
    return undefined;
  }
  if (decision.status === "cancel" && typeof decision.reason === "string") {
    return undefined;
  }
  return "Elicitation resolution must be answer or cancel with a reason.";
}

function createResolutionEntry(args: {
  sessionStore: AgentCoreJsonlSessionStore;
  interaction: MlloInteractionRecord;
  resolution: AgentCoreInteractionResolution;
  source: AgentCoreInteractionResolutionSource;
}) {
  const request = args.interaction.request;
  if (request.kind === "permission" && args.resolution.kind === "permission") {
    return args.sessionStore.createPermissionEventEntry({
      sessionId: args.interaction.threadId,
      cwd: args.interaction.cwd,
      call: request.call,
      request: request.decision,
      response: args.resolution.decision,
      interactionId: args.interaction.id,
      resolutionSource: args.source,
    });
  }
  if (request.kind === "elicitation" && args.resolution.kind === "elicitation") {
    return args.sessionStore.createElicitationEventEntry({
      sessionId: args.interaction.threadId,
      cwd: args.interaction.cwd,
      call: request.call,
      request: request.request,
      response: args.resolution.decision,
      interactionId: args.interaction.id,
      resolutionSource: args.source,
    });
  }
  throw new Error(`Interaction ${args.interaction.id} has an inconsistent request kind.`);
}

function interactionHandle(interaction: MlloInteractionRecord): AgentCoreSessionHandle {
  return {
    sessionId: interaction.threadId,
    cwd: interaction.cwd,
    projectDir: "",
    transcriptPath: interaction.transcriptPath,
  };
}

// 在 callback 前先写 JSONL request，再投影 SQLite；崩溃窗口可由 reindex 修复。
export async function recordAgentCorePendingInteraction(args: {
  session: AgentCorePreparedRunSession;
  result: AgentCoreWaitingInteractionResult;
  messageCount: number;
  interactionId?: string;
}): Promise<MlloInteractionRecord> {
  const interactionId = args.interactionId ?? randomUUID();
  const request = interactionRequestFromResult(args.result);
  const requestKey = `${request.kind}:${request.call.id}:${args.messageCount}`;
  const entry = args.session.store.createInteractionRequestEventEntry({
    sessionId: args.session.handle.sessionId,
    cwd: args.session.handle.cwd,
    interactionId,
    requestKey,
    messageCount: args.messageCount,
    request,
  });
  await args.session.store.appendEntry(args.session.handle, entry);
  const createdAtMs = timestampMs(entry.timestamp);
  return args.session.stateStore.upsertInteraction({
    version: AGENT_CORE_INTERACTION_SCHEMA_VERSION,
    id: interactionId,
    threadId: args.session.handle.sessionId,
    requestKey,
    kind: request.kind,
    status: "pending",
    callId: request.call.id,
    toolName: request.call.name,
    cwd: args.session.handle.cwd,
    transcriptPath: args.session.handle.transcriptPath,
    messageCount: args.messageCount,
    request,
    requestEntryUuid: entry.uuid,
    createdAtMs,
    updatedAtMs: createdAtMs,
  });
}

export function getAgentCoreInteraction(args: {
  stateStore: MlloStateStore;
  interactionId: string;
}): MlloInteractionRecord | undefined {
  return args.stateStore.getInteraction(args.interactionId);
}

export function listPendingAgentCoreInteractions(args: {
  stateStore: MlloStateStore;
  threadId?: string;
  limit?: number;
}): MlloInteractionRecord[] {
  return args.stateStore.listPendingInteractions({
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
}

// 提交只持久化用户决定，不会在重启后自动重放可能有副作用的 permission tool。
export async function submitAgentCoreInteractionResolution(args: {
  stateStore: MlloStateStore;
  sessionStore: AgentCoreJsonlSessionStore;
  interactionId: string;
  resolution: AgentCoreInteractionResolution;
  source?: AgentCoreInteractionResolutionSource;
}): Promise<AgentCoreInteractionResolutionResult> {
  const interaction = args.stateStore.getInteraction(args.interactionId);
  if (interaction === undefined) {
    return {
      status: "not-found",
      interactionId: args.interactionId,
    };
  }
  const validationError = validateResolution(interaction, args.resolution);
  if (validationError !== undefined) {
    return {
      status: "invalid-resolution",
      interaction,
      message: validationError,
    };
  }
  if (interaction.status === "resolved") {
    if (isDeepStrictEqual(interaction.resolution, args.resolution)) {
      return {
        status: "already-resolved",
        interaction,
      };
    }
    return {
      status: "conflict",
      interaction,
      message: `Interaction ${interaction.id} already has a different resolution.`,
    };
  }

  const source = args.source ?? "external";
  const entry = createResolutionEntry({
    sessionStore: args.sessionStore,
    interaction,
    resolution: args.resolution,
    source,
  });
  await args.sessionStore.appendEntry(interactionHandle(interaction), entry);
  const resolvedAtMs = timestampMs(entry.timestamp);
  const resolved = args.stateStore.upsertInteraction({
    ...interaction,
    status: "resolved",
    resolution: args.resolution,
    resolutionSource: source,
    resolutionEntryUuid: entry.uuid,
    resolvedAtMs,
    updatedAtMs: resolvedAtMs,
  });
  if (!isDeepStrictEqual(resolved.resolution, args.resolution)) {
    return {
      status: "conflict",
      interaction: resolved,
      message: `Interaction ${interaction.id} was resolved concurrently.`,
    };
  }
  return {
    status: "resolved",
    interaction: resolved,
  };
}
