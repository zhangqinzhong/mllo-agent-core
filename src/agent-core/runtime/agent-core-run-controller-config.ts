import {
  createMlloConfiguredHooks,
  type MlloConfiguredHooksRuntime
} from '../hooks/agent-core-configured-hooks'
import {
  getDefaultMlloModelProvider,
  getMlloModelProvider,
  readMlloAgentCoreConfig,
  type MlloAgentCoreConfig
} from '../model/agent-core-mllo-config'
import type { AgentCoreHttpModelConfig } from '../model/agent-core-http-model-config'
import type { AgentCoreHookDefinition } from '../hooks/agent-core-hook-types'
import type { AgentCoreRunControllerOptions } from './agent-core-run-controller-types'

// 加载 mllo 配置。显式传 modelProvider 时不强制读取配置文件，方便测试和嵌入场景。
export async function loadAgentCoreRunConfig(
  options: Pick<AgentCoreRunControllerOptions, 'configPath' | 'modelProvider'>
): Promise<MlloAgentCoreConfig | undefined> {
  if (options.modelProvider !== undefined) {
    return undefined
  }
  if (options.configPath === undefined) {
    throw new Error('mllo configPath is required when modelProvider is not provided.')
  }
  return await readMlloAgentCoreConfig(options.configPath)
}

// 加载 mllo 自己的模型 provider；Agent Core 不隐式读取其他 agent 的配置。
export function loadAgentCoreRunModelProvider(
  options: Pick<AgentCoreRunControllerOptions, 'modelProvider' | 'providerName'>,
  config: MlloAgentCoreConfig | undefined
): AgentCoreHttpModelConfig {
  if (options.modelProvider !== undefined) {
    return options.modelProvider
  }
  if (config === undefined) {
    throw new Error('mllo config must be loaded before resolving default provider.')
  }
  if (options.providerName !== undefined) {
    return getMlloModelProvider(config, options.providerName)
  }
  return getDefaultMlloModelProvider(config)
}

// 合并配置 hooks 和调用方显式 hooks。配置先跑，显式 hooks 作为调用方覆写层。
export function loadAgentCoreRunHooks(args: {
  config: MlloAgentCoreConfig | undefined
  hooks?: readonly AgentCoreHookDefinition[]
  runtime?: MlloConfiguredHooksRuntime
}): AgentCoreHookDefinition[] {
  return [...createMlloConfiguredHooks(args.config, args.runtime), ...(args.hooks ?? [])]
}
