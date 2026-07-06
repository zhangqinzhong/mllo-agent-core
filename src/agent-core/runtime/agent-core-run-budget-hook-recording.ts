import type { AgentCoreHookDefinition } from "../hooks/agent-core-hook-types";
import type {
  AgentCoreMessage,
  AgentCoreModelAdapter,
  AgentCoreQueryEvent,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreHttpModelConfig } from "../model/agent-core-http-model-config";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import { recordAgentCoreRunEvent } from "./agent-core-run-recording";
import type { AgentCorePreparedRunSession } from "./agent-core-run-session";
import {
  applyAgentCoreRunBudget,
  type AgentCoreRunBudgetOptions,
  type AgentCoreRunBudgetResult,
} from "./agent-core-run-budget";

export type AgentCoreRunBudgetWithHookRecordingResult = {
  budgeted: AgentCoreRunBudgetResult;
  hookEvents: AgentCoreQueryEvent[];
};

export async function applyAgentCoreRunBudgetWithHookRecording(args: {
  messages: readonly AgentCoreMessage[];
  model: AgentCoreModelAdapter;
  provider?: AgentCoreHttpModelConfig;
  session: AgentCorePreparedRunSession;
  budget?: AgentCoreRunBudgetOptions;
  hooks: readonly AgentCoreHookDefinition[];
  signal?: AbortSignal;
  workers: readonly AgentCoreWorker[];
}): Promise<AgentCoreRunBudgetWithHookRecordingResult> {
  const hookEvents: AgentCoreQueryEvent[] = [];
  const budgeted = await applyAgentCoreRunBudget({
    messages: args.messages,
    model: args.model,
    provider: args.provider,
    session: args.session,
    budget: args.budget,
    hookOptions: {
      hooks: args.hooks,
      signal: args.signal,
      async onHookEvent(event) {
        hookEvents.push(
          await recordAgentCoreRunEvent({
            session: args.session,
            event,
            workers: args.workers,
          }),
        );
      },
    },
  });
  return {
    budgeted,
    hookEvents,
  };
}
