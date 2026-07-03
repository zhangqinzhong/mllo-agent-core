import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentCoreProjectInstructions } from "../../src/agent-core/context/agent-core-project-instructions";

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
});
