import { resolve } from "node:path";
import { listAgentCoreInputHistory } from "../agent-core/session/agent-core-input-history";
import { resolveLatestAgentCoreSession } from "../agent-core/runtime/agent-core-latest-session";
import { getMlloRuntimeHomeLayout } from "../agent-core/runtime-home/mllo-home-paths";
import type { MlloCliParsedArgs } from "./mllo-cli-types";

const DEFAULT_CLI_HISTORY_SIZE = 100;

export type MlloCliReadlineHistoryOptions = {
  parsed: MlloCliParsedArgs;
  limit?: number;
};

async function resolveHistorySessionId(args: {
  parsed: MlloCliParsedArgs;
  configDir: string;
  stateDbPath: string;
  cwd: string;
}): Promise<string | undefined> {
  if (args.parsed.sessionId !== undefined || args.parsed.resumeSessionId !== undefined) {
    return args.parsed.resumeSessionId ?? args.parsed.sessionId;
  }
  if (!args.parsed.continueLatest) {
    return undefined;
  }
  const latest = await resolveLatestAgentCoreSession({
    configDir: args.configDir,
    stateDbPath: args.stateDbPath,
    cwd: args.cwd,
  });
  return latest?.sessionId;
}

// 预加载 readline 历史。这样 mllo chat 的上箭头能复用 core 的项目输入历史。
export async function loadMlloCliReadlineHistory(
  options: MlloCliReadlineHistoryOptions,
): Promise<string[]> {
  const layout = getMlloRuntimeHomeLayout({
    homePath: options.parsed.homePath,
  });
  const cwd = resolve(options.parsed.cwd);
  const sessionId = await resolveHistorySessionId({
    parsed: options.parsed,
    configDir: layout.homePath,
    stateDbPath: layout.stateDbPath,
    cwd,
  });
  const entries = await listAgentCoreInputHistory({
    configDir: layout.homePath,
    cwd,
    ...(sessionId === undefined ? {} : { sessionId }),
    limit: options.limit ?? DEFAULT_CLI_HISTORY_SIZE,
    dedupeByInput: true,
  });
  return entries.map((entry) => entry.input);
}
