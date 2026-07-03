import type { AgentCoreModelAdapter } from '../query-loop/agent-core-query-types'
import {
  assertAgentCoreHttpModelConfig,
  type AgentCoreHttpModelConfig
} from './agent-core-http-model-config'
import { createAgentCoreAnthropicModelAdapter } from './agent-core-anthropic-model-adapter'
import { createAgentCoreOpenAIModelAdapter } from './agent-core-openai-model-adapter'

type AgentCoreFetch = typeof fetch

// 按协议创建 HTTP 模型 adapter。Agent Core 主循环只依赖统一 adapter，不感知 wire protocol。
export function createAgentCoreHttpModelAdapter(
  config: AgentCoreHttpModelConfig,
  fetchImpl?: AgentCoreFetch
): AgentCoreModelAdapter {
  assertAgentCoreHttpModelConfig(config)
  if (config.protocol === 'anthropic') {
    return createAgentCoreAnthropicModelAdapter(config, fetchImpl)
  }
  return createAgentCoreOpenAIModelAdapter(config, fetchImpl)
}
