import type { AgentCoreModelStreamEvent } from '../query-loop/agent-core-query-types'
import { createAgentCoreToolCall } from './agent-core-model-wire'
import type {
  AnthropicStreamingToolUse,
  AnthropicStreamEvent
} from './agent-core-anthropic-wire-types'

// 处理 Anthropic content block start。tool_use 的 input 后续通过 input_json_delta 补齐。
export function captureAnthropicContentBlockStart(
  calls: Map<number, AnthropicStreamingToolUse>,
  event: AnthropicStreamEvent
): void {
  if (event.index === undefined || event.content_block?.type !== 'tool_use') {
    return
  }
  calls.set(event.index, {
    id: event.content_block.id,
    name: event.content_block.name,
    partialJson: ''
  })
}

// 处理 Anthropic delta。文本直接 yield，工具 JSON 分片聚合到对应 block。
export function* handleAnthropicDelta(
  calls: Map<number, AnthropicStreamingToolUse>,
  event: AnthropicStreamEvent
): Generator<AgentCoreModelStreamEvent> {
  if (event.delta?.type === 'text_delta' && event.delta.text !== undefined) {
    yield {
      type: 'text-delta',
      content: event.delta.text
    }
    return
  }
  if (
    event.delta?.type === 'input_json_delta' &&
    event.delta.partial_json !== undefined &&
    event.index !== undefined
  ) {
    const call = calls.get(event.index)
    if (call !== undefined) {
      call.partialJson += event.delta.partial_json
    }
  }
}

function createAnthropicToolCallEvent(
  index: number,
  call: AnthropicStreamingToolUse
): AgentCoreModelStreamEvent {
  return {
    type: 'tool-call',
    call: createAgentCoreToolCall({
      id: call.id,
      index,
      name: call.name,
      arguments: call.partialJson.length > 0 ? call.partialJson : '{}'
    })
  }
}

// Anthropic 的 tool_use 到 content_block_stop 已完整，早发能让 query loop 提前启动安全工具。
export function* flushAnthropicToolCallAtIndex(
  calls: Map<number, AnthropicStreamingToolUse>,
  index: number | undefined
): Generator<AgentCoreModelStreamEvent> {
  if (index === undefined) {
    return
  }
  const call = calls.get(index)
  if (call === undefined) {
    return
  }
  calls.delete(index)
  yield createAnthropicToolCallEvent(index, call)
}

// 结束或坏流时补发剩余 tool_use，兼容没有 content_block_stop 的兼容端点。
export function* flushAnthropicToolCalls(
  calls: Map<number, AnthropicStreamingToolUse>
): Generator<AgentCoreModelStreamEvent> {
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    calls.delete(index)
    yield createAnthropicToolCallEvent(index, call)
  }
}
