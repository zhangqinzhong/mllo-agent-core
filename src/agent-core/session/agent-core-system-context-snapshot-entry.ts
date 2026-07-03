import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type { AgentCoreSessionEntry } from './agent-core-session-types'

export type AgentCoreSystemContextSnapshotEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'system-context-snapshot' }
>

// 创建 system context snapshot entry。prompt cache 边界属于 session 事实，不放进临时状态。
export function createAgentCoreSystemContextSnapshotEntry(args: {
  sessionId: string
  cwd: string
  snapshot: AgentCoreSystemContextSnapshotEntry['snapshot']
}): AgentCoreSystemContextSnapshotEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'system-context-snapshot',
    sessionId: args.sessionId,
    cwd: args.cwd,
    snapshot: args.snapshot
  })
}
