import { z } from 'zod'
import type { AgentCoreShellTerminationResult } from './shell-process-termination'

export const AGENT_CORE_SHELL_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const AGENT_CORE_SHELL_MAX_RESULT_CHARS = 200_000

export const agentCoreShellCommandInputSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute from the current shell cwd.'),
  description: z
    .string()
    .optional()
    .describe('Short active-voice reason for running the command, used in permission review.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Explicit environment variable overrides for this command only.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum foreground wait time in milliseconds before the command is timed out.'),
  runInBackground: z
    .boolean()
    .optional()
    .describe('Set true for long-running commands and inspect them later with shell_tasks.')
})

export type AgentCoreShellCommandInput = z.infer<typeof agentCoreShellCommandInputSchema>

export type AgentCoreShellCommandOutput = {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  elapsedMs: number
  timedOut: boolean
  interrupted: boolean
  terminationResult?: AgentCoreShellTerminationResult
  errorMessage?: string
  envWarnings?: string[]
  cwd: string
  cwdChanged?: {
    previousCwd: string
    currentCwd: string
  }
  backgroundTaskId?: string
  outputPath?: string
}
