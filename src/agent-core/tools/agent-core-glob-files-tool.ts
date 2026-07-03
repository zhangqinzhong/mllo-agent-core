import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath,
} from "../permissions/workspace-path-policy";
import type { AgentCoreFilesystemToolOptions } from "./agent-core-filesystem-tools";
import type { AgentCoreToolDefinition, AgentCoreToolResult } from "./agent-core-tool-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const DEFAULT_MAX_GLOB_MATCHES = 300;

const globFilesInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .default(".")
    .describe("Workspace-relative directory where file discovery starts."),
  pattern: z
    .string()
    .min(1)
    .describe("Glob pattern matched against workspace-relative file paths; supports *, ?, and **."),
  maxMatches: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum matching file paths to return."),
});

type GlobFilesInput = z.infer<typeof globFilesInputSchema>;

function shouldSkipDirectory(name: string): boolean {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "out" ||
    name === "build"
  );
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.includes("/") ? pattern : `**/${pattern}`;
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      source += after === "/" ? "(?:.*/)?" : ".*";
      index += after === "/" ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexChar(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

async function collectGlobMatches(args: {
  rootPath: string;
  currentPath: string;
  matcher: RegExp;
  maxMatches: number;
  matches: string[];
  options: AgentCoreFilesystemToolOptions;
}): Promise<void> {
  if (args.matches.length >= args.maxMatches) {
    return;
  }
  const realPathDecision = await evaluateAgentCoreRealPathPermission(
    args.options.permissionContext,
    args.currentPath,
    "read",
  );
  if (realPathDecision !== null) {
    return;
  }
  const currentStat = await stat(args.currentPath);
  if (currentStat.isFile()) {
    const relativePath = normalizeRelativePath(relative(args.rootPath, args.currentPath));
    if (args.matcher.test(relativePath)) {
      args.matches.push(relativePath);
    }
    return;
  }
  if (!currentStat.isDirectory()) {
    return;
  }

  const entries = await readdir(args.currentPath, {
    withFileTypes: true,
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (args.matches.length >= args.maxMatches) {
      return;
    }
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
      continue;
    }
    await collectGlobMatches({
      rootPath: args.rootPath,
      currentPath: join(args.currentPath, entry.name),
      matcher: args.matcher,
      maxMatches: args.maxMatches,
      matches: args.matches,
      options: args.options,
    });
  }
}

async function globFiles(
  input: GlobFilesInput,
  options: AgentCoreFilesystemToolOptions,
): Promise<AgentCoreToolResult> {
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
  const maxMatches = input.maxMatches ?? DEFAULT_MAX_GLOB_MATCHES;
  const matches: string[] = [];
  await collectGlobMatches({
    rootPath,
    currentPath: rootPath,
    matcher: globPatternToRegex(input.pattern),
    maxMatches,
    matches,
    options,
  });
  const suffix = matches.length >= maxMatches ? `\n... reached maxMatches=${maxMatches}` : "";
  return {
    content: matches.length === 0 ? "No files matched." : `${matches.join("\n")}${suffix}`,
  };
}

// glob_files 只做路径发现，不读取文件内容；模型后续可再调用 read_file 精读。
export function createAgentCoreGlobFilesTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "glob_files",
    description: "Find workspace files by glob pattern, supporting *, ?, and **.",
    inputSchema: globFilesInputSchema,
    maxResultSizeChars: 80_000,
    evaluatePermission(input) {
      const parsed = globFilesInputSchema.safeParse(input);
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, "read")
        : {
            status: "deny",
            capability: "file-read",
            reason: "Invalid glob_files input.",
          };
    },
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = globFilesInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "glob_files",
          error: parsed.error,
          input,
          schema: globFilesInputSchema,
        });
      }
      return await globFiles(parsed.data, options);
    },
  };
}
