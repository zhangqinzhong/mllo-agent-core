import type { AgentCorePermissionMode } from '../permissions/agent-core-permission-types'
import type { AgentCoreShellExecutionBackend } from '../tools/shell-execution-backend'

export type AgentCoreRunSandboxPolicy =
  | 'permission-gated-workspace+local-unsandboxed-process'
  | 'permission-gated-workspace+local-sandboxed-process'
  | 'permission-gated-workspace+remote-unsandboxed-process'
  | 'permission-gated-workspace+remote-sandboxed-process'
  | 'permission-bypass+local-unsandboxed-process'
  | 'permission-bypass+local-sandboxed-process'
  | 'permission-bypass+remote-unsandboxed-process'
  | 'permission-bypass+remote-sandboxed-process'

function processBoundary(backend: AgentCoreShellExecutionBackend | undefined): string {
  const location = backend?.remote === true ? 'remote' : 'local'
  const isolation = backend?.sandboxed === true ? 'sandboxed-process' : 'unsandboxed-process'
  return `${location}-${isolation}`
}

// sandboxPolicy 记录真实运行边界：权限/路径 guard 和进程隔离分开，不再把 ask 当 sandbox。
export function getAgentCoreRunSandboxPolicy(args: {
  permissionMode: AgentCorePermissionMode | undefined
  shellExecutionBackend?: AgentCoreShellExecutionBackend
}): AgentCoreRunSandboxPolicy {
  const permissionBoundary =
    args.permissionMode === 'dangerously-bypass'
      ? 'permission-bypass'
      : 'permission-gated-workspace'
  return `${permissionBoundary}+${processBoundary(args.shellExecutionBackend)}` as AgentCoreRunSandboxPolicy
}
