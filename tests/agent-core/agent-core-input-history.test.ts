import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAgentCoreInputHistoryEntry,
  listAgentCoreInputHistory,
  readAgentCoreInputHistory,
  readAgentCoreInputHistoryRecords,
  retractAgentCoreInputHistoryEntry,
  type AgentCoreInputHistoryEntry,
  type AgentCoreInputHistoryRecord,
} from "../../src/agent-core/session/agent-core-input-history";
import { getMlloHistoryPath } from "../../src/agent-core/runtime-home/mllo-home-paths";

function inputEntry(args: {
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  input: string;
}): AgentCoreInputHistoryEntry {
  return {
    kind: "input",
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: args.sessionId,
    cwd: args.cwd,
    input: args.input,
  };
}

async function writeHistory(
  configDir: string,
  lines: readonly (AgentCoreInputHistoryRecord | string)[],
): Promise<void> {
  const historyPath = getMlloHistoryPath({
    homePath: configDir,
  });
  await mkdir(dirname(historyPath), {
    recursive: true,
  });
  await writeFile(
    historyPath,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
    "utf8",
  );
}

describe("agent core input history", () => {
  it("lists cwd history newest-first with current session entries first", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mllo-input-history-"));
    const cwd = join(configDir, "project");
    const otherCwd = join(configDir, "other");
    await writeHistory(configDir, [
      inputEntry({
        uuid: "current-old",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "current",
        cwd,
        input: "current old",
      }),
      inputEntry({
        uuid: "other-newer",
        timestamp: "2026-01-01T00:01:00.000Z",
        sessionId: "other",
        cwd,
        input: "other newer",
      }),
      "{bad json",
      inputEntry({
        uuid: "ignored-cwd",
        timestamp: "2026-01-01T00:02:00.000Z",
        sessionId: "current",
        cwd: otherCwd,
        input: "wrong cwd",
      }),
      inputEntry({
        uuid: "current-newest",
        timestamp: "2026-01-01T00:03:00.000Z",
        sessionId: "current",
        cwd,
        input: "current newest",
      }),
    ]);

    const entries = await listAgentCoreInputHistory({
      configDir,
      cwd,
      sessionId: "current",
      limit: 3,
    });

    expect(entries.map((entry) => entry.input)).toEqual([
      "current newest",
      "current old",
      "other newer",
    ]);
  });

  it("can dedupe repeated inputs for search-style history pickers", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mllo-input-history-dedupe-"));
    const cwd = join(configDir, "project");
    await writeHistory(configDir, [
      inputEntry({
        uuid: "old",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        cwd,
        input: "repeat",
      }),
      inputEntry({
        uuid: "new",
        timestamp: "2026-01-01T00:01:00.000Z",
        sessionId: "s2",
        cwd,
        input: "repeat",
      }),
    ]);

    const entries = await listAgentCoreInputHistory({
      configDir,
      cwd,
      dedupeByInput: true,
    });

    expect(entries.map((entry) => entry.uuid)).toEqual(["new"]);
  });

  it("keeps strict reads strict while the interactive listing skips malformed lines", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mllo-input-history-strict-"));
    const cwd = join(configDir, "project");
    await writeHistory(configDir, [
      inputEntry({
        uuid: "ok",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        cwd,
        input: "ok",
      }),
      "{bad json",
    ]);

    await expect(readAgentCoreInputHistory(configDir)).rejects.toThrow(/Invalid Agent Core/);
    await expect(
      listAgentCoreInputHistory({
        configDir,
        cwd,
      }),
    ).resolves.toHaveLength(1);
  });

  it("returns an empty list when history has not been created", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mllo-input-history-empty-"));

    await expect(
      listAgentCoreInputHistory({
        configDir,
      }),
    ).resolves.toEqual([]);
  });

  it("hides retracted inputs from interactive history while preserving audit records", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mllo-input-history-retract-"));
    const cwd = join(configDir, "project");
    const first = await appendAgentCoreInputHistoryEntry({
      configDir,
      sessionId: "s1",
      cwd,
      input: "prompt to retract",
    });
    const second = await appendAgentCoreInputHistoryEntry({
      configDir,
      sessionId: "s1",
      cwd,
      input: "prompt to keep",
    });
    await retractAgentCoreInputHistoryEntry({
      configDir,
      sessionId: "s1",
      cwd,
      inputUuid: first.uuid,
      reason: "user-undo",
    });

    await expect(
      listAgentCoreInputHistory({
        configDir,
        cwd,
        sessionId: "s1",
      }),
    ).resolves.toMatchObject([
      {
        uuid: second.uuid,
        input: "prompt to keep",
      },
    ]);
    await expect(readAgentCoreInputHistory(configDir)).resolves.toMatchObject([
      {
        uuid: first.uuid,
      },
      {
        uuid: second.uuid,
      },
    ]);
    await expect(readAgentCoreInputHistoryRecords(configDir)).resolves.toMatchObject([
      {
        kind: "input",
        uuid: first.uuid,
      },
      {
        kind: "input",
        uuid: second.uuid,
      },
      {
        kind: "input-retraction",
        inputUuid: first.uuid,
      },
    ]);
  });
});
