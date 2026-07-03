import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";
import { repairAgentCoreToolResultPairing } from "../query-loop/agent-core-tool-result-pairing";
import type { AgentCoreCompactRecord } from "../budget/agent-core-budget-types";
import type { AgentCoreJsonlSessionStore } from "./agent-core-jsonl-session-store";
import type { AgentCoreSessionEntry, AgentCoreSessionHandle } from "./agent-core-session-types";
import {
  createAgentCoreTranscriptResumeIndexWindow,
  readAgentCoreTranscriptEntryAtOffset,
  readAgentCoreTranscriptSideIndex,
  type AgentCoreTranscriptSideIndexEntry,
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
  consistency?: AgentCoreResumeConsistency;
};

export type AgentCoreResumeConsistency = {
  expectedMessageCount: number;
  actualMessageCount: number;
  delta: number;
  checkpointAgeEntries: number;
  checkpointUuid: string;
  checkpointTimestamp: string;
};

type ResumeEntriesResult = {
  resumableEntries: AgentCoreSessionEntry[];
  compactEntries: AgentCoreSessionEntry[];
  omittedResumableEntries: number;
  omittedResumableBytes: number;
  checkpointEntry?: AgentCoreMessageCountCheckpointEntry;
  checkpointAgeEntries: number;
};

type AgentCoreMessageCountCheckpointEntry = Extract<
  AgentCoreSessionEntry,
  { kind: "budget-event" }
> & {
  messageCount: number;
};

type AgentCoreMessageEntry = Extract<AgentCoreSessionEntry, { kind: "message" }>;

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

function isMessageCountCheckpointEntry(
  entry: AgentCoreSessionEntry,
): entry is AgentCoreMessageCountCheckpointEntry {
  return entry.kind === "budget-event" && typeof entry.messageCount === "number";
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

function latestMessageCountCheckpoint(entries: readonly AgentCoreSessionEntry[]):
  | {
      entry: AgentCoreMessageCountCheckpointEntry;
      checkpointAgeEntries: number;
    }
  | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && isMessageCountCheckpointEntry(entry)) {
      return {
        entry,
        checkpointAgeEntries: entries.length - 1 - index,
      };
    }
  }
  return undefined;
}

function latestMessageCountCheckpointIndexEntry(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
):
  | {
      entry: AgentCoreTranscriptSideIndexEntry;
      checkpointAgeEntries: number;
    }
  | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.entryKind === "budget-event") {
      return {
        entry,
        checkpointAgeEntries: entries.length - 1 - index,
      };
    }
  }
  return undefined;
}

function firstMessageEntry(
  entries: readonly AgentCoreSessionEntry[],
): AgentCoreMessageEntry | undefined {
  return entries.find(isMessageEntry);
}

function startsAtSafeFallbackBoundary(args: {
  tailEntries: readonly AgentCoreSessionEntry[];
  omittedEntries: number;
}): boolean {
  const firstMessage = firstMessageEntry(args.tailEntries);
  if (firstMessage === undefined || args.omittedEntries === 0) {
    return true;
  }
  if (firstMessage.message.role === "user") {
    return true;
  }
  return (
    firstMessage.message.role === "assistant" && (firstMessage.message.toolCalls?.length ?? 0) > 0
  );
}

async function readFallbackResumeWindow(args: {
  store: AgentCoreJsonlSessionStore;
  handle: AgentCoreSessionHandle;
  headEntries: number;
  tailEntries: number;
}) {
  let tailEntries = args.tailEntries;
  while (true) {
    const window = await args.store.readSessionWindow(args.handle, {
      headEntries: args.headEntries,
      tailEntries,
    });
    if (
      startsAtSafeFallbackBoundary({
        tailEntries: window.tail,
        omittedEntries: window.omittedEntries,
      })
    ) {
      return window;
    }
    const maxTailEntries = Math.max(
      0,
      window.totalEntries - Math.min(args.headEntries, window.totalEntries),
    );
    const nextTailEntries = Math.min(maxTailEntries, Math.max(tailEntries + 1, tailEntries * 2));
    if (nextTailEntries <= tailEntries) {
      return window;
    }
    tailEntries = nextTailEntries;
  }
}

// 旧 session 没有 side index 时，继续用 head/tail 窗口恢复，保持向后兼容。
async function readFallbackResumeEntries(args: {
  store: AgentCoreJsonlSessionStore;
  handle: AgentCoreSessionHandle;
  headEntries: number;
  tailEntries: number;
}): Promise<ResumeEntriesResult> {
  const window = await readFallbackResumeWindow(args);
  const entries = [...window.head, ...window.tail];
  const compactIndex = latestCompactRecordIndex(entries);
  const checkpoint = latestMessageCountCheckpoint(entries);
  return {
    resumableEntries: compactIndex >= 0 ? entries.slice(compactIndex + 1) : entries,
    compactEntries: entries.filter(isCompactRecordEntry),
    omittedResumableEntries: window.omittedEntries,
    // 旧 JSONL fallback 没有 side index，无法可靠计算被省略 entry 的字节数。
    omittedResumableBytes: 0,
    ...(checkpoint === undefined
      ? {}
      : {
          checkpointEntry: checkpoint.entry,
        }),
    checkpointAgeEntries: checkpoint?.checkpointAgeEntries ?? 0,
  };
}

async function readIndexedMessageCountCheckpoint(args: {
  handle: AgentCoreSessionHandle;
  indexEntries: readonly AgentCoreTranscriptSideIndexEntry[];
}): Promise<
  | {
      entry: AgentCoreMessageCountCheckpointEntry;
      checkpointAgeEntries: number;
    }
  | undefined
> {
  const checkpoint = latestMessageCountCheckpointIndexEntry(args.indexEntries);
  if (checkpoint === undefined) {
    return undefined;
  }
  const entry = await readAgentCoreTranscriptEntryAtOffset({
    transcriptPath: args.handle.transcriptPath,
    indexEntry: checkpoint.entry,
  });
  if (!isMessageCountCheckpointEntry(entry)) {
    return undefined;
  }
  return {
    entry,
    checkpointAgeEntries: checkpoint.checkpointAgeEntries,
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
  const checkpoint = await readIndexedMessageCountCheckpoint({
    handle,
    indexEntries,
  });
  return {
    compactEntries,
    resumableEntries,
    omittedResumableEntries: window.omittedResumableEntries,
    omittedResumableBytes: window.omittedResumableBytes,
    ...(checkpoint === undefined
      ? {}
      : {
          checkpointEntry: checkpoint.entry,
        }),
    checkpointAgeEntries: checkpoint?.checkpointAgeEntries ?? 0,
  };
}

function createResumeConsistency(args: {
  checkpointEntry?: AgentCoreMessageCountCheckpointEntry;
  checkpointAgeEntries: number;
  actualMessageCount: number;
}): AgentCoreResumeConsistency | undefined {
  if (args.checkpointEntry === undefined) {
    return undefined;
  }
  return {
    expectedMessageCount: args.checkpointEntry.messageCount,
    actualMessageCount: args.actualMessageCount,
    delta: args.actualMessageCount - args.checkpointEntry.messageCount,
    checkpointAgeEntries: args.checkpointAgeEntries,
    checkpointUuid: args.checkpointEntry.uuid,
    checkpointTimestamp: args.checkpointEntry.timestamp,
  };
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
      "reason: resume budget omitted older transcript entries",
      `omittedEntries: ${args.omittedEntries}`,
      `omittedBytes: ${args.omittedBytes}`,
      "note: Earlier entries are not present in this recovered context. Use compact summaries and memory for older facts; do not assume the visible tail is the full session history.",
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

// 修复中断产生的悬空 tool call。返回新数组，避免改动读取出来的原始历史。
export function repairInterruptedAgentCoreMessages(
  messages: readonly AgentCoreMessage[],
): AgentCoreResumeResult {
  const repaired = repairAgentCoreToolResultPairing({
    messages,
    reason: "Recovered interrupted session: tool call did not complete before shutdown.",
  });

  return {
    messages: repaired.messages,
    repairedToolCallIds: repaired.repairedToolCallIds,
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
    (await readIndexedResumeEntries(args.handle, {
      maxIndexedResumeEntries: args.maxIndexedResumeEntries ?? DEFAULT_INDEXED_RESUME_ENTRIES,
      maxIndexedResumeBytes: args.maxIndexedResumeBytes ?? DEFAULT_INDEXED_RESUME_BYTES,
    })) ??
    (await readFallbackResumeEntries({
      store: args.store,
      handle: args.handle,
      headEntries: args.headEntries ?? DEFAULT_RESUME_HEAD_ENTRIES,
      tailEntries: args.tailEntries ?? DEFAULT_RESUME_TAIL_ENTRIES,
    }));
  const {
    compactEntries,
    resumableEntries,
    omittedResumableEntries,
    omittedResumableBytes,
    checkpointEntry,
    checkpointAgeEntries,
  } = indexed;
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
  const consistency = createResumeConsistency({
    checkpointEntry,
    checkpointAgeEntries,
    actualMessageCount: repaired.messages.length,
  });
  return {
    ...repaired,
    compactRecords,
    omittedResumableEntries,
    omittedResumableBytes,
    ...(consistency === undefined ? {} : { consistency }),
  };
}
