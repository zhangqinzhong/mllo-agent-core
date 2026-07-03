import { buildAgentCoreContext } from '../context/agent-core-context-builder'
import type { AgentCoreBuiltContext } from '../context/agent-core-context-builder-types'
import type { MlloAgentCoreConfig } from '../model/agent-core-mllo-config'
import type { AgentCoreHttpModelConfig } from '../model/agent-core-http-model-config'
import type { AgentCoreModelAdapter } from '../query-loop/agent-core-query-types'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import type { AgentCoreJsonlSessionStore } from '../session/agent-core-jsonl-session-store'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'
import type { AgentCoreMcpClient } from '../mcp/agent-core-mcp-client-types'
import type { AgentCoreRunControllerOptions } from './agent-core-run-controller-types'

export async function buildAgentCoreRunContext(args: {
  cwd: string
  workspaceRoots: string[]
  options: AgentCoreRunControllerOptions
  loadedConfig?: MlloAgentCoreConfig
  provider: AgentCoreHttpModelConfig
  model: AgentCoreModelAdapter
  mcpClients: readonly AgentCoreMcpClient[]
  runtimeHome: MlloRuntimeHomeOptions
  sessionStore: AgentCoreJsonlSessionStore
  sessionHandle: AgentCoreSessionHandle
}): Promise<AgentCoreBuiltContext> {
  const shellPermissionRules = [
    ...(args.loadedConfig?.shellPermissionRules ?? []),
    ...(args.options.shellPermissionRules ?? [])
  ]
  const requireSandboxedShell =
    args.options.requireSandboxedShell ?? args.loadedConfig?.requireSandboxedShell
  return await buildAgentCoreContext({
    cwd: args.cwd,
    workspaceRoots: args.workspaceRoots,
    deniedPaths: args.options.deniedPaths,
    permissionMode: args.options.permissionMode,
    shellPermissionRules,
    model: args.model,
    workers: args.options.workers,
    mcpClients: args.mcpClients,
    shellExecutionBackend: args.options.shellExecutionBackend,
    requireSandboxedShell,
    skillHomeDir: args.options.skillHomeDir,
    signal: args.options.signal,
    maxTurns: args.options.maxTurns,
    middlewares: args.options.middlewares,
    modelProfile: {
      provider: args.provider.name ?? args.provider.protocol,
      model: args.provider.model,
      supportsStreaming: args.model.stream !== undefined,
      supportsToolUse: true
    },
    promptProfile: args.options.promptProfile ?? args.provider.promptProfile,
    session: {
      store: args.sessionStore,
      handle: args.sessionHandle,
      resume: args.options.session.resume,
      maxIndexedResumeEntries: args.options.session.maxIndexedResumeEntries,
      maxIndexedResumeBytes: args.options.session.maxIndexedResumeBytes
    },
    runtimeHome: args.runtimeHome,
    newMessages: [
      {
        role: 'user',
        content: args.options.input
      }
    ]
  })
}
