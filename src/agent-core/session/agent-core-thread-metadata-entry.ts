import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type {
  AgentCoreSessionEntry,
  AgentCoreThreadMetadataPatch
} from './agent-core-session-types'

export type AgentCoreThreadMetadataSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'thread-metadata-event' }
>

// 创建 thread metadata entry。用户改名/归档这类操作要独立入账，不能只依赖当前态快照。
export function createAgentCoreThreadMetadataEventEntry(args: {
  sessionId: string
  cwd: string
  patch: AgentCoreThreadMetadataPatch
}): AgentCoreThreadMetadataSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'thread-metadata-event',
    sessionId: args.sessionId,
    cwd: args.cwd,
    patch: args.patch
  })
}
