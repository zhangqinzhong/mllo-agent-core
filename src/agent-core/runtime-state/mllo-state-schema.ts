import type { SyncDatabaseHandle } from "../../sqlite/sync-database";

const MLLO_STATE_SCHEMA_VERSION = 8;

// 读取表字段集合，迁移时用它做幂等判断，避免新库和旧库路径分叉。
function getTableColumnNames(db: SyncDatabaseHandle, tableName: string): Set<string> {
  const rows = db.pragma(`table_info(${tableName})`) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

// 给旧版 threads 表补齐恢复裁剪统计；新建库已经有这些列，不需要重复 ALTER。
function migrateThreadsResumeStats(db: SyncDatabaseHandle): void {
  const columns = getTableColumnNames(db, "threads");
  if (!columns.has("resume_omitted_entries")) {
    db.exec("ALTER TABLE threads ADD COLUMN resume_omitted_entries INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("resume_omitted_bytes")) {
    db.exec("ALTER TABLE threads ADD COLUMN resume_omitted_bytes INTEGER NOT NULL DEFAULT 0");
  }
}

// 给旧 thread 补运行生命周期状态，GUI 不再需要从 timeline 里反推终止态。
function migrateThreadsRunLifecycle(db: SyncDatabaseHandle): void {
  const columns = getTableColumnNames(db, "threads");
  if (!columns.has("run_status")) {
    db.exec("ALTER TABLE threads ADD COLUMN run_status TEXT NOT NULL DEFAULT 'completed'");
  }
  if (!columns.has("run_message")) {
    db.exec("ALTER TABLE threads ADD COLUMN run_message TEXT");
  }
}

// 给 worker tool 事件补稳定调用 id，旧库没有这个列时要原地迁移。
function migrateWorkerToolInvocationId(db: SyncDatabaseHandle): void {
  const columns = getTableColumnNames(db, "worker_tool_events");
  if (!columns.has("invocation_id")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN invocation_id TEXT");
  }
}

// 给 worker tool 结果补输出预算元数据，GUI 审计可以知道输出是否被截断。
function migrateWorkerToolPayloadBudget(db: SyncDatabaseHandle): void {
  const columns = getTableColumnNames(db, "worker_tool_events");
  if (!columns.has("payload_truncated")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN payload_truncated INTEGER");
  }
  if (!columns.has("payload_original_chars")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN payload_original_chars INTEGER");
  }
  if (!columns.has("payload_max_chars")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN payload_max_chars INTEGER");
  }
}

// 给 worker tool 结果补完整输出 blob 引用，避免大 stdout 直接写进 SQLite。
function migrateWorkerToolPayloadBlob(db: SyncDatabaseHandle): void {
  const columns = getTableColumnNames(db, "worker_tool_events");
  if (!columns.has("payload_blob_path")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN payload_blob_path TEXT");
  }
  if (!columns.has("payload_blob_bytes")) {
    db.exec("ALTER TABLE worker_tool_events ADD COLUMN payload_blob_bytes INTEGER");
  }
}

// 创建 mllo state.sqlite 第一版表结构，SQLite 只存索引和当前状态。
export function createMlloStateSchema(db: SyncDatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model TEXT,
      approval_mode TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      resume_omitted_entries INTEGER NOT NULL DEFAULT 0,
      resume_omitted_bytes INTEGER NOT NULL DEFAULT 0,
      run_status TEXT NOT NULL DEFAULT 'completed'
        CHECK(run_status IN (
          'running',
          'completed',
          'waiting-for-permission',
          'waiting-for-elicitation',
          'denied',
          'stopped',
          'error'
        )),
      run_message TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_threads_updated
      ON threads(archived, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_mllo_threads_cwd
      ON threads(cwd, updated_at_ms);

    CREATE TABLE IF NOT EXISTS thread_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
        CHECK(status IN ('active', 'completed', 'cancelled')),
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_thread_edges_parent
      ON thread_edges(parent_thread_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('pending', 'ready', 'running', 'completed', 'failed', 'blocked')),
      assignee TEXT,
      blocked_by_json TEXT NOT NULL,
      blocks_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_tasks_thread
      ON tasks(thread_id, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_mllo_tasks_status
      ON tasks(status, updated_at_ms);

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      subscriptions_json TEXT NOT NULL,
      runtime_handle TEXT,
      joined_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(team_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_team_members_team
      ON team_members(team_id, updated_at_ms);

    CREATE TABLE IF NOT EXISTS checkpoint_restores (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      checkpoint_path TEXT NOT NULL,
      conflict_strategy TEXT NOT NULL
        CHECK(conflict_strategy IN ('skip', 'force')),
      requested_file_paths_json TEXT NOT NULL,
      restored_count INTEGER NOT NULL,
      deleted_count INTEGER NOT NULL,
      conflict_count INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_checkpoint_restores_thread
      ON checkpoint_restores(thread_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_mllo_checkpoint_restores_checkpoint
      ON checkpoint_restores(checkpoint_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS checkpoint_restore_files (
      restore_id TEXT NOT NULL,
      path TEXT NOT NULL,
      resolved_path TEXT NOT NULL,
      action TEXT NOT NULL
        CHECK(action IN ('restored', 'deleted', 'conflict')),
      reason TEXT,
      restored_at TEXT,
      PRIMARY KEY(restore_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_checkpoint_restore_files_restore
      ON checkpoint_restore_files(restore_id, path);

    CREATE TABLE IF NOT EXISTS worker_tool_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK(kind IN ('use', 'result')),
      worker_id TEXT NOT NULL,
      invocation_id TEXT,
      tool_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      is_error INTEGER,
      payload_truncated INTEGER,
      payload_original_chars INTEGER,
      payload_max_chars INTEGER,
      payload_blob_path TEXT,
      payload_blob_bytes INTEGER,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mllo_worker_tool_events_thread
      ON worker_tool_events(thread_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_mllo_worker_tool_events_worker
      ON worker_tool_events(worker_id, kind, created_at_ms);
  `);
  const currentVersion = getMlloStateSchemaVersion(db);
  if (currentVersion < 2) {
    migrateThreadsResumeStats(db);
  }
  if (currentVersion < 5) {
    migrateWorkerToolInvocationId(db);
  }
  if (currentVersion < 6) {
    migrateWorkerToolPayloadBudget(db);
  }
  if (currentVersion < 7) {
    migrateWorkerToolPayloadBlob(db);
  }
  if (currentVersion < 8) {
    migrateThreadsRunLifecycle(db);
  }
  if (currentVersion < MLLO_STATE_SCHEMA_VERSION) {
    db.pragma(`user_version = ${MLLO_STATE_SCHEMA_VERSION}`);
  }
}

// 读取 schema 版本，后续做迁移时用它判断 state.sqlite 是否需要升级。
export function getMlloStateSchemaVersion(db: SyncDatabaseHandle): number {
  return db.pragma("user_version", {
    simple: true,
  }) as number;
}
