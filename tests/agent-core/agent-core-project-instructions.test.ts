import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAgentCoreProjectInstructions,
  readAgentCoreProjectInstructionsForPath,
} from "../../src/agent-core/context/agent-core-project-instructions";
import { createAgentCoreBaseTools } from "../../src/agent-core/tools/agent-core-base-tools";
import { createAgentCoreWriteFileTool } from "../../src/agent-core/tools/agent-core-write-file-tool";

async function writeInstruction(path: string, content: string): Promise<void> {
  await mkdir(path, {
    recursive: true,
  });
  await writeFile(join(path, "AGENTS.md"), content, "utf8");
}

describe("agent core project instructions", () => {
  it("loads AGENTS.md from workspace root to the current nested directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-"));
    const root = join(dir, "repo");
    const packageDir = join(root, "packages", "agent-core");
    const cwd = join(packageDir, "src");

    await writeInstruction(root, "root rules");
    await writeInstruction(packageDir, "package rules");
    await writeInstruction(cwd, "src rules");

    const instructions = await readAgentCoreProjectInstructions({
      cwd,
      workspaceRoots: [root],
    });

    expect(instructions.map((instruction) => instruction.path)).toEqual([
      join(root, "AGENTS.md"),
      join(packageDir, "AGENTS.md"),
      join(cwd, "AGENTS.md"),
    ]);
    expect(instructions.map((instruction) => instruction.content)).toEqual([
      "root rules",
      "package rules",
      "src rules",
    ]);
  });

  it("does not load parent AGENTS.md outside the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-boundary-"));
    const root = join(dir, "repo");
    const cwd = join(root, "src");

    await writeInstruction(dir, "parent rules");
    await writeInstruction(root, "root rules");
    await writeInstruction(cwd, "src rules");

    const instructions = await readAgentCoreProjectInstructions({
      cwd,
      workspaceRoots: [root],
    });

    expect(instructions.map((instruction) => instruction.content)).toEqual([
      "root rules",
      "src rules",
    ]);
  });

  it("loads only the root instruction for additional workspace roots outside cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-extra-root-"));
    const primaryRoot = join(dir, "repo");
    const extraRoot = join(dir, "shared");
    const cwd = join(primaryRoot, "src");

    await writeInstruction(primaryRoot, "primary root");
    await writeInstruction(cwd, "primary src");
    await writeInstruction(extraRoot, "shared root");
    await writeInstruction(join(extraRoot, "nested"), "shared nested");

    const instructions = await readAgentCoreProjectInstructions({
      cwd,
      workspaceRoots: [primaryRoot, extraRoot],
    });

    expect(instructions.map((instruction) => instruction.content)).toEqual([
      "primary root",
      "primary src",
      "shared root",
    ]);
  });

  it("finds target-path instructions that were not loaded for the current cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-target-"));
    const root = join(dir, "repo");
    const cwd = join(root, "src");
    const targetDir = join(cwd, "feature");

    await writeInstruction(root, "root rules");
    await writeInstruction(cwd, "src rules");
    await writeInstruction(targetDir, "feature rules");

    const instructions = await readAgentCoreProjectInstructionsForPath({
      cwd,
      workspaceRoots: [root],
      targetPath: join(targetDir, "component.ts"),
    });

    expect(instructions.map((instruction) => instruction.content)).toEqual(["feature rules"]);
  });

  it("prevents write_file once when target-path instructions were not surfaced yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-write-"));
    const root = join(dir, "repo");
    const cwd = join(root, "src");
    const targetDir = join(cwd, "feature");
    const targetPath = join(targetDir, "component.ts");

    await writeInstruction(targetDir, "Use exact exports in this folder.");
    const tool = createAgentCoreWriteFileTool({
      permissionContext: {
        mode: "workspace-write",
        cwd,
        workspaceRoots: [root],
      },
    });

    const first = await tool.run(
      {
        path: "feature/component.ts",
        content: "export const value = 1;\n",
      },
      {
        cwd,
      },
    );
    expect(first).toMatchObject({
      isError: true,
      errorKind: "project-instructions-required",
    });
    expect(first.content).toContain("Use exact exports in this folder.");
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = await tool.run(
      {
        path: "feature/component.ts",
        content: "export const value = 1;\n",
      },
      {
        cwd,
      },
    );
    expect(second.isError).toBeUndefined();
    await expect(readFile(targetPath, "utf8")).resolves.toBe("export const value = 1;\n");
  });

  it("shares surfaced target-path instructions across base write tools in one run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-project-instructions-shared-guard-"));
    const root = join(dir, "repo");
    const cwd = join(root, "src");
    const targetDir = join(cwd, "feature");
    const existingFile = join(targetDir, "existing.ts");

    await writeInstruction(targetDir, "Feature files must use named exports.");
    await writeFile(existingFile, "export const oldValue = 1;\n", "utf8");
    const tools = createAgentCoreBaseTools({
      permissionContext: {
        mode: "workspace-write",
        cwd,
        workspaceRoots: [root],
      },
    });
    const writeTool = tools.find((tool) => tool.name === "write_file");
    const editTool = tools.find((tool) => tool.name === "edit_file");
    if (writeTool === undefined || editTool === undefined) {
      throw new Error("base file tools are missing");
    }

    const first = await writeTool.run(
      {
        path: "feature/new.ts",
        content: "export const newValue = 1;\n",
      },
      {
        cwd,
      },
    );
    expect(first.errorKind).toBe("project-instructions-required");

    const second = await editTool.run(
      {
        path: "feature/existing.ts",
        oldText: "oldValue",
        newText: "renamedValue",
      },
      {
        cwd,
      },
    );

    expect(second.isError).toBeUndefined();
    await expect(readFile(existingFile, "utf8")).resolves.toBe("export const renamedValue = 1;\n");
  });
});
