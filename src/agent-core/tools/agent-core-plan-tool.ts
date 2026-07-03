import { z } from 'zod'
import type { AgentCoreToolDefinition, AgentCoreToolResult } from './agent-core-tool-types'
import {
  appendAgentCorePlanJournalEntry,
  type AgentCorePlanItem,
  type AgentCorePlanSnapshot
} from './agent-core-plan-journal'
import { createAgentCoreToolInputValidationResult } from './agent-core-tool-input-validation'

const planItemSchema = z.object({
  step: z.string().min(1).describe('Concrete task step written as a short action.'),
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form shown while the item is in progress.'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('Current step state; only one item may be in_progress.')
})

const planInputSchema = z.object({
  explanation: z
    .string()
    .min(1)
    .optional()
    .describe('Brief reason for changing the plan, used when it helps future recovery.'),
  plan: z
    .array(planItemSchema)
    .min(1)
    .max(20)
    .describe('Complete replacement plan for the current session.')
})

type PlanInput = z.infer<typeof planInputSchema>

export type AgentCorePlanToolOptions = {
  journalPath?: string
}

// plan 同一时间最多只能有一个 in_progress，避免恢复后模型不知道当前焦点。
function validatePlanFocus(items: readonly AgentCorePlanItem[]): AgentCoreToolResult | undefined {
  const activeItems = items.filter((item) => item.status === 'in_progress')
  if (activeItems.length <= 1) {
    return undefined
  }
  return {
    content: 'Plan can contain at most one in_progress item.',
    isError: true
  }
}

function verificationNudgeNeeded(items: readonly AgentCorePlanItem[]): boolean {
  return (
    items.length >= 3 &&
    items.every((item) => item.status === 'completed') &&
    !items.some((item) =>
      /verif|test|validate|检查|验证|测试/i.test(`${item.step} ${item.activeForm ?? ''}`)
    )
  )
}

// 生成持久快照。undefined 字段不写入，保持 exact optional property types 友好。
function createPlanSnapshot(input: PlanInput): AgentCorePlanSnapshot {
  const snapshot: AgentCorePlanSnapshot = {
    items: input.plan.map((item) => ({
      step: item.step,
      activeForm: item.activeForm,
      status: item.status
    })),
    updatedAt: new Date().toISOString()
  }
  if (input.explanation !== undefined) {
    snapshot.explanation = input.explanation
  }
  return snapshot
}

// 渲染工具结果。短结果足够，完整计划会进入下一轮 turn context。
function formatPlanSnapshot(snapshot: AgentCorePlanSnapshot): string {
  const lines = ['Plan updated.']
  if (snapshot.explanation !== undefined) {
    lines.push(`Explanation: ${snapshot.explanation}`)
  }
  lines.push('')
  lines.push(
    ...snapshot.items.map((item) => {
      const activeForm =
        item.activeForm === undefined || item.activeForm.length === 0
          ? ''
          : ` (active: ${item.activeForm})`
      return `- ${item.status}: ${item.step}${activeForm}`
    })
  )
  if (verificationNudgeNeeded(snapshot.items)) {
    lines.push(
      '',
      'NOTE: You just completed 3+ plan items and none of them was a verification step. Run an appropriate verification step before finalizing.'
    )
  }
  return lines.join('\n')
}

export function createAgentCorePlanTool(
  options: AgentCorePlanToolOptions = {}
): AgentCoreToolDefinition {
  return {
    name: 'update_plan',
    description: [
      'Create or replace the current session plan.',
      'Use this before multi-step work and whenever progress changes.',
      'Each item has step, activeForm, and status: pending, in_progress, or completed.',
      'At most one item may be in_progress.',
      'Include a verification item for non-trivial implementation work.'
    ].join('\n'),
    inputSchema: planInputSchema,
    async run(input) {
      const parsed = planInputSchema.safeParse(input)
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: 'update_plan',
          error: parsed.error
        })
      }
      const focusError = validatePlanFocus(parsed.data.plan)
      if (focusError !== undefined) {
        return focusError
      }
      const snapshot = createPlanSnapshot(parsed.data)
      if (options.journalPath !== undefined) {
        await appendAgentCorePlanJournalEntry({
          journalPath: options.journalPath,
          plan: snapshot
        })
      }
      return {
        content: formatPlanSnapshot(snapshot)
      }
    }
  }
}
