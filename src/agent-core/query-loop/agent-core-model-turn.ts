import { isAgentCoreToolCallConcurrencySafe } from '../tools/agent-core-tool-orchestration'
import { runAgentCoreToolCall } from '../tools/agent-core-tool-runner'
import {
  getAgentCoreModelErrorMessage,
  isAgentCoreRetryableModelError
} from '../model/agent-core-model-error-classification'
import {
  createAgentCoreToolCallIdState,
  ensureAgentCoreToolCallUniqueId,
  ensureAgentCoreToolCallsUniqueIds
} from '../model/agent-core-model-wire'
import { createAgentCoreToolCallSignature } from './agent-core-tool-call-signature'
import { createAgentCoreRepeatedToolFailureResult } from './agent-core-repeated-tool-failure'
import type {
  AgentCoreToolCall,
  AgentCoreToolExecutionResult
} from '../tools/agent-core-tool-types'
import type {
  AgentCoreMessage,
  AgentCoreModelResponse,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs
} from './agent-core-query-types'

export type PreExecutedToolCall = {
  call: AgentCoreToolCall
  execution: Promise<AgentCoreToolExecutionResult>
}

export type AgentCoreModelTurn = {
  response: AgentCoreModelResponse
  preExecutedToolCalls: Map<string, PreExecutedToolCall>
  streamInterrupted?: {
    message: string
  }
}

const MAX_MODEL_TURN_ATTEMPTS = 2

function shouldRetryModelTurn(args: {
  attempt: number
  error: unknown
  observedModelOutput: boolean
  signal?: AbortSignal
}): boolean {
  return (
    args.attempt < MAX_MODEL_TURN_ATTEMPTS &&
    !args.observedModelOutput &&
    args.signal?.aborted !== true &&
    isAgentCoreRetryableModelError(args.error)
  )
}

// 把 TurnContext 作为本轮请求上下文临时追加给模型，不写入 queryLoop 历史。
function messagesForModelRequest(
  args: AgentCoreQueryLoopArgs,
  messages: readonly AgentCoreMessage[]
): readonly AgentCoreMessage[] {
  if (args.turnContext === undefined || args.turnContext.length === 0) {
    return messages
  }
  return [
    ...messages,
    {
      role: 'user' as const,
      content: args.turnContext
    }
  ]
}

// 预执行流式工具调用。只允许并发安全工具提前跑，写操作仍留给工具编排层串行处理。
function maybePreExecuteStreamingToolCall(args: {
  queryArgs: AgentCoreQueryLoopArgs
  messages: readonly AgentCoreMessage[]
  call: AgentCoreToolCall
  preExecutedToolCalls: Map<string, PreExecutedToolCall>
}): boolean {
  if (
    createAgentCoreRepeatedToolFailureResult({
      messages: args.messages,
      call: args.call
    }) !== undefined ||
    !isAgentCoreToolCallConcurrencySafe(args.queryArgs.tools ?? [], args.call) ||
    args.preExecutedToolCalls.has(args.call.id)
  ) {
    return false
  }

  args.preExecutedToolCalls.set(args.call.id, {
    call: args.call,
    execution: runAgentCoreToolCall({
      call: args.call,
      cwd: args.queryArgs.cwd,
      signal: args.queryArgs.signal,
      tools: args.queryArgs.tools ?? [],
      requestWorkerPermission: args.queryArgs.requestWorkerPermission
    })
  })
  return true
}

// 把非流式 complete 响应包装成统一的 model turn，方便 queryLoop 只处理一种形态。
async function readCompleteModelTurn(
  args: AgentCoreQueryLoopArgs,
  messages: readonly AgentCoreMessage[],
  preExecutedToolCalls: Map<string, PreExecutedToolCall>
): Promise<AgentCoreModelTurn> {
  const complete = args.model.complete
  if (complete === undefined) {
    throw new Error('AgentCoreModelAdapter must provide stream or complete.')
  }

  for (let attempt = 1; attempt <= MAX_MODEL_TURN_ATTEMPTS; attempt += 1) {
    try {
      return {
        response: normalizeModelResponseToolCallIds(
          await complete({
            systemPrompt: args.systemPrompt,
            messages: messagesForModelRequest(args, messages),
            tools: args.tools ?? [],
            signal: args.signal
          })
        ),
        preExecutedToolCalls
      }
    } catch (error) {
      if (
        shouldRetryModelTurn({
          attempt,
          error,
          observedModelOutput: false,
          signal: args.signal
        })
      ) {
        continue
      }
      throw error
    }
  }
  throw new Error('Agent Core model retry loop exhausted unexpectedly.')
}

function normalizeModelResponseToolCallIds(
  response: AgentCoreModelResponse
): AgentCoreModelResponse {
  return {
    ...response,
    toolCalls:
      response.toolCalls === undefined
        ? undefined
        : ensureAgentCoreToolCallsUniqueIds(response.toolCalls)
  }
}

function hasRecoverableStreamOutput(args: {
  content: string
  toolCalls: readonly AgentCoreToolCall[]
}): boolean {
  return args.content.length > 0 || args.toolCalls.length > 0
}

// 把流式事件聚合成一次 assistant 回复。事件先 yield 给 GUI，再生成历史消息。
export async function* readAgentCoreModelTurn(
  args: AgentCoreQueryLoopArgs,
  messages: readonly AgentCoreMessage[]
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreModelTurn> {
  const preExecutedToolCalls = new Map<string, PreExecutedToolCall>()
  if (args.model.stream === undefined) {
    return await readCompleteModelTurn(args, messages, preExecutedToolCalls)
  }

  for (let attempt = 1; attempt <= MAX_MODEL_TURN_ATTEMPTS; attempt += 1) {
    let content = ''
    const toolCalls: AgentCoreToolCall[] = []
    const seenToolCallSignatures = new Set<string>()
    let observedModelOutput = false
    let canPreExecuteStreamingTools = true
    const toolCallIdState = createAgentCoreToolCallIdState()
    try {
      for await (const event of args.model.stream({
        systemPrompt: args.systemPrompt,
        messages: messagesForModelRequest(args, messages),
        tools: args.tools ?? [],
        signal: args.signal
      })) {
        if (event.type === 'text-delta') {
          observedModelOutput = true
          content += event.content
          yield {
            type: 'assistant-delta',
            content: event.content
          }
          continue
        }

        if (event.type === 'tool-call') {
          observedModelOutput = true
          const call = ensureAgentCoreToolCallUniqueId(event.call, toolCallIdState)
          const signature = createAgentCoreToolCallSignature(call)
          const isDuplicateInTurn = seenToolCallSignatures.has(signature)
          seenToolCallSignatures.add(signature)
          toolCalls.push(call)
          const isConcurrencySafe = isAgentCoreToolCallConcurrencySafe(args.tools ?? [], call)
          if (!isConcurrencySafe) {
            canPreExecuteStreamingTools = false
          }
          if (
            !isDuplicateInTurn &&
            canPreExecuteStreamingTools &&
            maybePreExecuteStreamingToolCall({
              queryArgs: args,
              messages,
              call,
              preExecutedToolCalls
            })
          ) {
            yield {
              type: 'tool-call',
              call
            }
          }
          continue
        }

        if (event.type === 'message-end') {
          break
        }
      }

      return {
        response: {
          content,
          toolCalls
        },
        preExecutedToolCalls
      }
    } catch (error) {
      if (
        observedModelOutput &&
        hasRecoverableStreamOutput({
          content,
          toolCalls
        })
      ) {
        return {
          response: {
            content,
            toolCalls
          },
          preExecutedToolCalls,
          // 流已经产生可见输出时不能重试，否则 GUI 和 transcript 会出现重复前缀。
          streamInterrupted: {
            message: getAgentCoreModelErrorMessage(error)
          }
        }
      }
      if (
        shouldRetryModelTurn({
          attempt,
          error,
          observedModelOutput,
          signal: args.signal
        })
      ) {
        continue
      }
      throw error
    }
  }
  throw new Error('Agent Core model stream retry loop exhausted unexpectedly.')
}
