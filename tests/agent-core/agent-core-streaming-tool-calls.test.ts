import { describe, expect, it } from "vitest";
import {
  flushOpenAIToolCalls,
  mergeOpenAIToolCallDeltas,
  type OpenAIStreamingToolCall,
} from "../../src/agent-core/model/agent-core-openai-streaming-tool-calls";
import { createAgentCoreToolCall } from "../../src/agent-core/model/agent-core-model-wire";

describe("agent core streaming tool calls", () => {
  it("continues OpenAI tool arguments by id when later chunks omit index", () => {
    const calls = new Map<number, OpenAIStreamingToolCall>();

    mergeOpenAIToolCallDeltas({
      calls,
      deltas: [
        {
          index: 0,
          id: "call_read",
          function: {
            name: "read_file",
            arguments: '{"path"',
          },
        },
      ],
    });
    mergeOpenAIToolCallDeltas({
      calls,
      deltas: [
        {
          id: "call_read",
          function: {
            arguments: ':"README.md"}',
          },
        },
      ],
    });

    const events = [...flushOpenAIToolCalls(calls)];

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool-call");
    expect(events[0]?.call).toMatchObject({
      id: "call_read",
      name: "read_file",
      input: {
        path: "README.md",
      },
    });
  });

  it("separates reused OpenAI tool-call indexes when a new id appears", () => {
    const calls = new Map<number, OpenAIStreamingToolCall>();

    mergeOpenAIToolCallDeltas({
      calls,
      deltas: [
        {
          index: 0,
          id: "call_one",
          function: {
            name: "list_dir",
            arguments: '{"path":"."}',
          },
        },
      ],
    });
    mergeOpenAIToolCallDeltas({
      calls,
      deltas: [
        {
          index: 0,
          id: "call_two",
          function: {
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        },
      ],
    });

    const toolCalls = [...flushOpenAIToolCalls(calls)].map((event) => event.call);

    expect(toolCalls.map((call) => call.id)).toEqual(["call_one", "call_two"]);
    expect(toolCalls.map((call) => call.name)).toEqual(["list_dir", "read_file"]);
  });

  it("marks malformed tool arguments without throwing away the raw repair context", () => {
    const call = createAgentCoreToolCall({
      id: "call_bad",
      index: 0,
      name: "read_file",
      arguments: '{"path":',
    });

    expect(call).toMatchObject({
      id: "call_bad",
      name: "read_file",
      inputParseStatus: {
        status: "malformed-json",
      },
    });
    expect(call.inputParseStatus?.rawPreview).toContain('"path"');
  });
});
