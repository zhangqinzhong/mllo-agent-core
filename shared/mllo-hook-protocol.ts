export const MLLO_HOOK_PHASES = [
  'session-start',
  'user-prompt-submit',
  'pre-tool',
  'permission-request',
  'elicitation',
  'elicitation-result',
  'post-tool',
  'post-tool-failure',
  'pre-compact',
  'post-compact',
  'session-end',
  'file-changed',
  'cwd-changed',
  'stop-failure',
  'subagent-start',
  'subagent-end',
  'stop'
] as const

export type MlloHookPhase = (typeof MLLO_HOOK_PHASES)[number]

export type MlloHookMatcher = {
  toolNames?: string[]
  filePathGlobs?: string[]
  cwdGlobs?: string[]
  userPromptIncludes?: string[]
  workerIds?: string[]
}

export type MlloHookDraft = {
  name: string
  phase: MlloHookPhase
  command: string
  matcher?: MlloHookMatcher
  timeoutMs?: number
}

export type MlloHookSaveResult = {
  hook: MlloHookSummary
}

export type MlloHookTrustStatus = 'trusted' | 'untrusted' | 'changed'

export type MlloHookSummary = {
  name: string
  phase: MlloHookPhase
  command: string
  trustStatus: MlloHookTrustStatus
  expectedTrustedHash: string
  trustedHash?: string
  matcher?: MlloHookMatcher
  timeoutMs?: number
}

export type MlloHookApprovalResult = {
  status: 'updated' | 'already-trusted'
  hookName: string
  trustedHash: string
}
