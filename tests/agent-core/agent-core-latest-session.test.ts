import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLatestAgentCoreSession } from "../../src/agent-core/runtime/agent-core-latest-session";
import { MlloStateStore } from "../../src/agent-core/runtime-state/mllo-state-store";
import type { MlloThreadRecord } from "../../src/agent-core/runtime-state/mllo-thread-records";
import { appendAgentCoreSessionIndexEntry } from "../../src/agent-core/session/agent-core-session-index";

async function writeTranscript(path: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, "{}\n", "utf8");
}

function threadRecord(args: {
  id: string;
  cwd: string;
  rolloutPath: string;
  updatedAtMs: number;
}): MlloThreadRecord {
  return {
    id: args.id,
    rolloutPath: args.rolloutPath,
    cwd: args.cwd,
    title: args.id,
    modelProvider: "test",
    approvalMode: "ask",
    sandboxPolicy: "workspace-write",
    tokensUsed: 0,
    resumeOmittedEntries: 0,
    resumeOmittedBytes: 0,
    runStatus: "completed",
    archived: false,
    preview: "",
    createdAtMs: 1,
    updatedAtMs: args.updatedAtMs,
  };
}

describe("resolveLatestAgentCoreSession", () => {
  it("uses the newest existing state thread for the requested cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "mllo-latest-state-"));
    const cwd = join(home, "project");
    const otherCwd = join(home, "other");
    const oldPath = join(home, "old.jsonl");
    const newPath = join(home, "new.jsonl");
    const otherPath = join(home, "other.jsonl");
    await Promise.all([
      writeTranscript(oldPath),
      writeTranscript(newPath),
      writeTranscript(otherPath),
    ]);
    const state = new MlloStateStore({
      dbPath: join(home, "state.sqlite"),
    });
    try {
      state.upsertThread(
        threadRecord({
          id: "old-session",
          cwd,
          rolloutPath: oldPath,
          updatedAtMs: 10,
        }),
      );
      state.upsertThread(
        threadRecord({
          id: "new-session",
          cwd,
          rolloutPath: newPath,
          updatedAtMs: 20,
        }),
      );
      state.upsertThread(
        threadRecord({
          id: "other-session",
          cwd: otherCwd,
          rolloutPath: otherPath,
          updatedAtMs: 30,
        }),
      );
    } finally {
      state.close();
    }

    await expect(
      resolveLatestAgentCoreSession({
        configDir: home,
        stateDbPath: join(home, "state.sqlite"),
        cwd,
      }),
    ).resolves.toMatchObject({
      sessionId: "new-session",
      transcriptPath: newPath,
      source: "state",
    });
  });

  it("falls back to the session index when state is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "mllo-latest-index-"));
    const cwd = join(home, "project");
    const oldPath = join(home, "old-index.jsonl");
    const newPath = join(home, "new-index.jsonl");
    await Promise.all([writeTranscript(oldPath), writeTranscript(newPath)]);
    await appendAgentCoreSessionIndexEntry({
      configDir: home,
      sessionId: "old-index-session",
      cwd,
      workspaceRoots: [cwd],
      projectDir: join(home, "project-index"),
      transcriptPath: oldPath,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await appendAgentCoreSessionIndexEntry({
      configDir: home,
      sessionId: "new-index-session",
      cwd,
      workspaceRoots: [cwd],
      projectDir: join(home, "project-index"),
      transcriptPath: newPath,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    await expect(
      resolveLatestAgentCoreSession({
        configDir: home,
        stateDbPath: join(home, "missing-state.sqlite"),
        cwd,
      }),
    ).resolves.toMatchObject({
      sessionId: "new-index-session",
      transcriptPath: newPath,
      source: "index",
    });
  });
});
