import { resolve } from 'node:path'
import type { buildAgentCoreContext } from '../context/agent-core-context-builder'

type AgentCoreContextResume = Awaited<ReturnType<typeof buildAgentCoreContext>>['resume']

export function normalizeAgentCoreRunCwd(cwd: string): string {
  return resolve(cwd)
}

export function normalizeAgentCoreRunWorkspaceRoots(
  cwd: string,
  workspaceRoots: readonly string[] | undefined
): string[] {
  return (workspaceRoots?.length ? workspaceRoots : [cwd]).map((root) => resolve(cwd, root))
}

export function persistedAgentCoreRunResumeMessageCount(resume: AgentCoreContextResume): number {
  return Math.max(0, (resume?.messages.length ?? 0) - (resume?.repairedToolCallIds.length ?? 0))
}

export function getAgentCoreRunResumeOmittedEntries(resume: AgentCoreContextResume): number {
  return resume?.omittedResumableEntries ?? 0
}

export function getAgentCoreRunResumeOmittedBytes(resume: AgentCoreContextResume): number {
  return resume?.omittedResumableBytes ?? 0
}
