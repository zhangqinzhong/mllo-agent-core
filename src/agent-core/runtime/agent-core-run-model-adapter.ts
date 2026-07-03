import { createMlloDumpPromptsFetch } from '../model/agent-core-dump-prompts-fetch'
import type { AgentCoreHttpModelConfig } from '../model/agent-core-http-model-config'
import { createAgentCoreHttpModelAdapter } from '../model/agent-core-http-model-adapter'
import type { AgentCoreModelAdapter } from '../query-loop/agent-core-query-types'
import type { AgentCorePreparedRunSession } from './agent-core-run-session'

type AgentCoreRunModelAdapterOptions = {
  provider: AgentCoreHttpModelConfig
  session: AgentCorePreparedRunSession
  fetchImpl?: typeof fetch
}

// 创建本轮 run 使用的模型 adapter；prompt dump 是观测层，不能渗进 query loop。
export function createAgentCoreRunModelAdapter(
  options: AgentCoreRunModelAdapterOptions
): AgentCoreModelAdapter {
  const fetchImpl = createMlloDumpPromptsFetch({
    homePath: options.session.configDir,
    sessionId: options.session.handle.sessionId,
    fetchImpl: options.fetchImpl
  })
  return createAgentCoreHttpModelAdapter(options.provider, fetchImpl)
}
