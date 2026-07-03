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

  it("runs whitelisted tool name aliases through the query loop", async () => {
    let streamCount = 0;
    let receivedInput: unknown;
    const shellTool: AgentCoreToolDefinition = {
      name: "shell_command",
      description: "Run a shell command.",
      isConcurrencySafe: () => true,
      run: async (input) => {
        receivedInput = input;
        return {
          content: "ran shell",
        };
      },
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
                id: "call_alias",
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

    const assistantWithTools = result.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    const toolMessage = result.messages.find((message) => message.role === "tool");

    expect(result.status).toBe("completed");
    expect(receivedInput).toEqual({
      command: "pwd",
    });
    expect(assistantWithTools?.toolCalls?.[0]).toMatchObject({
      id: "call_alias",
      name: "shell_command",
      nameRepairStatus: {
        status: "tool-alias-renamed",
        originalName: "shell",
        targetName: "shell_command",
      },
    });
    expect(toolMessage).toMatchObject({
      toolCallId: "call_alias",
      name: "shell_command",
      content: "ran shell",
    });
  });

  it("keeps misspelled non-alias tool names as repair feedback", async () => {
    let streamCount = 0;
    const readTool: AgentCoreToolDefinition = {
      name: "read_file",
      description: "Read a file.",
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
      tools: [readTool],
      model: {
        stream: async function* () {
          streamCount += 1;
          if (streamCount === 1) {
            yield {
              type: "tool-call",
              call: {
                id: "call_misspelled",
                name: "readfile",
                input: {
                  path: "README.md",
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
    expect(toolMessage?.content).toContain("Closest registered tools: read_file");
    expect(toolMessage?.content).toContain("Repair guidance for readfile:");
  });
});
