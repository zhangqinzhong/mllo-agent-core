import type { SyncDatabaseHandle } from "../../sqlite/sync-database";

export type MlloCheckpointRestoreAction = "restored" | "deleted" | "conflict";
export type MlloCheckpointRestoreConflictStrategy = "skip" | "force";

export type MlloCheckpointRestoreFileRecord = {
  restoreId: string;
  path: string;
  resolvedPath: string;
  action: MlloCheckpointRestoreAction;
  reason?: string;
  restoredAt?: string;
};

export type MlloCheckpointRestoreRecord = {
  id: string;
  threadId: string;
  checkpointId: string;
  checkpointPath: string;
  conflictStrategy: MlloCheckpointRestoreConflictStrategy;
  requestedFilePaths: string[];
  restoredCount: number;
  deletedCount: number;
  conflictCount: number;
  createdAtMs: number;
};

export type MlloCheckpointRestoreRow = {
  id: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_path: string;
  conflict_strategy: MlloCheckpointRestoreConflictStrategy;
  requested_file_paths_json: string;
  restored_count: number;
  deleted_count: number;
  conflict_count: number;
  created_at_ms: number;
};

export type MlloCheckpointRestoreFileRow = {
  restore_id: string;
  path: string;
  resolved_path: string;
  action: MlloCheckpointRestoreAction;
  reason: string | null;
  restored_at: string | null;
};

function parseRequestedFilePaths(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringifyMlloRequestedFilePaths(values: readonly string[] = []): string {
  return JSON.stringify([...values]);
}

export function toMlloCheckpointRestoreRecord(
  row: MlloCheckpointRestoreRow,
): MlloCheckpointRestoreRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    checkpointId: row.checkpoint_id,
    checkpointPath: row.checkpoint_path,
    conflictStrategy: row.conflict_strategy,
    requestedFilePaths: parseRequestedFilePaths(row.requested_file_paths_json),
    restoredCount: row.restored_count,
    deletedCount: row.deleted_count,
    conflictCount: row.conflict_count,
    createdAtMs: row.created_at_ms,
  };
}

export function toMlloCheckpointRestoreFileRecord(
  row: MlloCheckpointRestoreFileRow,
): MlloCheckpointRestoreFileRecord {
  const record: MlloCheckpointRestoreFileRecord = {
    restoreId: row.restore_id,
    path: row.path,
    resolvedPath: row.resolved_path,
    action: row.action,
  };
  if (row.reason !== null) {
    record.reason = row.reason;
  }
  if (row.restored_at !== null) {
    record.restoredAt = row.restored_at;
  }
  return record;
}

export function upsertMlloCheckpointRestore(
  db: SyncDatabaseHandle,
  record: MlloCheckpointRestoreRecord,
  files: readonly MlloCheckpointRestoreFileRecord[],
): void {
  db.prepare(
    `
      INSERT INTO checkpoint_restores (
        id, thread_id, checkpoint_id, checkpoint_path, conflict_strategy,
        requested_file_paths_json, restored_count, deleted_count, conflict_count, created_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        checkpoint_id = excluded.checkpoint_id,
        checkpoint_path = excluded.checkpoint_path,
        conflict_strategy = excluded.conflict_strategy,
        requested_file_paths_json = excluded.requested_file_paths_json,
        restored_count = excluded.restored_count,
        deleted_count = excluded.deleted_count,
        conflict_count = excluded.conflict_count,
        created_at_ms = excluded.created_at_ms
    `,
  ).run(
    record.id,
    record.threadId,
    record.checkpointId,
    record.checkpointPath,
    record.conflictStrategy,
    stringifyMlloRequestedFilePaths(record.requestedFilePaths),
    record.restoredCount,
    record.deletedCount,
    record.conflictCount,
    record.createdAtMs,
  );
  db.prepare("DELETE FROM checkpoint_restore_files WHERE restore_id = ?").run(record.id);
  const insertFile = db.prepare(
    `
      INSERT INTO checkpoint_restore_files (
        restore_id, path, resolved_path, action, reason, restored_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  );
  for (const file of files) {
    insertFile.run(
      file.restoreId,
      file.path,
      file.resolvedPath,
      file.action,
      file.reason ?? null,
      file.restoredAt ?? null,
    );
  }
}

export function listMlloCheckpointRestoresForThread(
  db: SyncDatabaseHandle,
  threadId: string,
): MlloCheckpointRestoreRecord[] {
  return (
    db
      .prepare("SELECT * FROM checkpoint_restores WHERE thread_id = ? ORDER BY created_at_ms ASC")
      .all(threadId) as MlloCheckpointRestoreRow[]
  ).map(toMlloCheckpointRestoreRecord);
}

export function listMlloCheckpointRestoreFiles(
  db: SyncDatabaseHandle,
  restoreId: string,
): MlloCheckpointRestoreFileRecord[] {
  return (
    db
      .prepare("SELECT * FROM checkpoint_restore_files WHERE restore_id = ? ORDER BY path ASC")
      .all(restoreId) as MlloCheckpointRestoreFileRow[]
  ).map(toMlloCheckpointRestoreFileRecord);
}
