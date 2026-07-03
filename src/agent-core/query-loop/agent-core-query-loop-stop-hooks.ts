import { runAgentCoreHooks } from '../hooks/agent-core-hook-runner'
import type { AgentCoreHookRunResult } from '../hooks/agent-core-hook-types'
import type { AgentCoreQueryEvent, AgentCoreQueryLoopArgs } from './agent-core-query-types'

export async function* runAgentCoreStopHooksStep(
  args: AgentCoreQueryLoopArgs,
  content: string
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreHookRunResult> {
  return yield* runAgentCoreHooks({
    hooks: args.hooks ?? [],
    context: {
      phase: 'stop',
      cwd: args.cwd,
      finalContent: content,
      signal: args.signal
    }
  })
}
