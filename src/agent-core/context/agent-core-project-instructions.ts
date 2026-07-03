import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type AgentCoreProjectInstruction = {
  source: "AGENTS.md";
  path: string;
  content: string;
};

// 判断 child 是否在 parent 目录内。用 path.relative 处理跨平台路径分隔符。
function isInsideOrSameDirectory(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// 收集一个 workspace root 对 cwd 生效的目录链；cwd 不在 root 内时只读 root 规则。
function collectInstructionDirectories(args: { workspaceRoot: string; cwd: string }): string[] {
  const root = resolve(args.workspaceRoot);
  const cwd = resolve(args.cwd);
  if (!isInsideOrSameDirectory(root, cwd)) {
    return [root];
  }

  const directories: string[] = [];
  let current = cwd;
  while (isInsideOrSameDirectory(root, current)) {
    directories.push(current);
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  // 根目录规则先出现，越靠近 cwd 的规则越后出现，便于模型按更具体规则执行。
  return directories.reverse();
}

// 合并多个 workspace root 的目录链。嵌套 root 可能产生重复目录，必须去重。
function uniqueInstructionDirectories(args: {
  cwd: string;
  workspaceRoots: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const workspaceRoot of args.workspaceRoots) {
    for (const directory of collectInstructionDirectories({
      workspaceRoot,
      cwd: args.cwd,
    })) {
      const normalized = resolve(directory);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      directories.push(normalized);
    }
  }
  return directories;
}

// 读取 cwd 到 workspace root 之间的 AGENTS.md。目录级规则不能越界泄漏到其他项目。
export async function readAgentCoreProjectInstructions(args: {
  cwd: string;
  workspaceRoots: readonly string[];
}): Promise<AgentCoreProjectInstruction[]> {
  const instructions: AgentCoreProjectInstruction[] = [];
  for (const directory of uniqueInstructionDirectories(args)) {
    const path = join(directory, "AGENTS.md");
    try {
      instructions.push({
        source: "AGENTS.md",
        path,
        content: await readFile(path, "utf8"),
      });
    } catch {
      // AGENTS.md 是可选项目规则文件；不存在或不可读时不阻塞 agent run。
    }
  }
  return instructions;
}
