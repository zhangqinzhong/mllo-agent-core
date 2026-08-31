import { describe, expect, it } from "vitest";
import {
  flushOpenAIToolCalls,
  mergeOpenAIToolCallDeltas,
  type OpenAIStreamingToolCall,
} from "../../src/agent-core/model/agent-core-openai-streaming-tool-calls";
import { renderAgentCoreCompactTranscript } from "../../src/agent-core/budget/agent-core-compact-transcript";
import {
  createAgentCoreToolCall,
  ensureAgentCoreToolCallsUniqueIds,
} from "../../src/agent-core/model/agent-core-model-wire";

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

  it("repairs whitelisted file_path aliases without changing tool semantics", () => {
    const call = createAgentCoreToolCall({
      id: "call_alias",
      index: 0,
      name: "read_file",
      arguments: {
        file_path: "README.md",
        maxBytes: 100,
      },
    });

    expect(call.input).toEqual({
      path: "README.md",
      maxBytes: 100,
    });
    expect(call.inputRepairStatus).toEqual({
      status: "parameter-alias-renamed",
      repairs: [
        {
          from: "file_path",
          to: "path",
        },
      ],
    });
  });

  it("does not let a parameter alias override an explicit canonical path", () => {
    const call = createAgentCoreToolCall({
      id: "call_alias_conflict",
      index: 0,
      name: "read_file",
      arguments: {
        file_path: "wrong.md",
        path: "README.md",
      },
    });

    expect(call.input).toEqual({
      file_path: "wrong.md",
      path: "README.md",
    });
    expect(call.inputRepairStatus).toBeUndefined();
  });

  it("renames repeated tool call ids and records the original provider id", () => {
    const calls = ensureAgentCoreToolCallsUniqueIds([
      {
        id: "call_same",
        name: "list_dir",
        input: {
          path: ".",
        },
      },
      {
        id: "call_same",
        name: "read_file",
        input: {
          path: "README.md",
        },
      },
      {
        id: "call_same",
        name: "grep_files",
        input: {
          path: ".",
          pattern: "mllo",
        },
      },
    ]);

    expect(calls.map((call) => call.id)).toEqual(["call_same", "call_same_2", "call_same_3"]);
    expect(calls[0]?.idRepairStatus).toBeUndefined();
    expect(calls[1]?.idRepairStatus).toEqual({
      status: "duplicate-id-renamed",
      originalId: "call_same",
      occurrence: 2,
    });
    expect(calls[2]?.idRepairStatus).toEqual({
      status: "duplicate-id-renamed",
      originalId: "call_same",
      occurrence: 3,
    });
  });

  it("keeps tool call id repair metadata in compact transcript text", () => {
    const call = ensureAgentCoreToolCallsUniqueIds([
      {
        id: "call_same",
        name: "list_dir",
        input: {
          path: ".",
        },
      },
      {
        id: "call_same",
        name: "read_file",
        input: {
          path: "README.md",
        },
      },
    ])[1];

    const transcript = renderAgentCoreCompactTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: call === undefined ? [] : [call],
      },
    ]);

    expect(transcript).toContain("idRepairStatus: duplicate-id-renamed");
    expect(transcript).toContain("originalToolCallId: call_same");
  });

  it("keeps tool input repair metadata in compact transcript text", () => {
    const call = createAgentCoreToolCall({
      id: "call_alias",
      index: 0,
      name: "read_file",
      arguments: {
        file_path: "README.md",
      },
    });

    const transcript = renderAgentCoreCompactTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: [call],
      },
    ]);

    expect(transcript).toContain("inputRepairStatus: parameter-alias-renamed");
    expect(transcript).toContain("inputRepairs: file_path->path");
  });

  it("keeps tool name repair metadata in compact transcript text", () => {
    const transcript = renderAgentCoreCompactTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_alias",
            name: "shell_command",
            input: {
              command: "pwd",
            },
            nameRepairStatus: {
              status: "tool-alias-renamed",
              originalName: "shell",
              targetName: "shell_command",
            },
          },
        ],
      },
    ]);

    expect(transcript).toContain("nameRepairStatus: tool-alias-renamed");
    expect(transcript).toContain("originalToolName: shell");
    expect(transcript).toContain("targetToolName: shell_command");
  });
});
