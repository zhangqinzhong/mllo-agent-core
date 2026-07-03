import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listAgentCoreInputHistory,
  readAgentCoreInputHistory,
  type AgentCoreInputHistoryEntry,
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
  lines: readonly (AgentCoreInputHistoryEntry | string)[],
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
});
