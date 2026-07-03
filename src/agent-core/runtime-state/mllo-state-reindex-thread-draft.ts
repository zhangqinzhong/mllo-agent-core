import type {
  AgentCoreSessionEntry,
  AgentCoreThreadRunStatus,
  AgentCoreThreadStateSnapshot
} from '../session/agent-core-session-types'
import type { MlloThreadRecord } from './mllo-thread-records'

export type MlloReindexThreadDraft = {
  sessionId: string
  transcriptPath: string
  cwd: string
  title: string
  preview: string
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
  createdAtMs: number
  updatedAtMs: number
}

// 把 ISO 时间转成毫秒时间戳。坏时间回退到 Date.now，避免损坏旧日志阻断全量重建。
export function parseMlloReindexTimestampMs(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

// 把消息文本压成单行，复用 thread 列表对标题和预览的展示约束。
function compactSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// 从 session metadata 建立 thread 草稿。模型信息旧日志里没有时用 unknown 占位。
export function createMlloReindexThreadDraft(
  entry: Extract<AgentCoreSessionEntry, { kind: 'session-metadata' }>,
  transcriptPath: string
): MlloReindexThreadDraft {
  const createdAtMs = parseMlloReindexTimestampMs(entry.metadata.createdAt)
  return {
    sessionId: entry.sessionId,
    transcriptPath,
    cwd: entry.metadata.cwd,
    title: 'New mllo thread',
    preview: '',
    modelProvider: 'unknown',
    approvalMode: 'ask',
    sandboxPolicy: 'permission-gated-workspace+local-unsandboxed-process',
    tokensUsed: 0,
    resumeOmittedEntries: 0,
    resumeOmittedBytes: 0,
    runStatus: 'completed',
    archived: false,
    createdAtMs,
    updatedAtMs: createdAtMs
  }
}

// 用 message entry 更新标题和预览。标题优先取第一条 user，预览优先取最新 assistant。
export function applyMlloMessageToThreadDraft(
  draft: MlloReindexThreadDraft,
  entry: Extract<AgentCoreSessionEntry, { kind: 'message' }>
): void {
  const text = compactSingleLine(entry.message.content)
  if (entry.message.role === 'user' && draft.title === 'New mllo thread' && text.length > 0) {
    draft.title = text.slice(0, 80)
  }
  if (entry.message.role === 'assistant' && text.length > 0) {
    draft.preview = text.slice(0, 240)
  } else if (draft.preview.length === 0 && text.length > 0) {
    draft.preview = text.slice(0, 240)
  }
  draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
}

// 用 budget event 更新 token 估算。state.sqlite 只需要当前列表展示级别的最后值。
export function applyMlloBudgetToThreadDraft(
  draft: MlloReindexThreadDraft,
  entry: Extract<AgentCoreSessionEntry, { kind: 'budget-event' }>
): void {
  if (entry.inputTokens !== undefined) {
    draft.tokensUsed = entry.inputTokens
  }
  draft.updatedAtMs = parseMlloReindexTimestampMs(entry.timestamp)
}

// 用 transcript 里的 thread state snapshot 覆盖草稿。它比 message/budget 推断更精确。
export function applyMlloThreadStateSnapshot(
  draft: MlloReindexThreadDraft,
  snapshot: AgentCoreThreadStateSnapshot
): void {
  draft.title = snapshot.title
  draft.preview = snapshot.preview
  draft.modelProvider = snapshot.modelProvider
  draft.model = snapshot.model
  draft.approvalMode = snapshot.approvalMode
  draft.sandboxPolicy = snapshot.sandboxPolicy
  draft.tokensUsed = snapshot.tokensUsed
  draft.resumeOmittedEntries = snapshot.resumeOmittedEntries
  draft.resumeOmittedBytes = snapshot.resumeOmittedBytes
  draft.runStatus = snapshot.runStatus ?? 'completed'
  draft.runMessage = snapshot.runMessage
  draft.archived = snapshot.archived
  draft.createdAtMs = snapshot.createdAtMs
  draft.updatedAtMs = snapshot.updatedAtMs
}

// 应用用户或系统写入的 thread 元数据补丁。它用于保留手动改名/归档等显式操作。
export function applyMlloThreadMetadataPatch(
  draft: MlloReindexThreadDraft,
  entry: Extract<AgentCoreSessionEntry, { kind: 'thread-metadata-event' }>
): void {
  if (entry.patch.title !== undefined) {
    draft.title = entry.patch.title
  }
  if (entry.patch.archived !== undefined) {
    draft.archived = entry.patch.archived
  }
  draft.updatedAtMs = entry.patch.updatedAtMs
}

// 把 thread 草稿转成 state store 可写入的稳定记录。
export function mlloThreadDraftToRecord(draft: MlloReindexThreadDraft): MlloThreadRecord {
  const record: MlloThreadRecord = {
    id: draft.sessionId,
    rolloutPath: draft.transcriptPath,
    cwd: draft.cwd,
    title: draft.title,
    modelProvider: draft.modelProvider,
    approvalMode: draft.approvalMode,
    sandboxPolicy: draft.sandboxPolicy,
    tokensUsed: draft.tokensUsed,
    resumeOmittedEntries: draft.resumeOmittedEntries,
    resumeOmittedBytes: draft.resumeOmittedBytes,
    runStatus: draft.runStatus,
    runMessage: draft.runMessage,
    archived: draft.archived,
    preview: draft.preview,
    createdAtMs: draft.createdAtMs,
    updatedAtMs: draft.updatedAtMs
  }
  if (draft.model !== undefined) {
    record.model = draft.model
  }
  return record
}
