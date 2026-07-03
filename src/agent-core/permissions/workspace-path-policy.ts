import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "path";
import type {
  AgentCorePathOperation,
  AgentCorePermissionContext,
  AgentCorePermissionDecision,
} from "./agent-core-permission-types";

// 构造统一的路径权限结果，避免每个分支手写 capability 和 reason。
function decision(
  status: AgentCorePermissionDecision["status"],
  operation: AgentCorePathOperation,
  reason: string,
): AgentCorePermissionDecision {
  return {
    status,
    capability: operation === "read" ? "file-read" : "file-write",
    reason,
  };
}

// 判断 candidate 是否在 root 内部或正好等于 root；防止 ../ 和跨盘路径逃逸。
function isInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// 规范化 workspace root 列表。空字符串不参与判断，其他路径统一 resolve。
function normalizeRoots(roots: readonly string[]): string[] {
  return roots.filter((root) => root.trim().length > 0).map((root) => resolve(root));
}

// workspace root 本身可能是 symlink，真实边界必须按 realpath 比较。
async function normalizeRealRoots(roots: readonly string[]): Promise<string[]> {
  const resolvedRoots = normalizeRoots(roots);
  const realRoots: string[] = [];
  for (const root of resolvedRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        realRoots.push(root);
        continue;
      }
      throw error;
    }
  }
  return realRoots;
}

// 工具会先检查再读写，缺失路径不能被当成系统错误提前打断。
async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// 新文件还不存在时，必须用最近存在父目录判断 symlink 逃逸。
async function nearestExistingParentRealPath(path: string): Promise<string | null> {
  let current = dirname(path);
  const root = parse(current).root;
  while (current !== root) {
    const real = await realpathOrNull(current);
    if (real !== null) {
      return real;
    }
    current = dirname(current);
  }
  return await realpathOrNull(root);
}

// 把模型传入的相对/绝对路径解析成实际检查路径；相对路径基于本次 run 的 cwd。
export function resolveAgentCorePath(
  context: AgentCorePermissionContext,
  targetPath: string,
): string {
  return resolve(context.cwd, targetPath);
}

// 判断目标路径是否落在当前 agent run 允许访问的 workspace roots 里。
export function isPathInsideAgentWorkspace(
  context: AgentCorePermissionContext,
  targetPath: string,
): boolean {
  const resolved = resolveAgentCorePath(context, targetPath);
  return normalizeRoots(context.workspaceRoots).some((root) => isInsideOrEqual(root, resolved));
}

// 对文件读写做权限判断。它只给出 allow/ask/deny，不直接执行任何文件操作。
export function evaluateAgentCorePathPermission(
  context: AgentCorePermissionContext,
  targetPath: string,
  operation: AgentCorePathOperation,
): AgentCorePermissionDecision {
  const resolved = resolveAgentCorePath(context, targetPath);
  const deniedRoots = normalizeRoots(context.deniedPaths ?? []);
  if (deniedRoots.some((root) => isInsideOrEqual(root, resolved))) {
    return decision("deny", operation, "Path is explicitly denied for this agent run.");
  }

  if (!isPathInsideAgentWorkspace(context, resolved)) {
    return decision("deny", operation, "Path is outside the active workspace roots.");
  }

  if (context.mode === "dangerously-bypass" || operation === "read") {
    return decision("allow", operation, "Path is inside the active workspace roots.");
  }

  if (context.mode === "workspace-write") {
    return decision("allow", operation, "Workspace write mode allows writes inside roots.");
  }

  return decision("ask", operation, "Mutating workspace files requires approval in this mode.");
}

// 字符串路径检查挡不住 symlink，执行前还要按真实路径再验一次边界。
export async function evaluateAgentCoreRealPathPermission(
  context: AgentCorePermissionContext,
  targetPath: string,
  operation: AgentCorePathOperation,
  options: {
    fallbackToExistingParent?: boolean;
  } = {},
): Promise<AgentCorePermissionDecision | null> {
  const resolved = resolveAgentCorePath(context, targetPath);
  const realTarget =
    (await realpathOrNull(resolved)) ??
    (options.fallbackToExistingParent === true
      ? await nearestExistingParentRealPath(resolved)
      : null);
  if (realTarget === null) {
    return null;
  }

  const deniedRoots = await normalizeRealRoots(context.deniedPaths ?? []);
  if (deniedRoots.some((root) => isInsideOrEqual(root, realTarget))) {
    return decision("deny", operation, "Resolved path is explicitly denied for this agent run.");
  }

  const workspaceRoots = await normalizeRealRoots(context.workspaceRoots);
  if (!workspaceRoots.some((root) => isInsideOrEqual(root, realTarget))) {
    return decision("deny", operation, "Resolved path escapes the active workspace roots.");
  }

  return null;
}
