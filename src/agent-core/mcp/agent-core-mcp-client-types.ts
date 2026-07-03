import type { AgentCoreToolAvailabilityPolicy } from '../tools/agent-core-tool-types'

export type AgentCoreMcpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: unknown
}

export type AgentCoreMcpToolCallRequest = {
  toolName: string
  arguments?: Record<string, unknown>
  signal?: AbortSignal
}

export type AgentCoreMcpToolCallResult = {
  content: unknown
  isError?: boolean
}

// Agent Core 只依赖这个最小边界；stdio/http SDK client 后续作为适配器挂进来。
export type AgentCoreMcpClient = {
  serverName: string
  label?: string
  availability?: AgentCoreToolAvailabilityPolicy
  listTools: () => Promise<AgentCoreMcpToolDescriptor[]>
  callTool: (request: AgentCoreMcpToolCallRequest) => Promise<AgentCoreMcpToolCallResult>
  close?: () => Promise<void>
}
