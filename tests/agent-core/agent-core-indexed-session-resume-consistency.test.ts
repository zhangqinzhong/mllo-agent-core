import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCoreJsonlSessionStore } from "../../src/agent-core/session/agent-core-jsonl-session-store";
import { resumeAgentCoreSession } from "../../src/agent-core/session/agent-core-session-resume";

describe("agent core indexed session resume consistency", () => {
  it("reads the latest message-count checkpoint through the transcript side index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-indexed-resume-consistency-"));
    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle = await store.createSession({
      sessionId: "session-1",
      cwd: dir,
      workspaceRoots: [dir],
    });

    await store.appendMessage(
      handle,
      store.createMessageEntry({
        sessionId: handle.sessionId,
        cwd: handle.cwd,
        message: {
          role: "user",
          content: "first",
        },
      }),
    );
    await store.appendMessage(
      handle,
      store.createMessageEntry({
        sessionId: handle.sessionId,
        cwd: handle.cwd,
        message: {
          role: "assistant",
          content: "second",
        },
      }),
    );
    await store.appendEntry(
      handle,
      store.createBudgetEventEntry({
        sessionId: handle.sessionId,
        cwd: handle.cwd,
        messageCount: 2,
      }),
    );

    const result = await resumeAgentCoreSession({
      store,
      handle,
    });

    expect(result.messages.map((message) => message.content)).toEqual(["first", "second"]);
    expect(result.consistency).toMatchObject({
      expectedMessageCount: 2,
      actualMessageCount: 2,
      delta: 0,
      checkpointAgeEntries: 0,
    });
  });

  it("reports indexed resume delta when a budgeted tail drops checkpointed messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-indexed-resume-consistency-delta-"));
    const store = new AgentCoreJsonlSessionStore({
      configDir: dir,
    });
    const handle = await store.createSession({
      sessionId: "session-1",
      cwd: dir,
      workspaceRoots: [dir],
    });

    for (const content of ["first", "second", "third"]) {
      await store.appendMessage(
        handle,
        store.createMessageEntry({
          sessionId: handle.sessionId,
          cwd: handle.cwd,
          message: {
            role: "user",
            content,
          },
        }),
      );
    }
    await store.appendEntry(
      handle,
      store.createBudgetEventEntry({
        sessionId: handle.sessionId,
        cwd: handle.cwd,
        messageCount: 3,
      }),
    );

    const result = await resumeAgentCoreSession({
      store,
      handle,
      maxIndexedResumeEntries: 1,
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("<mllo_resume_boundary>"),
      "third",
    ]);
    expect(result.consistency).toMatchObject({
      expectedMessageCount: 3,
      actualMessageCount: 2,
      delta: -1,
      checkpointAgeEntries: 0,
    });
  });
});
