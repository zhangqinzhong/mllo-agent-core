export const AGENT_CORE_PROMPT_PROFILES = ['full', 'local-compact'] as const

export type AgentCorePromptProfile = (typeof AGENT_CORE_PROMPT_PROFILES)[number]

export const DEFAULT_AGENT_CORE_PROMPT_PROFILE: AgentCorePromptProfile = 'local-compact'

export function resolveAgentCorePromptProfile(
  profile: AgentCorePromptProfile | undefined
): AgentCorePromptProfile {
  return profile ?? DEFAULT_AGENT_CORE_PROMPT_PROFILE
}

export function isAgentCoreLocalCompactPromptProfile(
  profile: AgentCorePromptProfile | undefined
): boolean {
  return resolveAgentCorePromptProfile(profile) === 'local-compact'
}
