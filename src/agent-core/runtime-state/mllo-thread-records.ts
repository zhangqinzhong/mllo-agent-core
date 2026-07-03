import type { AgentCoreThreadRunStatus } from '../session/agent-core-session-types'

export type MlloThreadRecord = {
  id: string
  rolloutPath: string
  cwd: string
  title: string
  modelProvider: string
  model?: string
  approvalMode: string
  sandboxPolicy: string
  tokensUsed: number
  resumeOmittedEntries: number
  resumeOmittedBytes: number
  runStatus: AgentCoreThreadRunStatus
  runMessage?: string
  archived: boolean
  preview: string
  createdAtMs: number
  updatedAtMs: number
}

export type MlloThreadEdgeStatus = 'active' | 'completed' | 'cancelled'

export type MlloThreadEdgeRecord = {
  parentThreadId: string
  childThreadId: string
  status: MlloThreadEdgeStatus
  createdAtMs: number
}

export type MlloThreadRow = {
  id: string
  rollout_path: string
  cwd: string
  title: string
  model_provider: string
  model: string | null
  approval_mode: string
  sandbox_policy: string
  tokens_used: number
  resume_omitted_entries: number
  resume_omitted_bytes: number
  run_status: AgentCoreThreadRunStatus
  run_message: string | null
  archived: number
  preview: string
  created_at_ms: number
  updated_at_ms: number
}

export type MlloThreadEdgeRow = {
  parent_thread_id: string
  child_thread_id: string
  status: MlloThreadEdgeStatus
  created_at_ms: number
}

// 把 SQLite 行转成 Agent Core 内部字段名，避免上层到处感知 snake_case。
export function toMlloThreadRecord(row: MlloThreadRow): MlloThreadRecord {
  const record: MlloThreadRecord = {
    id: row.id,
    rolloutPath: row.rollout_path,
    cwd: row.cwd,
    title: row.title,
    modelProvider: row.model_provider,
    approvalMode: row.approval_mode,
    sandboxPolicy: row.sandbox_policy,
    tokensUsed: row.tokens_used,
    resumeOmittedEntries: row.resume_omitted_entries,
    resumeOmittedBytes: row.resume_omitted_bytes,
    runStatus: row.run_status,
    archived: row.archived === 1,
    preview: row.preview,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
  if (row.model !== null) {
    record.model = row.model
  }
  if (row.run_message !== null) {
    record.runMessage = row.run_message
  }
  return record
}

// 把 thread 关系行转成稳定对象，GUI 后续用它重建父子会话关系。
export function toMlloThreadEdgeRecord(row: MlloThreadEdgeRow): MlloThreadEdgeRecord {
  return {
    parentThreadId: row.parent_thread_id,
    childThreadId: row.child_thread_id,
    status: row.status,
    createdAtMs: row.created_at_ms
  }
}
