import { runAgentCoreQueryLoop } from './agent-core-query-loop'
import type {
  AgentCoreModelAdapter,
  AgentCoreModelResponse,
  AgentCoreModelStreamEvent,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult
} from './agent-core-query-types'

export async function collectQueryLoop(args: AgentCoreQueryLoopArgs): Promise<{
  events: AgentCoreQueryEvent[]
  result: AgentCoreQueryLoopResult
}> {
  const generator = runAgentCoreQueryLoop(args)
  const events: AgentCoreQueryEvent[] = []

  while (true) {
    const item = await generator.next()
    if (item.done === true) {
      return {
        events,
        result: item.value
      }
    }
    events.push(item.value)
  }
}

export function scriptedModel(responses: AgentCoreModelResponse[]): AgentCoreModelAdapter {
  let index = 0
  return {
    async complete() {
      const response = responses[index]
      index += 1
      if (response === undefined) {
        throw new Error('No scripted model response left.')
      }
      return response
    }
  }
}

export function scriptedStreamModel(events: AgentCoreModelStreamEvent[]): AgentCoreModelAdapter {
  return {
    async *stream() {
      for (const event of events) {
        yield event
      }
    }
  }
}

export function loopArgs(overrides: Partial<AgentCoreQueryLoopArgs>): AgentCoreQueryLoopArgs {
  return {
    cwd: '/workspace/project',
    messages: [
      {
        role: 'user',
        content: 'hello'
      }
    ],
    model: scriptedModel([
      {
        content: 'done'
      }
    ]),
    ...overrides
  }
}
