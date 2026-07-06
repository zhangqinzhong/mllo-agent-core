import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAgentCoreShellPermission } from "../../src/agent-core/permissions/shell-command-policy";
import type { AgentCorePermissionContext } from "../../src/agent-core/permissions/agent-core-permission-types";
import { createAgentCoreGrepFilesTool } from "../../src/agent-core/tools/agent-core-grep-files-tool";

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, content, "utf8");
}

function permissionContext(cwd: string): AgentCorePermissionContext {
  return {
    mode: "ask",
    cwd,
    workspaceRoots: [cwd],
  };
}

describe("agent core search tool behavior", () => {
  it("defaults grep_files to compact matching filenames", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mllo-grep-tool-"));
    await writeText(
      join(cwd, "src", "settings.ts"),
      "export const label = 'Bypass permissions';\n",
    );
    await writeText(join(cwd, "src", "other.ts"), "export const label = 'other';\n");

    const tool = createAgentCoreGrepFilesTool({
      permissionContext: permissionContext(cwd),
    });

    const result = await tool.run(
      {
        path: ".",
        pattern: "Bypass permissions",
        glob: "**/*.ts",
      },
      {
        cwd,
      },
    );

    expect(result.content.trim()).toBe("src/settings.ts");
  });

  it("allows bounded read-only shell pipelines for efficient repository search", () => {
    const cwd = "/tmp/mllo-project";
    const decision = evaluateAgentCoreShellPermission(
      permissionContext(cwd),
      'rg -n "Bypass permissions" src --glob "*.ts" | head -80',
    );

    expect(decision).toMatchObject({
      status: "allow",
      capability: "shell-readonly",
    });
  });
});
