import { resumeAgentCoreElicitationDecision } from "../query-loop/agent-core-elicitation-resume";
import { runAgentCoreHooks } from "../hooks/agent-core-hook-runner";
import type { AgentCoreHookDefinition } from "../hooks/agent-core-hook-types";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import { submitAgentCoreInteractionResolution } from "./agent-core-interactions";
import { recordAgentCoreRunEvent } from "./agent-core-run-recording";
import type { AgentCoreRunControllerOptions } from "./agent-core-run-controller-types";
import type { AgentCorePreparedRunSession } from "./agent-core-run-session";

export type AgentCoreRunElicitationArgs = {
  session: AgentCorePreparedRunSession;
  result: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-elicitation" }>;
  hooks: readonly AgentCoreHookDefinition[];
  onElicitationRequest: NonNullable<AgentCoreRunControllerOptions["onElicitationRequest"]>;
  timeoutMs?: number;
  signal?: AbortSignal;
  workers: readonly AgentCoreWorker[];
  interactionId: string;
};

// 等待用户回答时可以设置超时，避免 GUI/IPC 丢响应后 run 永久挂住。
async function waitForElicitationDecision(
  args: AgentCoreRunElicitationArgs,
): Promise<Awaited<ReturnType<AgentCoreRunElicitationArgs["onElicitationRequest"]>>> {
  if (args.timeoutMs === undefined || args.timeoutMs <= 0) {
    return await args.onElicitationRequest(args.result, {
      interactionId: args.interactionId,
    });
  }
  let timeout: NodeJS.Timeout | undefined;
  const timeoutDecision = new Promise<
    Awaited<ReturnType<AgentCoreRunElicitationArgs["onElicitationRequest"]>>
  >((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: "cancel",
        reason: `Elicitation timed out after ${args.timeoutMs}ms.`,
      });
    }, args.timeoutMs);
  });
  try {
    return await Promise.race([
      args.onElicitationRequest(args.result, {
        interactionId: args.interactionId,
      }),
      timeoutDecision,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

// 恢复 ask_user 暂停点。这里同时写审计和 tool_result，避免用户回答只存在内存里。
export async function* resumeAgentCoreRunElicitation(
  args: AgentCoreRunElicitationArgs,
): AsyncGenerator<AgentCoreQueryEvent, readonly AgentCoreMessage[]> {
  const decision = await waitForElicitationDecision(args);
  const hookDecision = yield* runAgentCoreHooks({
    hooks: args.hooks,
    context: {
      phase: "elicitation-result",
      cwd: args.session.handle.cwd,
      call: args.result.call,
      elicitationRequest: args.result.request,
      elicitationDecision: decision,
      signal: args.signal,
    },
  });
  const effectiveDecision =
    hookDecision.action === "block"
      ? {
          status: "cancel" as const,
          reason: hookDecision.reason ?? "Elicitation result hook blocked the answer.",
        }
      : decision;
  const resolution = await submitAgentCoreInteractionResolution({
    stateStore: args.session.stateStore,
    sessionStore: args.session.store,
    interactionId: args.interactionId,
    resolution: {
      kind: "elicitation",
      decision: effectiveDecision,
    },
    source: "callback",
  });
  if (resolution.status !== "resolved" && resolution.status !== "already-resolved") {
    throw new Error(
      `Elicitation interaction ${args.interactionId} resolution failed: ${resolution.status}.`,
    );
  }
  const resumeGenerator = resumeAgentCoreElicitationDecision({
    waitingResult: args.result,
    decision: effectiveDecision,
  });
  while (true) {
    const item = resumeGenerator.next();
    if (item.done === true) {
      return item.value.messages;
    }
    const recordedEvent = await recordAgentCoreRunEvent({
      session: args.session,
      event: item.value,
      workers: args.workers,
    });
    yield recordedEvent;
  }
}
