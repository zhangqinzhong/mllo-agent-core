import type { AgentCoreMessage } from '../query-loop/agent-core-query-types'
import {
  resumeAgentCoreSession,
  type AgentCoreResumeResult
} from '../session/agent-core-session-resume'
import type { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'

export type AgentCoreContextSessionResumeOptions = {
  store: AgentCoreJsonlSessionStore
  handle: AgentCoreSessionHandle
  resume?: boolean
  maxIndexedResumeEntries?: number
  maxIndexedResumeBytes?: number
}

// 合并恢复出来的历史消息和本轮新消息。新消息总是追加在恢复消息之后。
export function combineAgentCoreContextMessages(
  resume: AgentCoreResumeResult | undefined,
  newMessages: readonly AgentCoreMessage[] | undefined
): AgentCoreMessage[] {
  return [...(resume?.messages ?? []), ...(newMessages ?? [])]
}

// 如果调用方要求 resume，就从 JSONL 恢复历史；否则从空历史开始。
export async function maybeResumeAgentCoreContextSession(
  session: AgentCoreContextSessionResumeOptions | undefined
): Promise<AgentCoreResumeResult | undefined> {
  if (session?.resume !== true) {
    return undefined
  }
  return await resumeAgentCoreSession({
    store: session.store,
    handle: session.handle,
    maxIndexedResumeEntries: session.maxIndexedResumeEntries,
    maxIndexedResumeBytes: session.maxIndexedResumeBytes
  })
}
