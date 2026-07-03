import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentCoreWorkerId } from './agent-core-worker-types'

export type AgentCoreWorkerToolResultBlob = {
  version: 1
  sessionId: string
  cwd: string
  workerId: AgentCoreWorkerId
  toolName: string
  invocationId?: string
  content: string
  originalChars: number
  createdAt: string
}

export type StoredAgentCoreWorkerToolResultBlob = {
  relativePath: string
  absolutePath: string
  byteLength: number
}

const WORKER_TOOL_RESULT_BLOBS_DIR = 'worker-tool-results'
const THREAD_RUNTIME_DIR = 'threads'

function safeBlobFileName(): string {
  return `${Date.now()}-${randomUUID()}.json`
}

function sanitizeBlobSessionId(sessionId: string): string {
  const sanitized = sessionId
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (sanitized.length === 0) {
    throw new Error('mllo sessionId is required to store worker tool result blobs.')
  }
  return sanitized
}

function isPathInsideDir(root: string, absolutePath: string): boolean {
  const relation = relative(root, absolutePath)
  return relation.length > 0 && !relation.startsWith('..') && !isAbsolute(relation)
}

function isThreadWorkerBlobRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/u).filter((part) => part.length > 0)
  return (
    parts.length >= 4 &&
    parts[0] === THREAD_RUNTIME_DIR &&
    parts[1] !== undefined &&
    parts[1].length > 0 &&
    parts[2] === WORKER_TOOL_RESULT_BLOBS_DIR
  )
}

function workerToolResultBlobRelativePath(sessionId: string): string {
  return join(
    THREAD_RUNTIME_DIR,
    sanitizeBlobSessionId(sessionId),
    WORKER_TOOL_RESULT_BLOBS_DIR,
    safeBlobFileName()
  )
}

function resolveWorkerToolResultBlobPath(args: {
  projectDir: string
  relativePath: string
}): string {
  const absolutePath = resolve(args.projectDir, args.relativePath)
  const legacyRoot = resolve(args.projectDir, WORKER_TOOL_RESULT_BLOBS_DIR)
  if (isPathInsideDir(legacyRoot, absolutePath)) {
    return absolutePath
  }
  if (isThreadWorkerBlobRelativePath(args.relativePath)) {
    const parts = args.relativePath.split(/[\\/]+/u).filter((part) => part.length > 0)
    const threadRoot = resolve(
      args.projectDir,
      THREAD_RUNTIME_DIR,
      parts[1]!,
      WORKER_TOOL_RESULT_BLOBS_DIR
    )
    if (isPathInsideDir(threadRoot, absolutePath)) {
      return absolutePath
    }
  }
  throw new Error('Worker tool result blob path escapes mllo project storage.')
}

export async function writeAgentCoreWorkerToolResultBlob(args: {
  projectDir: string
  sessionId: string
  cwd: string
  workerId: AgentCoreWorkerId
  invocationId?: string
  toolName: string
  content: string
}): Promise<StoredAgentCoreWorkerToolResultBlob> {
  const relativePath = workerToolResultBlobRelativePath(args.sessionId)
  const absolutePath = resolve(args.projectDir, relativePath)
  const blob: AgentCoreWorkerToolResultBlob = {
    version: 1,
    sessionId: args.sessionId,
    cwd: args.cwd,
    workerId: args.workerId,
    toolName: args.toolName,
    content: args.content,
    originalChars: args.content.length,
    createdAt: new Date().toISOString()
  }
  if (args.invocationId !== undefined) {
    blob.invocationId = args.invocationId
  }
  const serialized = `${JSON.stringify(blob)}\n`
  await mkdir(dirname(absolutePath), {
    recursive: true
  })
  await writeFile(absolutePath, serialized, 'utf8')
  return {
    relativePath,
    absolutePath,
    byteLength: Buffer.byteLength(serialized, 'utf8')
  }
}

export async function readAgentCoreWorkerToolResultBlob(args: {
  projectDir: string
  relativePath: string
}): Promise<AgentCoreWorkerToolResultBlob> {
  const absolutePath = resolveWorkerToolResultBlobPath(args)
  return JSON.parse(await readFile(absolutePath, 'utf8')) as AgentCoreWorkerToolResultBlob
}
