import type { AgentCorePermissionResumeDecision } from '../query-loop/agent-core-permission-resume'
import type { AgentCoreQueryLoopResult } from '../query-loop/agent-core-query-types'
import type {
  AgentCoreWorkerId,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest
} from '../workers/agent-core-worker-types'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'
import { redactAgentCorePermissionCallInput } from './agent-core-permission-input-redaction'

// 记录用户对权限请求的响应。allow/deny 必须独立审计，不能只靠 tool_result 反推。
export async function recordAgentCorePermissionDecision(args: {
  session: AgentCorePreparedRunSession
  result: Extract<AgentCoreQueryLoopResult, { status: 'waiting-for-permission' }>
  decision: AgentCorePermissionResumeDecision
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createPermissionEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      call: redactAgentCorePermissionCallInput({
        call: args.result.call,
        decision: args.result.decision
      }),
      request: args.result.decision,
      response: args.decision
    })
  )
}

// 记录外部 worker 的权限响应。worker 不一定产出 tool_result，所以必须单独落审计。
export async function recordAgentCoreWorkerPermissionDecision(args: {
  session: AgentCorePreparedRunSession
  workerId: AgentCoreWorkerId
  request: AgentCoreWorkerPermissionRequest
  decision: AgentCoreWorkerPermissionDecision
}): Promise<void> {
  await args.session.store.appendEntry(
    args.session.handle,
    args.session.store.createWorkerPermissionEventEntry({
      sessionId: args.session.handle.sessionId,
      cwd: args.session.handle.cwd,
      workerId: args.workerId,
      request: args.request,
      response: args.decision
    })
  )
}
