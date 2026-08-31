import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCoreJsonlSessionStore } from "../../src/agent-core/session/agent-core-jsonl-session-store";
import { readAgentCoreTranscriptEntriesAtOffsets } from "../../src/agent-core/session/agent-core-transcript-offset-reader";
import { readAgentCoreTranscriptSideIndex } from "../../src/agent-core/session/agent-core-transcript-side-index";

describe("agent core transcript offset reader", () => {
  it("reads selected transcript entries through one ordered offset batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-offset-reader-"));
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

    const indexEntries = await readAgentCoreTranscriptSideIndex(handle.transcriptPath);
    const messageIndexes = indexEntries.filter((entry) => entry.entryKind === "message");
    const entries = await readAgentCoreTranscriptEntriesAtOffsets({
      transcriptPath: handle.transcriptPath,
      indexEntries: [messageIndexes[2]!, messageIndexes[0]!],
    });

    expect(entries.map((entry) => (entry.kind === "message" ? entry.message.content : ""))).toEqual(
      ["third", "first"],
    );
  });

  it("rejects an offset entry when side-index metadata does not match the JSONL line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mllo-offset-reader-corrupt-"));
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

    const [entry] = (await readAgentCoreTranscriptSideIndex(handle.transcriptPath)).filter(
      (indexEntry) => indexEntry.entryKind === "message",
    );

    await expect(
      readAgentCoreTranscriptEntriesAtOffsets({
        transcriptPath: handle.transcriptPath,
        indexEntries: [
          {
            ...entry!,
            entryUuid: "wrong-uuid",
          },
        ],
      }),
    ).rejects.toThrow("entry does not match side index metadata");
  });
});
