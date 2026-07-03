import type {
  AgentCoreMessage,
  AgentCoreModelResponse,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from '../query-loop/agent-core-query-types'
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolExecutionResult,
  AgentCoreToolResult
} from '../tools/agent-core-tool-types'

export type AgentCoreMiddlewareContext = {
  queryArgs: AgentCoreQueryLoopArgs
  messages: AgentCoreMessage[]
}

export type AgentCoreMiddlewareModelContext = AgentCoreMiddlewareContext & {
  turn: number
}

export type AgentCoreMiddlewareToolContext = AgentCoreMiddlewareContext & {
  call: AgentCoreToolCall
  execution: AgentCoreToolExecutionResult
  result?: AgentCoreToolResult
}

export type AgentCoreMiddleware = {
  name: string
  collectTools?: (
    context: AgentCoreMiddlewareContext
  ) => readonly AgentCoreToolDefinition[] | Promise<readonly AgentCoreToolDefinition[]>
  beforeAgent?: (context: AgentCoreMiddlewareContext) => void | Promise<void>
  beforeModel?: (context: AgentCoreMiddlewareModelContext) => void | Promise<void>
  afterModel?: (
    context: AgentCoreMiddlewareModelContext & {
      response: AgentCoreModelResponse
    }
  ) => void | Promise<void>
  beforeToolsBatch?: (
    context: AgentCoreMiddlewareModelContext & {
      calls: readonly AgentCoreToolCall[]
    }
  ) => void | Promise<void>
  afterTool?: (context: AgentCoreMiddlewareToolContext) => void | Promise<void>
  afterToolsBatch?: (
    context: AgentCoreMiddlewareModelContext & {
      calls: readonly AgentCoreToolCall[]
    }
  ) => void | Promise<void>
  afterAgent?: (
    context: AgentCoreMiddlewareContext & {
      result: AgentCoreQueryLoopResult
    }
  ) => AgentCoreQueryLoopResult | void | Promise<AgentCoreQueryLoopResult | void>
  onError?: (
    context: AgentCoreMiddlewareContext & {
      error: unknown
    }
  ) => void | Promise<void>
}
