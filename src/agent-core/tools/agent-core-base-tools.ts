import type { AgentCorePermissionContext } from '../permissions/agent-core-permission-types'
import type { AgentCoreMcpClient } from '../mcp/agent-core-mcp-client-types'
import {
  createAgentCoreListSkillsTool,
  createAgentCoreReadSkillTool,
  type AgentCoreSkillsToolOptions
} from '../skills/agent-core-skills-tools'
import {
  createAgentCoreCallMcpTool,
  createAgentCoreListMcpToolsTool
} from '../mcp/agent-core-mcp-tools'
import type { AgentCoreToolDefinition } from './agent-core-tool-types'
import {
  createAgentCoreListDirectoryTool,
  createAgentCoreReadFileTool,
  type AgentCoreFilesystemToolOptions
} from './agent-core-filesystem-tools'
import { createAgentCoreEditFileTool } from './agent-core-file-edit-tool'
import { createAgentCoreGlobFilesTool } from './agent-core-glob-files-tool'
import { createAgentCoreGrepFilesTool } from './agent-core-grep-files-tool'
import { createAgentCoreMultiEditTool } from './agent-core-multi-edit-tool'
import { createAgentCoreWriteFileTool } from './agent-core-write-file-tool'
import { createAgentCoreAskUserTool } from './agent-core-ask-user-tool'
import { createAgentCorePlanTool, type AgentCorePlanToolOptions } from './agent-core-plan-tool'
import {
  createAgentCoreShellCommandTool,
  type AgentCoreShellToolOptions
} from './agent-core-shell-tool'
import { createAgentCoreShellCancelTool } from './agent-core-shell-cancel-tool'
import { createAgentCoreShellTasksTool } from './agent-core-shell-tasks-tool'
import {
  createAgentCoreDelegatedAgentTool,
  type AgentCoreDelegatedAgentToolOptions
} from './agent-core-delegated-agent-tool'
import { createAgentCoreWorkflowTool } from './agent-core-workflow-tool'

export type AgentCoreBaseToolOptions = {
  permissionContext: AgentCorePermissionContext
  filesystem?: Omit<AgentCoreFilesystemToolOptions, 'permissionContext'>
  plan?: AgentCorePlanToolOptions
  skills?: AgentCoreSkillsToolOptions
  shell?: Omit<AgentCoreShellToolOptions, 'permissionContext'>
  mcpClients?: readonly AgentCoreMcpClient[]
  delegatedAgents?: AgentCoreDelegatedAgentToolOptions
}

// 创建 Agent Core 默认基础工具集合。顺序保持稳定，方便模型 prompt 和 GUI 展示。
export function createAgentCoreBaseTools(
  options: AgentCoreBaseToolOptions
): AgentCoreToolDefinition[] {
  const filesystemOptions = {
    permissionContext: options.permissionContext,
    ...options.filesystem
  }
  const shellOptions = {
    permissionContext: options.permissionContext,
    ...options.shell
  }

  const tools = [
    createAgentCoreReadFileTool(filesystemOptions),
    createAgentCoreListDirectoryTool(filesystemOptions),
    createAgentCoreGlobFilesTool(filesystemOptions),
    createAgentCoreGrepFilesTool(filesystemOptions),
    createAgentCoreWriteFileTool(filesystemOptions),
    createAgentCoreEditFileTool(filesystemOptions),
    createAgentCoreMultiEditTool(filesystemOptions),
    createAgentCorePlanTool(options.plan),
    createAgentCoreListSkillsTool(
      options.skills ?? {
        cwd: options.permissionContext.cwd
      }
    ),
    createAgentCoreReadSkillTool(
      options.skills ?? {
        cwd: options.permissionContext.cwd
      }
    ),
    createAgentCoreAskUserTool(),
    createAgentCoreShellCommandTool(shellOptions),
    createAgentCoreShellTasksTool(shellOptions),
    createAgentCoreShellCancelTool(shellOptions)
  ]

  const mcpClients = options.mcpClients ?? []
  if (mcpClients.length > 0) {
    tools.push(
      createAgentCoreListMcpToolsTool({
        permissionContext: options.permissionContext,
        clients: mcpClients
      })
    )
    tools.push(
      createAgentCoreCallMcpTool({
        permissionContext: options.permissionContext,
        clients: mcpClients
      })
    )
  }

  const delegatedAgents = options.delegatedAgents
  if (delegatedAgents !== undefined && delegatedAgents.workers.length > 0) {
    tools.push(createAgentCoreDelegatedAgentTool(delegatedAgents))
    tools.push(
      createAgentCoreWorkflowTool({
        workers: delegatedAgents.workers,
        journalPath: delegatedAgents.workflowJournalPath
      })
    )
  }

  return tools
}
