import type { AgentCorePermissionContext } from "../permissions/agent-core-permission-types";
import { readAgentCoreProjectInstructionsForPath } from "../context/agent-core-project-instructions";
import type { AgentCoreToolResult } from "./agent-core-tool-types";

export type AgentCoreProjectInstructionWriteGuard = {
  checkTarget(targetPath: string): Promise<AgentCoreToolResult | undefined>;
};

function renderProjectInstructionGuardResult(args: {
  targetPath: string;
  instructions: Awaited<ReturnType<typeof readAgentCoreProjectInstructionsForPath>>;
}): string {
  return [
    `Project instructions apply to ${args.targetPath}, but they were not part of the current prompt context.`,
    "No file was modified. Read and follow these instructions, then retry the write/edit operation.",
    "",
    ...args.instructions.map((instruction) =>
      [
        `<mllo_project_instruction source="${instruction.path}">`,
        instruction.content.trim(),
        "</mllo_project_instruction>",
      ].join("\n"),
    ),
  ].join("\n");
}

// 写文件前先发现目标路径专属规则。第一次只回灌规则，第二次才允许同一 run 继续写。
export function createAgentCoreProjectInstructionWriteGuard(
  permissionContext: AgentCorePermissionContext,
): AgentCoreProjectInstructionWriteGuard {
  const surfacedInstructionPaths = new Set<string>();
  return {
    async checkTarget(targetPath) {
      const instructions = (
        await readAgentCoreProjectInstructionsForPath({
          cwd: permissionContext.cwd,
          workspaceRoots: permissionContext.workspaceRoots,
          targetPath,
        })
      ).filter((instruction) => !surfacedInstructionPaths.has(instruction.path));
      if (instructions.length === 0) {
        return undefined;
      }
      for (const instruction of instructions) {
        surfacedInstructionPaths.add(instruction.path);
      }
      return {
        content: renderProjectInstructionGuardResult({
          targetPath,
          instructions,
        }),
        isError: true,
        errorKind: "project-instructions-required",
      };
    },
  };
}
