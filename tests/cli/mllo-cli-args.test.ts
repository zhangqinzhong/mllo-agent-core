import { describe, expect, it } from "vitest";
import { parseMlloCliArgs } from "../../src/cli/mllo-cli-args";

describe("parseMlloCliArgs", () => {
  it("opens chat for an empty TTY invocation", () => {
    expect(parseMlloCliArgs([], { stdinIsTty: true }).command).toBe("chat");
  });

  it("runs once when stdin is piped", () => {
    expect(parseMlloCliArgs([], { stdinIsTty: false }).command).toBe("run");
  });

  it("treats prompt text as a one-shot run", () => {
    const parsed = parseMlloCliArgs(["summarize", "this"], { stdinIsTty: true });

    expect(parsed.command).toBe("run");
    expect(parsed.promptParts).toEqual(["summarize", "this"]);
  });

  it("parses config subcommands", () => {
    expect(parseMlloCliArgs(["config", "path"]).command).toBe("config-path");
    expect(parseMlloCliArgs(["config", "init"]).command).toBe("config-init");
  });

  it("parses observe command options", () => {
    const parsed = parseMlloCliArgs(["observe", "--host", "127.0.0.1", "--port", "43111"]);

    expect(parsed.command).toBe("observe");
    expect(parsed.observerHost).toBe("127.0.0.1");
    expect(parsed.observerPort).toBe(43111);
  });

  it("parses latest-session resume", () => {
    const parsed = parseMlloCliArgs(["run", "--continue", "hello"]);

    expect(parsed.continueLatest).toBe(true);
    expect(parsed.promptParts).toEqual(["hello"]);
  });

  it("parses runtime options", () => {
    const parsed = parseMlloCliArgs([
      "run",
      "--cwd",
      "/tmp/project",
      "--home=/tmp/mllo",
      "--config",
      "/tmp/config.json",
      "--provider",
      "local",
      "--permission-mode",
      "auto-readonly",
      "--output-format",
      "stream-json",
      "--max-turns",
      "3",
      "--resume",
      "session-1",
      "hello",
    ]);

    expect(parsed.cwd).toBe("/tmp/project");
    expect(parsed.homePath).toBe("/tmp/mllo");
    expect(parsed.configPath).toBe("/tmp/config.json");
    expect(parsed.providerName).toBe("local");
    expect(parsed.permissionMode).toBe("auto-readonly");
    expect(parsed.outputFormat).toBe("stream-json");
    expect(parsed.maxTurns).toBe(3);
    expect(parsed.resumeSessionId).toBe("session-1");
    expect(parsed.promptParts).toEqual(["hello"]);
  });

  it("rejects invalid options", () => {
    expect(() => parseMlloCliArgs(["--output-format", "xml"])).toThrow(/output-format/);
    expect(() => parseMlloCliArgs(["--max-turns", "0"])).toThrow(/positive integer/);
    expect(() => parseMlloCliArgs(["--unknown"])).toThrow(/Unknown option/);
  });
});
