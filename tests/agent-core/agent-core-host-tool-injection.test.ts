import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAgentCoreContext } from "../../src/agent-core/context/agent-core-context-builder";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

const temporaryDirectories: string[] = [];

/** 为每个用例创建隔离目录，避免 prompt 与 runtime 状态读取真实用户环境。 */
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mllo-host-tools-"));
  temporaryDirectories.push(path);
  return path;
}

/** 构造最小宿主工具，测试只关注注册边界而不触发模型调用。 */
function createHostTool(name: string): AgentCoreToolDefinition {
  return {
    name,
    description: `Host tool ${name}`,
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    run: async () => ({ content: `${name} completed` }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("Agent Core host tool injection", () => {
  it("can expose only host-owned tools", async () => {
    const cwd = await createTemporaryDirectory();
    const tool = createHostTool("content_search");
    const context = await buildAgentCoreContext({
      cwd,
      model: {
        complete: async () => ({ content: "done" }),
      },
      includeBaseTools: false,
      additionalTools: [tool],
      toolExposureMode: "direct",
      runtimeHome: {
        homePath: join(cwd, ".mllo"),
      },
    });

    expect(context.tools.map((candidate) => candidate.name)).toEqual(["content_search"]);
  });

  it("rejects duplicate names across host tools", async () => {
    const cwd = await createTemporaryDirectory();
    await expect(
      buildAgentCoreContext({
        cwd,
        model: {
          complete: async () => ({ content: "done" }),
        },
        includeBaseTools: false,
        additionalTools: [createHostTool("content_search"), createHostTool("content_search")],
        runtimeHome: {
          homePath: join(cwd, ".mllo"),
        },
      }),
    ).rejects.toThrow("Duplicate Agent Core tool name: content_search");
  });

  it("appends host product policy as a structured prompt block", async () => {
    const cwd = await createTemporaryDirectory();
    const context = await buildAgentCoreContext({
      cwd,
      model: {
        complete: async () => ({ content: "done" }),
      },
      includeBaseTools: false,
      additionalSystemPromptBlocks: [
        {
          name: "host_product_policy",
          text: "# Host Product\nTreat captured sources as the factual record.",
          cacheScope: "session",
        },
      ],
      runtimeHome: {
        homePath: join(cwd, ".mllo"),
      },
    });

    expect(context.systemPromptBlocks.at(-1)).toMatchObject({
      name: "host_product_policy",
      cacheScope: "session",
    });
    expect(context.systemPrompt).toContain("Treat captured sources as the factual record.");
  });

  it("rejects host prompt block names that shadow Core blocks", async () => {
    const cwd = await createTemporaryDirectory();
    await expect(
      buildAgentCoreContext({
        cwd,
        model: {
          complete: async () => ({ content: "done" }),
        },
        additionalSystemPromptBlocks: [
          {
            name: "tools",
            text: "shadow",
            cacheScope: "session",
          },
        ],
        runtimeHome: {
          homePath: join(cwd, ".mllo"),
        },
      }),
    ).rejects.toThrow("Duplicate Agent Core prompt block name: tools");
  });
});
