import { createAgentCoreModelNetworkError } from './agent-core-model-error-classification'

export type AgentCoreModelFetch = typeof fetch

// 统一包装模型 fetch 的网络异常，retry 层只需要看 AgentCoreModelError。
export async function fetchAgentCoreModelResponse(args: {
  fetchImpl: AgentCoreModelFetch
  url: string
  init: RequestInit
}): Promise<Response> {
  try {
    return await args.fetchImpl(args.url, args.init)
  } catch (error) {
    throw createAgentCoreModelNetworkError(error)
  }
}
