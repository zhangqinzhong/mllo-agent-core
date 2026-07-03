import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentCoreToolAvailabilityCheckResult } from "./agent-core-tool-types";
import type {
  AgentCoreShellExecutionBackend,
  AgentCoreShellExecutionProcess,
  AgentCoreShellExecutionSpawnArgs,
} from "./shell-execution-backend";
import type { AgentCoreShellRemoteEnvironmentPolicy } from "./shell-environment-policy";

type SshChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type SshSpawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => SshChildProcess;

export type AgentCoreSshShellExecutionBackendOptions = {
  target: string;
  label?: string;
  sshCommand?: string;
  remoteShell?: string;
  localCwd?: string;
  port?: number;
  identityFile?: string;
  extraArgs?: readonly string[];
  connectTimeoutSeconds?: number;
  forwardedEnvNames?: readonly string[];
  remoteEnvironmentPolicy?: AgentCoreShellRemoteEnvironmentPolicy;
  remoteProcessCleanup?: boolean;
  availabilityCheck?: () =>
    | AgentCoreToolAvailabilityCheckResult
    | Promise<AgentCoreToolAvailabilityCheckResult>;
  spawnImpl?: SshSpawn;
};

const DEFAULT_SSH_COMMAND = process.platform === "win32" ? "ssh.exe" : "ssh";
const DEFAULT_REMOTE_SHELL = "/bin/sh";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 5;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildSshConnectionArgs(options: AgentCoreSshShellExecutionBackendOptions): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
    ...(options.port === undefined ? [] : ["-p", String(options.port)]),
    ...(options.identityFile === undefined ? [] : ["-i", options.identityFile]),
    ...(options.extraArgs ?? []),
  ];
}

function extractShellCommand(args: AgentCoreShellExecutionSpawnArgs): string {
  if (!args.shell && args.args[0] === "-lc" && args.args[1] !== undefined) {
    return args.args[1];
  }
  if (args.shell && args.args.length === 0) {
    return args.file;
  }
  return [args.file, ...args.args].map(shellQuote).join(" ");
}

function remoteEnvironmentAssignments(args: {
  env: NodeJS.ProcessEnv;
  names?: readonly string[];
}): string {
  return (args.names ?? Object.keys(args.env))
    .flatMap((name) => {
      const value = args.env[name];
      return value === undefined ? [] : [`${name}=${shellQuote(value)}`];
    })
    .join(" ");
}

// ssh 断开时远端 shell 通常收到 HUP/TERM；trap 会尽量清理同一进程组里的子进程。
function wrapRemoteCommandForCleanup(command: string, enabled: boolean): string {
  if (!enabled) {
    return command;
  }
  return [
    "__mllo_cleanup() {",
    "  trap - HUP INT TERM",
    "  kill -TERM 0 2>/dev/null || true",
    "}",
    "trap __mllo_cleanup HUP INT TERM",
    command,
  ].join("\n");
}

function buildRemoteShellCommand(
  spawnArgs: AgentCoreShellExecutionSpawnArgs,
  options: AgentCoreSshShellExecutionBackendOptions,
): string {
  const envText = remoteEnvironmentAssignments({
    env: spawnArgs.forwardedEnv,
    names: options.forwardedEnvNames,
  });
  const command = wrapRemoteCommandForCleanup(
    extractShellCommand(spawnArgs),
    options.remoteProcessCleanup ?? true,
  );
  const remoteShell = options.remoteShell ?? DEFAULT_REMOTE_SHELL;
  const shellInvocation = [envText, shellQuote(remoteShell), "-lc", shellQuote(command)]
    .filter((part) => part.length > 0)
    .join(" ");
  return `cd ${shellQuote(spawnArgs.cwd)} && ${shellInvocation}`;
}

async function defaultSshAvailabilityCheck(args: {
  options: AgentCoreSshShellExecutionBackendOptions;
}): Promise<AgentCoreToolAvailabilityCheckResult> {
  const sshCommand = args.options.sshCommand ?? DEFAULT_SSH_COMMAND;
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(
      sshCommand,
      [...buildSshConnectionArgs(args.options), args.options.target, "true"],
      {
        stdio: "ignore",
      },
    );
    const finish = (result: AgentCoreToolAvailabilityCheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve(result);
    };
    timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        finish({
          available: false,
          reason: `SSH availability check timed out: ${args.options.target}`,
        });
      },
      (args.options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1_000 + 1_000,
    );
    timeout.unref();
    child.once("error", (error) => {
      finish({
        available: false,
        reason: `SSH command is not available: ${sshCommand}. ${error.message}`,
      });
    });
    child.once("close", (code) => {
      finish(
        code === 0
          ? {
              available: true,
              reason: `SSH target is reachable: ${args.options.target}.`,
            }
          : {
              available: false,
              reason: `SSH target check failed with code ${code}: ${args.options.target}`,
            },
      );
    });
  });
}

export function buildAgentCoreSshShellCommandArgs(
  spawnArgs: AgentCoreShellExecutionSpawnArgs,
  options: AgentCoreSshShellExecutionBackendOptions,
): string[] {
  return [
    ...buildSshConnectionArgs(options),
    "--",
    options.target,
    buildRemoteShellCommand(spawnArgs, options),
  ];
}

// SSH backend 只替换执行位置；权限、审计、输出、cancel 仍由 shell runner 统一处理。
export function createAgentCoreSshShellExecutionBackend(
  options: AgentCoreSshShellExecutionBackendOptions,
): AgentCoreShellExecutionBackend {
  const sshCommand = options.sshCommand ?? DEFAULT_SSH_COMMAND;
  const spawnImpl: SshSpawn = options.spawnImpl ?? spawn;
  return {
    kind: "ssh",
    label: options.label ?? `SSH shell ${options.target}`,
    remote: true,
    sandboxed: false,
    cwdTrackingMode: "stdout-marker",
    remoteEnvironmentPolicy: options.remoteEnvironmentPolicy,
    availability: {
      ttlMs: 60_000,
      failureGraceMs: 5 * 60_000,
      check:
        options.availabilityCheck ??
        (() =>
          defaultSshAvailabilityCheck({
            options,
          })),
    },
    spawn(spawnArgs): AgentCoreShellExecutionProcess {
      return spawnImpl(sshCommand, buildAgentCoreSshShellCommandArgs(spawnArgs, options), {
        cwd: options.localCwd ?? process.cwd(),
        detached: spawnArgs.detached,
        env: spawnArgs.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  };
}
