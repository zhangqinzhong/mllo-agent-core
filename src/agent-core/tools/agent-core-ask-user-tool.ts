import { z } from 'zod'
import type { AgentCoreToolDefinition, AgentCoreToolResult } from './agent-core-tool-types'
import { createAgentCoreToolInputValidationResult } from './agent-core-tool-input-validation'

const askUserInputSchema = z.object({
  question: z.string().min(1),
  context: z.string().min(1).optional(),
  options: z.array(z.string().min(1)).min(1).max(12).optional(),
  allowFreeform: z.boolean().optional()
})

// 将模型输入解析成可展示给用户的问题；解析错误必须回灌给模型，不能让运行崩掉。
function parseAskUserInput(
  input: unknown
): AgentCoreToolResult | z.infer<typeof askUserInputSchema> {
  const parsed = askUserInputSchema.safeParse(input)
  if (!parsed.success) {
    return createAgentCoreToolInputValidationResult({
      toolName: 'ask_user',
      error: parsed.error
    })
  }
  return parsed.data
}

// 创建 mllo elicitation 工具；它只发起暂停，不直接读取 GUI。
export function createAgentCoreAskUserTool(): AgentCoreToolDefinition {
  return {
    name: 'ask_user',
    description:
      'Ask the user a focused question when their input is required to continue. Provide a clear question, optional context, optional choices, and allowFreeform when free text is acceptable.',
    inputSchema: askUserInputSchema,
    isConcurrencySafe() {
      // 用户问答必须串行；并发多个问题会让 GUI 和模型上下文都难以对应。
      return false
    },
    // 只创建 elicitation 暂停请求；真正的用户答案由 controller/GUI 恢复链路写回。
    async run(input) {
      const parsed = parseAskUserInput(input)
      if ('content' in parsed) {
        return parsed
      }
      return {
        content: 'Waiting for user answer.',
        elicitation: {
          question: parsed.question,
          context: parsed.context,
          options: parsed.options,
          allowFreeform: parsed.allowFreeform ?? true
        }
      }
    }
  }
}
