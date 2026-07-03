import type { SyncDatabaseHandle } from "../../sqlite/sync-database";

export type MlloWorkerToolEventKind = "use" | "result";

export type MlloWorkerToolEventRecord = {
  id: string;
  threadId: string;
  kind: MlloWorkerToolEventKind;
  workerId: string;
  invocationId?: string;
  toolName: string;
  payload: unknown;
  isError?: boolean;
  payloadTruncated?: boolean;
  payloadOriginalChars?: number;
  payloadMaxChars?: number;
  payloadBlobPath?: string;
  payloadBlobBytes?: number;
  createdAtMs: number;
};

export type MlloWorkerToolEventRow = {
  id: string;
  thread_id: string;
  kind: MlloWorkerToolEventKind;
  worker_id: string;
  invocation_id: string | null;
  tool_name: string;
  payload_json: string;
  is_error: number | null;
  payload_truncated: number | null;
  payload_original_chars: number | null;
  payload_max_chars: number | null;
  payload_blob_path: string | null;
  payload_blob_bytes: number | null;
  created_at_ms: number;
};

export type MlloWorkerToolEventPair = {
  invocationId: string;
  workerId: string;
  toolName: string;
  use?: MlloWorkerToolEventRecord;
  result?: MlloWorkerToolEventRecord;
};

function parsePayloadJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringifyPayloadJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function toMlloWorkerToolEventRecord(
  row: MlloWorkerToolEventRow,
): MlloWorkerToolEventRecord {
  const record: MlloWorkerToolEventRecord = {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind,
    workerId: row.worker_id,
    toolName: row.tool_name,
    payload: parsePayloadJson(row.payload_json),
    createdAtMs: row.created_at_ms,
  };
  if (row.invocation_id !== null) {
    record.invocationId = row.invocation_id;
  }
  if (row.is_error !== null) {
    record.isError = row.is_error === 1;
  }
  if (row.payload_truncated !== null) {
    record.payloadTruncated = row.payload_truncated === 1;
  }
  if (row.payload_original_chars !== null) {
    record.payloadOriginalChars = row.payload_original_chars;
  }
  if (row.payload_max_chars !== null) {
    record.payloadMaxChars = row.payload_max_chars;
  }
  if (row.payload_blob_path !== null) {
    record.payloadBlobPath = row.payload_blob_path;
  }
  if (row.payload_blob_bytes !== null) {
    record.payloadBlobBytes = row.payload_blob_bytes;
  }
  return record;
}

export function upsertMlloWorkerToolEvent(
  db: SyncDatabaseHandle,
  record: MlloWorkerToolEventRecord,
): void {
  db.prepare(
    `
      INSERT INTO worker_tool_events (
        id, thread_id, kind, worker_id, invocation_id, tool_name, payload_json,
        is_error, payload_truncated, payload_original_chars, payload_max_chars,
        payload_blob_path, payload_blob_bytes, created_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        kind = excluded.kind,
        worker_id = excluded.worker_id,
        invocation_id = excluded.invocation_id,
        tool_name = excluded.tool_name,
        payload_json = excluded.payload_json,
        is_error = excluded.is_error,
        payload_truncated = excluded.payload_truncated,
        payload_original_chars = excluded.payload_original_chars,
        payload_max_chars = excluded.payload_max_chars,
        payload_blob_path = excluded.payload_blob_path,
        payload_blob_bytes = excluded.payload_blob_bytes,
        created_at_ms = excluded.created_at_ms
    `,
  ).run(
    record.id,
    record.threadId,
    record.kind,
    record.workerId,
    record.invocationId ?? null,
    record.toolName,
    stringifyPayloadJson(record.payload),
    record.isError === undefined ? null : record.isError ? 1 : 0,
    record.payloadTruncated === undefined ? null : record.payloadTruncated ? 1 : 0,
    record.payloadOriginalChars ?? null,
    record.payloadMaxChars ?? null,
    record.payloadBlobPath ?? null,
    record.payloadBlobBytes ?? null,
    record.createdAtMs,
  );
}

export function listMlloWorkerToolEventsForThread(
  db: SyncDatabaseHandle,
  threadId: string,
): MlloWorkerToolEventRecord[] {
  return (
    db
      .prepare("SELECT * FROM worker_tool_events WHERE thread_id = ? ORDER BY created_at_ms ASC")
      .all(threadId) as MlloWorkerToolEventRow[]
  ).map(toMlloWorkerToolEventRecord);
}

export function listMlloWorkerToolEventPairsForThread(
  db: SyncDatabaseHandle,
  threadId: string,
): MlloWorkerToolEventPair[] {
  const events = (
    db
      .prepare(
        `
          SELECT * FROM worker_tool_events
          WHERE thread_id = ? AND invocation_id IS NOT NULL
          ORDER BY created_at_ms ASC
        `,
      )
      .all(threadId) as MlloWorkerToolEventRow[]
  ).map(toMlloWorkerToolEventRecord);
  const pairs = new Map<string, MlloWorkerToolEventPair>();
  for (const event of events) {
    if (event.invocationId === undefined) {
      continue;
    }
    const pair =
      pairs.get(event.invocationId) ??
      ({
        invocationId: event.invocationId,
        workerId: event.workerId,
        toolName: event.toolName,
      } satisfies MlloWorkerToolEventPair);
    if (event.kind === "use") {
      pair.use = event;
      pair.workerId = event.workerId;
      pair.toolName = event.toolName;
    } else {
      pair.result = event;
      if (pair.use === undefined) {
        pair.workerId = event.workerId;
        pair.toolName = event.toolName;
      }
    }
    pairs.set(event.invocationId, pair);
  }
  return [...pairs.values()];
}
