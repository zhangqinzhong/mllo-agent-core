import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";
import type { AgentCoreToolCall } from "../tools/agent-core-tool-types";
import type { AgentCoreCompactRecord } from "../budget/agent-core-budget-types";
import type { AgentCoreJsonlSessionStore } from "./agent-core-jsonl-session-store";
import type { AgentCoreSessionEntry, AgentCoreSessionHandle } from "./agent-core-session-types";
import {
  createAgentCoreTranscriptResumeIndexWindow,
  rebuildAgentCoreTranscriptSideIndex,
  readAgentCoreTranscriptEntryAtOffset,
  readAgentCoreTranscriptSideIndex,
} from "./agent-core-transcript-side-index";

const DEFAULT_RESUME_HEAD_ENTRIES = 1;
const DEFAULT_RESUME_TAIL_ENTRIES = 1000;
const DEFAULT_INDEXED_RESUME_ENTRIES = 1000;
const DEFAULT_INDEXED_RESUME_BYTES = 4 * 1024 * 1024;

export type AgentCoreResumeResult = {
  messages: AgentCoreMessage[];
  repairedToolCallIds: string[];
  compactRecords: AgentCoreCompactRecord[];
  omittedResumableEntries: number;
  omittedResumableBytes: number;
};

type ResumeEntriesResult = {
  resumableEntries: AgentCoreSessionEntry[];
  compactEntries: AgentCoreSessionEntry[];
  omittedResumableEntries: number;
  omittedResumableBytes: number;
};

// 判断 entry 是否是可恢复进 queryLoop 的 message。timeline/hook/budget 只用于 UI 和审计。
function isMessageEntry(
  entry: AgentCoreSessionEntry,
): entry is Extract<AgentCoreSessionEntry, { kind: "message" }> {
  return entry.kind === "message";
}

// 判断 entry 是否是 compact 记录。resume 要知道历史是否已经被压缩过。
function isCompactRecordEntry(
  entry: AgentCoreSessionEntry,
): entry is Extract<AgentCoreSessionEntry, { kind: "compact-record" }> {
  return entry.kind === "compact-record";
}

// 找到最新 compact record 的位置。恢复时只读它之后的 message，避免旧上下文回流。
function latestCompactRecordIndex(entries: readonly AgentCoreSessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "compact-record") {
      return index;
    }
  }
  return -1;
}

// 旧 session 没有 side index 时，继续用 head/tail 窗口恢复，保持向后兼容。
async function readFallbackResumeEntries(args: {
  store: AgentCoreJsonlSessionStore;
  handle: AgentCoreSessionHandle;
  headEntries: number;
  tailEntries: number;
}): Promise<ResumeEntriesResult> {
  const window = await args.store.readSessionWindow(args.handle, {
    headEntries: args.headEntries,
    tailEntries: args.tailEntries,
  });
  const entries = [...window.head, ...window.tail];
  const compactIndex = latestCompactRecordIndex(entries);
  return {
    resumableEntries: compactIndex >= 0 ? entries.slice(compactIndex + 1) : entries,
    compactEntries: entries.filter(isCompactRecordEntry),
    omittedResumableEntries: 0,
    omittedResumableBytes: 0,
  };
}

// 新 session 用 side index 精确定位 latest compact，并按预算裁剪后续 entry。
async function readIndexedResumeEntries(
  handle: AgentCoreSessionHandle,
  options: {
    maxIndexedResumeEntries: number;
    maxIndexedResumeBytes: number;
  },
): Promise<ResumeEntriesResult | undefined> {
  const indexEntries = await readAgentCoreTranscriptSideIndex(handle.transcriptPath);
  if (indexEntries.length === 0) {
    return undefined;
  }
  const window = createAgentCoreTranscriptResumeIndexWindow(indexEntries, {
    maxIndexedResumeEntries: options.maxIndexedResumeEntries,
    maxIndexedResumeBytes: options.maxIndexedResumeBytes,
  });
  const [compactEntries, resumableEntries] = await Promise.all([
    Promise.all(
      window.compactEntries.map((entry) =>
        readAgentCoreTranscriptEntryAtOffset({
          transcriptPath: handle.transcriptPath,
          indexEntry: entry,
        }),
      ),
    ),
    Promise.all(
      window.resumableEntries.map((entry) =>
        readAgentCoreTranscriptEntryAtOffset({
          transcriptPath: handle.transcriptPath,
          indexEntry: entry,
        }),
      ),
    ),
  ]);
  return {
    compactEntries,
    resumableEntries,
    omittedResumableEntries: window.omittedResumableEntries,
    omittedResumableBytes: window.omittedResumableBytes,
  };
}

// side index 是派生缓存。缺失或损坏时从 transcript 重建一次，再走精确 offset 恢复。
async function readIndexedOrRebuiltResumeEntries(
  handle: AgentCoreSessionHandle,
  options: {
    maxIndexedResumeEntries: number;
    maxIndexedResumeBytes: number;
  },
): Promise<ResumeEntriesResult | undefined> {
  try {
    const indexed = await readIndexedResumeEntries(handle, options);
    if (indexed !== undefined) {
      return indexed;
    }
  } catch {
    // 继续走重建路径。索引坏了不应该阻断会话恢复，transcript 才是事实来源。
  }

  await rebuildAgentCoreTranscriptSideIndex(handle.transcriptPath);
  return await readIndexedResumeEntries(handle, options);
}

// 构造恢复裁剪边界消息。模型必须知道 compact 后还有一段 tail 被预算省略。
function createResumeBoundaryMessage(args: {
  omittedEntries: number;
  omittedBytes: number;
}): AgentCoreMessage | undefined {
  if (args.omittedEntries === 0 && args.omittedBytes === 0) {
    return undefined;
  }
  return {
    role: "user",
    content: [
      "<mllo_resume_boundary>",
      "reason: indexed resume budget omitted older post-compact transcript entries",
      `omittedEntries: ${args.omittedEntries}`,
      `omittedBytes: ${args.omittedBytes}`,
      "note: Earlier post-compact entries are not present in this recovered context. Use compact summaries and memory for older facts; do not assume the visible tail is the full session history.",
      "</mllo_resume_boundary>",
    ].join("\n"),
  };
}

// 判断恢复窗口里是否已经有 compact 上下文消息，避免重复给模型塞两份摘要。
function hasExistingCompactContextMessage(messages: readonly AgentCoreMessage[]): boolean {
  const firstMessage = messages[0];
  return (
    firstMessage?.role === "user" &&
    (firstMessage.content.includes("<mllo_context_summary>") ||
      firstMessage.content.includes("<mllo_context_collapse>"))
  );
}

// 渲染 compact 预算统计。恢复时知道哪些内容被裁剪过，模型才不会把摘要当完整日志。
function renderCompactBudgetState(record: AgentCoreCompactRecord): string[] {
  if (record.budgetState === undefined) {
    return [];
  }
  return [
    "",
    "# Compact Budget State",
    `estimatedInputTokens: ${record.budgetState.estimatedInputTokens}`,
    `toolResultsCompacted: ${record.budgetState.toolResultsCompacted ?? 0}`,
    `microCompactedToolResults: ${record.budgetState.microCompactedToolResults ?? 0}`,
    `toolCallInputsCompacted: ${record.budgetState.toolCallInputsCompacted ?? 0}`,
  ];
}

// 从 compact record 构造恢复摘要消息。没有这条消息，resume 后模型只能看到被裁剪后的 tail。
function createCompactSummaryResumeMessage(record: AgentCoreCompactRecord): AgentCoreMessage {
  return {
    role: "user",
    content: [
      "<mllo_context_summary>",
      "# Compact Boundary",
      `compactId: ${record.boundary.id}`,
      `createdAt: ${record.boundary.createdAt}`,
      `originalMessageCount: ${record.boundary.originalMessageCount}`,
      `retainedMessageCount: ${record.boundary.retainedMessageCount}`,
      `summarizedMessageCount: ${record.boundary.summarizedMessageCount}`,
      ...renderCompactBudgetState(record),
      "",
      "# Compact Summary",
      record.summary,
      "",
      "# Resume Note",
      "Messages after this summary are the exact post-compact transcript tail.",
      "</mllo_context_summary>",
    ].join("\n"),
  };
}

// 恢复时自动带上最新 compact 摘要。compact record 是审计数据，模型需要的是 message 形态。
function createCompactSummaryResumeMessages(args: {
  compactRecords: readonly AgentCoreCompactRecord[];
  resumableMessages: readonly AgentCoreMessage[];
}): AgentCoreMessage[] {
  const latestCompactRecord = args.compactRecords.at(-1);
  if (
    latestCompactRecord === undefined ||
    hasExistingCompactContextMessage(args.resumableMessages)
  ) {
    return [];
  }
  return [createCompactSummaryResumeMessage(latestCompactRecord)];
}

// 收集已经有结果的 tool_call id。恢复时要避免重复补同一个结果。
function completedToolCallIds(messages: readonly AgentCoreMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      ids.add(message.toolCallId);
    }
  }
  return ids;
}

// 收集历史里所有 assistant 发出的 tool call。resume 时也要保证这些 call 都有结果。
function assistantToolCalls(messages: readonly AgentCoreMessage[]): AgentCoreToolCall[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") {
      return [];
    }
    return message.toolCalls ?? [];
  });
}

// 创建恢复时的 synthetic tool message。这样下一轮模型不会看到悬空 tool_use。
function createInterruptedToolMessage(call: AgentCoreToolCall): AgentCoreMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: "Recovered interrupted session: tool call did not complete before shutdown.",
    isError: true,
  };
}

// 修复中断产生的悬空 tool call。返回新数组，避免改动读取出来的原始历史。
export function repairInterruptedAgentCoreMessages(
  messages: readonly AgentCoreMessage[],
): AgentCoreResumeResult {
  const repaired = [...messages];
  const completedIds = completedToolCallIds(repaired);
  const repairedToolCallIds: string[] = [];

  for (const call of assistantToolCalls(repaired)) {
    if (completedIds.has(call.id)) {
      continue;
    }
    repaired.push(createInterruptedToolMessage(call));
    completedIds.add(call.id);
    repairedToolCallIds.push(call.id);
  }

  return {
    messages: repaired,
    repairedToolCallIds,
    compactRecords: [],
    omittedResumableEntries: 0,
    omittedResumableBytes: 0,
  };
}

// 从 JSONL session 恢复 queryLoop 消息。第一版只恢复消息链，timeline 仍由 GUI 单独读取。
export async function resumeAgentCoreSession(args: {
  store: AgentCoreJsonlSessionStore;
  handle: AgentCoreSessionHandle;
  headEntries?: number;
  tailEntries?: number;
  maxIndexedResumeEntries?: number;
  maxIndexedResumeBytes?: number;
}): Promise<AgentCoreResumeResult> {
  const indexed =
    (await readIndexedOrRebuiltResumeEntries(args.handle, {
      maxIndexedResumeEntries: args.maxIndexedResumeEntries ?? DEFAULT_INDEXED_RESUME_ENTRIES,
      maxIndexedResumeBytes: args.maxIndexedResumeBytes ?? DEFAULT_INDEXED_RESUME_BYTES,
    })) ??
    (await readFallbackResumeEntries({
      store: args.store,
      handle: args.handle,
      headEntries: args.headEntries ?? DEFAULT_RESUME_HEAD_ENTRIES,
      tailEntries: args.tailEntries ?? DEFAULT_RESUME_TAIL_ENTRIES,
    }));
  const { compactEntries, resumableEntries, omittedResumableEntries, omittedResumableBytes } =
    indexed;
  const boundary = createResumeBoundaryMessage({
    omittedEntries: omittedResumableEntries,
    omittedBytes: omittedResumableBytes,
  });
  const compactRecords = compactEntries.filter(isCompactRecordEntry).map((entry) => entry.record);
  const resumableMessages = resumableEntries.filter(isMessageEntry).map((entry) => entry.message);
  const compactSummaryMessages = createCompactSummaryResumeMessages({
    compactRecords,
    resumableMessages,
  });
  const messages = [
    ...(boundary === undefined ? [] : [boundary]),
    ...compactSummaryMessages,
    ...resumableMessages,
  ];
  const repaired = repairInterruptedAgentCoreMessages(messages);
  return {
    ...repaired,
    compactRecords,
    omittedResumableEntries,
    omittedResumableBytes,
  };
}
