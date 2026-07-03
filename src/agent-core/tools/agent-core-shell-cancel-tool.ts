import { z } from 'zod'
import type { AgentCorePermissionContext } from '../permissions/agent-core-permission-types'
import type { AgentCoreToolDefinition } from './agent-core-tool-types'
import {
  defaultAgentCoreShellTaskRegistry,
  type AgentCoreShellTaskRegistry
} from './shell-task-registry'
import { createAgentCoreToolInputValidationResult } from './agent-core-tool-input-validation'

const shellCancelInputSchema = z.object({
  taskId: z.string().min(1)
})

export type AgentCoreShellCancelToolOptions = {
  permissionContext: AgentCorePermissionContext
  taskRegistry?: AgentCoreShellTaskRegistry
}

// 取消后台进程是有副作用的 shell 行为，必须走 shell-write 权限闸门。
export function createAgentCoreShellCancelTool(
  options: AgentCoreShellCancelToolOptions
): AgentCoreToolDefinition {
  return {
    name: 'shell_cancel',
    description: 'Cancel a running shell background task by taskId.',
    inputSchema: shellCancelInputSchema,
    evaluatePermission() {
      return {
        status: options.permissionContext.mode === 'dangerously-bypass' ? 'allow' : 'ask',
        capability: 'shell-write',
        reason: 'Cancelling a shell task terminates a running process.'
      }
    },
    isConcurrencySafe: () => false,
    async run(input) {
      const parsed = shellCancelInputSchema.safeParse(input)
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: 'shell_cancel',
          error: parsed.error
        })
      }
      const registry = options.taskRegistry ?? defaultAgentCoreShellTaskRegistry
      const cancelled = registry.cancel(parsed.data.taskId)
      return cancelled
        ? {
            content: `Cancelled shell task ${parsed.data.taskId}.`
          }
        : {
            content: `Shell task is not running or was not found: ${parsed.data.taskId}`,
            isError: true
          }
    }
  }
}
