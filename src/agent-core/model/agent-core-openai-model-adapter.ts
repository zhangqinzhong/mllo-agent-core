import type {
  AgentCoreModelAdapter,
  AgentCoreModelRequest,
  AgentCoreModelResponse,
  AgentCoreModelStreamEvent
} from '../query-loop/agent-core-query-types'
import type { AgentCoreHttpModelConfig } from './agent-core-http-model-config'
import {
  fetchAgentCoreModelResponse,
  type AgentCoreModelFetch
} from './agent-core-model-fetch-response'
import {
  createAgentCoreToolCall,
  normalizeAgentCoreMessagesForWire,
  stringifyAgentCoreToolCallInput,
  toAgentCoreWireToolSchema
} from './agent-core-model-wire'
import {
  createAgentCoreModelHttpError,
  createAgentCoreModelProviderError
} from './agent-core-model-error-classification'
import { readAgentCoreSseData } from './agent-core-sse-events'
import { parseAgentCoreStreamJsonEvent } from './agent-core-stream-json-event'
import {
  flushOpenAIToolCalls,
  mergeOpenAIToolCallDeltas,
  type OpenAIStreamingToolCall
} from './agent-core-openai-streaming-tool-calls'

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }[]
}

type OpenAIChatCompletionResponse = {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: {
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }[]
    }
  }[]
  error?: {
    message?: string
  }
}

type OpenAIChatCompletionChunk = {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }[]
    }
  }[]
  error?: {
    message?: string
  }
}

// 读取 OpenAI 错误响应。stream 失败时服务端通常还是返回 JSON 错误体。
async function readOpenAIErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as OpenAIChatCompletionResponse
    return body.error?.message ?? fallback
  } catch {
    return fallback
  }
}

// OpenAI 协议把 system 作为普通 message；tool call/result 通过 tool_calls/tool_call_id 关联。
function toOpenAIMessages(request: AgentCoreModelRequest): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = []
  if (request.systemPrompt !== undefined && request.systemPrompt.length > 0) {
    messages.push({
      role: 'system',
      content: request.systemPrompt
    })
  }

  for (const message of normalizeAgentCoreMessagesForWire(request.messages)) {
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: message.content
      })
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name
      })
      continue
    }
    messages.push({
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: stringifyAgentCoreToolCallInput(call)
        }
      }))
    })
  }
  return messages
}

// OpenAI 兼容端点路径通常是 base_url + /chat/completions。
function openAICompletionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`
}

// 构建 OpenAI 请求体。stream/complete 共用，避免协议字段漂移。
function createOpenAIRequestBody(
  request: AgentCoreModelRequest,
  config: AgentCoreHttpModelConfig,
  stream: boolean
): string {
  return JSON.stringify({
    model: config.model,
    messages: toOpenAIMessages(request),
    tools: request.tools.map((tool) => {
      const schema = toAgentCoreWireToolSchema(tool)
      return {
        type: 'function',
        function: {
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters
        }
      }
    }),
    stream,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  })
}

// 创建 OpenAI-compatible adapter。OpenAI-compatible 端点都走这里。
export function createAgentCoreOpenAIModelAdapter(
  config: AgentCoreHttpModelConfig,
  fetchImpl: AgentCoreModelFetch = fetch
): AgentCoreModelAdapter {
  return {
    async complete(request: AgentCoreModelRequest): Promise<AgentCoreModelResponse> {
      const response = await fetchAgentCoreModelResponse({
        fetchImpl,
        url: openAICompletionUrl(config.baseUrl),
        init: {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: createOpenAIRequestBody(request, config, false),
          signal: request.signal
        }
      })
      if (!response.ok) {
        throw createAgentCoreModelHttpError({
          message: await readOpenAIErrorMessage(
            response,
            `OpenAI-compatible request failed: ${response.status}`
          ),
          status: response.status
        })
      }
      const body = (await response.json()) as OpenAIChatCompletionResponse
      const message = body.choices?.[0]?.message
      return {
        content: message?.content ?? '',
        toolCalls: message?.tool_calls?.map((call, index) =>
          createAgentCoreToolCall({
            id: call.id,
            index,
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '{}'
          })
        )
      }
    },
    async *stream(request: AgentCoreModelRequest): AsyncIterable<AgentCoreModelStreamEvent> {
      const response = await fetchAgentCoreModelResponse({
        fetchImpl,
        url: openAICompletionUrl(config.baseUrl),
        init: {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: createOpenAIRequestBody(request, config, true),
          signal: request.signal
        }
      })
      if (!response.ok) {
        throw createAgentCoreModelHttpError({
          message: await readOpenAIErrorMessage(
            response,
            `OpenAI-compatible stream request failed: ${response.status}`
          ),
          status: response.status
        })
      }

      const toolCalls = new Map<number, OpenAIStreamingToolCall>()
      let streamDone = false
      for await (const data of readAgentCoreSseData(response.body)) {
        if (data.trim() === '[DONE]') {
          streamDone = true
          break
        }
        const chunk = parseAgentCoreStreamJsonEvent<OpenAIChatCompletionChunk>({
          protocol: 'openai',
          data
        })
        if (chunk.error?.message !== undefined) {
          throw new Error(chunk.error.message)
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta === undefined) {
          continue
        }
        if (delta.content !== undefined && delta.content !== null && delta.content.length > 0) {
          yield {
            type: 'text-delta',
            content: delta.content
          }
        }
        mergeOpenAIToolCallDeltas({
          calls: toolCalls,
          deltas: delta.tool_calls
        })
      }
      if (!streamDone) {
        yield* flushOpenAIToolCalls(toolCalls)
        throw createAgentCoreModelProviderError({
          message: 'openai stream ended before [DONE].',
          retryable: true
        })
      }

      yield* flushOpenAIToolCalls(toolCalls)
      yield {
        type: 'message-end'
      }
    }
  }
}
