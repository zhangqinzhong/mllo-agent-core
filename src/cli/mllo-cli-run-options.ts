import { resolve } from "node:path";
import type {
  AgentCoreRunControllerOptions,
  AgentCoreRunControllerResult,
} from "../agent-core/runtime/agent-core-run-controller-types";
import { runAgentCoreController } from "../agent-core/runtime/agent-core-run-controller";
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

export function createMlloCliRunOptions(args: {
  parsed: MlloCliParsedArgs;
  input: string;
  handlers: MlloCliRunHandlers;
  signal?: AbortSignal;
}): AgentCoreRunControllerOptions {
  if (args.parsed.inputFormat !== "text") {
    throw new Error("mllo CLI currently supports only --input-format text.");
  }
  if (args.parsed.continueLatest) {
    throw new Error("mllo --continue is reserved until latest-session indexing is exposed.");
  }
  const layout = getMlloRuntimeHomeLayout({ homePath: args.parsed.homePath });
  const cwd = resolve(args.parsed.cwd);
  const resume = args.parsed.resumeSessionId !== undefined;
  const sessionId = args.parsed.resumeSessionId ?? args.parsed.sessionId;

  return {
    cwd,
    workspaceRoots: [cwd],
    input: args.input,
    configPath:
      args.parsed.configPath === undefined ? layout.configPath : resolve(args.parsed.configPath),
    session: {
      configDir: layout.homePath,
      stateDbPath: layout.stateDbPath,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(resume ? { resume: true } : {}),
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
