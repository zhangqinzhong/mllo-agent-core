import { open, stat } from "node:fs/promises";
import { redactMlloObserverText, redactMlloObserverValue } from "./mllo-observer-redaction";
import type { MlloObserverJsonlEntry, MlloObserverJsonlReadResult } from "./mllo-observer-types";

export type MlloObserverJsonlTailOptions = {
  maxEntries?: number;
  maxBytes?: number;
  redactSecrets?: boolean;
};

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseJsonlLine(args: {
  line: string;
  ordinal: number;
  lineNumber?: number;
  redactSecrets?: boolean;
}): MlloObserverJsonlEntry {
  try {
    const parsed = JSON.parse(args.line) as unknown;
    const redacted = redactMlloObserverValue(parsed, {
      redactSecrets: args.redactSecrets,
    });
    return {
      ordinal: args.ordinal,
      ...(args.lineNumber === undefined ? {} : { lineNumber: args.lineNumber }),
      ...extractJsonlLabels(redacted),
      json: JSON.stringify(redacted, null, 2),
      parsed: redacted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ordinal: args.ordinal,
      ...(args.lineNumber === undefined ? {} : { lineNumber: args.lineNumber }),
      json: redactMlloObserverText(args.line),
      parseError: message,
    };
  }
}

function extractJsonlLabels(
  value: unknown,
): Pick<MlloObserverJsonlEntry, "kind" | "type" | "timestamp"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
  };
}

// 只读 tail 窗口，避免 observer 打开超大会话时把完整 JSONL 放进内存。
export async function readMlloObserverJsonlTail(
  path: string,
  options: MlloObserverJsonlTailOptions = {},
): Promise<MlloObserverJsonlReadResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let fileBytes = 0;
  try {
    fileBytes = (await stat(path)).size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        path,
        exists: false,
        fileBytes: 0,
        bytesRead: 0,
        truncatedHead: false,
        entries: [],
      };
    }
    throw error;
  }

  const start = Math.max(0, fileBytes - maxBytes);
  const bytesRead = fileBytes - start;
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytesRead);
    await file.read(buffer, 0, bytesRead, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) {
      lines.shift();
    }
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    const selected = nonEmptyLines.slice(-maxEntries);
    const omittedByEntryLimit = Math.max(0, nonEmptyLines.length - selected.length);
    const lineNumberOffset = start === 0 ? omittedByEntryLimit : undefined;
    return {
      path,
      exists: true,
      fileBytes,
      bytesRead,
      truncatedHead: start > 0 || omittedByEntryLimit > 0,
      entries: selected.map((line, index) =>
        parseJsonlLine({
          line,
          ordinal: omittedByEntryLimit + index + 1,
          ...(lineNumberOffset === undefined ? {} : { lineNumber: lineNumberOffset + index + 1 }),
          redactSecrets: options.redactSecrets,
        }),
      ),
    };
  } finally {
    await file.close();
  }
}
