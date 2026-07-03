import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolExecutionResult,
  AgentCoreToolResult,
} from "./agent-core-tool-types";
import {
  createAgentCoreToolInputValidationResult,
  createAgentCoreToolMalformedArgumentsResult,
} from "./agent-core-tool-input-validation";

// 根据工具名查找定义。工具数组保持顺序，便于以后按 UI 顺序展示。
function findAgentCoreTool(
  tools: readonly AgentCoreToolDefinition[],
  name: string,
): AgentCoreToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

function registeredToolNames(tools: readonly AgentCoreToolDefinition[]): string {
  return tools.length === 0
    ? "(none)"
    : tools
        .map((tool) => tool.name)
        .sort()
        .join(", ");
}

// 把未知异常转成工具错误文本。工具错误要回灌给模型，而不是打断整个 queryLoop。
function toolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RETRYABLE_EXCEPTION_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "glob_files",
  "grep_files",
  "shell_tasks",
  "list_skills",
  "read_skill",
  "list_mcp_tools",
]);

const RETRYABLE_ERROR_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ECONNRESET",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function shouldRetryToolException(args: {
  error: unknown;
  signal?: AbortSignal;
  toolName: string;
}): boolean {
  if (args.signal?.aborted === true || !RETRYABLE_EXCEPTION_TOOL_NAMES.has(args.toolName)) {
    return false;
  }
  const code = errorCode(args.error);
  return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
}

// 工具入参先在 runner 层统一校验。失败要回灌给模型修正，不能变成权限终态。
function validateToolCallInput(args: {
  call: AgentCoreToolCall;
  tool: AgentCoreToolDefinition;
}): AgentCoreToolResult | undefined {
  if (args.call.inputParseStatus !== undefined) {
    const parseError = createAgentCoreToolMalformedArgumentsResult({
      toolName: args.tool.name,
      parseStatus: args.call.inputParseStatus,
    });
    if (parseError !== undefined) {
      return parseError;
    }
  }
  const schema = args.tool.inputSchema;
  if (schema === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(args.call.input);
  return parsed.success
    ? undefined
    : createAgentCoreToolInputValidationResult({
        toolName: args.tool.name,
        error: parsed.error,
        input: args.call.input,
        schema,
      });
}

async function runToolWithRetry(args: {
  input: unknown;
  tool: AgentCoreToolDefinition;
  context: Parameters<AgentCoreToolDefinition["run"]>[1];
}): Promise<AgentCoreToolResult> {
  let retried = false;
  while (true) {
    try {
      return await args.tool.run(args.input, args.context);
    } catch (error) {
      if (
        retried ||
        !shouldRetryToolException({
          error,
          signal: args.context.signal,
          toolName: args.tool.name,
        })
      ) {
        return {
          content: `Error calling tool ${args.tool.name}: ${toolErrorMessage(error)}`,
          isError: true,
          errorKind: "runtime-exception",
        };
      }
      retried = true;
    }
  }
}

// 对单个工具结果做大小限制。工具级 maxResultSizeChars 用来控制上下文膨胀。
function limitToolResultSize(
  result: AgentCoreToolResult,
  maxResultSizeChars: number | undefined,
): AgentCoreToolResult {
  if (!Number.isFinite(maxResultSizeChars) || maxResultSizeChars === undefined) {
    return result;
  }
  if (result.content.length <= maxResultSizeChars) {
    return result;
  }

  return {
    ...result,
    content: `${result.content.slice(0, maxResultSizeChars)}\n\n[tool result truncated after ${maxResultSizeChars} chars]`,
    outputTruncated: true,
    outputOriginalChars: result.content.length,
    outputMaxChars: maxResultSizeChars,
  };
}

// 运行单个工具调用。这里集中处理权限 gate，query loop 只关心执行状态。
export async function runAgentCoreToolCall(args: {
  call: AgentCoreToolCall;
  cwd: string;
  signal?: AbortSignal;
  tools: readonly AgentCoreToolDefinition[];
  permissionOverride?: "allow";
  onProgress?: Parameters<AgentCoreToolDefinition["run"]>[1]["onProgress"];
  requestWorkerPermission?: Parameters<
    AgentCoreToolDefinition["run"]
  >[1]["requestWorkerPermission"];
}): Promise<AgentCoreToolExecutionResult> {
  const tool = findAgentCoreTool(args.tools, args.call.name);
  if (tool === undefined) {
    return {
      status: "not-found",
      message: [
        `Tool is not registered: ${args.call.name}`,
        `Registered tools: ${registeredToolNames(args.tools)}`,
      ].join("\n"),
    };
  }

  const validationError = validateToolCallInput({
    call: args.call,
    tool,
  });
  if (validationError !== undefined) {
    return {
      status: "ok",
      result: validationError,
    };
  }

  const permissionDecision = tool.evaluatePermission?.(args.call.input);
  if (permissionDecision?.status === "ask") {
    if (args.permissionOverride === "allow") {
      return {
        status: "ok",
        result: limitToolResultSize(
          await runToolWithRetry({
            tool,
            input: args.call.input,
            context: {
              cwd: args.cwd,
              permissionDecision: {
                status: "allow",
                capability: permissionDecision.capability,
                reason: "Allowed by user permission decision.",
              },
              signal: args.signal,
              onProgress: args.onProgress,
              requestWorkerPermission: args.requestWorkerPermission,
            },
          }),
          tool.maxResultSizeChars,
        ),
      };
    }
    return {
      status: "permission-required",
      decision: permissionDecision,
    };
  }
  if (permissionDecision?.status === "deny") {
    return {
      status: "permission-denied",
      decision: permissionDecision,
    };
  }

  return {
    status: "ok",
    result: limitToolResultSize(
      await runToolWithRetry({
        tool,
        input: args.call.input,
        context: {
          cwd: args.cwd,
          permissionDecision,
          signal: args.signal,
          onProgress: args.onProgress,
          requestWorkerPermission: args.requestWorkerPermission,
        },
      }),
      tool.maxResultSizeChars,
    ),
  };
}
