import {
  isMlloCliInputFormat,
  isMlloCliOutputFormat,
  isMlloCliPermissionMode,
  type MlloCliCommand,
  type MlloCliInputFormat,
  type MlloCliOutputFormat,
  type MlloCliParsedArgs,
  type MlloCliParseOptions,
} from "./mllo-cli-types";
import type { AgentCorePermissionMode } from "../agent-core/permissions/agent-core-permission-types";

type MutableParsedArgs = {
  command?: MlloCliCommand | "config";
  configSubcommand?: "path" | "init";
  promptParts: string[];
  cwd: string;
  homePath?: string;
  configPath?: string;
  providerName?: string;
  permissionMode?: AgentCorePermissionMode;
  outputFormat: MlloCliOutputFormat;
  inputFormat: MlloCliInputFormat;
  maxTurns?: number;
  sessionId?: string;
  resumeSessionId?: string;
  observerHost?: string;
  observerPort?: number;
  anthropicTraceProxy: boolean;
  traceProxyHost?: string;
  traceProxyPort?: number;
  anthropicTraceUpstream?: string;
  traceCaptureBodies: boolean;
  continueLatest: boolean;
  force: boolean;
  print: boolean;
};

function splitLongOption(raw: string): { flag: string; value?: string } {
  const equalsIndex = raw.indexOf("=");
  if (equalsIndex < 0) {
    return { flag: raw };
  }
  return {
    flag: raw.slice(0, equalsIndex),
    value: raw.slice(equalsIndex + 1),
  };
}

function takeFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function commandFromArg(arg: string): MlloCliCommand | "config" | undefined {
  switch (arg) {
    case "run":
    case "chat":
    case "observe":
    case "help":
    case "version":
      return arg;
    case "config":
      return "config";
    default:
      return undefined;
  }
}

function finalizeCommand(parsed: MutableParsedArgs, stdinIsTty: boolean): MlloCliCommand {
  if (parsed.command === "config") {
    if (parsed.configSubcommand === "path") {
      return "config-path";
    }
    if (parsed.configSubcommand === "init") {
      return "config-init";
    }
    return "help";
  }
  if (parsed.command !== undefined) {
    return parsed.command;
  }
  // 没有显式命令时，TTY 进入交互；带 prompt 或 pipe 输入时走一次性 run。
  return parsed.print || parsed.promptParts.length > 0 || !stdinIsTty ? "run" : "chat";
}

function setOutputFormat(parsed: MutableParsedArgs, value: string, flag: string): void {
  if (!isMlloCliOutputFormat(value)) {
    throw new Error(`${flag} must be one of: text, json, stream-json.`);
  }
  parsed.outputFormat = value;
}

function setInputFormat(parsed: MutableParsedArgs, value: string, flag: string): void {
  if (!isMlloCliInputFormat(value)) {
    throw new Error(`${flag} must be one of: text, stream-json.`);
  }
  parsed.inputFormat = value;
}

function setPermissionMode(parsed: MutableParsedArgs, value: string, flag: string): void {
  if (!isMlloCliPermissionMode(value)) {
    throw new Error(
      `${flag} must be one of: ask, auto-readonly, workspace-write, dangerously-bypass.`,
    );
  }
  parsed.permissionMode = value;
}

function applyOption(args: readonly string[], index: number, parsed: MutableParsedArgs): number {
  const raw = args[index]!;
  const { flag, value: inlineValue } = splitLongOption(raw);
  const nextValue = (): { value: string; nextIndex: number } => {
    if (inlineValue !== undefined) {
      return { value: inlineValue, nextIndex: index };
    }
    return { value: takeFlagValue(args, index, flag), nextIndex: index + 1 };
  };

  switch (flag) {
    case "-p":
    case "--print":
      parsed.print = true;
      return index;
    case "--json":
      parsed.outputFormat = "json";
      return index;
    case "-c":
    case "--continue":
      parsed.continueLatest = true;
      return index;
    case "--help":
    case "-h":
      parsed.command = "help";
      return index;
    case "--version":
    case "-v":
      parsed.command = "version";
      return index;
    case "--force":
      parsed.force = true;
      return index;
    case "--cwd": {
      const next = nextValue();
      parsed.cwd = next.value;
      return next.nextIndex;
    }
    case "--home": {
      const next = nextValue();
      parsed.homePath = next.value;
      return next.nextIndex;
    }
    case "--config": {
      const next = nextValue();
      parsed.configPath = next.value;
      return next.nextIndex;
    }
    case "--provider": {
      const next = nextValue();
      parsed.providerName = next.value;
      return next.nextIndex;
    }
    case "--permission-mode": {
      const next = nextValue();
      setPermissionMode(parsed, next.value, flag);
      return next.nextIndex;
    }
    case "--dangerously-skip-permissions":
      parsed.permissionMode = "dangerously-bypass";
      return index;
    case "--output-format": {
      const next = nextValue();
      setOutputFormat(parsed, next.value, flag);
      return next.nextIndex;
    }
    case "--input-format": {
      const next = nextValue();
      setInputFormat(parsed, next.value, flag);
      return next.nextIndex;
    }
    case "--max-turns": {
      const next = nextValue();
      parsed.maxTurns = parsePositiveInt(next.value, flag);
      return next.nextIndex;
    }
    case "--host": {
      const next = nextValue();
      parsed.observerHost = next.value;
      return next.nextIndex;
    }
    case "--port": {
      const next = nextValue();
      parsed.observerPort = parsePositiveInt(next.value, flag);
      return next.nextIndex;
    }
    case "--anthropic-trace-proxy":
      parsed.anthropicTraceProxy = true;
      return index;
    case "--trace-proxy-host": {
      const next = nextValue();
      parsed.traceProxyHost = next.value;
      return next.nextIndex;
    }
    case "--trace-proxy-port": {
      const next = nextValue();
      parsed.traceProxyPort = parsePositiveInt(next.value, flag);
      return next.nextIndex;
    }
    case "--anthropic-upstream": {
      const next = nextValue();
      parsed.anthropicTraceUpstream = next.value;
      return next.nextIndex;
    }
    case "--trace-capture-bodies":
      parsed.traceCaptureBodies = true;
      return index;
    case "--session-id": {
      const next = nextValue();
      parsed.sessionId = next.value;
      return next.nextIndex;
    }
    case "--resume": {
      const next = nextValue();
      parsed.resumeSessionId = next.value;
      return next.nextIndex;
    }
    default:
      throw new Error(`Unknown option: ${flag}`);
  }
}

export function parseMlloCliArgs(
  args: readonly string[],
  options: MlloCliParseOptions = {},
): MlloCliParsedArgs {
  const parsed: MutableParsedArgs = {
    promptParts: [],
    cwd: process.cwd(),
    outputFormat: "text",
    inputFormat: "text",
    anthropicTraceProxy: false,
    traceCaptureBodies: false,
    continueLatest: false,
    force: false,
    print: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      parsed.promptParts.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      index = applyOption(args, index, parsed);
      continue;
    }
    const command = commandFromArg(arg);
    if (parsed.command === undefined && command !== undefined) {
      parsed.command = command;
      continue;
    }
    if (parsed.command === "config" && parsed.configSubcommand === undefined) {
      if (arg === "path" || arg === "init") {
        parsed.configSubcommand = arg;
        continue;
      }
    }
    parsed.promptParts.push(arg);
  }

  return {
    command: finalizeCommand(parsed, options.stdinIsTty ?? true),
    promptParts: parsed.promptParts,
    cwd: parsed.cwd,
    ...(parsed.homePath === undefined ? {} : { homePath: parsed.homePath }),
    ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
    ...(parsed.providerName === undefined ? {} : { providerName: parsed.providerName }),
    ...(parsed.permissionMode === undefined ? {} : { permissionMode: parsed.permissionMode }),
    outputFormat: parsed.outputFormat,
    inputFormat: parsed.inputFormat,
    ...(parsed.maxTurns === undefined ? {} : { maxTurns: parsed.maxTurns }),
    ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
    ...(parsed.resumeSessionId === undefined ? {} : { resumeSessionId: parsed.resumeSessionId }),
    ...(parsed.observerHost === undefined ? {} : { observerHost: parsed.observerHost }),
    ...(parsed.observerPort === undefined ? {} : { observerPort: parsed.observerPort }),
    anthropicTraceProxy: parsed.anthropicTraceProxy,
    ...(parsed.traceProxyHost === undefined ? {} : { traceProxyHost: parsed.traceProxyHost }),
    ...(parsed.traceProxyPort === undefined ? {} : { traceProxyPort: parsed.traceProxyPort }),
    ...(parsed.anthropicTraceUpstream === undefined
      ? {}
      : { anthropicTraceUpstream: parsed.anthropicTraceUpstream }),
    traceCaptureBodies: parsed.traceCaptureBodies,
    continueLatest: parsed.continueLatest,
    force: parsed.force,
  };
}
