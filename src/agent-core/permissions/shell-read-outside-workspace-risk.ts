import { posix, resolve, win32 } from "node:path";
import type {
  AgentCorePermissionContext,
  AgentCorePermissionRisk,
} from "./agent-core-permission-types";

type AgentCoreShellReadOutsideWorkspaceRisk = Extract<
  AgentCorePermissionRisk,
  { kind: "outside-workspace-shell-read" }
>;

type PathToken = {
  raw: string;
  path: string;
};

const SEARCH_PATTERN_COMMANDS = new Set(["grep", "rg"]);

function tokenizeShellCommandForPathScan(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function tokenPathValue(token: string): string | null {
  if (token.startsWith("-")) {
    const equalsIndex = token.indexOf("=");
    return equalsIndex === -1 ? null : token.slice(equalsIndex + 1);
  }
  return token;
}

function skipFirstSearchPattern(tokens: readonly string[]): string[] {
  const pathTokens: string[] = [];
  let skippedPattern = false;
  for (const token of tokens) {
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-") && !token.includes("=")) {
      continue;
    }
    if (!skippedPattern) {
      skippedPattern = true;
      continue;
    }
    pathTokens.push(token);
  }
  return pathTokens;
}

function skipFirstSedScript(tokens: readonly string[]): string[] {
  const pathTokens: string[] = [];
  let skippedScript = false;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      continue;
    }
    if (!skippedScript) {
      skippedScript = true;
      continue;
    }
    pathTokens.push(token);
  }
  return pathTokens;
}

function shellPathArgumentTokens(tokens: readonly string[]): string[] {
  const command = tokens[0];
  const args = tokens.slice(1);
  if (command !== undefined && SEARCH_PATTERN_COMMANDS.has(command)) {
    // grep/rg 的第一个非 option 参数是 pattern，不是文件路径。
    return skipFirstSearchPattern(args);
  }
  if (command === "sed") {
    // sed 的第一个非 option 参数通常是脚本表达式，如 /foo/p。
    return skipFirstSedScript(args);
  }
  return args;
}

function isPathLike(value: string): boolean {
  return (
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    win32.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function shellPathTokens(command: string): PathToken[] {
  return shellPathArgumentTokens(tokenizeShellCommandForPathScan(command)).flatMap((token) => {
    const path = tokenPathValue(token);
    return path !== null && isPathLike(path) ? [{ raw: token, path }] : [];
  });
}

function slashNormalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function comparablePath(args: { cwd: string; path: string }): string {
  if (win32.isAbsolute(args.path)) {
    return slashNormalize(win32.normalize(args.path)).toLowerCase();
  }
  if (posix.isAbsolute(args.path)) {
    return slashNormalize(posix.normalize(args.path));
  }
  return slashNormalize(resolve(args.cwd, args.path));
}

function insideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function outsideWorkspacePaths(context: AgentCorePermissionContext, command: string): string[] {
  const roots = context.workspaceRoots.map((root) =>
    comparablePath({
      cwd: context.cwd,
      path: root,
    }),
  );
  return shellPathTokens(command)
    .filter(({ path }) => {
      if (path.startsWith("~") || path.includes("$")) {
        return true;
      }
      const candidate = comparablePath({
        cwd: context.cwd,
        path,
      });
      return !roots.some((root) => insideOrEqual(root, candidate));
    })
    .map(({ raw }) => raw);
}

// 只读 shell 自动放行前必须挡住 workspace 外读取，避免把本机 secret 送进模型。
export function createAgentCoreShellReadOutsideWorkspaceRisk(args: {
  context: AgentCorePermissionContext;
  command: string;
  commandPreview: string;
}): AgentCoreShellReadOutsideWorkspaceRisk | undefined {
  const paths = [...new Set(outsideWorkspacePaths(args.context, args.command))];
  if (paths.length === 0) {
    return undefined;
  }
  return {
    kind: "outside-workspace-shell-read",
    severity: "high",
    title: "Shell read outside workspace",
    detail: `This read-only shell command references paths outside the active workspace: ${paths.join(", ")}.`,
    names: [],
    commandPreview: args.commandPreview,
    paths,
  };
}
