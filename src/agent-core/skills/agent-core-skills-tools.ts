import { z } from 'zod'
import type { MlloRuntimeHomeOptions } from '../runtime-home/mllo-runtime-home-types'
import type { AgentCoreToolDefinition, AgentCoreToolResult } from '../tools/agent-core-tool-types'
import { discoverAgentCoreSkills, readAgentCoreSkill } from './agent-core-skill-discovery'

const readSkillInputSchema = z.object({
  skill: z.string().min(1),
  maxBytes: z.number().int().positive().optional()
})

export type AgentCoreSkillsToolOptions = {
  cwd: string
  homeDir?: string
  runtimeHome?: MlloRuntimeHomeOptions
}

function validationErrorResult(error: z.ZodError): AgentCoreToolResult {
  return {
    content: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
    isError: true
  }
}

function formatSkillList(
  skills: Awaited<ReturnType<typeof discoverAgentCoreSkills>>
): AgentCoreToolResult {
  if (skills.length === 0) {
    return {
      content: 'No skills discovered.'
    }
  }
  return {
    content: skills
      .map((skill) => {
        const lines = [
          `id: ${skill.id}`,
          `name: ${skill.name}`,
          `source: ${skill.sourceLabel}`,
          `providers: ${skill.providers.join(', ')}`
        ]
        if (skill.description !== undefined) {
          lines.push(`description: ${skill.description}`)
        }
        return lines.join('\n')
      })
      .join('\n\n---\n\n')
  }
}

export function createAgentCoreListSkillsTool(
  options: AgentCoreSkillsToolOptions
): AgentCoreToolDefinition {
  return {
    name: 'list_skills',
    description: 'List discovered agent skills. Use read_skill to load the full SKILL.md.',
    isConcurrencySafe: () => true,
    async run() {
      return formatSkillList(await discoverAgentCoreSkills(options))
    }
  }
}

export function createAgentCoreReadSkillTool(
  options: AgentCoreSkillsToolOptions
): AgentCoreToolDefinition {
  return {
    name: 'read_skill',
    description: [
      'Read the full SKILL.md for a discovered skill by id or name.',
      'Use this before following a skill; summaries in the prompt are not enough.'
    ].join('\n'),
    inputSchema: readSkillInputSchema,
    maxResultSizeChars: 260_000,
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = readSkillInputSchema.safeParse(input)
      if (!parsed.success) {
        return validationErrorResult(parsed.error)
      }
      const result = await readAgentCoreSkill({
        ...options,
        skillRef: parsed.data.skill,
        maxBytes: parsed.data.maxBytes
      })
      if (result === undefined) {
        return {
          content: `Skill is not discovered: ${parsed.data.skill}`,
          isError: true
        }
      }
      return {
        content: [
          `Skill: ${result.skill.name}`,
          `Source: ${result.skill.sourceLabel}`,
          `Path: ${result.skill.skillFilePath}`,
          '',
          result.truncated ? `${result.markdown}\n\n[SKILL.md truncated]` : result.markdown
        ].join('\n')
      }
    }
  }
}
