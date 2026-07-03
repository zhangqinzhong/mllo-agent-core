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

function instructionPath(directory: string): string {
  return join(directory, "AGENTS.md");
}

function targetInstructionDirectories(args: {
  targetPath: string;
  workspaceRoots: readonly string[];
}): string[] {
  const targetDir = dirname(resolve(args.targetPath));
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const workspaceRoot of args.workspaceRoots) {
    const root = resolve(workspaceRoot);
    if (!isInsideOrSameDirectory(root, targetDir)) {
      continue;
    }
    for (const directory of collectInstructionDirectories({
      workspaceRoot: root,
      cwd: targetDir,
    })) {
      if (seen.has(directory)) {
        continue;
      }
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

async function readInstructionPath(path: string): Promise<AgentCoreProjectInstruction | undefined> {
  try {
    return {
      source: "AGENTS.md",
      path,
      content: await readFile(path, "utf8"),
    };
  } catch {
    // AGENTS.md 是可选项目规则文件；不存在或不可读时不阻塞 agent run。
    return undefined;
  }
}

// 读取 cwd 到 workspace root 之间的 AGENTS.md。目录级规则不能越界泄漏到其他项目。
export async function readAgentCoreProjectInstructions(args: {
  cwd: string;
  workspaceRoots: readonly string[];
}): Promise<AgentCoreProjectInstruction[]> {
  const instructions: AgentCoreProjectInstruction[] = [];
  for (const directory of uniqueInstructionDirectories(args)) {
    const instruction = await readInstructionPath(instructionPath(directory));
    if (instruction !== undefined) {
      instructions.push(instruction);
    }
  }
  return instructions;
}

// 读取目标文件路径额外适用的 AGENTS.md。写文件前用它发现 cwd 之外或更深目录的规则。
export async function readAgentCoreProjectInstructionsForPath(args: {
  cwd: string;
  workspaceRoots: readonly string[];
  targetPath: string;
}): Promise<AgentCoreProjectInstruction[]> {
  const alreadyLoadedPaths = new Set(
    uniqueInstructionDirectories({
      cwd: args.cwd,
      workspaceRoots: args.workspaceRoots,
    }).map(instructionPath),
  );
  const instructions: AgentCoreProjectInstruction[] = [];
  for (const directory of targetInstructionDirectories(args)) {
    const path = instructionPath(directory);
    if (alreadyLoadedPaths.has(path)) {
      continue;
    }
    const instruction = await readInstructionPath(path);
    if (instruction !== undefined) {
      instructions.push(instruction);
    }
  }
  return instructions;
}
