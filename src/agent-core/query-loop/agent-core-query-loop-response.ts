import type { AgentCoreMessage, AgentCoreModelResponse } from './agent-core-query-types'

export function appendAgentCoreAssistantMessage(
  messages: AgentCoreMessage[],
  response: AgentCoreModelResponse
): AgentCoreMessage {
  const message: AgentCoreMessage = {
    role: 'assistant',
    content: response.content,
    toolCalls: response.toolCalls
  }
  messages.push(message)
  return message
}

export function agentCoreModelResponseHasToolCalls(response: AgentCoreModelResponse): boolean {
  return (response.toolCalls?.length ?? 0) > 0
}
