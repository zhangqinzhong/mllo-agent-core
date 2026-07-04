import type { AgentCorePermissionMode } from "../agent-core/permissions/agent-core-permission-types";

export type MlloCliCommand =
  | "run"
  | "chat"
  | "observe"
  | "config-path"
  | "config-init"
  | "help"
  | "version";

export type MlloCliOutputFormat = "text" | "json" | "stream-json";

export type MlloCliInputFormat = "text" | "stream-json";

export type MlloCliParsedArgs = {
  command: MlloCliCommand;
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
};

export type MlloCliParseOptions = {
  stdinIsTty?: boolean;
};

export const MLLO_CLI_OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;

export const MLLO_CLI_INPUT_FORMATS = ["text", "stream-json"] as const;

export const MLLO_CLI_PERMISSION_MODES = [
  "ask",
  "auto-readonly",
  "workspace-write",
  "dangerously-bypass",
] as const;

export function isMlloCliOutputFormat(value: string): value is MlloCliOutputFormat {
  return (MLLO_CLI_OUTPUT_FORMATS as readonly string[]).includes(value);
}

export function isMlloCliInputFormat(value: string): value is MlloCliInputFormat {
  return (MLLO_CLI_INPUT_FORMATS as readonly string[]).includes(value);
}

export function isMlloCliPermissionMode(value: string): value is AgentCorePermissionMode {
  return (MLLO_CLI_PERMISSION_MODES as readonly string[]).includes(value);
}
