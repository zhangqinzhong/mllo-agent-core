import { resolve } from "node:path";
import type {
  AgentCoreRunControllerOptions,
  AgentCoreRunControllerResult,
} from "../agent-core/runtime/agent-core-run-controller-types";
import { runAgentCoreController } from "../agent-core/runtime/agent-core-run-controller";
import { resolveLatestAgentCoreSession } from "../agent-core/runtime/agent-core-latest-session";
import { getMlloRuntimeHomeLayout } from "../agent-core/runtime-home/mllo-home-paths";
import type { AgentCoreQueryEvent } from "../agent-core/query-loop/agent-core-query-types";
import type { MlloCliParsedArgs } from "./mllo-cli-types";

export type MlloCliRunHandlers = Pick<
  AgentCoreRunControllerOptions,
  "onPermissionRequest" | "onElicitationRequest" | "onWorkerPermissionRequest"
>;

export type MlloCliEventSink = {
  handleEvent: (event: AgentCoreQueryEvent) => void;
};

async function resolveMlloCliSession(args: {
  parsed: MlloCliParsedArgs;
  configDir: string;
  stateDbPath: string;
  cwd: string;
}): Promise<{
  sessionId?: string;
  resume: boolean;
}> {
  const explicitSessionId = args.parsed.resumeSessionId ?? args.parsed.sessionId;
  if (args.parsed.continueLatest) {
    if (explicitSessionId !== undefined) {
      throw new Error("mllo --continue cannot be combined with --session-id or --resume.");
    }
    const latest = await resolveLatestAgentCoreSession({
      configDir: args.configDir,
      stateDbPath: args.stateDbPath,
      cwd: args.cwd,
    });
    if (latest === undefined) {
      throw new Error(`No mllo session found for --continue in cwd: ${args.cwd}`);
    }
    return {
      sessionId: latest.sessionId,
      resume: true,
    };
  }
  return {
    ...(explicitSessionId === undefined ? {} : { sessionId: explicitSessionId }),
    resume: args.parsed.resumeSessionId !== undefined,
  };
}

export async function createMlloCliRunOptions(args: {
  parsed: MlloCliParsedArgs;
  input: string;
  handlers: MlloCliRunHandlers;
  signal?: AbortSignal;
}): Promise<AgentCoreRunControllerOptions> {
  if (args.parsed.inputFormat !== "text") {
    throw new Error("mllo CLI currently supports only --input-format text.");
  }
  const layout = getMlloRuntimeHomeLayout({ homePath: args.parsed.homePath });
  const cwd = resolve(args.parsed.cwd);
  const sessionResolution = await resolveMlloCliSession({
    parsed: args.parsed,
    configDir: layout.homePath,
    stateDbPath: layout.stateDbPath,
    cwd,
  });

  return {
    cwd,
    workspaceRoots: [cwd],
    input: args.input,
    configPath:
      args.parsed.configPath === undefined ? layout.configPath : resolve(args.parsed.configPath),
    session: {
      configDir: layout.homePath,
      stateDbPath: layout.stateDbPath,
      ...(sessionResolution.sessionId === undefined
        ? {}
        : { sessionId: sessionResolution.sessionId }),
      ...(sessionResolution.resume ? { resume: true } : {}),
    },
    skillHomeDir: layout.skillsDir,
    ...(args.parsed.providerName === undefined ? {} : { providerName: args.parsed.providerName }),
    ...(args.parsed.permissionMode === undefined
      ? {}
      : { permissionMode: args.parsed.permissionMode }),
    ...(args.parsed.maxTurns === undefined ? {} : { maxTurns: args.parsed.maxTurns }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    ...args.handlers,
  };
}

export async function consumeMlloCliAgentRun(args: {
  options: AgentCoreRunControllerOptions;
  sink: MlloCliEventSink;
}): Promise<AgentCoreRunControllerResult> {
  const generator = runAgentCoreController(args.options);
  while (true) {
    const item = await generator.next();
    if (item.done === true) {
      return item.value;
    }
    args.sink.handleEvent(item.value);
  }
}
