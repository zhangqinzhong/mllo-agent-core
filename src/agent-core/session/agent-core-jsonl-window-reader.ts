import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentCoreSessionEntry } from "./agent-core-session-types";

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export type AgentCoreJsonlWindow = {
  head: AgentCoreSessionEntry[];
  tail: AgentCoreSessionEntry[];
  totalEntries: number;
  omittedEntries: number;
};

// 过滤 JSONL 空行。append-only transcript 允许末尾换行，但不允许空行影响窗口计数。
function nonEmptyLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function completeJsonlLinesFromChunks(
  chunks: readonly Buffer[],
  dropLeadingPartial: boolean,
): string[] {
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  if (dropLeadingPartial) {
    lines.shift();
  }
  return nonEmptyLines(lines);
}

// 解析一行 JSONL。窗口读取保留 source 描述，方便定位坏 JSON 来自 head 还是 tail。
function parseJsonlLine(line: string, source: string): AgentCoreSessionEntry {
  try {
    return JSON.parse(line) as AgentCoreSessionEntry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Agent Core session JSONL in ${source}: ${message}`);
  }
}

// 统计非空 JSONL 行数。它是流式扫描，不把整份 transcript 放进内存。
async function countJsonlEntries(path: string): Promise<number> {
  let count = 0;
  let carry = "";
  for await (const chunk of createReadStream(path, {
    encoding: "utf8",
  })) {
    const text = `${carry}${chunk}`;
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? "";
    count += nonEmptyLines(lines).length;
  }
  if (carry.trim().length > 0) {
    count += 1;
  }
  return count;
}

// 从文件头读取有限行。metadata 和最早 compact/budget 事实通常在这里。
async function readHeadLines(path: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) {
    return [];
  }
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (true) {
      const buffer = Buffer.alloc(DEFAULT_CHUNK_SIZE);
      const result = await file.read(buffer, 0, buffer.length, bytesReadTotal);
      if (result.bytesRead === 0) {
        break;
      }
      bytesReadTotal += result.bytesRead;
      chunks.push(buffer.subarray(0, result.bytesRead));
      if (nonEmptyLines(Buffer.concat(chunks).toString("utf8").split(/\r?\n/)).length >= maxLines) {
        break;
      }
    }
    return nonEmptyLines(Buffer.concat(chunks).toString("utf8").split(/\r?\n/)).slice(0, maxLines);
  } finally {
    await file.close();
  }
}

// 从文件尾读取有限行。恢复对最近消息敏感，所以 tail 不能依赖完整读取。
async function readTailLines(path: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) {
    return [];
  }
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    let position = stat.size;
    const chunks: Buffer[] = [];
    while (position > 0) {
      const readSize = Math.min(DEFAULT_CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      chunks.unshift(buffer);
      const lines = completeJsonlLinesFromChunks(chunks, position > 0);
      if (lines.length >= maxLines) {
        return lines.slice(-maxLines);
      }
    }
    return completeJsonlLinesFromChunks(chunks, false).slice(-maxLines);
  } finally {
    await file.close();
  }
}

// 读取 JSONL 的 head/tail 窗口。中间 entry 只计数，不进入内存。
export async function readAgentCoreJsonlWindow(args: {
  path: string;
  headEntries: number;
  tailEntries: number;
}): Promise<AgentCoreJsonlWindow> {
  const totalEntries = await countJsonlEntries(args.path);
  const headLineCount = Math.min(args.headEntries, totalEntries);
  const tailLineCount = Math.min(args.tailEntries, Math.max(0, totalEntries - headLineCount));
  const [headLines, tailLines] = await Promise.all([
    readHeadLines(args.path, headLineCount),
    readTailLines(args.path, tailLineCount),
  ]);

  return {
    head: headLines.map((line, index) => parseJsonlLine(line, `head line ${index + 1}`)),
    tail: tailLines.map((line, index) => parseJsonlLine(line, `tail line ${index + 1}`)),
    totalEntries,
    omittedEntries: Math.max(0, totalEntries - headLines.length - tailLines.length),
  };
}
