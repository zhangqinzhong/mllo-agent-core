import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath,
} from "../permissions/workspace-path-policy";
import type { AgentCoreFilesystemToolOptions } from "./agent-core-filesystem-tools";
import type { AgentCoreToolDefinition, AgentCoreToolResult } from "./agent-core-tool-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";
import {
  runAgentCoreRipgrepSearch,
  type AgentCoreGrepFilesOutputMode,
} from "./agent-core-ripgrep-search";

const DEFAULT_MAX_GREP_FILES = 300;
const DEFAULT_HEAD_LIMIT = 100;
const DEFAULT_MAX_GREP_MATCHES = 200;

const grepFilesInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .default(".")
    .describe("Workspace-relative file or directory to search. Defaults to the workspace root."),
  pattern: z
    .string()
    .min(1)
    .describe("Text to search for. Treated as a literal string unless regex is true."),
  regex: z.boolean().optional().describe("Set true to interpret pattern as a JavaScript regex."),
  glob: z
    .string()
    .optional()
    .describe('Optional file glob filter, for example "*.ts" or "**/*.{ts,tsx}".'),
  outputMode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Result shape. "files_with_matches" is the compact default; use "content" only when matching lines are needed.',
    ),
  caseInsensitive: z.boolean().optional().describe("Set true for case-insensitive search."),
  context: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Context lines for outputMode="content".'),
  headLimit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum result rows to return. 0 means unlimited and should be rare."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Skip this many result rows before applying headLimit."),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum files to scan before stopping."),
  maxMatches: z.number().int().positive().optional().describe("Maximum matching lines to return."),
});

type GrepFilesInput = z.infer<typeof grepFilesInputSchema>;

type SearchFileResult = {
  filePath: string;
  matches: string[];
};

type TextMatcher =
  | {
      status: "ok";
      matches: (line: string) => boolean;
    }
  | {
      status: "error";
      result: AgentCoreToolResult;
    };

function shouldSkipDirectory(name: string): boolean {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "out" ||
    name === "build"
  );
}

function createMatcher(input: GrepFilesInput): TextMatcher {
  const pattern = input.caseInsensitive === true ? input.pattern.toLowerCase() : input.pattern;
  if (input.regex !== true) {
    return {
      status: "ok",
      matches: (line) =>
        (input.caseInsensitive === true ? line.toLowerCase() : line).includes(pattern),
    };
  }
  try {
    const regex = new RegExp(input.pattern, input.caseInsensitive === true ? "i" : undefined);
    return {
      status: "ok",
      matches: (line) => regex.test(line),
    };
  } catch (error) {
    return {
      status: "error",
      result: {
        content: `Invalid regex for grep_files: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      },
    };
  }
}

async function collectSearchFiles(args: {
  rootPath: string;
  maxFiles: number;
  files: string[];
  options: AgentCoreFilesystemToolOptions;
}): Promise<void> {
  if (args.files.length >= args.maxFiles) {
    return;
  }
  const realPathDecision = await evaluateAgentCoreRealPathPermission(
    args.options.permissionContext,
    args.rootPath,
    "read",
  );
  if (realPathDecision !== null) {
    return;
  }

  const rootStat = await stat(args.rootPath);
  if (rootStat.isFile()) {
    args.files.push(args.rootPath);
    return;
  }
  if (!rootStat.isDirectory()) {
    return;
  }

  const entries = await readdir(args.rootPath, {
    withFileTypes: true,
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (args.files.length >= args.maxFiles) {
      return;
    }
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
      continue;
    }
    await collectSearchFiles({
      rootPath: join(args.rootPath, entry.name),
      maxFiles: args.maxFiles,
      files: args.files,
      options: args.options,
    });
  }
}

async function searchFile(args: {
  filePath: string;
  workspaceRoot: string;
  matches: (line: string) => boolean;
  remainingMatches: number;
}): Promise<SearchFileResult | undefined> {
  try {
    const content = await readFile(args.filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const matches: string[] = [];
    for (
      let index = 0;
      index < lines.length && matches.length < args.remainingMatches;
      index += 1
    ) {
      if (args.matches(lines[index]!)) {
        matches.push(`${relative(args.workspaceRoot, args.filePath)}:${index + 1}:${lines[index]}`);
      }
    }
    return matches.length === 0
      ? undefined
      : {
          filePath: relative(args.workspaceRoot, args.filePath),
          matches,
        };
  } catch {
    return undefined;
  }
}

function applyResultWindow(
  lines: readonly string[],
  input: GrepFilesInput,
): {
  lines: string[];
  truncated: boolean;
} {
  const offset = input.offset ?? 0;
  const headLimit = input.headLimit ?? DEFAULT_HEAD_LIMIT;
  if (headLimit === 0) {
    return {
      lines: lines.slice(offset),
      truncated: false,
    };
  }
  const end = offset + headLimit;
  return {
    lines: lines.slice(offset, end),
    truncated: lines.length > end,
  };
}

function formatFallbackSearchResults(args: {
  results: SearchFileResult[];
  input: GrepFilesInput;
}): AgentCoreToolResult {
  const mode: AgentCoreGrepFilesOutputMode = args.input.outputMode ?? "files_with_matches";
  if (mode === "files_with_matches") {
    const windowed = applyResultWindow(
      args.results.map((result) => result.filePath),
      args.input,
    );
    return {
      content:
        args.results.length === 0
          ? "No matches found."
          : `${windowed.lines.join("\n")}${windowed.truncated ? `\n[grep_files paginated: offset=${args.input.offset ?? 0}, headLimit=${args.input.headLimit ?? DEFAULT_HEAD_LIMIT}, totalRows=${args.results.length}]` : ""}`,
    };
  }
  if (mode === "count") {
    const rows = args.results.map((result) => `${result.filePath}:${result.matches.length}`);
    const windowed = applyResultWindow(rows, args.input);
    const totalMatches = args.results.reduce((sum, result) => sum + result.matches.length, 0);
    return {
      content:
        rows.length === 0
          ? "No matches found."
          : `${windowed.lines.join("\n")}\nFound ${totalMatches} matches across ${args.results.length} files.${windowed.truncated ? `\n[grep_files paginated: offset=${args.input.offset ?? 0}, headLimit=${args.input.headLimit ?? DEFAULT_HEAD_LIMIT}, totalRows=${rows.length}]` : ""}`,
    };
  }
  const rows = args.results.flatMap((result) => result.matches);
  const windowed = applyResultWindow(rows, args.input);
  return {
    content:
      rows.length === 0
        ? "No matches found."
        : `${windowed.lines.join("\n")}${windowed.truncated ? `\n[grep_files paginated: offset=${args.input.offset ?? 0}, headLimit=${args.input.headLimit ?? DEFAULT_HEAD_LIMIT}, totalRows=${rows.length}]` : ""}`,
  };
}

async function grepFiles(
  input: GrepFilesInput,
  options: AgentCoreFilesystemToolOptions,
): Promise<AgentCoreToolResult> {
  const matcher = createMatcher(input);
  if (matcher.status === "error") {
    return matcher.result;
  }

  const rootPath = resolveAgentCorePath(options.permissionContext, input.path);
  const realPathDecision = await evaluateAgentCoreRealPathPermission(
    options.permissionContext,
    input.path,
    "read",
  );
  if (realPathDecision !== null) {
    return {
      content: realPathDecision.reason,
      isError: true,
    };
  }
  const ripgrepResult = await runAgentCoreRipgrepSearch({
    workspaceRoot: options.permissionContext.cwd,
    rootPath,
    pattern: input.pattern,
    regex: input.regex,
    glob: input.glob,
    caseInsensitive: input.caseInsensitive,
    context: input.context,
    outputMode: input.outputMode ?? "files_with_matches",
    headLimit: input.headLimit ?? DEFAULT_HEAD_LIMIT,
    offset: input.offset ?? 0,
  });
  if (ripgrepResult !== undefined) {
    return {
      content: ripgrepResult.content,
    };
  }

  const files: string[] = [];
  await collectSearchFiles({
    rootPath,
    maxFiles: input.maxFiles ?? options.maxGrepFiles ?? DEFAULT_MAX_GREP_FILES,
    files,
    options,
  });

  const maxMatches = input.maxMatches ?? options.maxGrepMatches ?? DEFAULT_MAX_GREP_MATCHES;
  const results: SearchFileResult[] = [];
  let matchCount = 0;
  for (const filePath of files) {
    if (matchCount >= maxMatches) {
      break;
    }
    const result = await searchFile({
      filePath,
      workspaceRoot: options.permissionContext.cwd,
      matches: matcher.matches,
      remainingMatches: maxMatches - matchCount,
    });
    if (result !== undefined) {
      matchCount += result.matches.length;
      results.push(result);
    }
  }
  const formatted = formatFallbackSearchResults({
    results,
    input,
  });
  return matchCount >= maxMatches
    ? {
        content: `${formatted.content}\n... reached maxMatches=${maxMatches}`,
      }
    : formatted;
}

// grep_files 默认 literal search；需要正则时由模型显式传 regex=true，避免误解释用户文本。
export function createAgentCoreGrepFilesTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "grep_files",
    description: [
      "Search workspace text files with ripgrep-compatible behavior.",
      'Default outputMode is "files_with_matches" to keep context small; request "content" with headLimit/context only when matching lines are needed.',
      "Use glob/type narrowing before broad searches, and stop searching once enough file evidence is found.",
    ].join("\n"),
    inputSchema: grepFilesInputSchema,
    maxResultSizeChars: 20_000,
    evaluatePermission(input) {
      const parsed = grepFilesInputSchema.safeParse(input);
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, "read")
        : {
            status: "deny",
            capability: "file-read",
            reason: "Invalid grep_files input.",
          };
    },
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = grepFilesInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "grep_files",
          error: parsed.error,
          input,
          schema: grepFilesInputSchema,
        });
      }
      return await grepFiles(parsed.data, options);
    },
  };
}
