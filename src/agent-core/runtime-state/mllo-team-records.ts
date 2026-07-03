export type MlloTeamMemberRecord = {
  teamId: string
  agentId: string
  agentType: string
  backendType: string
  name: string
  cwd: string
  subscriptions: string[]
  runtimeHandle?: string
  joinedAtMs: number
  updatedAtMs: number
}

export type MlloTeamMemberRow = {
  team_id: string
  agent_id: string
  agent_type: string
  backend_type: string
  name: string
  cwd: string
  subscriptions_json: string
  runtime_handle: string | null
  joined_at_ms: number
  updated_at_ms: number
}

// 解析订阅 JSON，保证旧数据里混入的非字符串项不会进入 worker 面板。
function parseSubscriptions(value: string): string[] {
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

// 把 team member 行转成业务对象，后续 运行态面板不需要读 JSON 字符串。
export function toMlloTeamMemberRecord(row: MlloTeamMemberRow): MlloTeamMemberRecord {
  const record: MlloTeamMemberRecord = {
    teamId: row.team_id,
    agentId: row.agent_id,
    agentType: row.agent_type,
    backendType: row.backend_type,
    name: row.name,
    cwd: row.cwd,
    subscriptions: parseSubscriptions(row.subscriptions_json),
    joinedAtMs: row.joined_at_ms,
    updatedAtMs: row.updated_at_ms
  }
  if (row.runtime_handle !== null) {
    record.runtimeHandle = row.runtime_handle
  }
  return record
}

// 统一序列化订阅列表，保证 team member upsert 不产生不稳定字段顺序。
export function stringifyMlloSubscriptions(values: readonly string[] = []): string {
  return JSON.stringify([...values])
}
