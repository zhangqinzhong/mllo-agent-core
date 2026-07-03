import type { AgentCoreToolErrorKind } from '../tools/agent-core-tool-types'

function repairHintsForTool(toolName: string): string[] {
  switch (toolName) {
    case 'read_file':
    case 'list_dir':
    case 'glob_files':
    case 'grep_files':
      return [
        'Verify the path is inside the workspace.',
        'Use list_dir or glob_files to rediscover the current path before retrying.'
      ]
    case 'write_file':
      return [
        'Read the latest file content before retrying if the failure mentions stale content.',
        'Use createParentDirectories only when the parent directory should be created.'
      ]
    case 'edit_file':
    case 'multi_edit':
      return [
        'Read the latest file content and retry with exact current text.',
        'Do not repeat the same oldText if the error says no match or multiple matches.'
      ]
    case 'shell_command':
      return [
        'Inspect exit code, stdout, and stderr before retrying.',
        'Change the command or working assumptions; do not repeat the same failing command blindly.'
      ]
    case 'shell_tasks':
    case 'shell_cancel':
      return ['List current shell tasks first, then retry with a valid taskId.']
    case 'read_skill':
      return ['Use list_skills first, then retry with an exact skill id or name.']
    case 'call_mcp_tool':
      return [
        'Use list_mcp_tools first.',
        'Retry with an exact serverName, toolName, and arguments matching the MCP tool schema.'
      ]
    case 'delegate_agent':
    case 'run_agent_workflow':
      return [
        'Use only registered agent ids from the tool description.',
        'Fix task dependencies and retry with a smaller scoped request if needed.'
      ]
    default:
      return [
        'Change the tool arguments or choose a different registered tool.',
        'Do not repeat the same failing call unchanged.'
      ]
  }
}

function repairHintsForErrorKind(args: {
  errorKind: AgentCoreToolErrorKind | undefined
  toolName: string
}): string[] {
  switch (args.errorKind) {
    case 'unknown-tool':
      return [
        'Choose one of the tools from the current tool schema.',
        'If the needed capability is unavailable, explain the blocker instead of inventing a tool.'
      ]
    case 'runtime-exception':
      return [
        'Treat this as a runtime failure, not a schema problem.',
        ...repairHintsForTool(args.toolName)
      ]
    case 'tool-error':
    case undefined:
      return repairHintsForTool(args.toolName)
    default:
      return []
  }
}

// 有些 synthetic 错误已经包含完整修复指令，再追加 guidance 只会浪费上下文。
export function shouldAppendAgentCoreToolRepairGuidance(args: {
  content: string
  errorKind: AgentCoreToolErrorKind | undefined
}): boolean {
  if (
    args.errorKind === 'schema-validation' ||
    args.errorKind === 'malformed-arguments' ||
    args.errorKind === 'duplicate-call' ||
    args.errorKind === 'repeated-failure' ||
    args.errorKind === 'cancelled-sibling' ||
    args.errorKind === 'interrupted-tool-call'
  ) {
    return false
  }
  return !args.content.startsWith('Tool input schema validation failed for ')
}

export function createAgentCoreToolRepairGuidance(args: {
  errorKind: AgentCoreToolErrorKind | undefined
  toolName: string
}): string[] {
  const hints = repairHintsForErrorKind({
    errorKind: args.errorKind,
    toolName: args.toolName
  })
  return hints.length === 0 ? [] : [`Repair guidance for ${args.toolName}:`, ...hints]
}
