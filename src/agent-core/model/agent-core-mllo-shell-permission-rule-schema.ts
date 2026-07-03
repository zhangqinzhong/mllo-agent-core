import { z } from 'zod'

export const MlloShellPermissionRuleSchema = z.object({
  action: z.enum(['allow', 'ask', 'deny']),
  match: z.enum(['exact', 'prefix']),
  command: z.string().min(1),
  scope: z.enum(['global', 'project']).optional(),
  cwd: z.string().min(1).optional(),
  source: z.string().min(1).optional()
})
