import type {
  AgentCorePermissionContext,
  AgentCorePermissionDecision,
  AgentCorePermissionRisk,
  AgentCoreShellPermissionRule
} from './agent-core-permission-types'
import { createAgentCoreDestructiveShellRisk } from './destructive-shell-command-risk'
import {
  findAgentCoreShellPermissionRule,
  suggestAgentCoreShellPermissionRules
} from './shell-permission-rules'
import { explainAgentCoreShellCommand } from './shell-command-explanation'
import { createAgentCoreShellReadOutsideWorkspaceRisk } from './shell-read-outside-workspace-risk'
import { createAgentCoreShellSensitiveFileReadRisk } from './shell-sensitive-file-read-risk'
export {
  detectAgentCoreBlockingSleepPattern,
  explainAgentCoreShellCommand
} from './shell-command-explanation'

// 构造统一的 shell 权限结果，readonlyCommand 决定 capability 是只读还是写操作。
function decision(
  status: AgentCorePermissionDecision['status'],
  reason: string,
  readonlyCommand: boolean,
  risk?: AgentCorePermissionRisk,
  suggestedRules?: readonly AgentCoreShellPermissionRule[]
): AgentCorePermissionDecision {
  return {
    status,
    capability: readonlyCommand ? 'shell-readonly' : 'shell-write',
    reason,
    ...(risk === undefined ? {} : { risk }),
    ...(suggestedRules === undefined || suggestedRules.length === 0 ? {} : { suggestedRules })
  }
}

// 对 shell 命令做权限判断。这里只分类和给出决策，不执行命令。
export function evaluateAgentCoreShellPermission(
  context: AgentCorePermissionContext,
  command: string,
  options: {
    runInBackground?: boolean
  } = {}
): AgentCorePermissionDecision {
  const trimmed = command.trim()
  const explanation = explainAgentCoreShellCommand(trimmed)
  const destructiveRisk = createAgentCoreDestructiveShellRisk({
    command: trimmed,
    commandPreview: explanation.commandPreview
  })
  const outsideWorkspaceReadRisk = explanation.readonlyCommand
    ? createAgentCoreShellReadOutsideWorkspaceRisk({
        context,
        command: trimmed,
        commandPreview: explanation.commandPreview
      })
    : undefined
  const sensitiveReadRisk = explanation.readonlyCommand
    ? createAgentCoreShellSensitiveFileReadRisk({
        command: trimmed,
        commandPreview: explanation.commandPreview
      })
    : undefined
  const shellRisk = destructiveRisk ?? outsideWorkspaceReadRisk ?? sensitiveReadRisk
  const ruleMatch = findAgentCoreShellPermissionRule({
    command: trimmed,
    cwd: context.cwd,
    rules: context.shellRules
  })
  const suggestedRules =
    shellRisk === undefined
      ? suggestAgentCoreShellPermissionRules(trimmed, {
          scope: 'project',
          cwd: context.cwd
        })
      : []
  if (explanation.risk === 'empty') {
    return decision('deny', explanation.reason, false)
  }
  if (explanation.risk === 'blocking-sleep' && options.runInBackground !== true) {
    return decision(
      'deny',
      `${explanation.reason}. Set runInBackground: true and use shell_tasks to read output later, or replace the sleep with a direct status check.`,
      false
    )
  }

  if (context.mode === 'dangerously-bypass') {
    return decision(
      'allow',
      `Dangerously bypass mode allows shell execution: ${explanation.commandPreview}`,
      false
    )
  }

  if (ruleMatch?.action === 'deny') {
    return decision(
      'deny',
      `Shell command denied by ${ruleMatch.rule.match} rule: ${ruleMatch.rule.command}`,
      explanation.readonlyCommand,
      shellRisk
    )
  }

  if (ruleMatch?.action === 'ask') {
    return decision(
      'ask',
      `Shell command requires approval by ${ruleMatch.rule.match} rule: ${ruleMatch.rule.command}`,
      explanation.readonlyCommand,
      shellRisk
    )
  }

  if (explanation.risk === 'command-substitution' || explanation.risk === 'shell-control') {
    return decision('ask', explanation.reason, false, shellRisk)
  }

  if (destructiveRisk !== undefined) {
    return decision(
      'ask',
      `Destructive shell command requires approval: ${explanation.commandPreview}`,
      false,
      destructiveRisk
    )
  }

  if (outsideWorkspaceReadRisk !== undefined) {
    return decision(
      'ask',
      `Read-only shell command references paths outside the workspace: ${outsideWorkspaceReadRisk.paths.join(', ')}`,
      true,
      outsideWorkspaceReadRisk
    )
  }

  if (sensitiveReadRisk !== undefined) {
    const paths = sensitiveReadRisk.paths.join(', ')
    return decision(
      'ask',
      `Read-only shell command references sensitive files: ${paths}`,
      true,
      sensitiveReadRisk
    )
  }

  if (explanation.readonlyCommand) {
    return decision('allow', explanation.reason, true)
  }

  if (ruleMatch?.action === 'allow') {
    return decision(
      'allow',
      `Shell command allowed by ${ruleMatch.rule.match} rule: ${ruleMatch.rule.command}`,
      explanation.readonlyCommand
    )
  }

  if (explanation.risk === 'mutating') {
    return decision('ask', explanation.reason, false, shellRisk, suggestedRules)
  }

  return decision('ask', explanation.reason, false, shellRisk, suggestedRules)
}
