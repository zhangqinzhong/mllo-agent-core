import { describe, expect, it, vi } from "vitest";
import { renderAgentCoreSystemPromptBlocks } from "../../src/agent-core/context/agent-core-prompt-renderer";
import type { AgentCorePromptContext } from "../../src/agent-core/context/agent-core-prompt-context";
import { renderAgentCoreTurnContextMessage } from "../../src/agent-core/context/agent-core-turn-context-message";
import {
  joinAgentCorePromptBlocks,
  MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AgentCorePromptBlock,
} from "../../src/agent-core/query-loop/agent-core-prompt-block-types";
import { createAgentCoreAnthropicModelAdapter } from "../../src/agent-core/model/agent-core-anthropic-model-adapter";
import { createAgentCoreOpenAIModelAdapter } from "../../src/agent-core/model/agent-core-openai-model-adapter";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

function createPromptContext(): AgentCorePromptContext {
  return {
    identity: {
      productName: "mllo",
      role: "agent-core",
    },
    generatedAt: "2026-07-05T00:00:00.000Z",
    cwd: "/workspace/project",
    shellCwd: "/workspace/project",
    runtime: {
      sandboxPolicy: "permission-gated-workspace+local-unsandboxed-process",
      shellBackend: {
        kind: "local",
        label: "local shell",
        remote: false,
        sandboxed: false,
        allowedRemoteSecretLikeEnvNames: [],
      },
    },
    shellTasks: [],
    workspaceRoots: ["/workspace/project"],
    permissionContext: {
      mode: "ask",
      cwd: "/workspace/project",
      workspaceRoots: ["/workspace/project"],
      deniedPaths: ["/workspace/project/.env"],
    },
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        concurrency: "safe",
      },
    ],
    toolAvailability: [],
    skills: [
      {
        id: "code-review",
        name: "code-review",
        sourceLabel: "local",
        sourceKind: "local",
        providers: ["mllo"],
        description: "Review code",
      },
    ],
    mcpConfigs: [],
    memory: [],
    projectInstructions: [
      {
        path: "/workspace/project/AGENTS.md",
        source: "AGENTS.md",
        content: "Follow project rules.",
        originalBytes: 21,
        includedBytes: 21,
        truncated: false,
      },
    ],
    workflowRuns: [],
    budget: {
      compacted: false,
    },
    modelProfile: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      supportsStreaming: true,
      supportsToolUse: true,
    },
  };
}

function captureFetch(args: { responseBody: unknown; capturedBodies: unknown[] }): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    args.capturedBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(args.responseBody), {
      headers: {
        "content-type": "application/json",
      },
    });
  }) as unknown as typeof fetch;
}

function promptBlocksForAdapter(): AgentCorePromptBlock[] {
  return [
    {
      name: "system_policy_role",
      text: "role block",
      cacheScope: "global",
    },
    {
      name: "system_prompt_dynamic_boundary",
      text: MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      cacheScope: "global",
    },
    {
      name: "tools",
      text: "tools block",
      cacheScope: "session",
    },
    {
      name: "project_instructions",
      text: "project rules block",
      cacheScope: "session",
    },
    {
      name: "debug_tail",
      text: "uncached tail",
      cacheScope: "uncached",
    },
  ];
}

function toolForAdapter(name: string): AgentCoreToolDefinition {
  return {
    name,
    description: `Run ${name}`,
    async run() {
      return {
        content: "ok",
      };
    },
  };
}

describe("agent core prompt cache blocks", () => {
  it("separates stable system blocks from dynamic turn context", () => {
    const context = createPromptContext();
    const blocks = renderAgentCoreSystemPromptBlocks(context);
    const joined = joinAgentCorePromptBlocks(blocks);

    expect(blocks[0]?.cacheScope).toBe("global");
    expect(blocks.some((block) => block.text === MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe(true);
    expect(blocks.find((block) => block.name === "tools")?.cacheScope).toBe("session");
    expect(joined).toContain("# System Policy");
    expect(joined).toContain("# Project Instructions");
    expect(joined).not.toContain("generatedAt:");
    expect(joined).not.toContain("# Budget");

    const turnContext = renderAgentCoreTurnContextMessage(context);
    expect(turnContext).toContain("generatedAt: 2026-07-05T00:00:00.000Z");
    expect(turnContext).toContain("# Budget");
  });

  it("maps cacheable prompt blocks to Anthropic cache_control breakpoints", async () => {
    const capturedBodies: unknown[] = [];
    const adapter = createAgentCoreAnthropicModelAdapter(
      {
        protocol: "anthropic",
        baseUrl: "https://model.test/anthropic",
        apiKey: "test-key",
        model: "deepseek-v4-pro",
      },
      captureFetch({
        capturedBodies,
        responseBody: {
          content: [
            {
              type: "text",
              text: "ok",
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 80,
            cache_read_input_tokens: 20,
          },
        },
      }),
    );

    const response = await adapter.complete?.({
      systemPrompt: "legacy fallback",
      systemPromptBlocks: promptBlocksForAdapter(),
      messages: [
        {
          role: "user",
          content: "hi",
        },
      ],
      tools: [toolForAdapter("read_file"), toolForAdapter("write_file")],
    });

    const body = capturedBodies[0] as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.system.map((block) => block.text)).toEqual([
      "role block",
      MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      "tools block",
      "project rules block",
      "uncached tail",
    ]);
    expect(
      body.system.filter((block) => block.cache_control !== undefined).map((block) => block.text),
    ).toEqual([MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "project rules block"]);
    expect(body.tools.map((tool) => tool.cache_control)).toEqual([
      undefined,
      {
        type: "ephemeral",
      },
    ]);
    expect(body.messages[0]?.content.at(-1)?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(response?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      cacheCreationInputTokens: 80,
      cacheReadInputTokens: 20,
    });
  });

  it("keeps OpenAI system content in stable block order without provider-specific cache fields", async () => {
    const capturedBodies: unknown[] = [];
    const adapter = createAgentCoreOpenAIModelAdapter(
      {
        protocol: "openai",
        baseUrl: "https://model.test/v1",
        apiKey: "test-key",
        model: "gpt-test",
      },
      captureFetch({
        capturedBodies,
        responseBody: {
          choices: [
            {
              message: {
                content: "ok",
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            total_tokens: 107,
            prompt_tokens_details: {
              cached_tokens: 64,
            },
          },
        },
      }),
    );

    const response = await adapter.complete?.({
      systemPrompt: "legacy fallback",
      systemPromptBlocks: promptBlocksForAdapter(),
      messages: [
        {
          role: "user",
          content: "hi",
        },
      ],
      tools: [],
    });

    const body = capturedBodies[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]).toEqual({
      role: "system",
      content: joinAgentCorePromptBlocks(promptBlocksForAdapter()),
    });
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(response?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 7,
      totalTokens: 107,
      cachedInputTokens: 64,
    });
  });
});
