import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  evaluateAgentCorePathPermission,
  evaluateAgentCoreRealPathPermission,
  resolveAgentCorePath,
} from "../permissions/workspace-path-policy";
import { createWriteFileChangeProgress } from "./agent-core-file-change-progress";
import { detectAgentCoreStaleFileWrite } from "./agent-core-file-stale-write";
import type { AgentCoreFilesystemToolOptions } from "./agent-core-filesystem-tools";
import type { AgentCoreToolDefinition } from "./agent-core-tool-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";

const writeFileInputSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative file path to create or overwrite."),
  content: z.string().describe("Full UTF-8 file content to write."),
  createParentDirectories: z
    .boolean()
    .optional()
    .describe("Set true when missing parent directories should be created before writing."),
});

// 读取写入前的旧内容。文件不存在用 null 表示，这样 checkpoint restore 可以删除新建文件。
async function readExistingUtf8File(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

// 整文件写入也必须产出变更摘要，避免绕过 GUI timeline 的文件审计。
export function createAgentCoreWriteFileTool(
  options: AgentCoreFilesystemToolOptions,
): AgentCoreToolDefinition {
  return {
    name: "write_file",
    description: "Write a UTF-8 text file in the workspace.",
    inputSchema: writeFileInputSchema,
    evaluatePermission(input) {
      const parsed = writeFileInputSchema.safeParse(input);
      return parsed.success
        ? evaluateAgentCorePathPermission(options.permissionContext, parsed.data.path, "write")
        : {
            status: "deny",
            capability: "file-write",
            reason: "Invalid write_file input.",
          };
    },
    isConcurrencySafe: () => false,
    async run(input, context) {
      const parsed = writeFileInputSchema.safeParse(input);
      if (!parsed.success) {
        return createAgentCoreToolInputValidationResult({
          toolName: "write_file",
          error: parsed.error,
          input,
          schema: writeFileInputSchema,
        });
      }
      const resolvedPath = resolveAgentCorePath(options.permissionContext, parsed.data.path);
      const realPathDecision = await evaluateAgentCoreRealPathPermission(
        options.permissionContext,
        parsed.data.path,
        "write",
        {
          fallbackToExistingParent: true,
        },
      );
      if (realPathDecision !== null) {
        return {
          content: realPathDecision.reason,
          isError: true,
        };
      }
      if (parsed.data.createParentDirectories === true) {
        await mkdir(dirname(resolvedPath), {
          recursive: true,
        });
      }
      const previousContent = await readExistingUtf8File(resolvedPath);
      await options.onBeforeFileWrite?.({
        path: parsed.data.path,
        resolvedPath,
        previousContent,
      });
      const staleWrite = await detectAgentCoreStaleFileWrite({
        path: parsed.data.path,
        resolvedPath,
        expectedContent: previousContent,
        toolName: "write_file",
      });
      if (staleWrite !== null) {
        return staleWrite;
      }
      await writeFile(resolvedPath, parsed.data.content, "utf8");
      await options.onAfterFileWrite?.({
        path: parsed.data.path,
        resolvedPath,
        contentAfterWrite: parsed.data.content,
      });
      context.onProgress?.({
        kind: "file-change",
        change: createWriteFileChangeProgress({
          path: parsed.data.path,
          content: parsed.data.content,
          previousContent,
        }),
      });
      return {
        content: `Wrote ${Buffer.byteLength(parsed.data.content, "utf8")} bytes to ${parsed.data.path}.`,
      };
    },
  };
}
