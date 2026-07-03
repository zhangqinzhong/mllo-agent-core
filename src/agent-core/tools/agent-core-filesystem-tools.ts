import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentCorePermissionContext } from "../permissions/agent-core-permission-types";
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath,
} from "../permissions/workspace-path-policy";
import type { AgentCoreToolDefinition } from "./agent-core-tool-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 200;
const readFileInputSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative path of the UTF-8 text file to read."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum bytes to return before truncating the file content."),
});

const listDirectoryInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .default(".")
    .describe("Workspace-relative directory path to list. Defaults to the current workspace root."),
  maxEntries: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum directory entries to return after stable name sorting."),
});

export type AgentCoreFilesystemToolOptions = {
  permissionContext: AgentCorePermissionContext;
  maxReadBytes?: number;
  maxDirectoryEntries?: number;
  maxGrepFiles?: number;
  maxGrepMatches?: number;
  onBeforeFileWrite?: (snapshot: {
    path: string;
    resolvedPath: string;
    previousContent: string | null;
  }) => Promise<void>;
  onAfterFileWrite?: (snapshot: {
    path: string;
    resolvedPath: string;
    contentAfterWrite: string;
  }) => Promise<void>;
};

// 读取文件时限制最大字节数。大文件必须先截断，避免一次 tool_result 撑爆上下文。
async function readLimitedFile(
  path: string,
  maxBytes: number,
): Promise<{
  content: string;
  truncated: boolean;
}> {
  const buffer = await readFile(path);
  const truncated = buffer.byteLength > maxBytes;
  return {
    content: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated,
  };
}

// 把目录项格式化成稳定文本。稳定顺序能减少模型重复读取同一目录的噪声。
async function formatDirectoryEntries(path: string, maxEntries: number): Promise<string> {
  const entries = await readdir(path, {
    withFileTypes: true,
  });
  const visibleEntries = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxEntries)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
  const suffix = entries.length > maxEntries ? `\n... ${entries.length - maxEntries} more` : "";
  return `${visibleEntries.join("\n")}${suffix}`;
}

// 创建 read_file 工具。读操作默认允许 workspace 内路径，并声明可并发。
export function createAgentCoreReadFileTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    inputSchema: readFileInputSchema,
    maxResultSizeChars: options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    evaluatePermission(input) {
      const parsed = readFileInputSchema.safeParse(input);
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, "read")
        : {
            status: "deny",
            capability: "file-read",
            reason: "Invalid read_file input.",
          };
    },
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = readFileInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "read_file",
          error: parsed.error,
          input,
          schema: readFileInputSchema,
        });
      }
      const maxBytes = parsed.data.maxBytes ?? options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
      const realPathDecision = await evaluateAgentCoreRealPathPermission(
        options.permissionContext,
        parsed.data.path,
        "read",
      );
      if (realPathDecision !== null) {
        return {
          content: realPathDecision.reason,
          isError: true,
        };
      }
      const result = await readLimitedFile(
        resolveAgentCorePath(options.permissionContext, parsed.data.path),
        maxBytes,
      );
      return {
        content: result.truncated
          ? `${result.content}\n\n[truncated after ${maxBytes} bytes]`
          : result.content,
      };
    },
  };
}

// 创建 list_dir 工具。目录读取可并发，用于模型先建立 workspace 结构感。
export function createAgentCoreListDirectoryTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "list_dir",
    description: "List files and directories in a workspace directory.",
    inputSchema: listDirectoryInputSchema,
    maxResultSizeChars: 50_000,
    evaluatePermission(input) {
      const parsed = listDirectoryInputSchema.safeParse(input);
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, "read")
        : {
            status: "deny",
            capability: "file-read",
            reason: "Invalid list_dir input.",
          };
    },
    isConcurrencySafe: () => true,
    async run(input) {
      const parsed = listDirectoryInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "list_dir",
          error: parsed.error,
          input,
          schema: listDirectoryInputSchema,
        });
      }
      const realPathDecision = await evaluateAgentCoreRealPathPermission(
        options.permissionContext,
        parsed.data.path,
        "read",
      );
      if (realPathDecision !== null) {
        return {
          content: realPathDecision.reason,
          isError: true,
        };
      }
      return {
        content: await formatDirectoryEntries(
          resolveAgentCorePath(options.permissionContext, parsed.data.path),
          parsed.data.maxEntries ?? options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
        ),
      };
    },
  };
}
