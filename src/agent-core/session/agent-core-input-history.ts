import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getMlloHistoryPath } from "../runtime-home/mllo-home-paths";

const DEFAULT_INPUT_HISTORY_LIMIT = 100;
const INPUT_HISTORY_REVERSE_CHUNK_SIZE = 64 * 1024;

export type AgentCoreInputHistoryEntry = {
  kind: "input";
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  input: string;
};

export type AgentCoreInputHistoryListOptions = {
  configDir: string;
  cwd?: string;
  sessionId?: string;
  limit?: number;
  dedupeByInput?: boolean;
};

export type AgentCoreInputHistoryAppendArgs = {
  configDir: string;
  sessionId: string;
  cwd: string;
  input: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function serializeHistoryEntry(entry: AgentCoreInputHistoryEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function isInputHistoryEntry(value: unknown): value is AgentCoreInputHistoryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "input" &&
    "uuid" in value &&
    typeof value.uuid === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "string" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "input" in value &&
    typeof value.input === "string"
  );
}

function parseHistoryLine(line: string, lineNumber: number): AgentCoreInputHistoryEntry {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isInputHistoryEntry(value)) {
      throw new Error("entry is not an input history record");
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Agent Core input history JSONL at line ${lineNumber}: ${message}`);
  }
}

function isMissingHistoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_INPUT_HISTORY_LIMIT;
  }
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_INPUT_HISTORY_LIMIT;
}

function inputHistoryMatchesCwd(
  entry: AgentCoreInputHistoryEntry,
  normalizedCwd: string | undefined,
): boolean {
  return normalizedCwd === undefined || resolve(entry.cwd) === normalizedCwd;
}

// 反向读取 JSONL 行。历史文件会长期增长，交互历史不能每次全量读入内存。
async function* readHistoryLinesReverse(path: string): AsyncGenerator<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    let position = stat.size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const readSize = Math.min(INPUT_HISTORY_REVERSE_CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      const data = Buffer.concat([buffer, carry]);
      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) {
          continue;
        }
        const line = data
          .subarray(index + 1, lineEnd)
          .toString("utf8")
          .trim();
        if (line.length > 0) {
          yield line;
        }
        lineEnd = index;
      }
      carry = data.subarray(0, lineEnd);
    }
    const line = carry.toString("utf8").trim();
    if (line.length > 0) {
      yield line;
    }
  } finally {
    await file.close();
  }
}

// 追加用户输入历史，供 GUI/CLI 恢复输入记录；完整会话事实仍以 rollout JSONL 为准。
export async function appendAgentCoreInputHistoryEntry(
  args: AgentCoreInputHistoryAppendArgs,
): Promise<AgentCoreInputHistoryEntry> {
  const entry: AgentCoreInputHistoryEntry = {
    kind: "input",
    uuid: randomUUID(),
    timestamp: nowIso(),
    sessionId: args.sessionId,
    cwd: args.cwd,
    input: args.input,
  };
  const historyPath = getMlloHistoryPath({
    homePath: args.configDir,
  });
  await mkdir(dirname(historyPath), {
    recursive: true,
  });
  await appendFile(historyPath, serializeHistoryEntry(entry), "utf8");
  return entry;
}

// 列出交互输入历史。坏行跳过，避免一行损坏导致 CLI/GUI 历史面板不可用。
export async function listAgentCoreInputHistory(
  options: AgentCoreInputHistoryListOptions,
): Promise<AgentCoreInputHistoryEntry[]> {
  const historyPath = getMlloHistoryPath({
    homePath: options.configDir,
  });
  const limit = normalizeLimit(options.limit);
  const normalizedCwd = options.cwd === undefined ? undefined : resolve(options.cwd);
  const currentSessionEntries: AgentCoreInputHistoryEntry[] = [];
  const otherSessionEntries: AgentCoreInputHistoryEntry[] = [];
  const seenInputs = new Set<string>();
  try {
    for await (const line of readHistoryLinesReverse(historyPath)) {
      let entry: AgentCoreInputHistoryEntry;
      try {
        entry = parseHistoryLine(line, 0);
      } catch {
        continue;
      }
      if (!inputHistoryMatchesCwd(entry, normalizedCwd)) {
        continue;
      }
      if (options.dedupeByInput === true) {
        if (seenInputs.has(entry.input)) {
          continue;
        }
        seenInputs.add(entry.input);
      }
      if (options.sessionId !== undefined && entry.sessionId === options.sessionId) {
        currentSessionEntries.push(entry);
      } else {
        otherSessionEntries.push(entry);
      }
      if (currentSessionEntries.length + otherSessionEntries.length >= limit) {
        break;
      }
    }
  } catch (error) {
    if (isMissingHistoryError(error)) {
      return [];
    }
    throw error;
  }
  return [...currentSessionEntries, ...otherSessionEntries].slice(0, limit);
}

// 读取输入历史。坏行直接报错，避免 UI 基于损坏 history 展示误导性记录。
export async function readAgentCoreInputHistory(
  configDir: string,
): Promise<AgentCoreInputHistoryEntry[]> {
  const historyPath = getMlloHistoryPath({
    homePath: configDir,
  });
  let content: string;
  try {
    content = await readFile(historyPath, "utf8");
  } catch (error) {
    if (isMissingHistoryError(error)) {
      return [];
    }
    throw error;
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => parseHistoryLine(line, index + 1));
}
