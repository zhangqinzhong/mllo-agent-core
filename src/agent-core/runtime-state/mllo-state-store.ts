import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SyncDatabase, { type SyncDatabaseHandle } from "../../sqlite/sync-database";
import {
  assertMlloStateSchemaVersionSupported,
  createMlloStateSchema,
  getMlloStateSchemaVersion,
} from "./mllo-state-schema";
import {
  toMlloTaskRecord,
  stringifyMlloTaskLinks,
  type MlloTaskRecord,
  type MlloTaskRow,
} from "./mllo-task-records";
import {
  listMlloCheckpointRestoreFiles,
  listMlloCheckpointRestoresForThread,
  upsertMlloCheckpointRestore,
  type MlloCheckpointRestoreFileRecord,
  type MlloCheckpointRestoreRecord,
} from "./mllo-checkpoint-restore-records";
import {
  listMlloWorkerToolEventPairsForThread,
  listMlloWorkerToolEventsForThread,
  upsertMlloWorkerToolEvent,
  type MlloWorkerToolEventPair,
  type MlloWorkerToolEventRecord,
} from "./mllo-worker-tool-event-records";
import {
  toMlloTeamMemberRecord,
  stringifyMlloSubscriptions,
  type MlloTeamMemberRecord,
  type MlloTeamMemberRow,
} from "./mllo-team-records";
import {
  toMlloThreadEdgeRecord,
  toMlloThreadRecord,
  type MlloThreadEdgeRecord,
  type MlloThreadEdgeRow,
  type MlloThreadRecord,
  type MlloThreadRow,
} from "./mllo-thread-records";
import {
  getMlloInteraction,
  listMlloInteractionsForThread,
  listPendingMlloInteractions,
  upsertMlloInteraction,
  type MlloInteractionRecord,
  type MlloInteractionStatus,
} from "./mllo-interaction-records";

export type MlloStateStoreOptions = {
  dbPath: string | ":memory:";
};

// SQLite 当前态索引。JSONL 是事实来源，state.sqlite 只服务 GUI 和调度器快速查询。
export class MlloStateStore {
  private readonly db: SyncDatabaseHandle;

  // 打开或创建 mllo state.sqlite，并立即确保第一版 schema 可用。
  constructor(options: MlloStateStoreOptions) {
    const dbPath = options.dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), {
        recursive: true,
      });
    }
    const db = new SyncDatabase(dbPath);
    try {
      // 先拒绝未来 schema，再配置连接和迁移；旧 Core 不能改写新 Core 的数据库。
      assertMlloStateSchemaVersionSupported(db);
      db.pragma("busy_timeout = 5000");
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      createMlloStateSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  // 关闭 SQLite 连接，测试和应用退出时都应显式释放文件句柄。
  close(): void {
    this.db.close();
  }

  // 返回当前 schema 版本，方便迁移测试确认 state.sqlite 的结构来源。
  getSchemaVersion(): number {
    return getMlloStateSchemaVersion(this.db);
  }

  // 清空派生索引表。JSONL transcript 仍然保留，reindex 会从事实日志重新生成这些行。
  clearDerivedState(): void {
    this.db.exec(`
      DELETE FROM interactions;
      DELETE FROM worker_tool_events;
      DELETE FROM checkpoint_restore_files;
      DELETE FROM checkpoint_restores;
      DELETE FROM team_members;
      DELETE FROM tasks;
      DELETE FROM thread_edges;
      DELETE FROM threads;
    `);
  }

  // 写入或更新 thread 当前状态，rollout JSONL 仍然是事实记录来源。
  upsertThread(record: MlloThreadRecord): MlloThreadRecord {
    this.db
      .prepare(
        `
          INSERT INTO threads (
            id, rollout_path, cwd, title, model_provider, model, approval_mode,
            sandbox_policy, tokens_used, resume_omitted_entries, resume_omitted_bytes,
            run_status, run_message, archived, preview, created_at_ms, updated_at_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            rollout_path = excluded.rollout_path,
            cwd = excluded.cwd,
            title = excluded.title,
            model_provider = excluded.model_provider,
            model = excluded.model,
            approval_mode = excluded.approval_mode,
            sandbox_policy = excluded.sandbox_policy,
            tokens_used = excluded.tokens_used,
            resume_omitted_entries = excluded.resume_omitted_entries,
            resume_omitted_bytes = excluded.resume_omitted_bytes,
            run_status = excluded.run_status,
            run_message = excluded.run_message,
            archived = excluded.archived,
            preview = excluded.preview,
            updated_at_ms = excluded.updated_at_ms
        `,
      )
      .run(
        record.id,
        record.rolloutPath,
        record.cwd,
        record.title,
        record.modelProvider,
        record.model ?? null,
        record.approvalMode,
        record.sandboxPolicy,
        record.tokensUsed,
        record.resumeOmittedEntries,
        record.resumeOmittedBytes,
        record.runStatus,
        record.runMessage ?? null,
        record.archived ? 1 : 0,
        record.preview,
        record.createdAtMs,
        record.updatedAtMs,
      );
    return this.getThread(record.id) ?? record;
  }

  // 按 id 读取 thread 当前状态，GUI 打开单个会话时走这个索引。
  getThread(threadId: string): MlloThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as
      | MlloThreadRow
      | undefined;
    return row === undefined ? undefined : toMlloThreadRecord(row);
  }

  // 列出最近更新的 thread，默认排除归档项以服务 运行态首页。
  listThreads(options: { includeArchived?: boolean; limit?: number } = {}): MlloThreadRecord[] {
    const includeArchived = options.includeArchived ?? false;
    const limit = options.limit ?? 100;
    const rows = includeArchived
      ? (this.db
          .prepare("SELECT * FROM threads ORDER BY updated_at_ms DESC LIMIT ?")
          .all(limit) as MlloThreadRow[])
      : (this.db
          .prepare("SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT ?")
          .all(limit) as MlloThreadRow[]);
    return rows.map(toMlloThreadRecord);
  }

  // 记录父子 thread 关系，让自研 agent 能追踪委派出来的子任务会话。
  upsertThreadEdge(record: MlloThreadEdgeRecord): MlloThreadEdgeRecord {
    this.db
      .prepare(
        `
          INSERT INTO thread_edges (parent_thread_id, child_thread_id, status, created_at_ms)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(child_thread_id) DO UPDATE SET
            parent_thread_id = excluded.parent_thread_id,
            status = excluded.status
        `,
      )
      .run(record.parentThreadId, record.childThreadId, record.status, record.createdAtMs);
    return record;
  }

  // 列出某个 parent thread 派生出的 child thread，后续用于 GUI 展示协作树。
  listThreadEdges(parentThreadId: string): MlloThreadEdgeRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM thread_edges WHERE parent_thread_id = ? ORDER BY created_at_ms ASC")
        .all(parentThreadId) as MlloThreadEdgeRow[]
    ).map(toMlloThreadEdgeRecord);
  }

  // 写入或更新 task 当前状态，task DAG 和 workflow 进度都先落这个索引。
  upsertTask(record: MlloTaskRecord): MlloTaskRecord {
    this.db
      .prepare(
        `
          INSERT INTO tasks (
            id, thread_id, subject, description, status, assignee,
            blocked_by_json, blocks_json, created_at_ms, updated_at_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id,
            subject = excluded.subject,
            description = excluded.description,
            status = excluded.status,
            assignee = excluded.assignee,
            blocked_by_json = excluded.blocked_by_json,
            blocks_json = excluded.blocks_json,
            updated_at_ms = excluded.updated_at_ms
        `,
      )
      .run(
        record.id,
        record.threadId,
        record.subject,
        record.description,
        record.status,
        record.assignee ?? null,
        stringifyMlloTaskLinks(record.blockedBy),
        stringifyMlloTaskLinks(record.blocks),
        record.createdAtMs,
        record.updatedAtMs,
      );
    return this.getTask(record.id) ?? record;
  }

  // 按 id 读取 task 当前状态，供 workflow UI 和调度器快速定位任务。
  getTask(taskId: string): MlloTaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | MlloTaskRow
      | undefined;
    return row === undefined ? undefined : toMlloTaskRecord(row);
  }

  // 列出 thread 下的任务，宿主应用可用它渲染 workflow / task 面板。
  listTasksForThread(threadId: string): MlloTaskRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY updated_at_ms ASC")
        .all(threadId) as MlloTaskRow[]
    ).map(toMlloTaskRecord);
  }

  // 写入或更新团队成员状态，第三方 agent worker 也要被 mllo 自己索引。
  upsertTeamMember(record: MlloTeamMemberRecord): MlloTeamMemberRecord {
    this.db
      .prepare(
        `
          INSERT INTO team_members (
            team_id, agent_id, agent_type, backend_type, name, cwd,
            subscriptions_json, runtime_handle, joined_at_ms, updated_at_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, agent_id) DO UPDATE SET
            agent_type = excluded.agent_type,
            backend_type = excluded.backend_type,
            name = excluded.name,
            cwd = excluded.cwd,
            subscriptions_json = excluded.subscriptions_json,
            runtime_handle = excluded.runtime_handle,
            updated_at_ms = excluded.updated_at_ms
        `,
      )
      .run(
        record.teamId,
        record.agentId,
        record.agentType,
        record.backendType,
        record.name,
        record.cwd,
        stringifyMlloSubscriptions(record.subscriptions),
        record.runtimeHandle ?? null,
        record.joinedAtMs,
        record.updatedAtMs,
      );
    return this.getTeamMember(record.teamId, record.agentId) ?? record;
  }

  // 读取单个团队成员，调度器恢复 worker handle 时需要这个索引。
  getTeamMember(teamId: string, agentId: string): MlloTeamMemberRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?")
      .get(teamId, agentId) as MlloTeamMemberRow | undefined;
    return row === undefined ? undefined : toMlloTeamMemberRecord(row);
  }

  // 列出团队成员，宿主应用的 worker/participant 面板后续应接这里。
  listTeamMembers(teamId: string): MlloTeamMemberRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM team_members WHERE team_id = ? ORDER BY updated_at_ms ASC")
        .all(teamId) as MlloTeamMemberRow[]
    ).map(toMlloTeamMemberRecord);
  }

  // 索引 checkpoint restore 审计事件，GUI 后续可按 thread 查询恢复历史。
  upsertCheckpointRestore(
    record: MlloCheckpointRestoreRecord,
    files: readonly MlloCheckpointRestoreFileRecord[],
  ): MlloCheckpointRestoreRecord {
    upsertMlloCheckpointRestore(this.db, record, files);
    return record;
  }

  // 列出某个 thread 的 checkpoint 恢复记录，来源仍可由 JSONL reindex 重建。
  listCheckpointRestoresForThread(threadId: string): MlloCheckpointRestoreRecord[] {
    return listMlloCheckpointRestoresForThread(this.db, threadId);
  }

  // 列出一次 checkpoint restore 涉及的文件结果，供 GUI 做审计详情页。
  listCheckpointRestoreFiles(restoreId: string): MlloCheckpointRestoreFileRecord[] {
    return listMlloCheckpointRestoreFiles(this.db, restoreId);
  }

  // 索引 worker 内部工具审计事件，后续 GUI/CLI 不需要扫描完整 JSONL。
  upsertWorkerToolEvent(record: MlloWorkerToolEventRecord): MlloWorkerToolEventRecord {
    upsertMlloWorkerToolEvent(this.db, record);
    return record;
  }

  // 列出某个 thread 下所有第三方 worker 的工具 use/result 审计记录。
  listWorkerToolEventsForThread(threadId: string): MlloWorkerToolEventRecord[] {
    return listMlloWorkerToolEventsForThread(this.db, threadId);
  }

  // 按 invocationId 配对 use/result，避免审计页用时间顺序猜测对应关系。
  listWorkerToolEventPairsForThread(threadId: string): MlloWorkerToolEventPair[] {
    return listMlloWorkerToolEventPairsForThread(this.db, threadId);
  }

  // interaction 是 JSONL request/resolution 事实的当前态投影，写入时不降级 resolved 行。
  upsertInteraction(record: MlloInteractionRecord): MlloInteractionRecord {
    upsertMlloInteraction(this.db, record);
    return this.getInteraction(record.id) ?? record;
  }

  // 按稳定 interaction id 读取待处理或已处理请求。
  getInteraction(interactionId: string): MlloInteractionRecord | undefined {
    return getMlloInteraction(this.db, interactionId);
  }

  // 给桌面宿主列出需要展示的 permission / elicitation 请求。
  listPendingInteractions(
    options: { threadId?: string; limit?: number } = {},
  ): MlloInteractionRecord[] {
    return listPendingMlloInteractions(this.db, {
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      limit: options.limit ?? 100,
    });
  }

  // 审计单个 thread 的 interaction 生命周期，可按状态筛选。
  listInteractionsForThread(
    threadId: string,
    options: { status?: MlloInteractionStatus; limit?: number } = {},
  ): MlloInteractionRecord[] {
    return listMlloInteractionsForThread(this.db, threadId, {
      ...(options.status === undefined ? {} : { status: options.status }),
      limit: options.limit ?? 100,
    });
  }
}
