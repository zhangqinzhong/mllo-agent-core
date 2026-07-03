import type {
  AgentCoreMiddleware,
  AgentCoreMiddlewareContext,
  AgentCoreMiddlewareModelContext,
  AgentCoreMiddlewareToolContext
} from './agent-core-middleware-types'
import type { AgentCoreModelResponse } from '../query-loop/agent-core-query-types'
import type { AgentCoreQueryLoopResult } from '../query-loop/agent-core-query-types'
import type { AgentCoreToolCall, AgentCoreToolDefinition } from '../tools/agent-core-tool-types'

export type AgentCoreMiddlewareChain = {
  collectTools: (context: AgentCoreMiddlewareContext) => Promise<AgentCoreToolDefinition[]>
  beforeAgent: (context: AgentCoreMiddlewareContext) => Promise<void>
  beforeModel: (context: AgentCoreMiddlewareModelContext) => Promise<void>
  afterModel: (
    context: AgentCoreMiddlewareModelContext & {
      response: AgentCoreModelResponse
    }
  ) => Promise<void>
  beforeToolsBatch: (
    context: AgentCoreMiddlewareModelContext & {
      calls: readonly AgentCoreToolCall[]
    }
  ) => Promise<void>
  afterTool: (context: AgentCoreMiddlewareToolContext) => Promise<void>
  afterToolsBatch: (
    context: AgentCoreMiddlewareModelContext & {
      calls: readonly AgentCoreToolCall[]
    }
  ) => Promise<void>
  afterAgent: (
    context: AgentCoreMiddlewareContext & {
      result: AgentCoreQueryLoopResult
    }
  ) => Promise<AgentCoreQueryLoopResult>
  onError: (
    context: AgentCoreMiddlewareContext & {
      error: unknown
    }
  ) => Promise<void>
}

async function runMiddlewareStep<TContext>(
  middlewares: readonly AgentCoreMiddleware[],
  method: keyof AgentCoreMiddleware,
  context: TContext
): Promise<void> {
  for (const middleware of middlewares) {
    const hook = middleware[method]
    if (typeof hook !== 'function') {
      continue
    }
    await hook(context as never)
  }
}

export function createAgentCoreMiddlewareChain(
  middlewares: readonly AgentCoreMiddleware[] = []
): AgentCoreMiddlewareChain {
  return {
    async collectTools(context) {
      const tools: AgentCoreToolDefinition[] = []
      for (const middleware of middlewares) {
        const collected = await middleware.collectTools?.(context)
        if (collected !== undefined) {
          tools.push(...collected)
        }
      }
      return tools
    },
    async beforeAgent(context) {
      await runMiddlewareStep(middlewares, 'beforeAgent', context)
    },
    async beforeModel(context) {
      await runMiddlewareStep(middlewares, 'beforeModel', context)
    },
    async afterModel(context) {
      await runMiddlewareStep(middlewares, 'afterModel', context)
    },
    async beforeToolsBatch(context) {
      await runMiddlewareStep(middlewares, 'beforeToolsBatch', context)
    },
    async afterTool(context) {
      await runMiddlewareStep(middlewares, 'afterTool', context)
    },
    async afterToolsBatch(context) {
      await runMiddlewareStep(middlewares, 'afterToolsBatch', context)
    },
    async afterAgent(context) {
      let result = context.result
      for (const middleware of middlewares) {
        const next = await middleware.afterAgent?.({
          ...context,
          result
        })
        if (next !== undefined) {
          result = next
        }
      }
      return result
    },
    async onError(context) {
      await runMiddlewareStep(middlewares, 'onError', context)
    }
  }
}
