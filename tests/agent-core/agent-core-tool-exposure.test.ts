import { describe, expect, it } from "vitest";
import { applyAgentCoreToolExposure } from "../../src/agent-core/tools/agent-core-tool-exposure";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

function toolNames(tools: readonly AgentCoreToolDefinition[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("agent core tool exposure", () => {
  it("keeps direct mode unchanged", () => {
    const tools: AgentCoreToolDefinition[] = [
      {
        name: "read_file",
        description: "Read file.",
        run: async () => ({
          content: "read",
        }),
      },
      {
        name: "grep_files",
        description: "Search files.",
        run: async () => ({
          content: "grep",
        }),
      },
    ];

    expect(
      toolNames(
        applyAgentCoreToolExposure({
          mode: "direct",
          tools,
        }),
      ),
    ).toEqual(["read_file", "grep_files"]);
  });

  it("wraps deferred tools behind search and call tools", async () => {
    const tools: AgentCoreToolDefinition[] = [
      {
        name: "read_file",
        description: "Read file.",
        run: async () => ({
          content: "read",
        }),
      },
      {
        name: "grep_files",
        description: "Search file content.",
        evaluatePermission: () => ({
          status: "ask",
          capability: "file-read",
          reason: "grep permission",
        }),
        isConcurrencySafe: () => true,
        run: async (input) => ({
          content: `grep ${JSON.stringify(input)}`,
        }),
      },
    ];

    const exposed = applyAgentCoreToolExposure({
      mode: "deferred",
      tools,
    });

    expect(toolNames(exposed)).toEqual([
      "read_file",
      "search_deferred_tools",
      "call_deferred_tool",
    ]);

    const search = exposed.find((tool) => tool.name === "search_deferred_tools");
    const call = exposed.find((tool) => tool.name === "call_deferred_tool");

    expect(search).toBeDefined();
    expect(call).toBeDefined();
    expect(
      (
        await search!.run(
          {
            query: "grep",
          },
          {
            cwd: "/tmp/project",
          },
        )
      ).content,
    ).toContain("name: grep_files");
    expect(
      call!.evaluatePermission?.({
        name: "grep_files",
        input: {
          pattern: "todo",
        },
      }),
    ).toMatchObject({
      status: "ask",
      reason: "grep permission",
    });
    await expect(
      call!.run(
        {
          name: "grep_files",
          input: {
            pattern: "todo",
          },
        },
        {
          cwd: "/tmp/project",
        },
      ),
    ).resolves.toMatchObject({
      content: 'grep {"pattern":"todo"}',
    });
  });
});
