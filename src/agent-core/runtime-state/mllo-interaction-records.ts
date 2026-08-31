import type { SyncDatabaseHandle } from "../../sqlite/sync-database";
import type {
  AgentCoreInteractionKind,
  AgentCoreInteractionRequest,
  AgentCoreInteractionResolution,
  AgentCoreInteractionResolutionSource,
} from "../interactions/agent-core-interaction-types";

export type MlloInteractionStatus = "pending" | "resolved";

export type MlloInteractionRecord = {
  version: number;
  id: string;
  threadId: string;
  requestKey: string;
  kind: AgentCoreInteractionKind;
  status: MlloInteractionStatus;
  callId: string;
  toolName: string;
  cwd: string;
  transcriptPath: string;
  messageCount: number;
  request: AgentCoreInteractionRequest;
  resolution?: AgentCoreInteractionResolution;
  resolutionSource?: AgentCoreInteractionResolutionSource;
  requestEntryUuid: string;
  resolutionEntryUuid?: string;
  createdAtMs: number;
  resolvedAtMs?: number;
  updatedAtMs: number;
};

export type MlloInteractionRow = {
  version: number;
  id: string;
  thread_id: string;
  request_key: string;
  kind: AgentCoreInteractionKind;
  status: MlloInteractionStatus;
  call_id: string;
  tool_name: string;
  cwd: string;
  transcript_path: string;
  message_count: number;
  request_json: string;
  resolution_json: string | null;
  resolution_source: AgentCoreInteractionResolutionSource | null;
  request_entry_uuid: string;
  resolution_entry_uuid: string | null;
  created_at_ms: number;
  resolved_at_ms: number | null;
  updated_at_ms: number;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function toMlloInteractionRecord(row: MlloInteractionRow): MlloInteractionRecord {
  const record: MlloInteractionRecord = {
    version: row.version,
    id: row.id,
    threadId: row.thread_id,
    requestKey: row.request_key,
    kind: row.kind,
    status: row.status,
    callId: row.call_id,
    toolName: row.tool_name,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    messageCount: row.message_count,
    request: parseJson<AgentCoreInteractionRequest>(row.request_json),
    requestEntryUuid: row.request_entry_uuid,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
  if (row.resolution_json !== null) {
    record.resolution = parseJson<AgentCoreInteractionResolution>(row.resolution_json);
  }
  if (row.resolution_source !== null) {
    record.resolutionSource = row.resolution_source;
  }
  if (row.resolution_entry_uuid !== null) {
    record.resolutionEntryUuid = row.resolution_entry_uuid;
  }
  if (row.resolved_at_ms !== null) {
    record.resolvedAtMs = row.resolved_at_ms;
  }
  return record;
}

// JSONL 按时间重放；旧 pending 事件不得把已经 resolved 的当前态降级。
export function upsertMlloInteraction(db: SyncDatabaseHandle, record: MlloInteractionRecord): void {
  db.prepare(
    `
      INSERT INTO interactions (
        version, id, thread_id, request_key, kind, status, call_id, tool_name,
        cwd, transcript_path, message_count, request_json, resolution_json,
        resolution_source, request_entry_uuid, resolution_entry_uuid,
        created_at_ms, resolved_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        resolution_json = excluded.resolution_json,
        resolution_source = excluded.resolution_source,
        resolution_entry_uuid = excluded.resolution_entry_uuid,
        resolved_at_ms = excluded.resolved_at_ms,
        updated_at_ms = excluded.updated_at_ms
      WHERE interactions.status = 'pending' AND excluded.status = 'resolved'
    `,
  ).run(
    record.version,
    record.id,
    record.threadId,
    record.requestKey,
    record.kind,
    record.status,
    record.callId,
    record.toolName,
    record.cwd,
    record.transcriptPath,
    record.messageCount,
    JSON.stringify(record.request),
    record.resolution === undefined ? null : JSON.stringify(record.resolution),
    record.resolutionSource ?? null,
    record.requestEntryUuid,
    record.resolutionEntryUuid ?? null,
    record.createdAtMs,
    record.resolvedAtMs ?? null,
    record.updatedAtMs,
  );
}

export function getMlloInteraction(
  db: SyncDatabaseHandle,
  interactionId: string,
): MlloInteractionRecord | undefined {
  const row = db.prepare("SELECT * FROM interactions WHERE id = ?").get(interactionId) as
    | MlloInteractionRow
    | undefined;
  return row === undefined ? undefined : toMlloInteractionRecord(row);
}

export function listPendingMlloInteractions(
  db: SyncDatabaseHandle,
  options: {
    threadId?: string;
    limit: number;
  },
): MlloInteractionRecord[] {
  const rows =
    options.threadId === undefined
      ? (db
          .prepare(
            "SELECT * FROM interactions WHERE status = 'pending' ORDER BY created_at_ms ASC LIMIT ?",
          )
          .all(options.limit) as MlloInteractionRow[])
      : (db
          .prepare(
            `
              SELECT * FROM interactions
              WHERE status = 'pending' AND thread_id = ?
              ORDER BY created_at_ms ASC LIMIT ?
            `,
          )
          .all(options.threadId, options.limit) as MlloInteractionRow[]);
  return rows.map(toMlloInteractionRecord);
}

export function listMlloInteractionsForThread(
  db: SyncDatabaseHandle,
  threadId: string,
  options: {
    status?: MlloInteractionStatus;
    limit: number;
  },
): MlloInteractionRecord[] {
  const rows =
    options.status === undefined
      ? (db
          .prepare(
            "SELECT * FROM interactions WHERE thread_id = ? ORDER BY created_at_ms ASC LIMIT ?",
          )
          .all(threadId, options.limit) as MlloInteractionRow[])
      : (db
          .prepare(
            `
              SELECT * FROM interactions
              WHERE thread_id = ? AND status = ?
              ORDER BY created_at_ms ASC LIMIT ?
            `,
          )
          .all(threadId, options.status, options.limit) as MlloInteractionRow[]);
  return rows.map(toMlloInteractionRecord);
}
