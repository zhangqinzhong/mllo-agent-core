import {
  resumeAgentCorePermissionDecision,
  type AgentCorePermissionResumeResult,
} from "../query-loop/agent-core-permission-resume";
import type {
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import { recordAgentCorePermissionDecision } from "./agent-core-permission-audit";
import { recordAgentCoreRunEvent } from "./agent-core-run-recording";
import type { AgentCoreRunControllerOptions } from "./agent-core-run-controller-types";
import type { AgentCorePreparedRunSession } from "./agent-core-run-session";

export type AgentCoreRunPermissionArgs = {
  cwd: string;
  session: AgentCorePreparedRunSession;
  result: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }>;
  tools: NonNullable<AgentCoreQueryLoopArgs["tools"]>;
  signal?: AbortSignal;
  requestWorkerPermission?: AgentCoreQueryLoopArgs["requestWorkerPermission"];
  onPermissionRequest: NonNullable<AgentCoreRunControllerOptions["onPermissionRequest"]>;
  workers: readonly AgentCoreWorker[];
};

// 恢复 permission 暂停点。审批决定先写 JSONL 审计，再执行被暂停的工具。
export async function* resumeAgentCoreRunPermission(
  args: AgentCoreRunPermissionArgs,
): AsyncGenerator<AgentCoreQueryEvent, AgentCorePermissionResumeResult> {
  const decision = await args.onPermissionRequest(args.result);
  await recordAgentCorePermissionDecision({
    session: args.session,
    result: args.result,
    decision,
  });
  const resumeGenerator = resumeAgentCorePermissionDecision({
    waitingResult: args.result,
    cwd: args.cwd,
    tools: args.tools,
    decision,
    signal: args.signal,
    requestWorkerPermission: args.requestWorkerPermission,
  });
  while (true) {
    const item = await resumeGenerator.next();
    if (item.done === true) {
      return item.value;
    }
    const recordedEvent = await recordAgentCoreRunEvent({
      session: args.session,
      event: item.value,
      workers: args.workers,
    });
    yield recordedEvent;
  }
}
