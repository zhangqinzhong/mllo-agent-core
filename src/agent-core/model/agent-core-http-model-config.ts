import type { AgentCorePromptProfile } from '../context/agent-core-prompt-profile'

export type AgentCoreHttpModelProtocol = 'anthropic' | 'openai'

export type AgentCoreHttpModelConfig = {
  name?: string
  protocol: AgentCoreHttpModelProtocol
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
  anthropicVersion?: string
  promptProfile?: AgentCorePromptProfile
}

export type AgentCoreAnthropicCompatibleEnv = {
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
}

// 提前校验配置，避免真实请求失败后才发现缺 key/model。
export function assertAgentCoreHttpModelConfig(config: AgentCoreHttpModelConfig): void {
  if (config.baseUrl.trim().length === 0) {
    throw new Error('Agent Core model baseUrl is required.')
  }
  if (config.model.trim().length === 0) {
    throw new Error('Agent Core model model is required.')
  }
  if (config.apiKey.trim().length === 0) {
    throw new Error('Agent Core model apiKey is required.')
  }
}
