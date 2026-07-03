import { access } from "node:fs/promises";
import { resolve } from "node:path";
import SyncDatabase from "../../sqlite/sync-database";
import type { MlloThreadRow } from "../runtime-state/mllo-thread-records";
import { toMlloThreadRecord } from "../runtime-state/mllo-thread-records";
import { readAgentCoreSessionIndex } from "../session/agent-core-session-index";

export type AgentCoreLatestSession = {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  updatedAtMs: number;
  source: "state" | "index";
};

export type ResolveLatestAgentCoreSessionOptions = {
  configDir: string;
  stateDbPath?: string;
  cwd: string;
  includeArchived?: boolean;
};

// 旧 state.sqlite 可能还没建 threads 表；continue 要降级到 append-only index。
function hasSqliteTable(db: SyncDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

// state 和 index 都可能留下陈旧路径，恢复前先确认 transcript 还在。
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toMillis(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (value === undefined) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// state 记录 updated_at_ms，是判断“最近继续过哪个会话”的优先来源。
async function readLatestStateSession(
  options: ResolveLatestAgentCoreSessionOptions,
): Promise<AgentCoreLatestSession | undefined> {
  if (options.stateDbPath === undefined || !(await pathExists(options.stateDbPath))) {
    return undefined;
  }
  const db = new SyncDatabase(options.stateDbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    if (!hasSqliteTable(db, "threads")) {
      return undefined;
    }
    const rows = (
      options.includeArchived === true
        ? db
            .prepare("SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at_ms DESC LIMIT ?")
            .all(options.cwd, 20)
        : db
            .prepare(
              "SELECT * FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at_ms DESC LIMIT ?",
            )
            .all(options.cwd, 20)
    ) as MlloThreadRow[];
    for (const row of rows) {
      const thread = toMlloThreadRecord(row);
      if (await pathExists(thread.rolloutPath)) {
        return {
          sessionId: thread.id,
          cwd: thread.cwd,
          transcriptPath: thread.rolloutPath,
          updatedAtMs: thread.updatedAtMs,
          source: "state",
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

// 没有 state 或 state 损坏时，session_index 仍能恢复最新创建的会话。
async function readLatestIndexedSession(
  options: ResolveLatestAgentCoreSessionOptions,
): Promise<AgentCoreLatestSession | undefined> {
  const cwd = resolve(options.cwd);
  const entries = await readAgentCoreSessionIndex(options.configDir);
  const candidates = entries
    .filter((entry) => resolve(entry.cwd) === cwd)
    .map((entry) => ({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      transcriptPath: entry.transcriptPath,
      updatedAtMs: toMillis(entry.createdAt) || toMillis(entry.timestamp),
      source: "index" as const,
    }))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  for (const candidate of candidates) {
    if (await pathExists(candidate.transcriptPath)) {
      return candidate;
    }
  }
  return undefined;
}

// 给 CLI/GUI 共用的入口：宿主不需要自己扫描 transcript 目录。
export async function resolveLatestAgentCoreSession(
  options: ResolveLatestAgentCoreSessionOptions,
): Promise<AgentCoreLatestSession | undefined> {
  const normalizedOptions = {
    ...options,
    cwd: resolve(options.cwd),
  };
  return (
    (await readLatestStateSession(normalizedOptions)) ??
    (await readLatestIndexedSession(normalizedOptions))
  );
}
