import type { AgentCoreToolCall, AgentCoreToolResult } from "../tools/agent-core-tool-types";
import type { AgentCoreToolResultBlobStore } from "./agent-core-query-types";

export const AGENT_CORE_TOOL_RESULTS_PER_TURN_MAX_CHARS = 200_000;

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

function aggregateBudgetNotice(args: {
  call: AgentCoreToolCall;
  maxChars: number;
  originalChars: number;
  keptChars: number;
}): string {
  return [
    `[tool result truncated by aggregate turn budget for ${args.call.name}]`,
    `keptChars: ${args.keptChars}`,
    `originalChars: ${args.originalChars}`,
    `turnBudgetChars: ${args.maxChars}`,
    "Run a narrower command/read/search if more output is needed.",
  ].join("\n");
}

// 同一 assistant turn 的工具结果共享预算，避免多个“不过单工具上限”的结果合起来打爆上下文。
export async function applyAgentCoreToolResultTurnBudget(args: {
  budget: AgentCoreToolResultTurnBudget;
  call: AgentCoreToolCall;
  result: AgentCoreToolResult;
  storeToolResultBlob?: AgentCoreToolResultBlobStore;
}): Promise<AgentCoreToolResult> {
  if (!Number.isFinite(args.budget.maxChars)) {
    args.budget.usedChars += args.result.content.length;
    return args.result;
  }
  const originalChars = originalToolResultChars(args.result);
  const remainingChars = args.budget.maxChars - args.budget.usedChars;
  if (args.result.content.length <= remainingChars) {
    args.budget.usedChars += args.result.content.length;
    return args.result;
  }

  const keptChars = Math.max(0, remainingChars);
  const notice = aggregateBudgetNotice({
    call: args.call,
    maxChars: args.budget.maxChars,
    originalChars,
    keptChars,
  });
  const content =
    keptChars === 0 ? notice : `${args.result.content.slice(0, keptChars)}\n\n${notice}`;
  const blob =
    args.storeToolResultBlob === undefined
      ? undefined
      : await args.storeToolResultBlob({
          call: args.call,
          content: args.result.content,
          originalChars,
        });
  args.budget.usedChars += content.length;
  args.budget.truncatedResults += 1;
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
