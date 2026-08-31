import type { LangfuseAgent } from "@langfuse/tracing";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import type { AgentCoreHttpModelConfig } from "../model/agent-core-http-model-config";
import type { AgentCoreRunControllerResult } from "../runtime/agent-core-run-controller-types";
import type { AgentCoreLangfuseTracingOptions } from "./agent-core-langfuse-options";
import {
  ensureAgentCoreLangfuseRuntime,
  flushAgentCoreLangfuseRuntime,
  resolveAgentCoreLangfuseTracing,
  type ResolvedAgentCoreLangfuseTracing,
} from "./agent-core-langfuse-runtime";
import {
  createAgentCoreLangfuseProviderMetadata,
  createAgentCoreLangfuseRunInput,
  createAgentCoreLangfuseRunOutput,
} from "./agent-core-langfuse-summaries";

export type AgentCoreLangfuseRunTrace = {
  root: LangfuseAgent;
  config: ResolvedAgentCoreLangfuseTracing;
  provider: AgentCoreHttpModelConfig;
};

export async function createAgentCoreLangfuseRunTrace(args: {
  options?: AgentCoreLangfuseTracingOptions;
  sessionId: string;
  cwd: string;
  workspaceRoots: readonly string[];
  input: string;
  provider: AgentCoreHttpModelConfig;
}): Promise<AgentCoreLangfuseRunTrace | undefined> {
  const config = resolveAgentCoreLangfuseTracing(args.options);
  if (config === undefined) {
    return undefined;
  }
  await ensureAgentCoreLangfuseRuntime(config);
  const providerMetadata = createAgentCoreLangfuseProviderMetadata(args.provider);
  const sessionId = config.sessionId ?? args.sessionId;
  const root = propagateAttributes(
    {
      traceName: config.traceName,
      userId: config.userId,
      sessionId,
      tags: [...config.tags],
      metadata: {
        ...config.metadata,
        ...providerMetadata,
        cwd: args.cwd,
      },
      version: config.release,
    },
    () =>
      startObservation(
        "mllo.agent.run",
        {
          input: createAgentCoreLangfuseRunInput({
            input: args.input,
            cwd: args.cwd,
            workspaceRoots: args.workspaceRoots,
            captureContent: config.captureContent,
          }),
          metadata: {
            ...providerMetadata,
            sessionId,
            workspaceRootCount: args.workspaceRoots.length,
          },
        },
        {
          asType: "agent",
        },
      ),
  );
  return {
    root,
    config,
    provider: args.provider,
  };
}

export async function finishAgentCoreLangfuseRunTrace(args: {
  trace?: AgentCoreLangfuseRunTrace;
  result?: AgentCoreRunControllerResult;
  error?: unknown;
}): Promise<void> {
  if (args.trace === undefined) {
    return;
  }
  if (args.error !== undefined) {
    args.trace.root.update({
      level: "ERROR",
      statusMessage: args.error instanceof Error ? args.error.message : String(args.error),
    });
  } else if (args.result !== undefined) {
    args.trace.root.update({
      output: createAgentCoreLangfuseRunOutput(args.result),
      metadata: {
        status: args.result.status,
        messageCount: args.result.messages.length,
      },
    });
  }
  args.trace.root.end();
  if (args.trace.config.flushOnEnd) {
    try {
      await flushAgentCoreLangfuseRuntime();
    } catch {
      // 观测层不能覆盖 agent 本身的成功/失败结果。
    }
  }
}
