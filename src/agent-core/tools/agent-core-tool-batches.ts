import type { AgentCoreToolCall, AgentCoreToolDefinition } from './agent-core-tool-types'

export type AgentCoreToolBatch = {
  isConcurrencySafe: boolean
  calls: AgentCoreToolCall[]
}

// 根据工具名取定义。这里服务于分批逻辑，避免 orchestration 文件继续膨胀。
function findAgentCoreTool(
  tools: readonly AgentCoreToolDefinition[],
  name: string
): AgentCoreToolDefinition | undefined {
  return tools.find((tool) => tool.name === name)
}

// 判断工具调用是否可以并发。默认保守地当作有副作用，只有工具显式声明才并发。
export function isAgentCoreToolCallConcurrencySafe(
  tools: readonly AgentCoreToolDefinition[],
  call: AgentCoreToolCall
): boolean {
  const tool = findAgentCoreTool(tools, call.name)
  if (tool?.isConcurrencySafe === undefined) {
    return false
  }

  try {
    return tool.isConcurrencySafe(call.input)
  } catch {
    return false
  }
}

// 判断工具失败后是否应该取消同批兄弟工具。默认保守地不取消。
export function shouldAgentCoreToolCancelSiblingsOnError(
  tools: readonly AgentCoreToolDefinition[],
  call: AgentCoreToolCall
): boolean {
  const tool = findAgentCoreTool(tools, call.name)
  if (tool?.cancelSiblingToolsOnError === undefined) {
    return false
  }

  try {
    return tool.cancelSiblingToolsOnError(call.input)
  } catch {
    return false
  }
}

// 把连续的并发安全工具合成批次；写操作或未知工具保持单个串行批次。
export function partitionAgentCoreToolCalls(
  calls: readonly AgentCoreToolCall[],
  tools: readonly AgentCoreToolDefinition[]
): AgentCoreToolBatch[] {
  const batches: AgentCoreToolBatch[] = []

  for (const call of calls) {
    const isConcurrencySafe = isAgentCoreToolCallConcurrencySafe(tools, call)
    const previous = batches.at(-1)
    if (isConcurrencySafe && previous?.isConcurrencySafe === true) {
      previous.calls.push(call)
      continue
    }

    batches.push({
      isConcurrencySafe,
      calls: [call]
    })
  }

  return batches
}
