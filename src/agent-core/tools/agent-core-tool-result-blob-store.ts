import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type AgentCoreToolResultBlob = {
  version: 1;
  sessionId: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  content: string;
  originalChars: number;
  createdAt: string;
};

export type StoredAgentCoreToolResultBlob = {
  relativePath: string;
  absolutePath: string;
  byteLength: number;
};

const TOOL_RESULT_BLOBS_DIR = "tool-results";
const THREAD_RUNTIME_DIR = "threads";

function safeBlobFileName(): string {
  return `${Date.now()}-${randomUUID()}.json`;
}

function sanitizeBlobSessionId(sessionId: string): string {
  const sanitized = sessionId
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (sanitized.length === 0) {
    throw new Error("mllo sessionId is required to store tool result blobs.");
  }
  return sanitized;
}

function isPathInsideDir(root: string, absolutePath: string): boolean {
  const relation = relative(root, absolutePath);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

function isThreadToolBlobRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/u).filter((part) => part.length > 0);
  return (
    parts.length >= 4 &&
    parts[0] === THREAD_RUNTIME_DIR &&
    parts[1] !== undefined &&
    parts[1].length > 0 &&
    parts[2] === TOOL_RESULT_BLOBS_DIR
  );
}

function toolResultBlobRelativePath(sessionId: string): string {
  return join(
    THREAD_RUNTIME_DIR,
    sanitizeBlobSessionId(sessionId),
    TOOL_RESULT_BLOBS_DIR,
    safeBlobFileName(),
  );
}

function resolveToolResultBlobPath(args: { projectDir: string; relativePath: string }): string {
  const absolutePath = resolve(args.projectDir, args.relativePath);
  const legacyRoot = resolve(args.projectDir, TOOL_RESULT_BLOBS_DIR);
  if (isPathInsideDir(legacyRoot, absolutePath)) {
    return absolutePath;
  }
  if (isThreadToolBlobRelativePath(args.relativePath)) {
    const parts = args.relativePath.split(/[\\/]+/u).filter((part) => part.length > 0);
    const threadRoot = resolve(
      args.projectDir,
      THREAD_RUNTIME_DIR,
      parts[1]!,
      TOOL_RESULT_BLOBS_DIR,
    );
    if (isPathInsideDir(threadRoot, absolutePath)) {
      return absolutePath;
    }
  }
  throw new Error("Tool result blob path escapes mllo project storage.");
}

export async function writeAgentCoreToolResultBlob(args: {
  projectDir: string;
  sessionId: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  content: string;
  originalChars?: number;
}): Promise<StoredAgentCoreToolResultBlob> {
  const relativePath = toolResultBlobRelativePath(args.sessionId);
  const absolutePath = resolve(args.projectDir, relativePath);
  const blob: AgentCoreToolResultBlob = {
    version: 1,
    sessionId: args.sessionId,
    cwd: args.cwd,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    content: args.content,
    originalChars: args.originalChars ?? args.content.length,
    createdAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(blob)}\n`;
  await mkdir(dirname(absolutePath), {
    recursive: true,
  });
  await writeFile(absolutePath, serialized, "utf8");
  return {
    relativePath,
    absolutePath,
    byteLength: Buffer.byteLength(serialized, "utf8"),
  };
}

export async function readAgentCoreToolResultBlob(args: {
  projectDir: string;
  relativePath: string;
}): Promise<AgentCoreToolResultBlob> {
  const absolutePath = resolveToolResultBlobPath(args);
  return JSON.parse(await readFile(absolutePath, "utf8")) as AgentCoreToolResultBlob;
}
