import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentCoreWorker,
  AgentCoreWorkerAvailabilityCheckResult,
  AgentCoreWorkerEvent,
  AgentCoreWorkerPermissionRequest,
} from "../../agent-core/workers/agent-core-worker-types";

type RawClaudeSdkMessage = {
  type: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      id?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }[];
  };
  tool_use_result?: unknown;
};

type ClaudeSdkQuery = (args: { prompt: string; options: Options }) => Query;
type ClaudeSdkWorkerPermissionMode = Extract<
  Options["permissionMode"],
  "default" | "dontAsk" | "plan"
>;

export type ClaudeSdkWorkerOptions = {
  availabilityCheck?: () =>
    | AgentCoreWorkerAvailabilityCheckResult
    | Promise<AgentCoreWorkerAvailabilityCheckResult>;
  permissionMode?: ClaudeSdkWorkerPermissionMode;
  queryImpl?: ClaudeSdkQuery;
};

// SDK import 成功只说明 adapter 可加载；真实认证和端点错误由 run 阶段暴露给宿主。
function defaultClaudeSdkAvailabilityCheck(): AgentCoreWorkerAvailabilityCheckResult {
  return {
    available: typeof query === "function",
    reason:
      typeof query === "function"
        ? "@anthropic-ai/claude-agent-sdk is loaded."
        : "@anthropic-ai/claude-agent-sdk query export is unavailable.",
  };
}

// 下级 Claude 的危险工具必须回到 mllo 权限桥，不能绕过主控 agent。
function claudeToolCapability(name: string | undefined): AgentCoreWorkerPermissionRequest | null {
  switch (name) {
    case undefined:
      return null;
    case "Bash":
      return {
        requestId: "claude-sdk-bash",
        toolName: "Bash",
        capability: "shell-write",
        reason: "Claude SDK wants to run a shell command.",
        input: {},
      };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        requestId: `claude-sdk-${name}`,
        toolName: name,
        capability: "file-write",
        reason: `Claude SDK wants to modify files with ${name}.`,
        input: {},
      };
    case "WebFetch":
    case "WebSearch":
      return {
        requestId: `claude-sdk-${name}`,
        toolName: name,
        capability: "network",
        reason: `Claude SDK wants to access network with ${name}.`,
        input: {},
      };
    default:
      return null;
  }
}

function extractClaudeSdkContent(message: RawClaudeSdkMessage): string[] {
  if (message.type !== "assistant") {
    return [];
  }
  return (
    message.message?.content?.flatMap((block) => {
      if (block.type === "text" && block.text !== undefined) {
        return [block.text];
      }
      if (block.type === "tool_use") {
        return [`[claude tool] ${block.name ?? "unknown"} ${JSON.stringify(block.input ?? {})}`];
      }
      return [];
    }) ?? []
  );
}

function claudeToolRequestId(args: {
  baseRequestId: string;
  toolUseId: string | undefined;
  sequence: number;
}): string {
  return args.toolUseId ?? `${args.baseRequestId}-${args.sequence}`;
}

async function emitClaudeSdkMessageEvents(args: {
  message: RawClaudeSdkMessage;
  request: Parameters<AgentCoreWorker["run"]>[0];
  permissionSequenceStart: number;
  toolNamesById: Map<string, string>;
}): Promise<{ allowed: boolean; nextPermissionSequence: number }> {
  const message = args.message;
  if (message.type !== "assistant" && message.type !== "user") {
    return {
      allowed: true,
      nextPermissionSequence: args.permissionSequenceStart,
    };
  }
  const events: AgentCoreWorkerEvent[] = [];
  let permissionSequence = args.permissionSequenceStart;
  for (const block of message.message?.content ?? []) {
    if (message.type === "user" && block.type === "tool_result") {
      events.push({
        type: "tool-result",
        workerId: "claude-sdk",
        ...(block.tool_use_id === undefined ? {} : { invocationId: block.tool_use_id }),
        name: args.toolNamesById.get(block.tool_use_id ?? "") ?? "tool_result",
        output: block.content ?? message.tool_use_result ?? {},
        isError: block.is_error === true,
      });
      continue;
    }
    if (block.type === "text" && block.text !== undefined) {
      events.push({
        type: "assistant-delta",
        workerId: "claude-sdk",
        content: block.text,
      });
    }
    if (block.type === "tool_use") {
      if (block.id !== undefined && block.name !== undefined) {
        args.toolNamesById.set(block.id, block.name);
      }
      events.push({
        type: "tool-use",
        workerId: "claude-sdk",
        ...(block.id === undefined ? {} : { invocationId: block.id }),
        name: block.name ?? "unknown",
        input: block.input ?? {},
      });
    }
    const permissionRequest = block.type === "tool_use" ? claudeToolCapability(block.name) : null;
    if (permissionRequest !== null) {
      permissionSequence += 1;
      const requestId = claudeToolRequestId({
        baseRequestId: permissionRequest.requestId,
        toolUseId: block.id,
        sequence: permissionSequence,
      });
      const decision = (await args.request.requestPermission?.({
        ...permissionRequest,
        requestId,
        input: block.input ?? {},
      })) ?? {
        status: "deny",
        reason: "Claude SDK worker needs mllo permission bridge before dangerous tool use.",
      };
      events.push({
        type: "permission-decision",
        workerId: "claude-sdk",
        requestId,
        status: decision.status,
        reason:
          decision.status === "allow"
            ? "Allowed by mllo worker permission bridge."
            : decision.reason,
      });
      if (decision.status === "deny") {
        for (const event of events) {
          args.request.onEvent?.(event);
        }
        args.request.onEvent?.({
          type: "worker-error",
          workerId: "claude-sdk",
          message: `Claude SDK permission denied: ${decision.reason}`,
        });
        return {
          allowed: false,
          nextPermissionSequence: permissionSequence,
        };
      }
    }
  }
  for (const event of events) {
    args.request.onEvent?.(event);
  }
  return {
    allowed: true,
    nextPermissionSequence: permissionSequence,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
// Claude SDK 是 mllo 的下级 worker；它可以执行任务，但危险动作要经过 mllo 权限桥。
export function createClaudeSdkWorker(workerOptions: ClaudeSdkWorkerOptions = {}): AgentCoreWorker {
  const queryImpl = workerOptions.queryImpl ?? query;
  const permissionMode = workerOptions.permissionMode ?? "dontAsk";
  return {
    id: "claude-sdk",
    label: "Claude",
    description: "Delegate a scoped coding task to Claude SDK and return its transcript summary.",
    capabilities: ["planning", "review", "file-read", "workspace-write", "shell", "network"],
    availability: {
      ttlMs: 60_000,
      failureGraceMs: 5 * 60_000,
      check: workerOptions.availabilityCheck ?? defaultClaudeSdkAvailabilityCheck,
    },
    async run(request) {
      const queryOptions: Options = {
        cwd: request.cwd,
        permissionMode,
      };
      let queryInstance: Query | null = queryImpl({
        prompt: request.prompt,
        options: queryOptions,
      });
      const abortListener = (): void => {
        queryInstance?.interrupt();
      };
      request.signal?.addEventListener("abort", abortListener, {
        once: true,
      });

      try {
        request.onEvent?.({
          type: "worker-start",
          workerId: "claude-sdk",
          label: "Claude",
        });
        const parts: string[] = [];
        let permissionSequence = 0;
        const toolNamesById = new Map<string, string>();
        for await (const raw of queryInstance) {
          const message = raw as RawClaudeSdkMessage;
          const eventResult = await emitClaudeSdkMessageEvents({
            message,
            request,
            permissionSequenceStart: permissionSequence,
            toolNamesById,
          });
          permissionSequence = eventResult.nextPermissionSequence;
          if (!eventResult.allowed) {
            queryInstance?.interrupt();
            const content = "Claude SDK worker stopped because mllo denied tool permission.";
            request.onEvent?.({
              type: "worker-done",
              workerId: "claude-sdk",
              content,
            });
            return {
              content,
              status: "denied",
            };
          }
          parts.push(...extractClaudeSdkContent(message));
        }
        const content =
          parts.length === 0 ? "Claude worker completed without text output." : parts.join("\n\n");
        request.onEvent?.({
          type: "worker-done",
          workerId: "claude-sdk",
          content,
        });
        return {
          content,
        };
      } catch (error) {
        request.onEvent?.({
          type: "worker-error",
          workerId: "claude-sdk",
          message: errorMessage(error),
        });
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", abortListener);
        queryInstance = null;
      }
    },
  };
}
