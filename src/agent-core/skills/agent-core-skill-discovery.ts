import { readFile } from 'node:fs/promises'
import { getMlloRuntimeHomeLayout } from '../runtime-home/mllo-home-paths'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import { discoverSkills } from '../../skills/discovery'
import { stablePathId, type SkillScanRoot } from '../../skills/skill-discovery-sources'

const MAX_AGENT_CORE_SKILLS = 80
const MAX_SKILL_MARKDOWN_BYTES = 256 * 1024

export type AgentCoreSkillSummary = {
  id: string
  name: string
  description?: string
  sourceLabel: string
  sourceKind: string
  providers: string[]
  skillFilePath: string
  updatedAt?: number
}

export type AgentCoreSkillReadResult = {
  skill: AgentCoreSkillSummary
  markdown: string
  truncated: boolean
}

function mlloSkillRoot(runtimeHome: MlloRuntimeHomeOptions | undefined): SkillScanRoot {
  const skillsDir = getMlloRuntimeHomeLayout(runtimeHome).skillsDir
  return {
    id: `mllo-skills-${stablePathId(skillsDir)}`,
    label: 'mllo skills',
    path: skillsDir,
    sourceKind: 'home',
    providers: ['agent-skills']
  }
}

function createAgentCoreSkillSummary(skill: {
  id: string
  name: string
  description: string | null
  sourceLabel: string
  sourceKind: string
  providers: readonly string[]
  skillFilePath: string
  updatedAt: number | null
}): AgentCoreSkillSummary {
  const summary: AgentCoreSkillSummary = {
    id: skill.id,
    name: skill.name,
    sourceLabel: skill.sourceLabel,
    sourceKind: skill.sourceKind,
    providers: [...skill.providers],
    skillFilePath: skill.skillFilePath
  }
  if (skill.description !== null) {
    summary.description = skill.description
  }
  if (skill.updatedAt !== null) {
    summary.updatedAt = skill.updatedAt
  }
  return summary
}

export async function discoverAgentCoreSkills(args: {
  cwd: string
  homeDir?: string
  runtimeHome?: MlloRuntimeHomeOptions
}): Promise<AgentCoreSkillSummary[]> {
  const result = await discoverSkills({
    cwd: args.cwd,
    homeDir: args.homeDir,
    additionalRoots: [mlloSkillRoot(args.runtimeHome)]
  })
  return result.skills.slice(0, MAX_AGENT_CORE_SKILLS).map(createAgentCoreSkillSummary)
}

function findAgentCoreSkill(
  skills: readonly AgentCoreSkillSummary[],
  skillRef: string
): AgentCoreSkillSummary | undefined {
  const normalized = skillRef.trim().toLowerCase()
  return skills.find(
    (skill) =>
      skill.id === skillRef ||
      skill.name.toLowerCase() === normalized ||
      skill.skillFilePath === skillRef
  )
}

export async function readAgentCoreSkill(args: {
  cwd: string
  skillRef: string
  homeDir?: string
  runtimeHome?: MlloRuntimeHomeOptions
  maxBytes?: number
}): Promise<AgentCoreSkillReadResult | undefined> {
  const skills = await discoverAgentCoreSkills(args)
  const skill = findAgentCoreSkill(skills, args.skillRef)
  if (skill === undefined) {
    return undefined
  }
  const maxBytes = Math.min(args.maxBytes ?? MAX_SKILL_MARKDOWN_BYTES, MAX_SKILL_MARKDOWN_BYTES)
  const buffer = await readFile(skill.skillFilePath)
  return {
    skill,
    markdown: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: buffer.byteLength > maxBytes
  }
}
