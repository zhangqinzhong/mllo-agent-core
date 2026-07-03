import { withAgentCoreSessionEntryEnvelope } from './agent-core-session-entry-envelope'
import type { AgentCoreSessionEntry } from './agent-core-session-types'

export type AgentCoreWorkerToolResultSessionEntry = Extract<
  AgentCoreSessionEntry,
  { kind: 'worker-tool-result-event' }
>

export type AgentCoreWorkerToolResultEventEntryArgs = {
  sessionId: string
  cwd: string
  result: AgentCoreWorkerToolResultSessionEntry['result']
}

// worker tool-result 单独落盘，后续审计可以配对“用了什么工具”和“结果是什么”。
export function createAgentCoreWorkerToolResultEventEntry(
  args: AgentCoreWorkerToolResultEventEntryArgs
): AgentCoreWorkerToolResultSessionEntry {
  return withAgentCoreSessionEntryEnvelope({
    kind: 'worker-tool-result-event',
    sessionId: args.sessionId,
    cwd: args.cwd,
    result: args.result
  })
}
