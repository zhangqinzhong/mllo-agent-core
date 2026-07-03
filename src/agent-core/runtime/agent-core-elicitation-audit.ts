import type { AgentCoreElicitationResumeDecision } from '../query-loop/agent-core-elicitation-resume'
import type { AgentCoreQueryLoopResult } from '../query-loop/agent-core-query-types'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'

// 记录用户对 ask_user 的回答或取消。它是审计事实，不能只依赖后续 tool_result 文本。
export async function recordAgentCoreElicitationDecision(args: {
  session: AgentCorePreparedRunSession
  result: Extract<AgentCoreQueryLoopResult, { status: 'waiting-for-elicitation' }>
  decision: AgentCoreElicitationResumeDecision
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createElicitationEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      call: args.result.call,
      request: args.result.request,
      response: args.decision
    })
  )
}
