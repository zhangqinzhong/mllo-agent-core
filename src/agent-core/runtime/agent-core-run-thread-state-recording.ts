import type { AgentCoreHttpModelConfig } from '../model/agent-core-http-model-config'
import type { AgentCoreQueryLoopResult } from '../query-loop/agent-core-query-types'
import { syncAgentCoreRunThreadState } from './agent-core-run-state'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'
import { recordAgentCoreThreadStateSnapshot } from './agent-core-run-recording'

export type AgentCoreRunThreadStateSyncArgs = {
  session: AgentCorePreparedRunSession
  input: string
  provider: AgentCoreHttpModelConfig
  permissionMode: string
  sandboxPolicy: string
  estimatedInputTokens?: number
  resumeOmittedEntries: number
  resumeOmittedBytes: number
  result?: AgentCoreQueryLoopResult
}

// 同步 thread 当前态到 SQLite，并把同一份快照写入 JSONL，保证 reindex 可恢复精确状态。
export async function syncAndRecordAgentCoreThreadState(
  args: AgentCoreRunThreadStateSyncArgs
): Promise<void> {
  const thread = syncAgentCoreRunThreadState({
    stateStore: args.session.stateStore,
    session: args.session.handle,
    input: args.input,
    provider: args.provider,
    permissionMode: args.permissionMode,
    sandboxPolicy: args.sandboxPolicy,
    estimatedInputTokens: args.estimatedInputTokens,
    resumeOmittedEntries: args.resumeOmittedEntries,
    resumeOmittedBytes: args.resumeOmittedBytes,
    result: args.result
  })
  await recordAgentCoreThreadStateSnapshot({
    session: args.session,
    thread
  })
}
