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

const DEFAULT_MAX_GREP_FILES = 300;
const DEFAULT_MAX_GREP_MATCHES = 100;

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
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum files to scan before stopping."),
  maxMatches: z.number().int().positive().optional().describe("Maximum matching lines to return."),
});

type GrepFilesInput = z.infer<typeof grepFilesInputSchema>;

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
  if (input.regex !== true) {
    return {
      status: "ok",
      matches: (line) => line.includes(input.pattern),
    };
  }
  try {
    const regex = new RegExp(input.pattern);
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
}): Promise<string[]> {
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
    return matches;
  } catch {
    return [];
  }
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
  const files: string[] = [];
  await collectSearchFiles({
    rootPath,
    maxFiles: input.maxFiles ?? options.maxGrepFiles ?? DEFAULT_MAX_GREP_FILES,
    files,
    options,
  });

  const maxMatches = input.maxMatches ?? options.maxGrepMatches ?? DEFAULT_MAX_GREP_MATCHES;
  const matches: string[] = [];
  for (const filePath of files) {
    if (matches.length >= maxMatches) {
      break;
    }
    matches.push(
      ...(await searchFile({
        filePath,
        workspaceRoot: rootPath,
        matches: matcher.matches,
        remainingMatches: maxMatches - matches.length,
      })),
    );
  }
  const suffix = matches.length >= maxMatches ? `\n... reached maxMatches=${maxMatches}` : "";
  return {
    content: matches.length === 0 ? "No matches found." : `${matches.join("\n")}${suffix}`,
  };
}

// grep_files 默认 literal search；需要正则时由模型显式传 regex=true，避免误解释用户文本。
export function createAgentCoreGrepFilesTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "grep_files",
    description: "Search workspace text files for a literal string or regex pattern.",
    inputSchema: grepFilesInputSchema,
    maxResultSizeChars: 80_000,
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
