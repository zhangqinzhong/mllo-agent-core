import { createHash } from 'node:crypto'
import type { AgentCoreShellPermissionRule } from '../permissions/agent-core-permission-types'
import { readMlloAgentCoreConfig, writeMlloAgentCoreConfig } from './agent-core-mllo-config'
import { MlloShellPermissionRuleSchema } from './agent-core-mllo-shell-permission-rule-schema'

export type MlloShellPermissionRuleConfig = AgentCoreShellPermissionRule

export type MlloShellPermissionRuleSaveResult = {
  status: 'added' | 'already-exists'
  rule: MlloShellPermissionRuleConfig
}

export type MlloShellPermissionRuleSummary = MlloShellPermissionRuleConfig & {
  id: string
  description: string
}

export type MlloShellPermissionRuleDeleteResult =
  | {
      status: 'deleted'
      rule: MlloShellPermissionRuleSummary
    }
  | {
      status: 'not-found'
    }

function normalizeMlloShellPermissionRule(
  rule: MlloShellPermissionRuleConfig
): MlloShellPermissionRuleConfig {
  const parsed = MlloShellPermissionRuleSchema.parse(rule)
  const command = parsed.command.trim()
  if (command.length === 0) {
    throw new Error('mllo shell permission rule command is required.')
  }
  const cwd = parsed.cwd?.trim()
  const scope = parsed.scope ?? (cwd === undefined ? undefined : 'project')
  if (scope === 'project' && (cwd === undefined || cwd.length === 0)) {
    throw new Error('mllo project shell permission rule cwd is required.')
  }
  const normalized: MlloShellPermissionRuleConfig = {
    action: parsed.action,
    match: parsed.match,
    command,
    source: 'user'
  }
  if (scope === 'project') {
    normalized.scope = 'project'
    normalized.cwd = cwd
  }
  return normalized
}

function isSameMlloShellPermissionRule(
  left: MlloShellPermissionRuleConfig,
  right: MlloShellPermissionRuleConfig
): boolean {
  return (
    left.action === right.action &&
    left.match === right.match &&
    left.command === right.command &&
    left.scope === right.scope &&
    left.cwd === right.cwd
  )
}

function getMlloShellPermissionRuleId(rule: MlloShellPermissionRuleConfig): string {
  const scopedKey = rule.scope === 'project' ? `\0project\0${rule.cwd ?? ''}` : ''
  return createHash('sha256')
    .update(`${rule.action}\0${rule.match}\0${rule.command}${scopedKey}`)
    .digest('hex')
    .slice(0, 16)
}

function describeMlloShellPermissionRule(rule: MlloShellPermissionRuleConfig): string {
  const action = rule.action === 'allow' ? 'Allow' : rule.action === 'deny' ? 'Deny' : 'Ask'
  const match = rule.match === 'exact' ? 'exact command' : 'commands with prefix'
  const scope = rule.scope === 'project' ? ` in project ${rule.cwd ?? '(unknown cwd)'}` : ''
  return `${action} ${match}${scope}: ${rule.command}`
}

function toMlloShellPermissionRuleSummary(
  rule: MlloShellPermissionRuleConfig
): MlloShellPermissionRuleSummary {
  return {
    ...rule,
    id: getMlloShellPermissionRuleId(rule),
    description: describeMlloShellPermissionRule(rule)
  }
}

export async function listMlloShellPermissionRuleConfigs(
  configPath: string
): Promise<MlloShellPermissionRuleSummary[]> {
  const config = await readMlloAgentCoreConfig(configPath)
  return (config.shellPermissionRules ?? []).map(toMlloShellPermissionRuleSummary)
}

export async function deleteMlloShellPermissionRuleConfig(
  ruleId: string,
  configPath: string
): Promise<MlloShellPermissionRuleDeleteResult> {
  const config = await readMlloAgentCoreConfig(configPath)
  const rules = config.shellPermissionRules ?? []
  const index = rules.findIndex((rule) => getMlloShellPermissionRuleId(rule) === ruleId)
  if (index < 0) {
    return {
      status: 'not-found'
    }
  }
  const deletedRule = toMlloShellPermissionRuleSummary(rules[index]!)
  await writeMlloAgentCoreConfig(
    {
      ...config,
      shellPermissionRules: rules.filter((_, candidateIndex) => candidateIndex !== index)
    },
    configPath
  )
  return {
    status: 'deleted',
    rule: deletedRule
  }
}

export async function saveMlloShellPermissionRuleConfig(
  rule: MlloShellPermissionRuleConfig,
  configPath: string
): Promise<MlloShellPermissionRuleSaveResult> {
  const config = await readMlloAgentCoreConfig(configPath)
  const normalizedRule = normalizeMlloShellPermissionRule(rule)
  const existingRules = config.shellPermissionRules ?? []
  const existing = existingRules.find((candidate) =>
    isSameMlloShellPermissionRule(candidate, normalizedRule)
  )
  if (existing !== undefined) {
    return {
      status: 'already-exists',
      rule: existing
    }
  }
  await writeMlloAgentCoreConfig(
    {
      ...config,
      shellPermissionRules: [...existingRules, normalizedRule]
    },
    configPath
  )
  return {
    status: 'added',
    rule: normalizedRule
  }
}
