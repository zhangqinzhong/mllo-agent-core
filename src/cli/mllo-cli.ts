#!/usr/bin/env node
import { parseMlloCliArgs } from "./mllo-cli-args";
import { getMlloCliConfigPath, initializeMlloCliConfig } from "./mllo-cli-config-command";
import { renderMlloCliHelp, renderMlloCliVersion } from "./mllo-cli-help";
import { readMlloCliStdin, writeCliLine, type MlloCliIo } from "./mllo-cli-io";
import { readMlloCliPackageVersion } from "./mllo-cli-package-version";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCliFailure(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("ENOENT") && message.includes("config")) {
    return `${message}\nRun "mllo config init" to create a starter config.`;
  }
  return message;
}

function createAbortSignal(): AbortSignal {
  const controller = new AbortController();
  // Ctrl+C 先取消当前 run，让 runtime 有机会关闭 MCP、shell 和 session store。
  process.once("SIGINT", () => {
    controller.abort();
  });
  return controller.signal;
}

async function promptFromArgsOrStdin(args: {
  promptParts: readonly string[];
  io: MlloCliIo;
}): Promise<string> {
  if (args.promptParts.length > 0) {
    return args.promptParts.join(" ");
  }
  if (args.io.stdin.isTTY === true) {
    return "";
  }
  return await readMlloCliStdin(args.io.stdin);
}

export async function main(argv = process.argv.slice(2), io?: MlloCliIo): Promise<number> {
  const cliIo: MlloCliIo = io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const parsed = parseMlloCliArgs(argv, {
    stdinIsTty: cliIo.stdin.isTTY === true,
  });
  switch (parsed.command) {
    case "help":
      writeCliLine(cliIo.stdout, renderMlloCliHelp());
      return 0;
    case "version":
      writeCliLine(cliIo.stdout, renderMlloCliVersion(readMlloCliPackageVersion(__dirname)));
      return 0;
    case "config-path":
      writeCliLine(cliIo.stdout, getMlloCliConfigPath(parsed));
      return 0;
    case "config-init": {
      const configPath = await initializeMlloCliConfig(parsed);
      writeCliLine(cliIo.stdout, `Created mllo config: ${configPath}`);
      return 0;
    }
    case "observe": {
      const { runMlloCliObserve } = await import("./mllo-cli-observe-command");
      return await runMlloCliObserve({
        parsed,
        io: cliIo,
        signal: createAbortSignal(),
      });
    }
    case "chat": {
      const { runMlloCliChat } = await import("./mllo-cli-chat-command");
      return await runMlloCliChat({
        parsed,
        io: cliIo,
        signal: createAbortSignal(),
      });
    }
    case "run": {
      const { runMlloCliPrompt } = await import("./mllo-cli-run-command");
      return await runMlloCliPrompt({
        parsed,
        io: cliIo,
        input: await promptFromArgsOrStdin({
          promptParts: parsed.promptParts,
          io: cliIo,
        }),
        signal: createAbortSignal(),
      });
    }
  }
}

if (require.main === module) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      writeCliLine(process.stderr, `mllo: ${formatCliFailure(error)}`);
      process.exitCode = 1;
    },
  );
}
