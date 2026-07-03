import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCoreJsonlSessionStore } from "../../src/agent-core/session/agent-core-jsonl-session-store";
import { resumeAgentCoreSession } from "../../src/agent-core/session/agent-core-session-resume";
import type {
  AgentCoreSessionEntry,
  AgentCoreSessionHandle,
} from "../../src/agent-core/session/agent-core-session-types";

function messageEntry(sessionId: string, cwd: string, content: string): AgentCoreSessionEntry {
  return {
    kind: "message",
    uuid: `uuid-${content}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId,
    cwd,
    message: {
      role: "user",
      content,
    },
  };
}

function budgetCheckpointEntry(
  sessionId: string,
  cwd: string,
  messageCount: number,
): AgentCoreSessionEntry {
  return {
    kind: "budget-event",
    uuid: `budget-${messageCount}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    sessionId,
    cwd,
    messageCount,
  };
}

async function writeTranscript(
  transcriptPath: string,
  entries: readonly AgentCoreSessionEntry[],
): Promise<void> {
  await writeFile(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

describe("agent core fallback session resume", () => {
  it("reports omitted entries when resuming an old JSONL session without a side index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-fallback-resume-"));
    const transcriptPath = join(dir, "session.jsonl");
    const sessionId = "session-1";
    const entries = ["first", "second", "third", "fourth", "fifth"].map((content) =>
      messageEntry(sessionId, dir, content),
    );
    await writeTranscript(transcriptPath, entries);

    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle: AgentCoreSessionHandle = {
      sessionId,
      cwd: dir,
      projectDir: dir,
      transcriptPath,
    };

    const result = await resumeAgentCoreSession({
      store,
      handle,
      headEntries: 1,
      tailEntries: 2,
    });

    expect(result.omittedResumableEntries).toBe(2);
    expect(result.omittedResumableBytes).toBe(0);
    expect(result.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("<mllo_resume_boundary>"),
      "first",
      "fourth",
      "fifth",
    ]);
    expect(result.messages[0]?.content).toContain("omittedEntries: 2");
  });

  it("reports zero resume consistency delta when the fallback window matches the latest checkpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-fallback-consistency-"));
    const transcriptPath = join(dir, "session.jsonl");
    const sessionId = "session-1";
    await writeTranscript(transcriptPath, [
      messageEntry(sessionId, dir, "first"),
      messageEntry(sessionId, dir, "second"),
      budgetCheckpointEntry(sessionId, dir, 2),
    ]);

    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle: AgentCoreSessionHandle = {
      sessionId,
      cwd: dir,
      projectDir: dir,
      transcriptPath,
    };

    const result = await resumeAgentCoreSession({
      store,
      handle,
      headEntries: 0,
      tailEntries: 3,
    });

    expect(result.consistency).toEqual({
      expectedMessageCount: 2,
      actualMessageCount: 2,
      delta: 0,
      checkpointAgeEntries: 0,
      checkpointUuid: "budget-2",
      checkpointTimestamp: "2026-01-01T00:00:01.000Z",
    });
  });

  it("reports a resume consistency delta when fallback budget omits earlier messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-fallback-consistency-delta-"));
    const transcriptPath = join(dir, "session.jsonl");
    const sessionId = "session-1";
    await writeTranscript(transcriptPath, [
      messageEntry(sessionId, dir, "first"),
      messageEntry(sessionId, dir, "second"),
      messageEntry(sessionId, dir, "third"),
      budgetCheckpointEntry(sessionId, dir, 3),
    ]);

    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle: AgentCoreSessionHandle = {
      sessionId,
      cwd: dir,
      projectDir: dir,
      transcriptPath,
    };

    const result = await resumeAgentCoreSession({
      store,
      handle,
      headEntries: 0,
      tailEntries: 2,
    });

    expect(result.omittedResumableEntries).toBe(2);
    expect(result.consistency).toMatchObject({
      expectedMessageCount: 3,
      actualMessageCount: 2,
      delta: -1,
      checkpointUuid: "budget-3",
    });
  });
});
