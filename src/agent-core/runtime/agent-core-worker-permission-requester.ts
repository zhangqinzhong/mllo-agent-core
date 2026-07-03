import type {
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest
} from '../workers/agent-core-worker-types'
import type { AgentCoreWorker } from '../workers/agent-core-worker-types'
import { recordAgentCoreWorkerPermissionDecision } from './agent-core-permission-audit'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'
import type { AgentCoreRunControllerOptions } from './agent-core-run-controller-types'

export type AgentCoreWorkerPermissionRequester = (
  request: AgentCoreWorkerPermissionRequest & {
    workerId: AgentCoreWorker['id']
  }
) => Promise<AgentCoreWorkerPermissionDecision>

// 创建带审计的 worker 权限请求函数。这样外部 worker 的审批不会只停留在 timeline。
export function createAgentCoreWorkerPermissionRequester(args: {
  session: AgentCorePreparedRunSession
  onRequest: AgentCoreRunControllerOptions['onWorkerPermissionRequest']
}): AgentCoreWorkerPermissionRequester | undefined {
  if (args.onRequest === undefined) {
    return undefined
  }
  return async (request) => {
    const decision = await args.onRequest!(request)
    await recordAgentCoreWorkerPermissionDecision({
      session: args.session,
      workerId: request.workerId,
      request,
      decision
    })
    return decision
  }
}
