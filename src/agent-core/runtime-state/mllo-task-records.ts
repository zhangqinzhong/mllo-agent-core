export type MlloTaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked'

export type MlloTaskRecord = {
  id: string
  threadId: string
  subject: string
  description: string
  status: MlloTaskStatus
  assignee?: string
  blockedBy: string[]
  blocks: string[]
  createdAtMs: number
  updatedAtMs: number
}

export type MlloTaskRow = {
  id: string
  thread_id: string
  subject: string
  description: string
  status: MlloTaskStatus
  assignee: string | null
  blocked_by_json: string
  blocks_json: string
  created_at_ms: number
  updated_at_ms: number
}

// 解析 task 依赖 JSON，损坏或非字符串项不应继续污染调度状态。
function parseStringArray(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return []
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

// 把 SQLite task 行转成业务对象，防止 JSON 字段泄漏到上层调用者。
export function toMlloTaskRecord(row: MlloTaskRow): MlloTaskRecord {
  const record: MlloTaskRecord = {
    id: row.id,
    threadId: row.thread_id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    blockedBy: parseStringArray(row.blocked_by_json),
    blocks: parseStringArray(row.blocks_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
  if (row.assignee !== null) {
    record.assignee = row.assignee
  }
  return record
}

// 统一序列化 task 依赖数组，保证写入 SQLite 的 JSON 形态稳定。
export function stringifyMlloTaskLinks(values: readonly string[] = []): string {
  return JSON.stringify([...values])
}
