import { isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentCoreShellPermissionRule,
  AgentCoreShellPermissionRuleAction,
  AgentCoreShellPermissionRuleScope
} from './agent-core-permission-types'

export type AgentCoreShellPermissionRuleMatchResult = {
  action: AgentCoreShellPermissionRuleAction
  rule: AgentCoreShellPermissionRule
}

const SAFE_ENV_ASSIGNMENT_NAMES = new Set([
  'CI',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'NODE_ENV',
  'TERM'
])

const DANGEROUS_PREFIX_COMMANDS = new Set([
  'bash',
  'cmd',
  'dash',
  'doas',
  'env',
  'fish',
  'nice',
  'nohup',
  'pkexec',
  'powershell',
  'pwsh',
  'sh',
  'stdbuf',
  'sudo',
  'time',
  'timeout',
  'xargs',
  'zsh'
])

const ACTION_PRIORITY: readonly AgentCoreShellPermissionRuleAction[] = ['deny', 'ask', 'allow']
const SAFE_WRAPPER_COMMANDS = new Set(['nohup', 'time'])

function envAssignmentName(token: string): string | null {
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
  return match?.[1] ?? null
}

function commandTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

function stripSafeEnvAssignments(tokens: readonly string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const name = envAssignmentName(tokens[index]!)
    if (name === null || !SAFE_ENV_ASSIGNMENT_NAMES.has(name)) {
      break
    }
    index += 1
  }
  return tokens.slice(index)
}

function stripSafeWrapper(tokens: readonly string[]): string[] {
  const first = tokens[0]
  if (first === undefined) {
    return []
  }
  if (SAFE_WRAPPER_COMMANDS.has(first)) {
    return tokens.slice(1)
  }
  if (first === 'timeout') {
    const next = tokens[1]
    return next !== undefined && /^-?\d/.test(next) ? tokens.slice(2) : tokens.slice(1)
  }
  if (first === 'nice') {
    return tokens[1] === '-n' && tokens[2] !== undefined ? tokens.slice(3) : tokens.slice(1)
  }
  return [...tokens]
}

function stripSafePrefixes(command: string): string {
  let tokens = commandTokens(command)
  let previous = ''
  while (tokens.join(' ') !== previous) {
    previous = tokens.join(' ')
    tokens = stripSafeEnvAssignments(stripSafeWrapper(tokens))
  }
  return tokens.join(' ')
}

function isPrefixSubcommand(token: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(token)
}

function isExactRuleMatch(command: string, ruleCommand: string): boolean {
  return command === ruleCommand || stripSafePrefixes(command) === ruleCommand
}

function containsShellControl(command: string): boolean {
  return /(^|[^\\])(?:>>?|<<?|[;&|])/.test(command)
}

function isPrefixRuleMatch(args: {
  command: string
  ruleCommand: string
  action: AgentCoreShellPermissionRuleAction
}): boolean {
  if (args.action === 'allow' && containsShellControl(args.command)) {
    return false
  }
  const candidates = [args.command, stripSafePrefixes(args.command)]
  return candidates.some(
    (candidate) =>
      candidate === args.ruleCommand ||
      candidate.startsWith(`${args.ruleCommand} `) ||
      candidate === `xargs ${args.ruleCommand}` ||
      candidate.startsWith(`xargs ${args.ruleCommand} `)
  )
}

function normalizedRule(rule: AgentCoreShellPermissionRule): AgentCoreShellPermissionRule | null {
  const command = rule.command.trim()
  if (command.length === 0) {
    return null
  }
  return {
    ...rule,
    command
  }
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function ruleInScope(rule: AgentCoreShellPermissionRule, cwd: string | undefined): boolean {
  if (rule.scope !== 'project') {
    return true
  }
  if (rule.cwd === undefined || cwd === undefined) {
    return false
  }
  return isPathInsideOrEqual(rule.cwd, cwd)
}

function ruleMatches(command: string, rule: AgentCoreShellPermissionRule): boolean {
  return rule.match === 'exact'
    ? isExactRuleMatch(command, rule.command)
    : isPrefixRuleMatch({
        command,
        ruleCommand: rule.command,
        action: rule.action
      })
}

export function findAgentCoreShellPermissionRule(args: {
  command: string
  cwd?: string
  rules?: readonly AgentCoreShellPermissionRule[]
}): AgentCoreShellPermissionRuleMatchResult | null {
  const rules = (args.rules ?? []).flatMap((rule) => {
    const normalized = normalizedRule(rule)
    return normalized === null || !ruleInScope(normalized, args.cwd) ? [] : [normalized]
  })
  for (const action of ACTION_PRIORITY) {
    const exactRule = rules.find(
      (rule) => rule.action === action && rule.match === 'exact' && ruleMatches(args.command, rule)
    )
    if (exactRule !== undefined) {
      return {
        action,
        rule: exactRule
      }
    }
    const prefixRule = rules.find(
      (rule) => rule.action === action && rule.match === 'prefix' && ruleMatches(args.command, rule)
    )
    if (prefixRule !== undefined) {
      return {
        action,
        rule: prefixRule
      }
    }
  }
  return null
}

export function getAgentCoreShellCommandPrefix(command: string): string | null {
  const tokens = commandTokens(stripSafePrefixes(command))
  if (tokens.length === 0) {
    return null
  }
  const first = tokens[0]!
  const second = tokens[1]
  if (DANGEROUS_PREFIX_COMMANDS.has(first)) {
    return null
  }
  if (second !== undefined && isPrefixSubcommand(second)) {
    return `${first} ${second}`
  }
  if (isPrefixSubcommand(first)) {
    return first
  }
  return null
}

export function suggestAgentCoreShellPermissionRules(
  command: string,
  options: {
    cwd?: string
    scope?: AgentCoreShellPermissionRuleScope
  } = {}
): AgentCoreShellPermissionRule[] {
  const trimmed = command.trim()
  if (trimmed.length === 0 || containsShellControl(trimmed)) {
    return []
  }
  const scopedFields =
    options.scope === 'project' && options.cwd !== undefined
      ? {
          scope: 'project' as const,
          cwd: options.cwd
        }
      : {}
  const prefix = getAgentCoreShellCommandPrefix(trimmed)
  const exactRule: AgentCoreShellPermissionRule = {
    action: 'allow',
    match: 'exact',
    command: trimmed,
    ...scopedFields,
    source: 'suggested'
  }
  if (prefix === null || prefix === trimmed) {
    return [exactRule]
  }
  return [
    {
      action: 'allow',
      match: 'prefix',
      command: prefix,
      ...scopedFields,
      source: 'suggested'
    },
    exactRule
  ]
}
