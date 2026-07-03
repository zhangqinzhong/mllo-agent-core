import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath
} from '../permissions/workspace-path-policy'
import { createAgentCoreEditFailureMessage } from './agent-core-file-edit-context'
import { createExactReplacementFileChangeProgress } from './agent-core-file-change-progress'
import { detectAgentCoreStaleFileWrite } from './agent-core-file-stale-write'
import type { AgentCoreFilesystemToolOptions } from './agent-core-filesystem-tools'
import type { AgentCoreToolDefinition, AgentCoreToolResult } from './agent-core-tool-types'
import { createAgentCoreToolInputValidationResult } from './agent-core-tool-input-validation'

const editFileInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative file path to edit.'),
  oldText: z
    .string()
    .min(1)
    .describe('Exact text currently in the file. Must be unique unless replaceAll is true.'),
  newText: z.string().describe('Replacement text to write in place of oldText.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of oldText should be replaced.')
})

type EditFileInput = z.infer<typeof editFileInputSchema>

export type AgentCoreFileEditToolOptions = AgentCoreFilesystemToolOptions

type FileEditReplacement =
  | {
      status: 'ok'
      content: string
      replacementCount: number
    }
  | {
      status: 'error'
      result: AgentCoreToolResult
    }

// 统计精确匹配次数。默认要求唯一匹配，避免模型误改多个位置。
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

// 生成替换后的完整文件内容。这里先校验再返回，调用方只在 ok 时写盘。
function replaceFileContent(input: EditFileInput, content: string): FileEditReplacement {
  const occurrences = countOccurrences(content, input.oldText)
  if (occurrences === 0) {
    return {
      status: 'error',
      result: {
        content: createAgentCoreEditFailureMessage({
          path: input.path,
          content,
          oldText: input.oldText,
          reason: `No match found for oldText in ${input.path}.`
        }),
        isError: true
      }
    }
  }
  if (occurrences > 1 && input.replaceAll !== true) {
    return {
      status: 'error',
      result: {
        content: createAgentCoreEditFailureMessage({
          path: input.path,
          content,
          oldText: input.oldText,
          reason: `Found ${occurrences} matches for oldText in ${input.path}; set replaceAll=true or provide a unique oldText.`
        }),
        isError: true
      }
    }
  }

  const nextContent =
    input.replaceAll === true
      ? content.split(input.oldText).join(input.newText)
      : content.replace(input.oldText, input.newText)
  return {
    status: 'ok',
    content: nextContent,
    replacementCount: occurrences
  }
}

// 精确替换避免模型用模糊 patch 改错位置；写权限仍统一走 mllo permission gate。
export function createAgentCoreEditFileTool(
  options: AgentCoreFileEditToolOptions
): AgentCoreToolDefinition {
  return {
    name: 'edit_file',
    description:
      'Edit a UTF-8 workspace file by replacing exact text. oldText must be unique unless replaceAll is true.',
    inputSchema: editFileInputSchema,
    evaluatePermission(input) {
      const parsed = editFileInputSchema.safeParse(input)
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, 'write')
        : {
            status: 'deny',
            capability: 'file-write',
            reason: 'Invalid edit_file input.'
          }
    },
    isConcurrencySafe: () => false,
    async run(input, context) {
      const parsed = editFileInputSchema.safeParse(input)
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: 'edit_file',
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
      const replaced = replaceFileContent(parsed.data, currentContent)
      if (replaced.status === 'error') {
        return replaced.result
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
        toolName: 'edit_file'
      })
      if (staleWrite !== null) {
        return staleWrite
      }
      await writeFile(resolvedPath, replaced.content, 'utf8')
      await options.onAfterFileWrite?.({
        path: parsed.data.path,
        resolvedPath,
        contentAfterWrite: replaced.content
      })
      context.onProgress?.({
        kind: 'file-change',
        change: createExactReplacementFileChangeProgress({
          path: parsed.data.path,
          oldText: parsed.data.oldText,
          newText: parsed.data.newText,
          replacementCount: replaced.replacementCount,
          before: currentContent,
          after: replaced.content
        })
      })
      return {
        content: `Edited ${parsed.data.path}.`
      }
    }
  }
}
