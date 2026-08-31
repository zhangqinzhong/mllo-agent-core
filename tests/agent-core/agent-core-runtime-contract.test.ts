import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_CORE_QUERY_EVENT_SCHEMA_VERSION,
  AGENT_CORE_RUNTIME_CONTRACT_VERSION,
  AGENT_CORE_INTERACTION_SCHEMA_VERSION,
  MLLO_STATE_SCHEMA_VERSION,
  MlloStateSchemaVersionError,
  getAgentCoreRuntimeCapabilities,
  resolveLatestAgentCoreSession,
} from "../../src";
import { MlloStateStore } from "../../src/agent-core/desktop-host";

function createVersionOneStateDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model TEXT,
        approval_mode TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        preview TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE worker_tool_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        is_error INTEGER,
        created_at_ms INTEGER NOT NULL
      );

      INSERT INTO threads (
        id, rollout_path, cwd, title, model_provider, model, approval_mode,
        sandbox_policy, tokens_used, archived, preview, created_at_ms, updated_at_ms
      ) VALUES (
        'legacy-thread', '/tmp/legacy.jsonl', '/tmp/project', 'Legacy', 'openai', NULL,
        'auto-readonly', 'workspace', 12, 0, 'legacy preview', 100, 200
      );

      INSERT INTO worker_tool_events (
        id, thread_id, kind, worker_id, tool_name, payload_json, is_error, created_at_ms
      ) VALUES (
        'legacy-event', 'legacy-thread', 'result', 'worker-1', 'read_file',
        '{"content":"ok"}', 0, 150
      );

      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

function tableColumns(path: string, table: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

describe("agent core runtime contract", () => {
  it("exports one public capability snapshot for host version gates", () => {
    const capabilities = getAgentCoreRuntimeCapabilities();

    expect(AGENT_CORE_RUNTIME_CONTRACT_VERSION).toBe(1);
    expect(AGENT_CORE_QUERY_EVENT_SCHEMA_VERSION).toBe(1);
    expect(AGENT_CORE_INTERACTION_SCHEMA_VERSION).toBe(1);
    expect(MLLO_STATE_SCHEMA_VERSION).toBe(9);
    expect(capabilities).toEqual({
      runtimeContractVersion: AGENT_CORE_RUNTIME_CONTRACT_VERSION,
      queryEventSchemaVersion: AGENT_CORE_QUERY_EVENT_SCHEMA_VERSION,
      interactionSchemaVersion: AGENT_CORE_INTERACTION_SCHEMA_VERSION,
      stateSchemaVersion: MLLO_STATE_SCHEMA_VERSION,
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(getAgentCoreRuntimeCapabilities()).toBe(capabilities);
  });

  it("migrates a version 1 state index to the current public schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-state-v1-migration-"));
    const dbPath = join(dir, "state.sqlite");
    createVersionOneStateDatabase(dbPath);

    const store = new MlloStateStore({ dbPath });
    try {
      expect(store.getSchemaVersion()).toBe(MLLO_STATE_SCHEMA_VERSION);
      expect(store.getThread("legacy-thread")).toMatchObject({
        id: "legacy-thread",
        resumeOmittedEntries: 0,
        resumeOmittedBytes: 0,
        runStatus: "completed",
      });
      expect(store.listWorkerToolEventsForThread("legacy-thread")).toEqual([
        expect.objectContaining({
          id: "legacy-event",
          payload: { content: "ok" },
        }),
      ]);
    } finally {
      store.close();
    }

    expect(tableColumns(dbPath, "threads")).toEqual(
      expect.arrayContaining([
        "resume_omitted_entries",
        "resume_omitted_bytes",
        "run_status",
        "run_message",
      ]),
    );
    expect(tableColumns(dbPath, "worker_tool_events")).toEqual(
      expect.arrayContaining([
        "invocation_id",
        "payload_truncated",
        "payload_original_chars",
        "payload_max_chars",
        "payload_blob_path",
        "payload_blob_bytes",
      ]),
    );
    expect(tableColumns(dbPath, "interactions")).toEqual(
      expect.arrayContaining([
        "id",
        "thread_id",
        "status",
        "request_json",
        "resolution_json",
        "message_count",
      ]),
    );
  });

  it("adds the durable interaction projection when upgrading a version 8 index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-state-v8-migration-"));
    const dbPath = join(dir, "state.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE legacy_sentinel (value TEXT NOT NULL);
      INSERT INTO legacy_sentinel (value) VALUES ('preserved');
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const store = new MlloStateStore({ dbPath });
    try {
      expect(store.getSchemaVersion()).toBe(9);
      expect(store.listPendingInteractions()).toEqual([]);
    } finally {
      store.close();
    }

    const migrated = new DatabaseSync(dbPath);
    try {
      expect(migrated.prepare("SELECT value FROM legacy_sentinel").get()).toEqual({
        value: "preserved",
      });
      expect(
        migrated
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interactions'")
          .get(),
      ).toEqual({ name: "interactions" });
    } finally {
      migrated.close();
    }
  });

  it("fails before mutating a state index created by a newer runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-state-future-version-"));
    const dbPath = join(dir, "state.sqlite");
    const futureVersion = MLLO_STATE_SCHEMA_VERSION + 1;
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE future_sentinel (value TEXT NOT NULL);
      INSERT INTO future_sentinel (value) VALUES ('preserve-me');
      PRAGMA user_version = ${futureVersion};
    `);
    db.close();

    let error: unknown;
    let unexpectedStore: MlloStateStore | undefined;
    try {
      unexpectedStore = new MlloStateStore({ dbPath });
    } catch (caught) {
      error = caught;
    } finally {
      unexpectedStore?.close();
    }

    expect(error).toBeInstanceOf(MlloStateSchemaVersionError);
    expect(error).toMatchObject({
      code: "MLLO_STATE_SCHEMA_VERSION_UNSUPPORTED",
      foundVersion: futureVersion,
      supportedVersion: MLLO_STATE_SCHEMA_VERSION,
    });
    await expect(
      resolveLatestAgentCoreSession({
        configDir: dir,
        stateDbPath: dbPath,
        cwd: dir,
      }),
    ).rejects.toMatchObject({
      code: "MLLO_STATE_SCHEMA_VERSION_UNSUPPORTED",
      foundVersion: futureVersion,
    });

    const preserved = new DatabaseSync(dbPath);
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({
        user_version: futureVersion,
      });
      expect(
        preserved
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
          .get(),
      ).toBeUndefined();
      expect(preserved.prepare("SELECT value FROM future_sentinel").get()).toEqual({
        value: "preserve-me",
      });
    } finally {
      preserved.close();
    }
  });
});
