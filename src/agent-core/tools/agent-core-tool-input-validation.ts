import type { ZodError, ZodIssue } from 'zod'
import type { AgentCoreToolInputParseStatus, AgentCoreToolResult } from './agent-core-tool-types'

function issuePath(issue: ZodIssue): string {
  return issue.path.length === 0 ? '<root>' : issue.path.join('.')
}

export function createAgentCoreToolInputValidationResult(args: {
  toolName: string
  error: ZodError
}): AgentCoreToolResult {
  const issues = args.error.issues
    .map((issue) => `- ${issuePath(issue)}: ${issue.message}`)
    .join('\n')
  return {
    isError: true,
    errorKind: 'schema-validation',
    content: [
      `Tool input schema validation failed for ${args.toolName}.`,
      `Repair instruction: call ${args.toolName} again with corrected JSON arguments.`,
      'Do not repeat the same invalid arguments.',
      `Issues:\n${issues}`
    ].join('\n')
  }
}

export function createAgentCoreToolMalformedArgumentsResult(args: {
  toolName: string
  parseStatus: AgentCoreToolInputParseStatus
}): AgentCoreToolResult | undefined {
  if (args.parseStatus.status !== 'malformed-json') {
    return undefined
  }
  return {
    isError: true,
    errorKind: 'malformed-arguments',
    content: [
      `Tool arguments JSON parse failed for ${args.toolName}.`,
      `Repair instruction: call ${args.toolName} again with valid JSON object arguments.`,
      'Do not repeat the same malformed JSON.',
      'Raw arguments preview:',
      args.parseStatus.rawPreview
    ].join('\n')
  }
}
