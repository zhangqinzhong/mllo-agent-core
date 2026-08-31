import { describe, expect, it } from "vitest";
import {
  createAgentCoreTranscriptResumeIndexWindow,
  type AgentCoreTranscriptSideIndexEntry,
} from "../../src/agent-core/session/agent-core-transcript-side-index";

function indexEntry(args: {
  uuid: string;
  offset: number;
  length?: number;
  role?: "user" | "assistant" | "tool";
  toolCallId?: string;
  toolCallIds?: string[];
}): AgentCoreTranscriptSideIndexEntry {
  return {
    kind: "transcript-index-entry",
    sessionId: "session-1",
    cwd: "/tmp/project",
    transcriptPath: "/tmp/project/session.jsonl",
    entryUuid: args.uuid,
    entryTimestamp: "2026-01-01T00:00:00.000Z",
    entryKind: "message",
    byteOffset: args.offset,
    byteLength: args.length ?? 10,
    messageRole: args.role,
    toolCallId: args.toolCallId,
    toolCallIds: args.toolCallIds,
  };
}

describe("agent core transcript side index resume window", () => {
  it("keeps the indexed resume window as a contiguous tail when byte budget is small", () => {
    const window = createAgentCoreTranscriptResumeIndexWindow(
      [
        indexEntry({
          uuid: "old-small",
          offset: 0,
          length: 5,
          role: "user",
        }),
        indexEntry({
          uuid: "middle-large",
          offset: 5,
          length: 100,
          role: "assistant",
        }),
        indexEntry({
          uuid: "latest-small",
          offset: 105,
          length: 5,
          role: "user",
        }),
      ],
      {
        maxIndexedResumeBytes: 10,
      },
    );

    expect(window.resumableEntries.map((entry) => entry.entryUuid)).toEqual(["latest-small"]);
    expect(window.omittedResumableEntries).toBe(2);
    expect(window.omittedResumableBytes).toBe(105);
  });

  it("expands the indexed resume tail to include the full tool trajectory", () => {
    const window = createAgentCoreTranscriptResumeIndexWindow(
      [
        indexEntry({
          uuid: "old-context",
          offset: 0,
          role: "user",
        }),
        indexEntry({
          uuid: "assistant-tool-call",
          offset: 10,
          role: "assistant",
          toolCallIds: ["call_read"],
        }),
        indexEntry({
          uuid: "tool-result",
          offset: 20,
          role: "tool",
          toolCallId: "call_read",
        }),
        indexEntry({
          uuid: "assistant-followup",
          offset: 30,
          role: "assistant",
        }),
      ],
      {
        maxIndexedResumeEntries: 1,
      },
    );

    expect(window.resumableEntries.map((entry) => entry.entryUuid)).toEqual([
      "assistant-tool-call",
      "tool-result",
      "assistant-followup",
    ]);
    expect(window.omittedResumableEntries).toBe(1);
    expect(window.omittedResumableBytes).toBe(10);
  });
});
