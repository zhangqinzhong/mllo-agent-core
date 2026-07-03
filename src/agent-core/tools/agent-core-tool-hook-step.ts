import { runAgentCoreHooks } from '../hooks/agent-core-hook-runner'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type { AgentCorePermissionDecision } from '../permissions/agent-core-permission-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult,
  AgentCoreToolOrchestrationUpdate,
  AgentCoreToolResult
} from './agent-core-tool-types'

// 把 hook block 转成工具错误结果。模型必须收到 tool_result，不能留下悬空 tool call。
function blockedByHookExecution(reason: string | undefined): AgentCoreToolExecutionResult {
  return {
    status: 'ok',
    result: {
      content: reason ?? 'Tool call was blocked by hook.',
      isError: true
    }
  }
}

// 执行 pre-tool hooks。若 hook 阻止工具，直接返回可回灌模型的工具错误。
export async function* runPreToolHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, AgentCoreToolExecutionResult | null> {
  const hookDecision = yield* runAgentCoreHooks({
    hooks: args.hooks,
    context: {
      phase: 'pre-tool',
      cwd: args.cwd,
      call: args.call,
      signal: args.signal
    }
  })
  return hookDecision.action === 'block' ? blockedByHookExecution(hookDecision.reason) : null
}

// 执行权限请求 hooks。权限会暂停 query loop，所以 hook 事件必须在 tool-complete 前产出。
export async function* runPermissionRequestHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  decision: AgentCorePermissionDecision
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  yield* runAgentCoreHooks({
    hooks: args.hooks,
    context: {
      phase: 'permission-request',
      cwd: args.cwd,
      call: args.call,
      permissionDecision: args.decision,
      signal: args.signal
    }
  })
}

// 执行 post-tool hooks。第一轮只产出审计事件，不改变已经完成的工具结果。
export async function* runPostToolHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  result: AgentCoreToolResult
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  yield* runAgentCoreHooks({
    hooks: args.hooks,
    context: {
      phase: 'post-tool',
      cwd: args.cwd,
      call: args.call,
      result: args.result,
      signal: args.signal
    }
  })
}

// 执行工具失败后的 hooks。失败结果仍会先回灌模型，hook 只负责审计和外部联动。
export async function* runPostToolFailureHooks(args: {
  hooks: readonly AgentCoreHookDefinition[]
  cwd: string
  call: AgentCoreToolCall
  result?: AgentCoreToolResult
  signal?: AbortSignal
}): AsyncGenerator<AgentCoreToolOrchestrationUpdate, void> {
  yield* runAgentCoreHooks({
    hooks: args.hooks,
    context: {
      phase: 'post-tool-failure',
      cwd: args.cwd,
      call: args.call,
      result: args.result,
      signal: args.signal
    }
  })
}
