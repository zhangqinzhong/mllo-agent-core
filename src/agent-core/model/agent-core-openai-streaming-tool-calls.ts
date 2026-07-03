import type { AgentCoreModelStreamEvent } from '../query-loop/agent-core-query-types'
import { createAgentCoreToolCall } from './agent-core-model-wire'

export type OpenAIStreamingToolCall = {
  id?: string
  name?: string
  arguments: string
  sourceIndex?: number
}

export type OpenAIStreamingToolCallDelta = {
  index?: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

// 找到同一个 wire index 最新映射到的内部槽。坏流复用 index 时，后续无 id 分片要跟最新 id。
function latestOpenAIToolCallIndexForSourceIndex(
  calls: Map<number, OpenAIStreamingToolCall>,
  sourceIndex: number
): number | undefined {
  return [...calls.entries()].filter(([, item]) => item.sourceIndex === sourceIndex).at(-1)?.[0]
}

// 找一个新的内部槽，避免兼容端点复用 index 时污染已经聚合完成的调用。
function nextOpenAIToolCallIndex(calls: Map<number, OpenAIStreamingToolCall>): number {
  const last = [...calls.keys()].sort((a, b) => a - b).at(-1)
  return last === undefined ? 0 : last + 1
}

function hasCompleteJsonArguments(call: OpenAIStreamingToolCall | undefined): boolean {
  if (call === undefined || call.arguments.trim().length === 0) {
    return false
  }
  try {
    JSON.parse(call.arguments)
    return true
  } catch {
    return false
  }
}

// OpenAI 兼容端点有时后续分片不带 index，只带 id；此时必须按 id 续接。
function resolveOpenAIToolCallDeltaIndex(
  calls: Map<number, OpenAIStreamingToolCall>,
  call: OpenAIStreamingToolCallDelta,
  anonymousIndex: number
): number {
  if (call.id !== undefined && call.id.length > 0) {
    const existing = [...calls.entries()].find(([, item]) => item.id === call.id)
    if (existing !== undefined) {
      return existing[0]
    }
  }
  if (call.index !== undefined && call.id !== undefined && call.id.length > 0) {
    const existing = calls.get(call.index)
    if (existing?.id !== undefined && existing.id !== call.id) {
      return nextOpenAIToolCallIndex(calls)
    }
    return call.index
  }
  if (call.index !== undefined) {
    const latestIndex = latestOpenAIToolCallIndexForSourceIndex(calls, call.index) ?? call.index
    const latestCall = calls.get(latestIndex)
    // 中文注释：坏流可能复用 index 且省略 id；完整 JSON 后再次出现 name 代表新 tool call。
    if (
      latestCall?.name !== undefined &&
      call.function?.name !== undefined &&
      hasCompleteJsonArguments(latestCall)
    ) {
      return nextOpenAIToolCallIndex(calls)
    }
    return latestIndex
  }
  // 兼容端点偶尔省略 index/id；同一 chunk 内只能按数组位置保持多个调用不被合并。
  if (anonymousIndex > 0 || calls.has(anonymousIndex)) {
    return anonymousIndex
  }
  const onlyExisting = calls.size === 1 ? [...calls.keys()][0] : undefined
  return onlyExisting ?? 0
}

// 聚合 OpenAI 流式 tool_call 分片。arguments 会分多段到达，必须等结束后再产出工具调用。
export function mergeOpenAIToolCallDeltas(args: {
  calls: Map<number, OpenAIStreamingToolCall>
  deltas: readonly OpenAIStreamingToolCallDelta[] | undefined
}): void {
  for (const [anonymousIndex, call] of (args.deltas ?? []).entries()) {
    const index = resolveOpenAIToolCallDeltaIndex(args.calls, call, anonymousIndex)
    const current = args.calls.get(index) ?? {
      arguments: '',
      sourceIndex: call.index ?? anonymousIndex
    }
    current.sourceIndex ??= call.index ?? anonymousIndex
    if (call.id !== undefined && call.id.length > 0) {
      current.id = call.id
    }
    if (call.function?.name !== undefined && call.function.name.length > 0) {
      current.name = call.function.name
    }
    current.arguments += call.function?.arguments ?? ''
    args.calls.set(index, current)
  }
}

// 把聚合后的 OpenAI tool calls 转成 Agent Core 事件。
export function* flushOpenAIToolCalls(
  calls: Map<number, OpenAIStreamingToolCall>
): Generator<AgentCoreModelStreamEvent> {
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    yield {
      type: 'tool-call',
      call: createAgentCoreToolCall({
        id: call.id,
        index,
        name: call.name ?? '',
        arguments: call.arguments.length > 0 ? call.arguments : '{}'
      })
    }
  }
}
