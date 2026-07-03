import type { AgentCoreCapability } from '../permissions/agent-core-permission-types'

// worker id 是跨 runtime 和日志的稳定标识；具体第三方实现不放在 agent-core。
export type AgentCoreWorkerId = string

// capability 用于主 agent 选择委托对象，避免把 review-only worker 派去写文件。
export type AgentCoreWorkerCapability =
  | 'planning'
  | 'review'
  | 'file-read'
  | 'workspace-write'
  | 'shell'
  | 'network'

// worker event 是外部 agent 回灌 mllo timeline 的最小公共事件协议。
export type AgentCoreWorkerEvent =
  | {
      type: 'worker-start'
      workerId: AgentCoreWorkerId
      label: string
    }
  | {
      type: 'assistant-delta'
      workerId: AgentCoreWorkerId
      content: string
    }
  | {
      type: 'tool-use'
      workerId: AgentCoreWorkerId
      invocationId?: string
      name: string
      input: unknown
    }
  | {
      type: 'tool-result'
      workerId: AgentCoreWorkerId
      invocationId?: string
      name: string
      output: unknown
      isError?: boolean
      outputTruncated?: boolean
      outputOriginalChars?: number
      outputMaxChars?: number
      outputBlobPath?: string
      outputBlobBytes?: number
    }
  | {
      type: 'permission-request'
      workerId: AgentCoreWorkerId
      requestId: string
      toolName: string
      capability: AgentCoreCapability
      reason: string
      input: unknown
    }
  | {
      type: 'permission-decision'
      workerId: AgentCoreWorkerId
      requestId: string
      status: 'allow' | 'deny'
      reason: string
    }
  | {
      type: 'worker-done'
      workerId: AgentCoreWorkerId
      content: string
    }
  | {
      type: 'worker-error'
      workerId: AgentCoreWorkerId
      message: string
    }

export type AgentCoreWorkerPermissionRequest = {
  requestId: string
  toolName: string
  capability: AgentCoreCapability
  reason: string
  input: unknown
}

// worker 权限决策只表达 allow/deny；具体执行仍由外部 worker 自己继续或失败。
export type AgentCoreWorkerPermissionDecision =
  | {
      status: 'allow'
    }
  | {
      status: 'deny'
      reason: string
    }

// request 只暴露 prompt/cwd/signal，避免外部 worker 直接拿到 mllo 内核状态。
export type AgentCoreWorkerRequest = {
  prompt: string
  cwd: string
  signal?: AbortSignal
  onEvent?: (event: AgentCoreWorkerEvent) => void
  // 外部 worker 遇到危险动作时调用这里，让 mllo GUI 权限流做最终决策。
  requestPermission?: (
    request: AgentCoreWorkerPermissionRequest
  ) => Promise<AgentCoreWorkerPermissionDecision>
}

// result 保持最小结构，复杂过程通过事件流记录到 session/timeline。
export type AgentCoreWorkerResult = {
  content: string
  // 权限拒绝不是普通完成；上层工具必须把它当失败结果回灌给主模型。
  status?: 'completed' | 'denied'
}

export type AgentCoreWorkerAvailabilityCheckResult = {
  available: boolean
  reason?: string
}

export type AgentCoreWorkerAvailabilityPolicy = {
  ttlMs?: number
  failureGraceMs?: number
  check?: () =>
    | AgentCoreWorkerAvailabilityCheckResult
    | Promise<AgentCoreWorkerAvailabilityCheckResult>
}

// AgentCoreWorker 是 mllo 调度外部 worker 的边界接口，不绑定具体实现。
export type AgentCoreWorker = {
  id: AgentCoreWorkerId
  label: string
  description: string
  capabilities: readonly AgentCoreWorkerCapability[]
  availability?: AgentCoreWorkerAvailabilityPolicy
  run: (request: AgentCoreWorkerRequest) => Promise<AgentCoreWorkerResult>
}
