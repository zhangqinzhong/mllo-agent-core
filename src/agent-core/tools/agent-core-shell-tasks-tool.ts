import { z } from "zod";
import type { AgentCorePermissionContext } from "../permissions/agent-core-permission-types";
import type { AgentCoreToolDefinition, AgentCoreToolResult } from "./agent-core-tool-types";
import {
  defaultAgentCoreShellTaskRegistry,
  type AgentCoreShellTaskSnapshot,
  type AgentCoreShellTaskRegistry,
} from "./shell-task-registry";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const shellTasksInputSchema = z.object({
  taskId: z.string().min(1).optional(),
  includeOutputTail: z.boolean().optional(),
  maxOutputChars: z.number().int().positive().optional(),
});

export type AgentCoreShellTasksToolOptions = {
  permissionContext: AgentCorePermissionContext;
  taskRegistry?: AgentCoreShellTaskRegistry;
};

function formatTask(snapshot: AgentCoreShellTaskSnapshot): string {
  const lines = [
    `taskId: ${snapshot.taskId}`,
    `status: ${snapshot.status}`,
    `command: ${snapshot.command}`,
    `cwd: ${snapshot.cwd}`,
    `outputPath: ${snapshot.outputPath}`,
    `startedAt: ${new Date(snapshot.startedAt).toISOString()}`,
    `updatedAt: ${new Date(snapshot.updatedAt).toISOString()}`,
  ];
  if (snapshot.executionBackend !== undefined) {
    lines.push(
      `backend: ${snapshot.executionBackend.kind}`,
      `backendRemote: ${snapshot.executionBackend.remote ? "true" : "false"}`,
      `backendSandboxed: ${snapshot.executionBackend.sandboxed ? "true" : "false"}`,
    );
    if (snapshot.executionBackend.label !== undefined) {
      lines.push(`backendLabel: ${snapshot.executionBackend.label}`);
    }
  }
  if (snapshot.session !== undefined) {
    if (snapshot.session.sessionId !== undefined) {
      lines.push(`sessionId: ${snapshot.session.sessionId}`);
    }
    lines.push(`runtimeDir: ${snapshot.session.runtimeDir}`);
  }
  if (snapshot.completedAt !== undefined) {
    lines.push(`completedAt: ${new Date(snapshot.completedAt).toISOString()}`);
  }
  if (snapshot.exitCode !== undefined) {
    lines.push(`exitCode: ${snapshot.exitCode}`);
  }
  if (snapshot.signal !== undefined) {
    lines.push(`signal: ${snapshot.signal}`);
  }
  if (snapshot.elapsedMs !== undefined) {
    lines.push(`elapsedMs: ${snapshot.elapsedMs}`);
  }
  if (snapshot.terminationResult !== undefined) {
    lines.push(`terminationResult: ${snapshot.terminationResult}`);
  }
  if (snapshot.errorMessage !== undefined) {
    lines.push(`error: ${snapshot.errorMessage}`);
  }
  if (snapshot.outputTail !== undefined) {
    lines.push(`outputTail:\n${snapshot.outputTail.trimEnd()}`);
  }
  return lines.join("\n");
}

function formatTasks(snapshots: readonly AgentCoreShellTaskSnapshot[]): AgentCoreToolResult {
  if (snapshots.length === 0) {
    return {
      content: "No shell tasks found.",
    };
  }
  return {
    content: snapshots.map(formatTask).join("\n\n---\n\n"),
  };
}

// shell_tasks 是只读任务查询工具；后台 shell 需要能被模型继续观察，而不是只返回一次路径。
export function createAgentCoreShellTasksTool(
  options: AgentCoreShellTasksToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "shell_tasks",
    description: "List shell background tasks or inspect one task with output tail.",
    inputSchema: shellTasksInputSchema,
    maxResultSizeChars: 80_000,
    evaluatePermission() {
      return {
        status: "allow",
        capability: "shell-readonly",
        reason: "Reading shell task status is safe.",
      };
    },
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = shellTasksInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "shell_tasks",
          error: parsed.error,
          input,
          schema: shellTasksInputSchema,
        });
      }
      const registry = options.taskRegistry ?? defaultAgentCoreShellTaskRegistry;
      const includeOutputTail = parsed.data.includeOutputTail ?? true;
      const maxOutputChars = parsed.data.maxOutputChars ?? 20_000;
      if (parsed.data.taskId !== undefined) {
        const snapshot = await registry.getTask(parsed.data.taskId, {
          includeOutputTail,
          maxOutputChars,
        });
        return snapshot === undefined
          ? {
              content: `Shell task not found: ${parsed.data.taskId}`,
              isError: true,
            }
          : formatTasks([snapshot]);
      }
      return formatTasks(
        await registry.listTasks({
          includeOutputTail,
          maxOutputChars,
        }),
      );
    },
  };
}
