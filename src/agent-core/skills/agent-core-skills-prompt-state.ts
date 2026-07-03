import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import { discoverAgentCoreSkills, type AgentCoreSkillSummary } from './agent-core-skill-discovery'

export type AgentCoreSkillPromptRecord = {
  id: string
  name: string
  description?: string
  sourceLabel: string
  sourceKind: string
  providers: string[]
}

function createSkillPromptRecord(skill: AgentCoreSkillSummary): AgentCoreSkillPromptRecord {
  const record: AgentCoreSkillPromptRecord = {
    id: skill.id,
    name: skill.name,
    sourceLabel: skill.sourceLabel,
    sourceKind: skill.sourceKind,
    providers: [...skill.providers]
  }
  if (skill.description !== undefined) {
    record.description = skill.description
  }
  return record
}

function dedupeSkillPromptRecordsByName(
  skills: readonly AgentCoreSkillSummary[]
): AgentCoreSkillPromptRecord[] {
  const records: AgentCoreSkillPromptRecord[] = []
  const seenNames = new Set<string>()
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    if (seenNames.has(key)) {
      continue
    }
    seenNames.add(key)
    records.push(createSkillPromptRecord(skill))
  }
  return records
}

// prompt 只注入 skill 摘要；完整 SKILL.md 必须按需通过 read_skill 读取。
export async function createAgentCoreSkillsPromptState(args: {
  cwd: string
  homeDir?: string
  runtimeHome?: MlloRuntimeHomeOptions
}): Promise<AgentCoreSkillPromptRecord[]> {
  return dedupeSkillPromptRecordsByName(await discoverAgentCoreSkills(args))
}
