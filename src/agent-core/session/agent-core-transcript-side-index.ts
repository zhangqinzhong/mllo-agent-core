import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentCoreSessionEntry, AgentCoreSessionEntryKind } from "./agent-core-session-types";
export {
  readAgentCoreTranscriptEntriesAtOffsets,
  readAgentCoreTranscriptEntryAtOffset,
} from "./agent-core-transcript-offset-reader";

export type AgentCoreTranscriptSideIndexEntry = {
  kind: "transcript-index-entry";
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  entryUuid: string;
  entryTimestamp: string;
  entryKind: AgentCoreSessionEntryKind;
  byteOffset: number;
  byteLength: number;
  compactId?: string;
  messageRole?: "user" | "assistant" | "tool";
  toolCallId?: string;
  toolCallIds?: string[];
  eventType?: string;
  permissionSource?: "tool" | "worker";
  workerId?: string;
};

export type AgentCoreTranscriptSideIndexResumeWindow = {
  compactEntries: AgentCoreTranscriptSideIndexEntry[];
  resumableEntries: AgentCoreTranscriptSideIndexEntry[];
  omittedResumableEntries: number;
  omittedResumableBytes: number;
};

export type AgentCoreTranscriptResumeIndexWindowPolicy = {
  maxIndexedResumeEntries?: number;
  maxIndexedResumeBytes?: number;
};

// side index 和 transcript 同目录同名，后续可以按 offset 精确跳读原始 JSONL。
export function getAgentCoreTranscriptSideIndexPath(transcriptPath: string): string {
  return `${transcriptPath}.index.jsonl`;
}

// 提取 assistant tool call ids。恢复权限暂停和工具补偿时，这些 id 是关键索引字段。
function getToolCallIds(entry: AgentCoreSessionEntry): string[] | undefined {
  if (entry.kind !== "message" || entry.message.role !== "assistant") {
    return undefined;
  }
  const ids = entry.message.toolCalls?.map((call) => call.id) ?? [];
  return ids.length === 0 ? undefined : ids;
}

// 提取单个 tool result id。它和 assistant toolCallIds 配对，用于发现悬空工具调用。
function getToolCallId(entry: AgentCoreSessionEntry): string | undefined {
  if (entry.kind === "message" && entry.message.role === "tool") {
    return entry.message.toolCallId;
  }
  return entry.kind === "elicitation-event" ? entry.call.id : undefined;
}

// 提取 compact id。以后恢复可以直接找到最新 compact offset，不必扫描完整 transcript。
function getCompactId(entry: AgentCoreSessionEntry): string | undefined {
  return entry.kind === "compact-record" ? entry.record.boundary.id : undefined;
}

// 提取 timeline 事件类型。GUI replay 可以先看索引再决定是否读取完整事件内容。
function getEventType(entry: AgentCoreSessionEntry): string | undefined {
  if (entry.kind === "timeline-event") {
    return entry.event.type;
  }
  if (entry.kind === "elicitation-event") {
    return `elicitation-${entry.response.status}`;
  }
  if (entry.kind === "checkpoint-restore-event") {
    return "checkpoint-restore";
  }
  if (entry.kind === "worker-tool-event") {
    return "worker-tool-use";
  }
  if (entry.kind === "worker-tool-result-event") {
    return entry.result.isError === true ? "worker-tool-error" : "worker-tool-result";
  }
  return undefined;
}

// 提取权限来源。worker/tool permission 分开索引，便于恢复审批状态。
function getPermissionSource(entry: AgentCoreSessionEntry): "tool" | "worker" | undefined {
  if (entry.kind !== "permission-event") {
    return undefined;
  }
  return entry.source ?? "tool";
}

// 把 transcript entry 投影成轻量索引记录。索引只存定位和关键字段，不复制完整消息。
export function createAgentCoreTranscriptSideIndexEntry(args: {
  transcriptPath: string;
  entry: AgentCoreSessionEntry;
  byteOffset: number;
  byteLength: number;
}): AgentCoreTranscriptSideIndexEntry {
  return {
    kind: "transcript-index-entry",
    sessionId: args.entry.sessionId,
    cwd: args.entry.cwd,
    transcriptPath: args.transcriptPath,
    entryUuid: args.entry.uuid,
    entryTimestamp: args.entry.timestamp,
    entryKind: args.entry.kind,
    byteOffset: args.byteOffset,
    byteLength: args.byteLength,
    compactId: getCompactId(args.entry),
    messageRole: args.entry.kind === "message" ? args.entry.message.role : undefined,
    toolCallId: getToolCallId(args.entry),
    toolCallIds: getToolCallIds(args.entry),
    eventType: getEventType(args.entry),
    permissionSource: getPermissionSource(args.entry),
    workerId: getWorkerId(args.entry),
  };
}

// workerId 单独索引，GUI 和审计可以不读取完整 payload 就定位第三方 agent 事件。
function getWorkerId(entry: AgentCoreSessionEntry): string | undefined {
  if (entry.kind === "permission-event" && entry.source === "worker") {
    return entry.workerId;
  }
  if (entry.kind === "worker-tool-event") {
    return entry.tool.workerId;
  }
  if (entry.kind === "worker-tool-result-event") {
    return entry.result.workerId;
  }
  return undefined;
}

// 追加一条 side index。它是派生索引，事实仍以 transcript JSONL 为准。
export async function appendAgentCoreTranscriptSideIndexEntry(args: {
  transcriptPath: string;
  entry: AgentCoreSessionEntry;
  byteOffset: number;
  byteLength: number;
}): Promise<void> {
  const indexPath = getAgentCoreTranscriptSideIndexPath(args.transcriptPath);
  await mkdir(dirname(indexPath), {
    recursive: true,
  });
  await appendFile(
    indexPath,
    `${JSON.stringify(createAgentCoreTranscriptSideIndexEntry(args))}\n`,
    "utf8",
  );
}

// 判断一行 JSON 是否是 side index 记录。索引损坏要尽早报错，不能静默跳过。
function isTranscriptSideIndexEntry(value: unknown): value is AgentCoreTranscriptSideIndexEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "transcript-index-entry" &&
    "entryUuid" in value &&
    typeof value.entryUuid === "string" &&
    "entryKind" in value &&
    typeof value.entryKind === "string" &&
    "byteOffset" in value &&
    typeof value.byteOffset === "number" &&
    "byteLength" in value &&
    typeof value.byteLength === "number"
  );
}

// 解析 side index 单行。报错带 lineNumber，方便用户定位损坏的索引文件。
function parseSideIndexLine(line: string, lineNumber: number): AgentCoreTranscriptSideIndexEntry {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isTranscriptSideIndexEntry(value)) {
      throw new Error("entry is not a transcript side index record");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Agent Core transcript side index at line ${lineNumber}: ${message}`);
  }
}

// 读取 side index。缺失时返回空数组，兼容旧 session。
export async function readAgentCoreTranscriptSideIndex(
  transcriptPath: string,
): Promise<AgentCoreTranscriptSideIndexEntry[]> {
  const indexPath = getAgentCoreTranscriptSideIndexPath(transcriptPath);
  let content: string;
  try {
    content = await readFile(indexPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => parseSideIndexLine(line, index + 1));
}

// 找到最新 compact 记录对应的索引。没有 compact 时返回 undefined。
export function findLatestAgentCoreCompactIndexEntry(
  indexEntries: readonly AgentCoreTranscriptSideIndexEntry[],
): AgentCoreTranscriptSideIndexEntry | undefined {
  for (let index = indexEntries.length - 1; index >= 0; index -= 1) {
    const entry = indexEntries[index];
    if (entry?.entryKind === "compact-record") {
      return entry;
    }
  }
  return undefined;
}

// 判断 side index entry 是否应该进入 queryLoop 恢复窗口。非 message 只用于 GUI/审计。
function isResumableMessageIndexEntry(entry: AgentCoreTranscriptSideIndexEntry): boolean {
  return entry.entryKind === "message";
}

function entryHasToolCallId(entry: AgentCoreTranscriptSideIndexEntry, toolCallId: string): boolean {
  return entry.toolCallIds?.includes(toolCallId) ?? false;
}

function findAssistantToolCallEntryIndex(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
  toolResultIndex: number,
): number | undefined {
  const toolResult = entries[toolResultIndex];
  if (toolResult?.messageRole !== "tool" || toolResult.toolCallId === undefined) {
    return undefined;
  }
  for (let index = toolResultIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.messageRole === "user") {
      return undefined;
    }
    if (entry.messageRole === "assistant" && entryHasToolCallId(entry, toolResult.toolCallId)) {
      return index;
    }
  }
  return undefined;
}

function findAssistantToolCallEntryIndexForFollowupAssistant(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
  assistantIndex: number,
): number | undefined {
  if (entries[assistantIndex]?.messageRole !== "assistant") {
    return undefined;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.messageRole !== "tool") {
      break;
    }
    const toolCallIndex = findAssistantToolCallEntryIndex(entries, index);
    if (toolCallIndex !== undefined) {
      return toolCallIndex;
    }
  }
  return undefined;
}

function findToolTrajectoryStartEntryIndex(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
  index: number,
): number | undefined {
  const entry = entries[index];
  if (entry?.messageRole === "tool") {
    return findAssistantToolCallEntryIndex(entries, index);
  }
  return findAssistantToolCallEntryIndexForFollowupAssistant(entries, index);
}

// 恢复窗口不能从 tool_result 或工具后的 assistant 回复中间开始。
function expandResumeStartToToolTrajectory(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
  initialStartIndex: number,
): number {
  let startIndex = initialStartIndex;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = startIndex; index < entries.length; index += 1) {
      const trajectoryStartIndex = findToolTrajectoryStartEntryIndex(entries, index);
      if (trajectoryStartIndex !== undefined && trajectoryStartIndex < startIndex) {
        startIndex = trajectoryStartIndex;
        changed = true;
        break;
      }
    }
  }
  return startIndex;
}

function byteLengthSum(entries: readonly AgentCoreTranscriptSideIndexEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.byteLength, 0);
}

// 按 entry 数量和字节预算裁剪连续恢复 tail。只预算 message，timeline/permission 由 GUI 回放。
function applyResumeIndexBudget(
  entries: readonly AgentCoreTranscriptSideIndexEntry[],
  policy: AgentCoreTranscriptResumeIndexWindowPolicy,
): {
  entries: AgentCoreTranscriptSideIndexEntry[];
  omittedEntries: number;
  omittedBytes: number;
} {
  let startIndex = entries.length;
  let selectedBytes = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const selectedCount = entries.length - startIndex;
    const wouldExceedEntryLimit =
      policy.maxIndexedResumeEntries !== undefined &&
      selectedCount >= policy.maxIndexedResumeEntries;
    const wouldExceedByteLimit =
      policy.maxIndexedResumeBytes !== undefined &&
      selectedCount > 0 &&
      selectedBytes + entry.byteLength > policy.maxIndexedResumeBytes;
    if (wouldExceedEntryLimit || wouldExceedByteLimit) {
      break;
    }
    startIndex = index;
    selectedBytes += entry.byteLength;
  }

  const expandedStartIndex = expandResumeStartToToolTrajectory(entries, startIndex);
  const selected = entries.slice(expandedStartIndex);
  const omitted = entries.slice(0, expandedStartIndex);

  return {
    entries: selected,
    omittedEntries: omitted.length,
    omittedBytes: byteLengthSum(omitted),
  };
}

// 构造 resume 需要的索引窗口。compact 之前的消息不再恢复，非 message 不占 queryLoop 恢复预算。
export function createAgentCoreTranscriptResumeIndexWindow(
  indexEntries: readonly AgentCoreTranscriptSideIndexEntry[],
  policy: AgentCoreTranscriptResumeIndexWindowPolicy = {},
): AgentCoreTranscriptSideIndexResumeWindow {
  const latestCompact = findLatestAgentCoreCompactIndexEntry(indexEntries);
  const compactEntries = indexEntries.filter((entry) => entry.entryKind === "compact-record");
  const resumableCandidates =
    latestCompact === undefined
      ? indexEntries.filter(isResumableMessageIndexEntry)
      : indexEntries
          .filter((entry) => entry.byteOffset > latestCompact.byteOffset)
          .filter(isResumableMessageIndexEntry);
  const budgeted = applyResumeIndexBudget(resumableCandidates, policy);
  if (latestCompact === undefined) {
    return {
      compactEntries,
      resumableEntries: budgeted.entries,
      omittedResumableEntries: budgeted.omittedEntries,
      omittedResumableBytes: budgeted.omittedBytes,
    };
  }
  return {
    compactEntries,
    resumableEntries: budgeted.entries,
    omittedResumableEntries: budgeted.omittedEntries,
    omittedResumableBytes: budgeted.omittedBytes,
  };
}
