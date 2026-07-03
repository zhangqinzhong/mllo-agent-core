import { z } from "zod";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import type { AgentCoreToolDefinition } from "./agent-core-tool-types";
import {
  cyclicAgentCoreWorkflowDependencies,
  duplicateAgentCoreWorkflowTaskIds,
  missingAgentCoreWorkflowDependencies,
} from "./agent-core-workflow-validation";
import {
  runAgentCoreWorkflow,
  type AgentCoreWorkflowTaskStatus,
} from "./agent-core-workflow-runner";
import { createAgentCoreWorkerToolAvailability } from "./agent-core-worker-tool-availability";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const workflowTaskRecoverySchema = z.object({
  agentId: z.string().min(1).optional(),
  prompt: z.string().min(1),
});

const workflowTaskSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  recovery: workflowTaskRecoverySchema.optional(),
});

const workflowInputSchema = z.object({
  goal: z.string().min(1),
  tasks: z.array(workflowTaskSchema).min(1).max(20),
});

type WorkflowInput = z.infer<typeof workflowInputSchema>;

export type AgentCoreWorkflowToolOptions = {
  workers: readonly AgentCoreWorker[];
  journalPath?: string;
};

function describeWorkers(workers: readonly AgentCoreWorker[]): string {
  return workers
    .map((worker) => {
      const capabilities = worker.capabilities.join(", ");
      return `${worker.id}: ${worker.description} Capabilities: ${capabilities}.`;
    })
    .join("\n");
}

function findWorker(
  workers: readonly AgentCoreWorker[],
  agentId: string,
): AgentCoreWorker | undefined {
  return workers.find((worker) => worker.id === agentId);
}

function unregisteredWorkflowWorkerIds(
  input: WorkflowInput,
  workers: readonly AgentCoreWorker[],
): string[] {
  const registeredIds = new Set(workers.map((worker) => worker.id));
  const requestedIds = new Set(
    input.tasks.flatMap((task) => [
      task.agentId,
      ...(task.recovery?.agentId === undefined ? [] : [task.recovery.agentId]),
    ]),
  );
  return [...requestedIds].filter((workerId) => !registeredIds.has(workerId));
}

function workflowPermissionReason(
  input: WorkflowInput,
  workers: readonly AgentCoreWorker[],
): string {
  const workerIds = [
    ...new Set(
      input.tasks.flatMap((task) => [
        task.agentId,
        ...(task.recovery?.agentId === undefined ? [] : [task.recovery.agentId]),
      ]),
    ),
  ];
  const capabilityText = workerIds
    .map((workerId) => {
      const worker = findWorker(workers, workerId);
      return worker === undefined
        ? `${workerId}: unregistered`
        : `${workerId}: ${worker.capabilities.join(", ")}`;
    })
    .join("; ");
  return `Running workflow "${input.goal}" dispatches worker agents. Capabilities: ${capabilityText}.`;
}

function formatWorkflowResult(args: {
  goal: string;
  results: ReadonlyMap<string, AgentCoreWorkflowTaskStatus>;
}): string {
  const lines = [`Workflow goal: ${args.goal}`, "", "Task results:"];
  for (const [taskId, result] of args.results) {
    lines.push(`- ${taskId}: ${result.status}`);
    lines.push(result.content);
  }
  return lines.join("\n");
}

export function createAgentCoreWorkflowTool(
  options: AgentCoreWorkflowToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "run_agent_workflow",
    description: [
      "Run a dependency-aware multi-agent workflow using registered worker agents.",
      "Tasks in the same ready batch may run concurrently; dependent tasks receive prior results.",
      "Available workers:",
      describeWorkers(options.workers),
    ].join("\n"),
    inputSchema: workflowInputSchema,
    availability: createAgentCoreWorkerToolAvailability(options.workers),
    evaluatePermission(input) {
      const parsed = workflowInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "deny",
          capability: "shell-write",
          reason: "Invalid run_agent_workflow input.",
        };
      }
      const unregistered = unregisteredWorkflowWorkerIds(parsed.data, options.workers);
      if (unregistered.length > 0) {
        return {
          status: "allow",
          capability: "shell-write",
          reason: `Workflow references unregistered workers: ${unregistered.join(", ")}`,
        };
      }
      return {
        status: "ask",
        capability: "shell-write",
        reason: workflowPermissionReason(parsed.data, options.workers),
      };
    },
    async run(input, context) {
      const parsed = workflowInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "run_agent_workflow",
          error: parsed.error,
          input,
          schema: workflowInputSchema,
        });
      }
      const duplicates = duplicateAgentCoreWorkflowTaskIds(parsed.data.tasks);
      if (duplicates.length > 0) {
        return {
          content: `Duplicate workflow task ids: ${duplicates.join(", ")}`,
          isError: true,
        };
      }
      const missing = missingAgentCoreWorkflowDependencies(parsed.data.tasks);
      if (missing.length > 0) {
        return {
          content: `Workflow task dependencies are missing: ${missing.join(", ")}`,
          isError: true,
        };
      }
      const cycles = cyclicAgentCoreWorkflowDependencies(parsed.data.tasks);
      if (cycles.length > 0) {
        return {
          content: `Workflow task dependencies contain cycles: ${cycles.join(", ")}`,
          isError: true,
        };
      }
      const unregistered = unregisteredWorkflowWorkerIds(parsed.data, options.workers);
      if (unregistered.length > 0) {
        return {
          content: `Workflow references unregistered workers: ${unregistered.join(", ")}`,
          isError: true,
        };
      }
      const results = await runAgentCoreWorkflow({
        input: parsed.data,
        workers: options.workers,
        cwd: context.cwd,
        journalPath: options.journalPath,
        signal: context.signal,
        onProgress: context.onProgress,
        requestWorkerPermission: context.requestWorkerPermission,
      });
      return {
        content: formatWorkflowResult({
          goal: parsed.data.goal,
          results,
        }),
        isError: [...results.values()].some((result) => result.status !== "completed"),
      };
    },
  };
}
