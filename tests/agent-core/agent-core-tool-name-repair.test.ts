import { describe, expect, it } from "vitest";
import { runAgentCoreQueryLoop } from "../../src/agent-core/query-loop/agent-core-query-loop";
import { runAgentCoreToolCall } from "../../src/agent-core/tools/agent-core-tool-runner";
import type { AgentCoreToolDefinition } from "../../src/agent-core/tools/agent-core-tool-types";

describe("agent core unknown tool repair feedback", () => {
  it("suggests a registered alias target without executing the unknown tool", async () => {
    let ran = false;
    const shellTool: AgentCoreToolDefinition = {
      name: "shell_command",
      description: "Run a shell command.",
      run: async () => {
        ran = true;
        return {
          content: "should not run",
        };
      },
    };

    const execution = await runAgentCoreToolCall({
      call: {
        id: "call_unknown",
        name: "shell",
        input: {
          command: "pwd",
        },
      },
      cwd: "/tmp/project",
      tools: [shellTool],
    });

    expect(ran).toBe(false);
    expect(execution).toMatchObject({
      status: "not-found",
    });
    if (execution.status !== "not-found") {
      throw new Error("expected unknown tool to return not-found");
    }
    expect(execution.message).toContain("Tool is not registered: shell");
    expect(execution.message).toContain("Alias suggestion: use shell_command instead of shell.");
    expect(execution.message).toContain(
      "Repair instruction: call one registered tool by exact name",
    );
  });

  it("suggests close registered tool names for misspelled calls", async () => {
    const readTool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
      run: async () => ({
        content: "should not run",
      }),
    };

    const execution = await runAgentCoreToolCall({
      call: {
        id: "call_misspelled",
        name: "readfile",
        input: {
          path: "README.md",
        },
      },
      cwd: "/tmp/project",
      tools: [readTool],
    });

    expect(execution.status).toBe("not-found");
    if (execution.status !== "not-found") {
      throw new Error("expected misspelled tool to return not-found");
    }
    expect(execution.message).toContain("Closest registered tools: read_file");
  });

  it("returns unknown tool guidance through the query loop as a tool result", async () => {
    let streamCount = 0;
    const shellTool: AgentCoreToolDefinition = {
      name: "shell_command",
      description: "Run a shell command.",
      run: async () => ({
        content: "should not run",
      }),
    };

    const loop = runAgentCoreQueryLoop({
      cwd: "/tmp/project",
      messages: [
        {
          role: "user",
          content: "run pwd",
        },
      ],
      tools: [shellTool],
      model: {
        stream: async function* () {
          streamCount += 1;
          if (streamCount === 1) {
            yield {
              type: "tool-call",
              call: {
                id: "call_unknown",
                name: "shell",
                input: {
                  command: "pwd",
                },
              },
            };
            yield {
              type: "message-end",
            };
            return;
          }
          yield {
            type: "text-delta",
            content: "done",
          };
          yield {
            type: "message-end",
          };
        },
      },
      maxTurns: 3,
    });

    let result;
    while (true) {
      const item = await loop.next();
      if (item.done === true) {
        result = item.value;
        break;
      }
    }

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(result.status).toBe("completed");
    expect(toolMessage?.content).toContain("Alias suggestion: use shell_command instead of shell.");
    expect(toolMessage?.content).toContain("Repair guidance for shell:");
  });
});
