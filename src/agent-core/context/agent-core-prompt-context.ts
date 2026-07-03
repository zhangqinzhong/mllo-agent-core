import type { AgentCorePermissionContext } from '../permissions/agent-core-permission-types'
import type { AgentCoreRunSandboxPolicy } from '../runtime/agent-core-run-sandbox-policy'
import type { AgentCoreResumeResult } from '../session/agent-core-session-resume'
import type { AgentCoreSessionHandle } from '../session/agent-core-session-types'
import type { AgentCoreToolAvailabilityRecord } from '../tools/agent-core-tool-availability'
import type { AgentCoreToolDefinition } from '../tools/agent-core-tool-types'
import type { AgentCoreShellExecutionBackend } from '../tools/shell-execution-backend'
import type { AgentCoreMemoryEntry } from './agent-core-memory'
import type { AgentCoreMcpConfigPromptRecord } from './agent-core-mcp-config-prompt-state'
import type { AgentCorePlanPromptState } from './agent-core-plan-prompt-state'
import type { AgentCoreProjectInstruction } from './agent-core-project-instructions'
import type { AgentCoreShellTaskPromptRecord } from './agent-core-shell-task-prompt-state'
import type { AgentCoreWorkflowPromptRun } from './agent-core-workflow-prompt-state'
import type { AgentCoreSkillPromptRecord } from '../skills/agent-core-skills-prompt-state'

export type AgentCoreModelProfile = {
  provider: string
  model: string
  supportsStreaming: boolean
  supportsToolUse: boolean
}

export type AgentCoreToolPromptDescriptor = {
  name: string
  description: string
  maxResultSizeChars?: number
  concurrency: 'safe' | 'serial'
  availability?: AgentCoreToolAvailabilityPromptRecord
}

export type AgentCoreToolAvailabilityPromptRecord = {
  toolName: string
  status: AgentCoreToolAvailabilityRecord['status']
  visible: boolean
  checkedAtMs: number
  reason?: string
  lastAvailableAtMs?: number
}

export type AgentCoreBudgetPromptState = {
  inputBudgetTokens?: number
  outputBudgetTokens?: number
  estimatedInputTokens?: number
  compacted: boolean
}

export type AgentCoreShellBackendPromptState = {
  kind: string
  label?: string
  remote: boolean
  sandboxed: boolean
  cwdTrackingMode?: AgentCoreShellExecutionBackend['cwdTrackingMode']
  allowedRemoteSecretLikeEnvNames: string[]
}

export type AgentCorePromptContext = {
  identity: {
    productName: 'mllo'
    role: 'agent-core'
  }
  generatedAt: string
  cwd: string
  shellCwd: string
  runtime: {
    sandboxPolicy: AgentCoreRunSandboxPolicy
    shellBackend: AgentCoreShellBackendPromptState
  }
  shellTasks: AgentCoreShellTaskPromptRecord[]
  workspaceRoots: string[]
  permissionContext: AgentCorePermissionContext
  tools: AgentCoreToolPromptDescriptor[]
  toolAvailability: AgentCoreToolAvailabilityPromptRecord[]
  skills: AgentCoreSkillPromptRecord[]
  mcpConfigs: AgentCoreMcpConfigPromptRecord[]
  memory: AgentCoreMemoryEntry[]
  projectInstructions: AgentCoreProjectInstruction[]
  plan?: AgentCorePlanPromptState
  workflowRuns: AgentCoreWorkflowPromptRun[]
  session?: {
    sessionId: string
    transcriptPath: string
    resumed: boolean
    repairedToolCallIds: string[]
    omittedResumableEntries: number
    omittedResumableBytes: number
  }
  budget: AgentCoreBudgetPromptState
  modelProfile?: AgentCoreModelProfile
}

export function describeAgentCoreShellBackendForPrompt(
  backend: AgentCoreShellExecutionBackend
): AgentCoreShellBackendPromptState {
  return {
    kind: backend.kind,
    label: backend.label,
    remote: backend.remote === true,
    sandboxed: backend.sandboxed === true,
    cwdTrackingMode: backend.cwdTrackingMode,
    allowedRemoteSecretLikeEnvNames:
      backend.remoteEnvironmentPolicy?.allowedSecretLikeEnvNames === undefined
        ? []
        : [...backend.remoteEnvironmentPolicy.allowedSecretLikeEnvNames]
  }
}

// 把工具定义转换成 prompt 可读描述。并发安全默认保守地视为 serial。
export function describeAgentCoreTools(
  tools: readonly AgentCoreToolDefinition[],
  availabilityRecords: readonly AgentCoreToolAvailabilityRecord[] = []
): AgentCoreToolPromptDescriptor[] {
  const availabilityByTool = new Map(
    availabilityRecords.map((record) => [
      record.toolName,
      {
        toolName: record.toolName,
        status: record.status,
        visible: record.visible,
        checkedAtMs: record.checkedAtMs,
        reason: record.reason,
        lastAvailableAtMs: record.lastAvailableAtMs
      }
    ])
  )
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    maxResultSizeChars: tool.maxResultSizeChars,
    concurrency: tool.isConcurrencySafe?.({}) === true ? 'safe' : 'serial',
    availability: availabilityByTool.get(tool.name)
  }))
}

// 构造 session prompt 状态。没有 session 时，prompt 里不写虚假的恢复信息。
export function createAgentCorePromptSessionState(args: {
  session: AgentCoreSessionHandle | undefined
  resume: AgentCoreResumeResult | undefined
}): AgentCorePromptContext['session'] {
  if (args.session === undefined) {
    return undefined
  }
  return {
    sessionId: args.session.sessionId,
    transcriptPath: args.session.transcriptPath,
    resumed: args.resume !== undefined,
    repairedToolCallIds: args.resume?.repairedToolCallIds ?? [],
    omittedResumableEntries: args.resume?.omittedResumableEntries ?? 0,
    omittedResumableBytes: args.resume?.omittedResumableBytes ?? 0
  }
}
