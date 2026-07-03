import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentCoreToolCall } from "../../src/agent-core/tools/agent-core-tool-runner";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

describe("agent core tool schema repair feedback", () => {
  it("returns structured repair context instead of executing invalid tool input", async () => {
    let ran = false;
    const tool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().optional(),
      }),
      run: async () => {
        ran = true;
        return {
          content: "should not run",
        };
      },
    };

    const execution = await runAgentCoreToolCall({
      call: {
        id: "call_bad_schema",
        name: "read_file",
        input: {
          path: 42,
          offset: "ten",
        },
      },
      cwd: "/tmp/project",
      tools: [tool],
    });

    expect(ran).toBe(false);
    expect(execution.status).toBe("ok");
    if (execution.status !== "ok") {
      throw new Error("expected schema validation to return a tool result");
    }
    expect(execution.result).toMatchObject({
      isError: true,
      errorKind: "schema-validation",
    });
    expect(execution.result.content).toContain("Validation issues:");
    expect(execution.result.content).toContain("Received arguments preview:");
    expect(execution.result.content).toContain("Expected JSON schema preview:");
    expect(execution.result.content).toContain('"path": 42');
    expect(execution.result.content).toContain('"type": "string"');
    expect(execution.result.content).toContain(
      "call read_file again with corrected JSON object arguments",
    );
  });
});
