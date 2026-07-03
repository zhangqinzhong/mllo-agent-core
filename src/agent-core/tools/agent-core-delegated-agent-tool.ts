import { z } from "zod";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import type { AgentCoreToolDefinition, AgentCoreToolResult } from "./agent-core-tool-types";
import {
  checkAgentCoreWorkerAvailability,
  createAgentCoreWorkerToolAvailability,
} from "./agent-core-worker-tool-availability";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const delegateAgentInputSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
});

export type AgentCoreDelegatedAgentToolOptions = {
  workers: readonly AgentCoreWorker[];
  workflowJournalPath?: string;
};

// 列出可用 worker。写进工具描述，让模型知道能调度谁。
function describeWorkers(workers: readonly AgentCoreWorker[]): string {
  return workers
    .map((worker) => {
      const capabilities = worker.capabilities.join(", ");
      return `${worker.id}: ${worker.description} Capabilities: ${capabilities}.`;
    })
    .join("\n");
}

// 找到指定 worker。保持显式 id，避免模型用 label 导致歧义。
function findWorker(
  workers: readonly AgentCoreWorker[],
  agentId: string,
): AgentCoreWorker | undefined {
  return workers.find((worker) => worker.id === agentId);
}

function workerPermissionReason(worker: AgentCoreWorker): string {
  return [
    `Delegating to ${worker.id} can execute another agent.`,
    `Capabilities: ${worker.capabilities.join(", ")}.`,
  ].join(" ");
}

// 真正调用 worker 前再检查一次，避免工具 schema grace 期间调到已失效 worker。
async function unavailableWorkerResult(
  worker: AgentCoreWorker,
): Promise<AgentCoreToolResult | null> {
  const availability = await checkAgentCoreWorkerAvailability(worker);
  if (availability.available) {
    return null;
  }
  return {
    content: `Delegated agent is unavailable: ${worker.id}. ${availability.reason ?? "No reason provided."}`,
    isError: true,
  };
}

// 创建 delegated agent 工具。第三方 agent 是 mllo Agent Core 的 worker，而不是主控层。
export function createAgentCoreDelegatedAgentTool(
  options: AgentCoreDelegatedAgentToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "delegate_agent",
    description: [
      "Delegate a scoped subtask to another agent worker and return its result.",
      "Available workers:",
      describeWorkers(options.workers),
    ].join("\n"),
    inputSchema: delegateAgentInputSchema,
    availability: createAgentCoreWorkerToolAvailability(options.workers),
    evaluatePermission(input) {
      const parsed = delegateAgentInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "deny",
          capability: "shell-write",
          reason: "Invalid delegate_agent input.",
        };
      }
      const worker = findWorker(options.workers, parsed.data.agentId);
      return worker === undefined
        ? {
            status: "deny",
            capability: "shell-write",
            reason: `Delegated agent is not registered: ${parsed.data.agentId}`,
          }
        : {
            status: "ask",
            capability: "shell-write",
            reason: workerPermissionReason(worker),
          };
    },
    async run(input, context) {
      const parsed = delegateAgentInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "delegate_agent",
          error: parsed.error,
        });
      }
      const worker = findWorker(options.workers, parsed.data.agentId);
      if (worker === undefined) {
        return {
          content: `Delegated agent is not registered: ${parsed.data.agentId}`,
          isError: true,
        };
      }
      const unavailable = await unavailableWorkerResult(worker);
      if (unavailable !== null) {
        return unavailable;
      }
      const result = await worker.run({
        prompt: parsed.data.prompt,
        cwd: context.cwd,
        signal: context.signal,
        onEvent(event) {
          context.onProgress?.({
            kind: "worker-event",
            event,
          });
        },
        async requestPermission(request) {
          context.onProgress?.({
            kind: "worker-event",
            event: {
              type: "permission-request",
              workerId: worker.id,
              ...request,
            },
          });
          const decision = (await context.requestWorkerPermission?.({
            workerId: worker.id,
            ...request,
          })) ?? {
            status: "deny",
            reason: "No worker permission bridge is available.",
          };
          context.onProgress?.({
            kind: "worker-event",
            event: {
              type: "permission-decision",
              workerId: worker.id,
              requestId: request.requestId,
              status: decision.status,
              reason:
                decision.status === "allow"
                  ? "Allowed by mllo worker permission bridge."
                  : decision.reason,
            },
          });
          return decision;
        },
      });
      if (result.status === "denied") {
        return {
          content: result.content,
          isError: true,
        };
      }
      return {
        content: result.content,
      };
    },
  };
}
