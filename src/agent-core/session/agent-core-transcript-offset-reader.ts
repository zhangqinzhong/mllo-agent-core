import { open, type FileHandle } from "node:fs/promises";
import type { AgentCoreSessionEntry } from "./agent-core-session-types";
import type { AgentCoreTranscriptSideIndexEntry } from "./agent-core-transcript-side-index";

// 按 side index 元数据校验 JSONL entry。offset 指错时必须失败，避免恢复错乱历史。
function parseJsonlTranscriptLine(
  line: string,
  indexEntry: AgentCoreTranscriptSideIndexEntry,
): AgentCoreSessionEntry {
  try {
    const value = JSON.parse(line) as AgentCoreSessionEntry;
    if (value.uuid !== indexEntry.entryUuid || value.kind !== indexEntry.entryKind) {
      throw new Error("entry does not match side index metadata");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid Agent Core transcript entry at offset ${indexEntry.byteOffset}: ${message}`,
    );
  }
}

async function readTranscriptEntryFromOpenFile(args: {
  file: FileHandle;
  indexEntry: AgentCoreTranscriptSideIndexEntry;
}): Promise<AgentCoreSessionEntry> {
  const buffer = Buffer.alloc(args.indexEntry.byteLength);
  const result = await args.file.read(
    buffer,
    0,
    args.indexEntry.byteLength,
    args.indexEntry.byteOffset,
  );
  if (result.bytesRead !== args.indexEntry.byteLength) {
    throw new Error(
      `Agent Core transcript entry at offset ${args.indexEntry.byteOffset} was truncated.`,
    );
  }
  const line = buffer.toString("utf8").trim();
  return parseJsonlTranscriptLine(line, args.indexEntry);
}

// 读取单条 offset。保留这个入口给精确诊断和小工具使用。
export async function readAgentCoreTranscriptEntryAtOffset(args: {
  transcriptPath: string;
  indexEntry: AgentCoreTranscriptSideIndexEntry;
}): Promise<AgentCoreSessionEntry> {
  const file = await open(args.transcriptPath, "r");
  try {
    return await readTranscriptEntryFromOpenFile({
      file,
      indexEntry: args.indexEntry,
    });
  } finally {
    await file.close();
  }
}

// 批量读取 offset。resume 不能为每条 tail message 反复 open/close 大 transcript。
export async function readAgentCoreTranscriptEntriesAtOffsets(args: {
  transcriptPath: string;
  indexEntries: readonly AgentCoreTranscriptSideIndexEntry[];
}): Promise<AgentCoreSessionEntry[]> {
  if (args.indexEntries.length === 0) {
    return [];
  }
  const file = await open(args.transcriptPath, "r");
  try {
    const entries: AgentCoreSessionEntry[] = [];
    for (const indexEntry of args.indexEntries) {
      entries.push(
        await readTranscriptEntryFromOpenFile({
          file,
          indexEntry,
        }),
      );
    }
    return entries;
  } finally {
    await file.close();
  }
}
