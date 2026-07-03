import { existsSync } from "node:fs";
import { getMlloStateDbPath } from "../agent-core/runtime-home/mllo-home-paths";
import {
  toMlloThreadRecord,
  type MlloThreadRecord,
  type MlloThreadRow,
} from "../agent-core/runtime-state/mllo-thread-records";

export type MlloObserverStateThreadOptions = {
  homePath: string;
  includeArchived?: boolean;
  limit?: number;
};

type MlloObserverReadableDatabase = {
  prepare: (sql: string) => {
    get: (value: string) => unknown;
  };
  close: () => void;
};

function hasSqliteTable(db: MlloObserverReadableDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

// Observer 只读 state.sqlite；缺库或旧库结构不应导致页面打不开。
export async function readMlloObserverStateThreads(
  options: MlloObserverStateThreadOptions,
): Promise<MlloThreadRecord[]> {
  const dbPath = getMlloStateDbPath({
    homePath: options.homePath,
  });
  if (!existsSync(dbPath)) {
    return [];
  }
  const { default: SyncDatabase } = await import("../sqlite/sync-database");
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    if (!hasSqliteTable(db, "threads")) {
      return [];
    }
    const limit = options.limit ?? 100;
    const rows =
      options.includeArchived === true
        ? (db
            .prepare("SELECT * FROM threads ORDER BY updated_at_ms DESC LIMIT ?")
            .all(limit) as MlloThreadRow[])
        : (db
            .prepare("SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT ?")
            .all(limit) as MlloThreadRow[]);
    return rows.map(toMlloThreadRecord);
  } finally {
    db.close();
  }
}
