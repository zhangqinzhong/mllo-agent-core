import type { AgentCoreFileChangeProgress } from './agent-core-tool-types'

const DEFAULT_DIFF_PREVIEW_MAX_CHARS = 20_000

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length
}

function diffLines(prefix: '-' | '+', content: string): string[] {
  return content.split(/\r?\n/).map((line) => `${prefix}${line}`)
}

function limitDiffPreview(diffPreview: string): {
  diffPreview: string
  diffPreviewTruncated: boolean
} {
  if (diffPreview.length <= DEFAULT_DIFF_PREVIEW_MAX_CHARS) {
    return {
      diffPreview,
      diffPreviewTruncated: false
    }
  }
  return {
    diffPreview: `${diffPreview.slice(0, DEFAULT_DIFF_PREVIEW_MAX_CHARS)}\n[diff preview truncated after ${DEFAULT_DIFF_PREVIEW_MAX_CHARS} chars]`,
    diffPreviewTruncated: true
  }
}

function createBaseFileChangeProgress(args: {
  path: string
  replacementCount: number
  before: string
  after: string
  diffPreview: string
}): AgentCoreFileChangeProgress {
  const beforeLines = countLines(args.before)
  const afterLines = countLines(args.after)
  const limitedPreview = limitDiffPreview(args.diffPreview)
  return {
    path: args.path,
    replacementCount: args.replacementCount,
    beforeLines,
    afterLines,
    addedLines: Math.max(afterLines - beforeLines, 0),
    removedLines: Math.max(beforeLines - afterLines, 0),
    diffPreview: limitedPreview.diffPreview,
    diffPreviewTruncated: limitedPreview.diffPreviewTruncated
  }
}

export function createExactReplacementFileChangeProgress(args: {
  path: string
  oldText: string
  newText: string
  replacementCount: number
  before: string
  after: string
}): AgentCoreFileChangeProgress {
  const suffix = args.replacementCount > 1 ? ` (${args.replacementCount} replacements)` : ''
  return createBaseFileChangeProgress({
    path: args.path,
    replacementCount: args.replacementCount,
    before: args.before,
    after: args.after,
    diffPreview: [
      `--- ${args.path}`,
      `+++ ${args.path}`,
      `@@ exact replacement${suffix} @@`,
      ...diffLines('-', args.oldText),
      ...diffLines('+', args.newText)
    ].join('\n')
  })
}

export function createMultiExactReplacementFileChangeProgress(args: {
  path: string
  edits: {
    oldText: string
    newText: string
    replacementCount: number
  }[]
  before: string
  after: string
}): AgentCoreFileChangeProgress {
  const totalReplacements = args.edits.reduce((total, edit) => total + edit.replacementCount, 0)
  return createBaseFileChangeProgress({
    path: args.path,
    replacementCount: totalReplacements,
    before: args.before,
    after: args.after,
    diffPreview: [
      `--- ${args.path}`,
      `+++ ${args.path}`,
      ...args.edits.flatMap((edit, index) => {
        const suffix = edit.replacementCount > 1 ? ` (${edit.replacementCount} replacements)` : ''
        return [
          `@@ exact replacement ${index + 1}${suffix} @@`,
          ...diffLines('-', edit.oldText),
          ...diffLines('+', edit.newText)
        ]
      })
    ].join('\n')
  })
}

export function createWriteFileChangeProgress(args: {
  path: string
  content: string
  previousContent: string | null
}): AgentCoreFileChangeProgress {
  const isCreate = args.previousContent === null
  const previousDiffLines = isCreate ? [] : diffLines('-', args.previousContent ?? '')
  return createBaseFileChangeProgress({
    path: args.path,
    replacementCount: isCreate ? 0 : 1,
    before: args.previousContent ?? '',
    after: args.content,
    diffPreview: [
      `--- ${args.path}`,
      `+++ ${args.path}`,
      isCreate ? '@@ create file @@' : '@@ overwrite file @@',
      ...previousDiffLines,
      ...diffLines('+', args.content)
    ].join('\n')
  })
}
