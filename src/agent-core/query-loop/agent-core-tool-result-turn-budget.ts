import type { AgentCoreToolCall, AgentCoreToolResult } from "../tools/agent-core-tool-types";
import type {
  AgentCoreToolResultBlobReference,
  AgentCoreToolResultBlobStore,
} from "./agent-core-query-types";

export const AGENT_CORE_TOOL_RESULTS_PER_TURN_MAX_CHARS = 80_000;
export const AGENT_CORE_PERSISTED_TOOL_OUTPUT_TAG = "mllo_persisted_tool_output";

export type AgentCoreToolResultTurnBudget = {
  maxChars: number;
  usedChars: number;
  truncatedResults: number;
};

export function createAgentCoreToolResultTurnBudget(
  maxChars = AGENT_CORE_TOOL_RESULTS_PER_TURN_MAX_CHARS,
): AgentCoreToolResultTurnBudget {
  return {
    maxChars,
    usedChars: 0,
    truncatedResults: 0,
  };
}

function originalToolResultChars(result: AgentCoreToolResult): number {
  return Math.max(result.outputOriginalChars ?? result.content.length, result.content.length);
}

function existingToolResultBlob(
  result: AgentCoreToolResult,
): AgentCoreToolResultBlobReference | undefined {
  return result.outputBlobPath === undefined || result.outputBlobBytes === undefined
    ? undefined
    : {
        outputBlobPath: result.outputBlobPath,
        outputBlobBytes: result.outputBlobBytes,
      };
}

function budgetLabel(args: {
  kind: "tool-result-max" | "aggregate-turn";
  maxChars: number;
}): string {
  return args.kind === "tool-result-max"
    ? `toolMaxResultChars: ${args.maxChars}`
    : `turnBudgetChars: ${args.maxChars}`;
}

function budgetNotice(args: {
  call: AgentCoreToolCall;
  kind: "tool-result-max" | "aggregate-turn";
  maxChars: number;
  originalChars: number;
  keptChars: number;
  blob?: AgentCoreToolResultBlobReference;
}): string {
  return [
    args.kind === "tool-result-max"
      ? `[tool result persisted because it exceeded maxResultSizeChars for ${args.call.name}]`
      : `[tool result truncated by aggregate turn budget for ${args.call.name}]`,
    `keptChars: ${args.keptChars}`,
    `originalChars: ${args.originalChars}`,
    budgetLabel(args),
    ...(args.blob === undefined
      ? ["Run a narrower command/read/search if more output is needed."]
      : [
          `outputBlobPath: ${args.blob.outputBlobPath}`,
          `outputBlobBytes: ${args.blob.outputBlobBytes}`,
          "The complete stored output is available to host/observer surfaces via outputBlobPath.",
        ]),
  ].join("\n");
}

function persistedToolOutputContent(args: {
  call: AgentCoreToolCall;
  kind: "tool-result-max" | "aggregate-turn";
  maxChars: number;
  originalChars: number;
  keptChars: number;
  preview: string;
  blob: AgentCoreToolResultBlobReference;
}): string {
  // 这个块进入模型上下文；blob metadata 不能只留在 GUI 事件里，否则下一轮模型不知道完整输出已落盘。
  return [
    `<${AGENT_CORE_PERSISTED_TOOL_OUTPUT_TAG}>`,
    `toolName: ${args.call.name}`,
    `toolCallId: ${args.call.id}`,
    `keptChars: ${args.keptChars}`,
    `originalChars: ${args.originalChars}`,
    budgetLabel(args),
    `outputBlobPath: ${args.blob.outputBlobPath}`,
    `outputBlobBytes: ${args.blob.outputBlobBytes}`,
    "",
    "Preview:",
    args.preview.length === 0 ? "(no preview retained in this message)" : args.preview,
    `</${AGENT_CORE_PERSISTED_TOOL_OUTPUT_TAG}>`,
  ].join("\n");
}

async function storeOrReuseToolResultBlob(args: {
  call: AgentCoreToolCall;
  content: string;
  originalChars: number;
  result: AgentCoreToolResult;
  storeToolResultBlob?: AgentCoreToolResultBlobStore;
}): Promise<AgentCoreToolResultBlobReference | undefined> {
  const existing = existingToolResultBlob(args.result);
  if (existing !== undefined) {
    return existing;
  }
  return args.storeToolResultBlob === undefined
    ? undefined
    : await args.storeToolResultBlob({
        call: args.call,
        content: args.content,
        originalChars: args.originalChars,
      });
}

async function applySingleToolResultSizeLimit(args: {
  call: AgentCoreToolCall;
  result: AgentCoreToolResult;
  maxResultSizeChars?: number;
  storeToolResultBlob?: AgentCoreToolResultBlobStore;
}): Promise<AgentCoreToolResult> {
  if (
    args.maxResultSizeChars === undefined ||
    !Number.isFinite(args.maxResultSizeChars) ||
    args.result.content.length <= args.maxResultSizeChars
  ) {
    return args.result;
  }
  const keptChars = Math.max(0, args.maxResultSizeChars);
  const originalChars = originalToolResultChars(args.result);
  const preview = args.result.content.slice(0, keptChars);
  const blob = await storeOrReuseToolResultBlob({
    call: args.call,
    content: args.result.content,
    originalChars,
    result: args.result,
    storeToolResultBlob: args.storeToolResultBlob,
  });
  const content =
    blob === undefined
      ? `${preview}\n\n${budgetNotice({
          call: args.call,
          kind: "tool-result-max",
          maxChars: args.maxResultSizeChars,
          originalChars,
          keptChars,
        })}`
      : persistedToolOutputContent({
          call: args.call,
          kind: "tool-result-max",
          maxChars: args.maxResultSizeChars,
          originalChars,
          keptChars,
          preview,
          blob,
        });
  return {
    ...args.result,
    content,
    outputTruncated: true,
    outputOriginalChars: originalChars,
    outputMaxChars: keptChars,
    ...(blob === undefined
      ? {}
      : {
          outputBlobPath: blob.outputBlobPath,
          outputBlobBytes: blob.outputBlobBytes,
        }),
  };
}

// 同一 assistant turn 的工具结果共享预算，避免多个“不过单工具上限”的结果合起来打爆上下文。
export async function applyAgentCoreToolResultTurnBudget(args: {
  budget: AgentCoreToolResultTurnBudget;
  call: AgentCoreToolCall;
  result: AgentCoreToolResult;
  maxResultSizeChars?: number;
  storeToolResultBlob?: AgentCoreToolResultBlobStore;
}): Promise<AgentCoreToolResult> {
  const result = await applySingleToolResultSizeLimit({
    call: args.call,
    result: args.result,
    maxResultSizeChars: args.maxResultSizeChars,
    storeToolResultBlob: args.storeToolResultBlob,
  });
  if (!Number.isFinite(args.budget.maxChars)) {
    args.budget.usedChars += result.content.length;
    return result;
  }
  const originalChars = originalToolResultChars(result);
  const remainingChars = args.budget.maxChars - args.budget.usedChars;
  if (result.content.length <= remainingChars) {
    args.budget.usedChars += result.content.length;
    return result;
  }

  const keptChars = Math.max(0, remainingChars);
  const preview = result.content.slice(0, keptChars);
  const blob = await storeOrReuseToolResultBlob({
    call: args.call,
    content: result.content,
    originalChars,
    result,
    storeToolResultBlob: args.storeToolResultBlob,
  });
  const notice = budgetNotice({
    call: args.call,
    kind: "aggregate-turn",
    maxChars: args.budget.maxChars,
    originalChars,
    keptChars,
    blob,
  });
  const content =
    blob === undefined
      ? keptChars === 0
        ? notice
        : `${preview}\n\n${notice}`
      : persistedToolOutputContent({
          call: args.call,
          kind: "aggregate-turn",
          maxChars: args.budget.maxChars,
          originalChars,
          keptChars,
          preview,
          blob,
        });
  args.budget.usedChars += content.length;
  args.budget.truncatedResults += 1;
  return {
    ...result,
    content,
    outputTruncated: true,
    outputOriginalChars: originalChars,
    outputMaxChars: keptChars,
    ...(blob === undefined
      ? {}
      : {
          outputBlobPath: blob.outputBlobPath,
          outputBlobBytes: blob.outputBlobBytes,
        }),
  };
}
