import type { AgentCoreToolCall } from '../tools/agent-core-tool-types'
import type { AgentCoreToolResultBudgetProfile } from './agent-core-budget-types'

type FileToolCallProjection = {
  toolName: string
  originalInputLength: number
  projectedInput: unknown
}

type ResolvedFileToolCallProjectionBudget = Required<
  Pick<
    AgentCoreToolResultBudgetProfile,
    'maxToolResultChars' | 'preservedToolResultHeadChars' | 'preservedToolResultTailChars'
  >
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isLargeText(value: unknown, budget: ResolvedFileToolCallProjectionBudget): boolean {
  return isString(value) && value.length > budget.maxToolResultChars
}

// 判断 write_file 是否真的需要投影。小文件保留原始 input，比协议包装更省上下文。
function shouldProjectWriteFileInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): boolean {
  return isLargeText(input.content, budget)
}

// 判断 edit_file 是否需要投影。old/new 任一过大都会影响长期上下文质量。
function shouldProjectEditFileInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): boolean {
  return isLargeText(input.oldText, budget) || isLargeText(input.newText, budget)
}

// 判断 multi_edit 是否需要投影。逐项判断能避免小编辑被无谓包装。
function shouldProjectMultiEditInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): boolean {
  return (
    Array.isArray(input.edits) &&
    input.edits.some(
      (edit) =>
        isRecord(edit) && (isLargeText(edit.oldText, budget) || isLargeText(edit.newText, budget))
    )
  )
}

// 生成可读的文本片段。文件编辑历史需要保留两端，才能看出开头协议和末尾闭合结构。
function projectText(value: string, budget: ResolvedFileToolCallProjectionBudget): unknown {
  if (value.length <= budget.maxToolResultChars) {
    return value
  }
  return {
    kind: 'mllo_text_projection',
    originalLength: value.length,
    preservedHeadLength: budget.preservedToolResultHeadChars,
    preservedTailLength: budget.preservedToolResultTailChars,
    head: value.slice(0, budget.preservedToolResultHeadChars),
    tail: value.slice(-budget.preservedToolResultTailChars)
  }
}

// 投影 write_file 输入。content 可能是整文件，不能原样长期留在模型上下文里。
function projectWriteFileInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): unknown {
  return {
    path: input.path,
    createParentDirectories: input.createParentDirectories,
    content: isString(input.content) ? projectText(input.content, budget) : input.content
  }
}

// 投影 edit_file 输入。old/new 片段是恢复编辑意图的核心，比盲目截断 JSON 更稳定。
function projectEditFileInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): unknown {
  return {
    path: input.path,
    replaceAll: input.replaceAll,
    oldText: isString(input.oldText) ? projectText(input.oldText, budget) : input.oldText,
    newText: isString(input.newText) ? projectText(input.newText, budget) : input.newText
  }
}

// 投影 multi_edit 输入。每个 edit 单独保留 old/new 语义，避免压缩后只剩一坨大数组。
function projectMultiEditInput(
  input: Record<string, unknown>,
  budget: ResolvedFileToolCallProjectionBudget
): unknown {
  const edits = Array.isArray(input.edits)
    ? input.edits.map((edit, index) => {
        if (!isRecord(edit)) {
          return edit
        }
        return {
          index: index + 1,
          replaceAll: edit.replaceAll,
          oldText: isString(edit.oldText) ? projectText(edit.oldText, budget) : edit.oldText,
          newText: isString(edit.newText) ? projectText(edit.newText, budget) : edit.newText
        }
      })
    : input.edits

  return {
    path: input.path,
    editCount: Array.isArray(input.edits) ? input.edits.length : undefined,
    edits
  }
}

// 只有文件写入类工具需要 input 投影；普通 shell 输出仍走结果预算。
function projectKnownFileToolInput(
  call: AgentCoreToolCall,
  budget: ResolvedFileToolCallProjectionBudget
): unknown | undefined {
  if (!isRecord(call.input)) {
    return undefined
  }
  if (call.name === 'write_file') {
    if (!shouldProjectWriteFileInput(call.input, budget)) {
      return undefined
    }
    return projectWriteFileInput(call.input, budget)
  }
  if (call.name === 'edit_file') {
    if (!shouldProjectEditFileInput(call.input, budget)) {
      return undefined
    }
    return projectEditFileInput(call.input, budget)
  }
  if (call.name === 'multi_edit') {
    if (!shouldProjectMultiEditInput(call.input, budget)) {
      return undefined
    }
    return projectMultiEditInput(call.input, budget)
  }
  return undefined
}

// 生成 tool call 投影。返回 undefined 表示这个 call 不需要被压缩或不是文件写入类工具。
export function createAgentCoreFileToolCallProjection(args: {
  call: AgentCoreToolCall
  budget: ResolvedFileToolCallProjectionBudget
}): FileToolCallProjection | undefined {
  const originalInputLength = JSON.stringify(args.call.input).length
  const projectedInput = projectKnownFileToolInput(args.call, args.budget)
  if (projectedInput === undefined) {
    return undefined
  }
  return {
    toolName: args.call.name,
    originalInputLength,
    projectedInput
  }
}
