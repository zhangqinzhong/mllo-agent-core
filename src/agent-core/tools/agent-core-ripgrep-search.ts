import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentCoreGrepFilesOutputMode = "content" | "files_with_matches" | "count";

export type AgentCoreRipgrepSearchInput = {
  workspaceRoot: string;
  rootPath: string;
  pattern: string;
  regex?: boolean;
  glob?: string;
  caseInsensitive?: boolean;
  context?: number;
  outputMode: AgentCoreGrepFilesOutputMode;
  headLimit: number;
  offset: number;
};

export type AgentCoreRipgrepSearchResult = {
  content: string;
  matchedFiles: number;
  matchedLines: number;
  truncated: boolean;
};

const RIPGREP_MAX_BUFFER = 20_000_000;
const RIPGREP_TIMEOUT_MS = 20_000;
const VCS_EXCLUDE_GLOBS = ["!.git", "!.svn", "!.hg", "!.jj", "!.sl"];

type AgentCoreRipgrepConfig = {
  mode: "builtin" | "system";
  command: string;
  args: string[];
  note?: string;
};

let ripgrepConfig: AgentCoreRipgrepConfig | undefined;

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isEnvDefinedFalsy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function systemRipgrepAvailable(): boolean {
  const result = spawnSync("rg", ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function vendoredRipgrepPath(): string {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  return resolve(__dirname, "vendor", "ripgrep", `${process.arch}-${process.platform}`, binaryName);
}

export function resolveAgentCoreRipgrepConfig(
  args: {
    builtinPath?: string;
    systemAvailable?: boolean;
    platform?: NodeJS.Platform;
    useBuiltinRipgrep?: string;
  } = {},
): AgentCoreRipgrepConfig {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    args.useBuiltinRipgrep ?? process.env.USE_BUILTIN_RIPGREP,
  );
  const systemAvailable = args.systemAvailable ?? systemRipgrepAvailable();
  if (userWantsSystemRipgrep && systemAvailable) {
    return {
      mode: "system",
      command: "rg",
      args: [],
    };
  }

  const builtinPath = args.builtinPath ?? vendoredRipgrepPath();
  if (existsSync(builtinPath)) {
    return {
      mode: "builtin",
      command: builtinPath,
      args: [],
    };
  }

  if (systemAvailable) {
    return {
      mode: "system",
      command: "rg",
      args: [],
      note: `fallback: builtin rg unavailable on ${args.platform ?? process.platform}, using system rg`,
    };
  }

  return {
    mode: "builtin",
    command: builtinPath,
    args: [],
    note: `no ripgrep available on ${args.platform ?? process.platform}; install ripgrep or ship a vendor binary`,
  };
}

function getRipgrepConfig(): AgentCoreRipgrepConfig {
  ripgrepConfig ??= resolveAgentCoreRipgrepConfig();
  return ripgrepConfig;
}

function targetPath(input: AgentCoreRipgrepSearchInput): string {
  const path = normalizePath(relative(input.workspaceRoot, input.rootPath));
  return path.length === 0 ? "." : path;
}

function globArgs(glob: string | undefined): string[] {
  if (glob === undefined || glob.trim().length === 0) {
    return [];
  }
  return glob
    .split(/\s+/)
    .flatMap((item) =>
      item.includes("{") && item.includes("}")
        ? [item]
        : item.split(",").filter((part) => part.length > 0),
    )
    .flatMap((item) => ["--glob", item]);
}

function commandArgs(input: AgentCoreRipgrepSearchInput): string[] {
  const args = ["--hidden", "--max-columns", "500"];
  for (const glob of VCS_EXCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  args.push(...globArgs(input.glob));
  if (input.regex !== true) {
    args.push("--fixed-strings");
  }
  if (input.caseInsensitive === true) {
    args.push("--ignore-case");
  }
  if (input.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  }
  if (input.outputMode === "count") {
    args.push("--count");
  }
  if (input.outputMode === "content") {
    args.push("--line-number");
    if (input.context !== undefined) {
      args.push("--context", String(input.context));
    }
  }
  args.push("--", input.pattern, targetPath(input));
  return args;
}

function applyWindow(
  lines: string[],
  headLimit: number,
  offset: number,
): {
  lines: string[];
  truncated: boolean;
} {
  const start = Math.max(0, offset);
  if (headLimit === 0) {
    return {
      lines: lines.slice(start),
      truncated: false,
    };
  }
  const end = start + headLimit;
  return {
    lines: lines.slice(start, end),
    truncated: lines.length > end,
  };
}

function summarizeLines(
  lines: string[],
  mode: AgentCoreGrepFilesOutputMode,
): Pick<AgentCoreRipgrepSearchResult, "matchedFiles" | "matchedLines"> {
  if (mode === "files_with_matches") {
    return {
      matchedFiles: lines.length,
      matchedLines: 0,
    };
  }
  if (mode === "count") {
    return {
      matchedFiles: lines.length,
      matchedLines: lines.reduce((sum, line) => {
        const count = Number(line.slice(line.lastIndexOf(":") + 1));
        return sum + (Number.isFinite(count) ? count : 0);
      }, 0),
    };
  }
  return {
    matchedFiles: new Set(lines.map((line) => line.split(":")[0] ?? "")).size,
    matchedLines: lines.length,
  };
}

function resultContent(args: {
  lines: string[];
  totalLines: number;
  truncated: boolean;
  input: AgentCoreRipgrepSearchInput;
}): string {
  if (args.totalLines === 0) {
    return "No matches found.";
  }
  const output = args.lines.join("\n");
  const suffix = args.truncated
    ? `\n[grep_files paginated: offset=${args.input.offset}, headLimit=${args.input.headLimit}, totalRows=${args.totalLines}]`
    : "";
  return `${output}${suffix}`;
}

function normalizeRipgrepOutputLine(line: string): string {
  return line.startsWith("./") ? line.slice(2) : line;
}

function normalizeRipgrepOutput(stdout: unknown): string[] {
  return String(stdout).split(/\r?\n/).filter(Boolean).map(normalizeRipgrepOutputLine);
}

function isRipgrepMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function stdoutFromError(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "stdout" in error
    ? String((error as { stdout?: unknown }).stdout ?? "")
    : undefined;
}

function isNoMatchesExit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  );
}

export async function runAgentCoreRipgrepSearch(
  input: AgentCoreRipgrepSearchInput,
): Promise<AgentCoreRipgrepSearchResult | undefined> {
  const config = getRipgrepConfig();
  try {
    const { stdout } = await execFileAsync(
      config.command,
      [...config.args, ...commandArgs(input)],
      {
        cwd: input.workspaceRoot,
        killSignal: process.platform === "win32" ? undefined : "SIGKILL",
        maxBuffer: RIPGREP_MAX_BUFFER,
        timeout: RIPGREP_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const allLines = normalizeRipgrepOutput(stdout);
    const windowed = applyWindow(allLines, input.headLimit, input.offset);
    return {
      ...summarizeLines(allLines, input.outputMode),
      content: resultContent({
        lines: windowed.lines,
        totalLines: allLines.length,
        truncated: windowed.truncated,
        input,
      }),
      truncated: windowed.truncated,
    };
  } catch (error) {
    if (isRipgrepMissing(error)) {
      return undefined;
    }
    if (isNoMatchesExit(error)) {
      const stdout = stdoutFromError(error) ?? "";
      const allLines = normalizeRipgrepOutput(stdout);
      const windowed = applyWindow(allLines, input.headLimit, input.offset);
      return {
        ...summarizeLines(allLines, input.outputMode),
        content: resultContent({
          lines: windowed.lines,
          totalLines: allLines.length,
          truncated: windowed.truncated,
          input,
        }),
        truncated: windowed.truncated,
      };
    }
    throw error;
  }
}
