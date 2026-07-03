import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type { AgentCoreSessionEntry, AgentCoreThreadEdgeSnapshot } from './agent-core-session-types'

export type AgentCoreThreadEdgeSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'thread-edge-event' }
>

// 创建 thread edge entry。父子会话关系必须进 JSONL，state.sqlite 才能被完整重建。
export function createAgentCoreThreadEdgeEventEntry(args: {
  sessionId: string
  cwd: string
  edge: AgentCoreThreadEdgeSnapshot
}): AgentCoreThreadEdgeSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'thread-edge-event',
    sessionId: args.sessionId,
    cwd: args.cwd,
    edge: args.edge
  })
}
