import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type { AgentCoreSessionEntry } from './agent-core-session-types'

export type AgentCoreCheckpointRestoreSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'checkpoint-restore-event' }
>

export type AgentCoreCheckpointRestoreEventEntryArgs = {
  sessionId: string
  cwd: string
  restore: AgentCoreCheckpointRestoreSessionEntry['restore']
}

// checkpoint restore 是可逆文件动作，必须独立落审计 entry。
export function createAgentCoreCheckpointRestoreEventEntry(
  args: AgentCoreCheckpointRestoreEventEntryArgs
): AgentCoreCheckpointRestoreSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'checkpoint-restore-event',
    sessionId: args.sessionId,
    cwd: args.cwd,
    restore: args.restore
  })
}
