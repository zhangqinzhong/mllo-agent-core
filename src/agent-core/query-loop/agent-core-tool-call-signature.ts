import type { AgentCoreToolCall } from '../tools/agent-core-tool-types'

// 稳定序列化工具输入。模型原样重复参数时，字段顺序不能影响签名。
function stableToolInputJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableToolInputJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableToolInputJson(item)}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

// 生成工具调用签名。只看工具名和输入，不能把每轮不同的 tool id 算成新动作。
export function createAgentCoreToolCallSignature(call: AgentCoreToolCall): string {
  return `${call.name}\0${stableToolInputJson(call.input)}`
}
