import type { AgentCoreWorkerEvent } from './agent-core-worker-types'

export const AGENT_CORE_WORKER_TOOL_RESULT_MAX_CHARS = 200_000

type AgentCoreWorkerToolResultEvent = Extract<AgentCoreWorkerEvent, { type: 'tool-result' }>

// 把任意 worker 输出转成预算计算用字符串；对象按 JSON 展开，便于截断后仍可读。
export function serializeAgentCoreWorkerToolResultOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }
  try {
    return JSON.stringify(output, null, 2) ?? String(output)
  } catch {
    return String(output)
  }
}

// 输出被截断后要保留可读预览；对象不伪装成原结构，避免调用方误判为完整结果。
function createTruncatedWorkerToolOutput(args: {
  output: unknown
  serialized: string
  maxChars: number
}): unknown {
  const preview = args.serialized.slice(0, args.maxChars)
  if (typeof args.output === 'string') {
    return `${preview}\n\n[worker tool result truncated after ${args.maxChars} chars]`
  }
  return {
    preview,
    truncated: true,
    originalChars: args.serialized.length,
    maxChars: args.maxChars,
    note: `worker tool result truncated after ${args.maxChars} chars`
  }
}

// 限制单个 worker tool-result 的输出大小，防止第三方 agent 大 stdout 打爆审计链路。
export function limitAgentCoreWorkerToolResultOutput(
  event: AgentCoreWorkerToolResultEvent,
  maxChars = AGENT_CORE_WORKER_TOOL_RESULT_MAX_CHARS
): AgentCoreWorkerToolResultEvent {
  if (event.outputTruncated === true || !Number.isFinite(maxChars)) {
    return event
  }
  const serialized = serializeAgentCoreWorkerToolResultOutput(event.output)
  if (serialized.length <= maxChars) {
    return event
  }
  return {
    ...event,
    output: createTruncatedWorkerToolOutput({
      output: event.output,
      serialized,
      maxChars
    }),
    outputTruncated: true,
    outputOriginalChars: serialized.length,
    outputMaxChars: maxChars
  }
}

// worker event 统一从这里过一遍预算；非 tool-result 事件保持原样。
export function limitAgentCoreWorkerEventOutput(event: AgentCoreWorkerEvent): AgentCoreWorkerEvent {
  return event.type === 'tool-result' ? limitAgentCoreWorkerToolResultOutput(event) : event
}
