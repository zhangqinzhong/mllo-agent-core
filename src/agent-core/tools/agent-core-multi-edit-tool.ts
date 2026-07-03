import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath
} from '../permissions/workspace-path-policy'
import { createAgentCoreEditFailureMessage } from './agent-core-file-edit-context'
import { createMultiExactReplacementFileChangeProgress } from './agent-core-file-change-progress'
import { detectAgentCoreStaleFileWrite } from './agent-core-file-stale-write'
import type { AgentCoreFilesystemToolOptions } from './agent-core-filesystem-tools'
import type { AgentCoreToolDefinition, AgentCoreToolResult } from './agent-core-tool-types'
import { createAgentCoreToolInputValidationResult } from './agent-core-tool-input-validation'

const multiEditItemSchema = z.object({
  oldText: z
    .string()
    .min(1)
    .describe('Exact text to replace at this step. Must be unique unless replaceAll is true.'),
  newText: z.string().describe('Replacement text for this edit step.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Set true only when this step should replace every matching occurrence.')
})

const multiEditInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative file path to edit.'),
  edits: z
    .array(multiEditItemSchema)
    .min(1)
    .describe('Ordered exact replacements to apply atomically to the same file.')
})

type MultiEditInput = z.infer<typeof multiEditInputSchema>
type MultiEditItem = MultiEditInput['edits'][number]

type AppliedMultiEdit = {
  oldText: string
  newText: string
  replacementCount: number
}

type MultiEditApplyResult =
  | {
      status: 'ok'
      content: string
      edits: AppliedMultiEdit[]
    }
  | {
      status: 'error'
      result: AgentCoreToolResult
    }

// 统计当前内容里的精确匹配次数。每一步都要重新统计，因为前序 edit 会改变文本。
function countOccurrences(content: string, target: string): number {
  let count = 0
  let offset = 0
  while (offset < content.length) {
    const index = content.indexOf(target, offset)
    if (index === -1) {
      return count
    }
    count += 1
    offset = index + target.length
  }
  return count
}

// 应用单个 edit。调用前已经校验过匹配数量，这里只负责替换和计数。
function applyOneEdit(
  content: string,
  edit: MultiEditItem
): {
  content: string
  replacementCount: number
} {
  const replacementCount = countOccurrences(content, edit.oldText)
  const nextContent =
    edit.replaceAll === true
      ? content.split(edit.oldText).join(edit.newText)
      : content.replace(edit.oldText, edit.newText)
  return {
    content: nextContent,
    replacementCount
  }
}

// 按顺序模拟全部 edits。只有全部成功时才允许调用方写盘，实现逻辑原子性。
function applyMultiEdit(input: MultiEditInput, content: string): MultiEditApplyResult {
  let nextContent = content
  const appliedEdits: AppliedMultiEdit[] = []
  for (const [index, edit] of input.edits.entries()) {
    const replacementCount = countOccurrences(nextContent, edit.oldText)
    if (replacementCount === 0) {
      return {
        status: 'error',
        result: {
          content: createAgentCoreEditFailureMessage({
            path: input.path,
            content: nextContent,
            oldText: edit.oldText,
            reason: `Edit ${index + 1}: no match found for oldText in ${input.path}.`
          }),
          isError: true
        }
      }
    }
    if (replacementCount > 1 && edit.replaceAll !== true) {
      return {
        status: 'error',
        result: {
          content: createAgentCoreEditFailureMessage({
            path: input.path,
            content: nextContent,
            oldText: edit.oldText,
            reason: `Edit ${index + 1}: found ${replacementCount} matches for oldText in ${input.path}; set replaceAll=true or provide a unique oldText.`
          }),
          isError: true
        }
      }
    }
    const applied = applyOneEdit(nextContent, edit)
    nextContent = applied.content
    appliedEdits.push({
      oldText: edit.oldText,
      newText: edit.newText,
      replacementCount: applied.replacementCount
    })
  }
  return {
    status: 'ok',
    content: nextContent,
    edits: appliedEdits
  }
}

// 多段编辑要先完整校验再写入，避免前几段成功、后几段失败导致文件半更新。
export function createAgentCoreMultiEditTool(
  options: AgentCoreFilesystemToolOptions
): AgentCoreToolDefinition {
  return {
    name: 'multi_edit',
    description:
      'Apply multiple exact text replacements to one UTF-8 workspace file atomically and in order.',
    inputSchema: multiEditInputSchema,
    evaluatePermission(input) {
      const parsed = multiEditInputSchema.safeParse(input)
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, 'write')
        : {
            status: 'deny',
            capability: 'file-write',
            reason: 'Invalid multi_edit input.'
          }
    },
    isConcurrencySafe: () => false,
    async run(input, context) {
      const parsed = multiEditInputSchema.safeParse(input)
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: 'multi_edit',
          error: parsed.error
        })
      }

      const resolvedPath = resolveAgentCorePath(options.permissionContext, parsed.data.path)
      const realPathDecision = await evaluateAgentCoreRealPathPermission(
        options.permissionContext,
        parsed.data.path,
        'write'
      )
      if (realPathDecision !== null) {
        return {
          content: realPathDecision.reason,
          isError: true
        }
      }
      const currentContent = await readFile(resolvedPath, 'utf8')
      const applied = applyMultiEdit(parsed.data, currentContent)
      if (applied.status === 'error') {
        return applied.result
      }
      await options.onBeforeFileWrite?.({
        path: parsed.data.path,
        resolvedPath,
        previousContent: currentContent
      })
      const staleWrite = await detectAgentCoreStaleFileWrite({
        path: parsed.data.path,
        resolvedPath,
        expectedContent: currentContent,
        toolName: 'multi_edit'
      })
      if (staleWrite !== null) {
        return staleWrite
      }
      await writeFile(resolvedPath, applied.content, 'utf8')
      await options.onAfterFileWrite?.({
        path: parsed.data.path,
        resolvedPath,
        contentAfterWrite: applied.content
      })
      context.onProgress?.({
        kind: 'file-change',
        change: createMultiExactReplacementFileChangeProgress({
          path: parsed.data.path,
          edits: applied.edits,
          before: currentContent,
          after: applied.content
        })
      })
      return {
        content: `Applied ${applied.edits.length} edits to ${parsed.data.path}.`
      }
    }
  }
}
