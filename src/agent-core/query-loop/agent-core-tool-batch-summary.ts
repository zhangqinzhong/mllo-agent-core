import type {
  AgentCoreToolCall,
  AgentCoreToolErrorKind,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";

export type AgentCoreToolBatchSummaryItem = {
  toolCallId: string;
  toolName: string;
  status: "ok" | "error";
  errorKind?: AgentCoreToolErrorKind;
  outputTruncated?: boolean;
  outputOriginalChars?: number;
  outputMaxChars?: number;
  outputBlobPath?: string;
  outputBlobBytes?: number;
};

export type AgentCoreToolBatchSummary = {
  label: string;
  toolCallIds: string[];
  items: AgentCoreToolBatchSummaryItem[];
  okCount: number;
  errorCount: number;
  truncatedCount: number;
};

export type AgentCoreToolBatchCompletedItem = {
  call: AgentCoreToolCall;
  result: AgentCoreToolResult;
};

function uniqueToolNames(items: readonly AgentCoreToolBatchSummaryItem[]): string[] {
  return [...new Set(items.map((item) => item.toolName))];
}

function toolNameList(items: readonly AgentCoreToolBatchSummaryItem[]): string {
  const names = uniqueToolNames(items).slice(0, 3);
  const overflow = uniqueToolNames(items).length - names.length;
  return `${names.join(", ")}${overflow > 0 ? ` +${overflow}` : ""}`;
}

function createSummaryLabel(args: {
  items: readonly AgentCoreToolBatchSummaryItem[];
  errorCount: number;
  truncatedCount: number;
}): string {
  if (args.items.length === 1) {
    const item = args.items[0]!;
    const status = item.status === "ok" ? "completed" : "failed";
    const truncated = item.outputTruncated === true ? " with truncated output" : "";
    return `${item.toolName} ${status}${truncated}`;
  }
  const suffixes = [
    args.errorCount > 0 ? `${args.errorCount} failed` : undefined,
    args.truncatedCount > 0 ? `${args.truncatedCount} truncated` : undefined,
  ].filter((suffix): suffix is string => suffix !== undefined);
  const suffix = suffixes.length === 0 ? "" : ` (${suffixes.join(", ")})`;
  return `Ran ${args.items.length} tools: ${toolNameList(args.items)}${suffix}`;
}

function createSummaryItem(item: AgentCoreToolBatchCompletedItem): AgentCoreToolBatchSummaryItem {
  return {
    toolCallId: item.call.id,
    toolName: item.call.name,
    status: item.result.isError === true ? "error" : "ok",
    ...(item.result.errorKind === undefined ? {} : { errorKind: item.result.errorKind }),
    ...(item.result.outputTruncated === undefined
      ? {}
      : { outputTruncated: item.result.outputTruncated }),
    ...(item.result.outputOriginalChars === undefined
      ? {}
      : { outputOriginalChars: item.result.outputOriginalChars }),
    ...(item.result.outputMaxChars === undefined
      ? {}
      : { outputMaxChars: item.result.outputMaxChars }),
    ...(item.result.outputBlobPath === undefined
      ? {}
      : { outputBlobPath: item.result.outputBlobPath }),
    ...(item.result.outputBlobBytes === undefined
      ? {}
      : { outputBlobBytes: item.result.outputBlobBytes }),
  };
}

// 批次摘要只记录元数据，不复制工具输入或输出，避免 observability 反向放大敏感信息。
export function createAgentCoreToolBatchSummary(
  completedItems: readonly AgentCoreToolBatchCompletedItem[],
): AgentCoreToolBatchSummary | undefined {
  if (completedItems.length === 0) {
    return undefined;
  }
  const items = completedItems.map(createSummaryItem);
  const errorCount = items.filter((item) => item.status === "error").length;
  const truncatedCount = items.filter((item) => item.outputTruncated === true).length;
  return {
    label: createSummaryLabel({
      items,
      errorCount,
      truncatedCount,
    }),
    toolCallIds: items.map((item) => item.toolCallId),
    items,
    okCount: items.length - errorCount,
    errorCount,
    truncatedCount,
  };
}
