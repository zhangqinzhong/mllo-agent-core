import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getMlloExternalTraceDir as getRuntimeExternalTraceDir } from "../agent-core/runtime-home/mllo-home-paths";
import { readMlloObserverJsonlTail } from "./mllo-observer-jsonl";
import type { MlloObserverJsonlReadResult } from "./mllo-observer-types";
import type {
  MlloExternalTraceJsonlOptions,
  MlloExternalTraceLogReadOptions,
  MlloExternalTraceLogSummary,
  MlloExternalTraceRecord,
  MlloExternalTraceSource,
} from "./mllo-external-trace-types";

const TRACE_SOURCE_PATTERN = /^[a-zA-Z0-9._-]+$/;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sanitizeExternalTraceSource(source: MlloExternalTraceSource): string {
  if (!TRACE_SOURCE_PATTERN.test(source)) {
    throw new Error(`Invalid external trace source: ${source}`);
  }
  return source;
}

export function getMlloExternalTraceDir(options: MlloExternalTraceJsonlOptions = {}): string {
  return getRuntimeExternalTraceDir(options);
}

export function getMlloExternalTracePath(
  source: MlloExternalTraceSource,
  options: MlloExternalTraceJsonlOptions = {},
): string {
  return join(getMlloExternalTraceDir(options), `${sanitizeExternalTraceSource(source)}.jsonl`);
}

export async function appendMlloExternalTraceRecord(
  record: MlloExternalTraceRecord,
  options: MlloExternalTraceJsonlOptions = {},
): Promise<string> {
  const path = getMlloExternalTracePath(record.source, options);
  await mkdir(dirname(path), {
    recursive: true,
  });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

export async function listMlloExternalTraceLogs(
  options: MlloExternalTraceJsonlOptions = {},
): Promise<MlloExternalTraceLogSummary[]> {
  const dir = getMlloExternalTraceDir(options);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const logs: MlloExternalTraceLogSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const source = basename(entry, ".jsonl");
    if (!TRACE_SOURCE_PATTERN.test(source)) {
      continue;
    }
    const path = join(dir, entry);
    const fileStat = await stat(path);
    logs.push({
      source,
      path,
      fileBytes: fileStat.size,
      updatedAtMs: fileStat.mtimeMs,
    });
  }
  return logs.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export async function readMlloExternalTraceLog(
  options: MlloExternalTraceLogReadOptions,
): Promise<MlloObserverJsonlReadResult> {
  return await readMlloObserverJsonlTail(getMlloExternalTracePath(options.source, options), {
    maxEntries: options.maxEntries,
    maxBytes: options.maxBytes,
    redactSecrets: options.redactSecrets,
  });
}
