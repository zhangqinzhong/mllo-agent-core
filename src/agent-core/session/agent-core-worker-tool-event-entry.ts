import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type { AgentCoreSessionEntry } from './agent-core-session-types'

export type AgentCoreWorkerToolSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'worker-tool-event' }
>

export type AgentCoreWorkerToolEventEntryArgs = {
  sessionId: string
  cwd: string
  tool: AgentCoreWorkerToolSessionEntry['tool']
}

// worker tool-use 既保留在 timeline，也要有独立审计 entry 供后续 reindex 使用。
export function createAgentCoreWorkerToolEventEntry(
  args: AgentCoreWorkerToolEventEntryArgs
): AgentCoreWorkerToolSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'worker-tool-event',
    sessionId: args.sessionId,
    cwd: args.cwd,
    tool: args.tool
  })
}
