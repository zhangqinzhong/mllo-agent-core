import type {
  AgentCorePermissionContext,
  AgentCorePermissionDecision,
} from "../permissions/agent-core-permission-types";
import { evaluateAgentCoreShellPermission } from "../permissions/shell-command-policy";
import type { AgentCoreToolDefinition, AgentCoreToolResult } from "./agent-core-tool-types";
import { runAgentCoreShellCommand } from "./shell-command-runner";
import type { AgentCoreShellCwdTracker } from "./shell-cwd-tracker";
import {
  checkAgentCoreShellExecutionBackendAvailability,
  createAgentCoreShellExecutionBackendToolAvailability,
  describeAgentCoreShellExecutionBackend,
  localAgentCoreShellExecutionBackend,
  type AgentCoreShellExecutionBackend,
} from "./shell-execution-backend";
import {
  inspectAgentCoreShellRemoteEnvironment,
  type AgentCoreShellSessionEnvironment,
} from "./shell-environment-policy";
import type { AgentCoreShellTaskRegistry } from "./shell-task-registry";
import {
  AGENT_CORE_SHELL_MAX_RESULT_CHARS,
  agentCoreShellCommandInputSchema,
  type AgentCoreShellCommandOutput,
} from "./shell-command-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

export type AgentCoreShellToolOptions = {
  permissionContext: AgentCorePermissionContext;
  outputDir?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  taskRegistry?: AgentCoreShellTaskRegistry;
  cwdTracker?: AgentCoreShellCwdTracker;
  executionBackend?: AgentCoreShellExecutionBackend;
  requireSandboxedBackend?: boolean;
  sessionEnvironment?: AgentCoreShellSessionEnvironment;
};

// 格式化命令完成状态。模型需要 exit/signal/timeout 信息来判断下一步。
function shellStatusLine(output: AgentCoreShellCommandOutput): string {
  if (output.backgroundTaskId !== undefined) {
    return `Background task ${output.backgroundTaskId} started. Output path: ${output.outputPath}`;
  }
  if (output.timedOut) {
    const termination = output.terminationResult
      ? ` Termination result: ${output.terminationResult}.`
      : "";
    return `Command timed out after ${output.elapsedMs}ms.${termination}`;
  }
  if (output.interrupted) {
    const termination = output.terminationResult
      ? ` Termination result: ${output.terminationResult}.`
      : "";
    return `Command interrupted after ${output.elapsedMs}ms.${termination}`;
  }
  if (output.errorMessage !== undefined) {
    return `Command failed before completion after ${output.elapsedMs}ms.`;
  }
  const status = `Command exited with code ${output.exitCode ?? "unknown"} after ${output.elapsedMs}ms.`;
  if (output.cwdChanged !== undefined) {
    return `${status}\nShell cwd changed: ${output.cwdChanged.previousCwd} -> ${output.cwdChanged.currentCwd}`;
  }
  return status;
}

// 把 stdout/stderr 合成模型可消费的文本。stderr 单独标注，避免模型误读普通输出。
function formatShellResult(output: AgentCoreShellCommandOutput): AgentCoreToolResult {
  const sections = [shellStatusLine(output)];
  if (output.envWarnings !== undefined && output.envWarnings.length > 0) {
    sections.push(`env warnings:\n${output.envWarnings.join("\n")}`);
  }
  if (output.errorMessage !== undefined) {
    sections.push(`error:\n${output.errorMessage}`);
  }
  if (output.stdout.length > 0) {
    sections.push(`stdout:\n${output.stdout.trimEnd()}`);
  }
  if (output.stderr.length > 0) {
    sections.push(`stderr:\n${output.stderr.trimEnd()}`);
  }
  return {
    content: sections.join("\n\n"),
    isError:
      output.timedOut ||
      output.interrupted ||
      output.errorMessage !== undefined ||
      (output.exitCode ?? 0) !== 0,
  };
}

function requireRemoteSecretEnvironmentApproval(args: {
  decision: AgentCorePermissionDecision;
  executionBackend: AgentCoreShellExecutionBackend;
  env?: Record<string, string>;
}): AgentCorePermissionDecision {
  if (args.decision.status === "deny") {
    return args.decision;
  }
  const inspection = inspectAgentCoreShellRemoteEnvironment({
    overrides: args.env,
    remote: args.executionBackend.remote === true,
    policy: args.executionBackend.remoteEnvironmentPolicy,
  });
  if (inspection.allowedSecretLikeNames.length === 0) {
    return args.decision;
  }
  const remoteSecretReason = `Remote shell will forward explicitly allowed secret-like environment variables and requires approval: ${inspection.allowedSecretLikeNames.join(", ")}.`;
  const risk = {
    kind: "remote-secret-env",
    severity: "high",
    title: "Remote secret environment forwarding",
    detail:
      "These environment variable names are allowed for remote forwarding. Values are hidden, but approval is required before sending them to the remote shell.",
    names: inspection.allowedSecretLikeNames,
  } as const;
  if (args.decision.status === "ask") {
    return {
      status: "ask",
      capability: "shell-write",
      reason: `${args.decision.reason}\n${remoteSecretReason}`,
      risk,
    };
  }
  return {
    status: "ask",
    capability: "shell-write",
    reason: remoteSecretReason,
    risk,
  };
}

// sandbox 必选时，不能让本地 unsandboxed shell 通过 availability 回退执行。
async function checkShellToolBackend(args: {
  executionBackend: AgentCoreShellExecutionBackend;
  requireSandboxedBackend: boolean | undefined;
}): Promise<Awaited<ReturnType<typeof checkAgentCoreShellExecutionBackendAvailability>>> {
  if (args.requireSandboxedBackend === true && args.executionBackend.sandboxed !== true) {
    return {
      available: false,
      reason: `Sandboxed shell backend is required but selected backend is ${describeAgentCoreShellExecutionBackend(args.executionBackend)}.`,
    };
  }
  return await checkAgentCoreShellExecutionBackendAvailability(args.executionBackend);
}

// availability 也执行 sandbox 要求，避免 schema 暴露一个运行时必失败的 shell_command。
function createShellToolBackendAvailability(args: {
  executionBackend: AgentCoreShellExecutionBackend;
  requireSandboxedBackend: boolean | undefined;
}): AgentCoreToolDefinition["availability"] {
  const availability = createAgentCoreShellExecutionBackendToolAvailability(args.executionBackend);
  const backend = describeAgentCoreShellExecutionBackend(args.executionBackend);
  return {
    ...availability,
    cacheKey: `shell_command:${backend}:sandbox-required=${args.requireSandboxedBackend === true}`,
    check: () => checkShellToolBackend(args),
  };
}

// 创建 shell_command 工具。复杂 shell 语义交给权限层解释，执行层只负责可靠运行。
export function createAgentCoreShellCommandTool(
  options: AgentCoreShellToolOptions,
): AgentCoreToolDefinition {
  const executionBackend = options.executionBackend ?? localAgentCoreShellExecutionBackend;
  const sandboxRequirement =
    options.requireSandboxedBackend === true ? "Sandbox requirement: sandboxed backend." : "";
  return {
    name: "shell_command",
    description: [
      "Run a shell command in the workspace with streaming output, timeout, and optional background execution.",
      "For repository investigation, prefer one bounded read-only command such as rg, grep, find, sed, git status, or git grep over many small file tools.",
      'Keep search output narrow, for example `rg -n "pattern" src --glob "*.ts" | head -80` before targeted read_file calls.',
      "Set description to a short active-voice explanation of the command intent for permission review.",
      `Execution backend: ${describeAgentCoreShellExecutionBackend(executionBackend)}.`,
      sandboxRequirement,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    inputSchema: agentCoreShellCommandInputSchema,
    maxResultSizeChars: options.maxBuffer ?? AGENT_CORE_SHELL_MAX_RESULT_CHARS,
    availability: createShellToolBackendAvailability({
      executionBackend,
      requireSandboxedBackend: options.requireSandboxedBackend,
    }),
    evaluatePermission(input) {
      const parsed = agentCoreShellCommandInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "deny",
          capability: "shell-write",
          reason: "Invalid shell_command input.",
        };
      }
      const decision = evaluateAgentCoreShellPermission(
        options.permissionContext,
        parsed.data.command,
        {
          runInBackground: parsed.data.runInBackground === true,
        },
      );
      return requireRemoteSecretEnvironmentApproval({
        decision,
        executionBackend,
        env: parsed.data.env,
      });
    },
    isConcurrencySafe(input) {
      const parsed = agentCoreShellCommandInputSchema.safeParse(input);
      if (!parsed.success) {
        return false;
      }
      const decision = requireRemoteSecretEnvironmentApproval({
        decision: evaluateAgentCoreShellPermission(options.permissionContext, parsed.data.command, {
          runInBackground: parsed.data.runInBackground === true,
        }),
        executionBackend,
        env: parsed.data.env,
      });
      return decision.status === "allow" && decision.capability === "shell-readonly";
    },
    cancelSiblingToolsOnError() {
      // shell 命令常有隐式依赖链；一个失败时同批命令继续跑通常只会制造噪声。
      return true;
    },
    async run(input, context) {
      const parsed = agentCoreShellCommandInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "shell_command",
          error: parsed.error,
          input,
          schema: agentCoreShellCommandInputSchema,
        });
      }
      const availability = await checkShellToolBackend({
        executionBackend,
        requireSandboxedBackend: options.requireSandboxedBackend,
      });
      if (!availability.available) {
        return {
          content: `Shell execution backend is unavailable: ${describeAgentCoreShellExecutionBackend(executionBackend)}. ${availability.reason ?? "No reason provided."}`,
          isError: true,
        };
      }
      const result = await runAgentCoreShellCommand(
        {
          ...parsed.data,
          timeoutMs: parsed.data.timeoutMs ?? options.timeoutMs,
        },
        {
          cwd: options.permissionContext.cwd,
          outputDir: options.outputDir,
          signal: context.signal,
          onProgress: context.onProgress,
          taskRegistry: options.taskRegistry,
          cwdTracker: options.cwdTracker,
          executionBackend,
          sessionEnvironment: options.sessionEnvironment,
        },
      );
      if (result.cwdChanged !== undefined) {
        context.onProgress?.({
          kind: "cwd-change",
          change: result.cwdChanged,
        });
      }
      return formatShellResult(result);
    },
  };
}
