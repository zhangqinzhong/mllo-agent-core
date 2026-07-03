import {
  createAgentCoreMcpClientsFromServerConfigMap,
  readAgentCoreMcpClientsFromConfig
} from '../mcp/agent-core-mcp-config-clients'
import type { AgentCoreMcpClient } from '../mcp/agent-core-mcp-client-types'
import type { MlloAgentCoreConfig } from '../model/agent-core-mllo-config'

export type AgentCoreRunMcpClients = {
  clients: readonly AgentCoreMcpClient[]
  ownedClients: readonly AgentCoreMcpClient[]
}

export async function resolveAgentCoreRunMcpClients(args: {
  cwd: string
  config?: MlloAgentCoreConfig
  configPath?: string
  clients?: readonly AgentCoreMcpClient[]
}): Promise<AgentCoreRunMcpClients> {
  if (args.clients !== undefined) {
    return {
      clients: args.clients,
      ownedClients: []
    }
  }

  const workspaceClients = await readAgentCoreMcpClientsFromConfig({
    cwd: args.cwd
  })
  // 中文注释：项目 MCP 配置是就近意图，优先级高于 mllo 用户级全局默认值。
  const configuredClients =
    args.config?.mcpServers === undefined || args.configPath === undefined
      ? []
      : createAgentCoreMcpClientsFromServerConfigMap({
          rootPath: args.cwd,
          configPath: args.configPath,
          servers: args.config.mcpServers,
          seenServerNames: new Set(workspaceClients.map((client) => client.serverName))
        })
  const clients = [...workspaceClients, ...configuredClients]
  return {
    clients,
    ownedClients: clients
  }
}

export async function closeAgentCoreRunMcpClients(
  clients: readonly AgentCoreMcpClient[]
): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.close?.()))
}
