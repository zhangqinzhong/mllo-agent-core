import type {
  AgentCoreToolCall,
  AgentCoreToolErrorKind,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";
import type { AgentCoreModelAdapter } from "./agent-core-query-types";

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
  labelSource: "model" | "deterministic";
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

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = [
  "Write a short summary label describing what these tool calls accomplished.",
  "It appears as a single-line row and truncates around 30 characters, so think git-commit-subject, not sentence.",
  "Keep the verb in past tense and the most distinctive noun.",
  "Drop articles, connectors, and long location context first.",
  "",
  "Examples:",
  "- Searched in auth/",
  "- Fixed NPE in UserService",
  "- Created signup endpoint",
  "- Read config.json",
  "- Ran failing tests",
].join("\n");

const TOOL_SUMMARY_JSON_PREVIEW_CHARS = 300;

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

function truncateJson(value: unknown, maxLength: number): string {
  try {
    const text = JSON.stringify(value) ?? "undefined";
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
  } catch {
    return "[unable to serialize]";
  }
}

function toolSummaryModelPromptItem(item: AgentCoreToolBatchCompletedItem): string {
  return [
    `Tool: ${item.call.name}`,
    `Input: ${truncateJson(item.call.input, TOOL_SUMMARY_JSON_PREVIEW_CHARS)}`,
    `Output: ${truncateJson(item.result.content, TOOL_SUMMARY_JSON_PREVIEW_CHARS)}`,
  ].join("\n");
}

function createToolSummaryModelPrompt(args: {
  completedItems: readonly AgentCoreToolBatchCompletedItem[];
  lastAssistantText?: string;
}): string {
  const contextPrefix =
    args.lastAssistantText === undefined || args.lastAssistantText.length === 0
      ? ""
      : `User's intent (from assistant's last message): ${args.lastAssistantText.slice(0, 200)}\n\n`;
  return [
    `${contextPrefix}Tools completed:`,
    "",
    args.completedItems.map(toolSummaryModelPromptItem).join("\n\n"),
    "",
    "Label:",
  ].join("\n");
}

function normalizeModelLabel(label: string): string | undefined {
  const normalized = label.trim().replace(/\s+/g, " ");
  return normalized.length === 0 ? undefined : normalized.slice(0, 120);
}

// 模型摘要是展示辅助信息，失败时不能影响主工具闭环。
async function generateModelToolBatchLabel(args: {
  completedItems: readonly AgentCoreToolBatchCompletedItem[];
  model?: AgentCoreModelAdapter;
  signal?: AbortSignal;
  lastAssistantText?: string;
}): Promise<string | undefined> {
  const complete = args.model?.complete;
  if (complete === undefined) {
    return undefined;
  }
  try {
    const response = await complete({
      systemPrompt: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: createToolSummaryModelPrompt({
            completedItems: args.completedItems,
            lastAssistantText: args.lastAssistantText,
          }),
        },
      ],
      tools: [],
      signal: args.signal,
    });
    return normalizeModelLabel(response.content);
  } catch {
    return undefined;
  }
}

// 批次摘要事件只记录最终 label 和元数据，不把摘要模型看到的 input/output 再写进 timeline。
export async function createAgentCoreToolBatchSummary(args: {
  completedItems: readonly AgentCoreToolBatchCompletedItem[];
  model?: AgentCoreModelAdapter;
  signal?: AbortSignal;
  lastAssistantText?: string;
}): Promise<AgentCoreToolBatchSummary | undefined> {
  const completedItems = args.completedItems;
  if (completedItems.length === 0) {
    return undefined;
  }
  const items = completedItems.map(createSummaryItem);
  const errorCount = items.filter((item) => item.status === "error").length;
  const truncatedCount = items.filter((item) => item.outputTruncated === true).length;
  const modelLabel = await generateModelToolBatchLabel({
    completedItems,
    model: args.model,
    signal: args.signal,
    lastAssistantText: args.lastAssistantText,
  });
  return {
    label:
      modelLabel ??
      createSummaryLabel({
        items,
        errorCount,
        truncatedCount,
      }),
    labelSource: modelLabel === undefined ? "deterministic" : "model",
    toolCallIds: items.map((item) => item.toolCallId),
    items,
    okCount: items.length - errorCount,
    errorCount,
    truncatedCount,
  };
}
