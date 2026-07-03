import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  AgentCoreToolAvailabilityCheckResult,
  AgentCoreToolAvailabilityPolicy,
} from "./agent-core-tool-types";
import type { AgentCoreShellRemoteEnvironmentPolicy } from "./shell-environment-policy";

export type AgentCoreShellExecutionSpawnArgs = {
  file: string;
  args: string[];
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
  forwardedEnv: NodeJS.ProcessEnv;
  shell: boolean;
};

export type AgentCoreShellExecutionProcess = ChildProcessByStdio<null, Readable, Readable>;

export type AgentCoreShellCwdTrackingMode = "file" | "stdout-marker";

export type AgentCoreShellExecutionBackend = {
  kind: string;
  label?: string;
  remote?: boolean;
  sandboxed?: boolean;
  cwdTrackingMode?: AgentCoreShellCwdTrackingMode;
  remoteEnvironmentPolicy?: AgentCoreShellRemoteEnvironmentPolicy;
  availability?: AgentCoreToolAvailabilityPolicy;
  spawn(args: AgentCoreShellExecutionSpawnArgs): AgentCoreShellExecutionProcess;
};

function backendLabel(backend: AgentCoreShellExecutionBackend): string {
  return backend.label ?? backend.kind;
}

export function describeAgentCoreShellExecutionBackend(
  backend: AgentCoreShellExecutionBackend,
): string {
  const location = backend.remote === true ? "remote" : "local";
  const sandbox = backend.sandboxed === true ? "sandboxed" : "unsandboxed";
  return `${backendLabel(backend)} (${location}, ${sandbox})`;
}

// 后端没声明 availability 时按可用处理，保持旧本地 spawn 和测试后端兼容。
export async function checkAgentCoreShellExecutionBackendAvailability(
  backend: AgentCoreShellExecutionBackend,
): Promise<AgentCoreToolAvailabilityCheckResult> {
  const check = backend.availability?.check;
  if (check === undefined) {
    return {
      available: true,
      reason: `Shell execution backend is registered: ${describeAgentCoreShellExecutionBackend(backend)}.`,
    };
  }
  try {
    return await check();
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createAgentCoreShellExecutionBackendToolAvailability(
  backend: AgentCoreShellExecutionBackend,
): AgentCoreToolAvailabilityPolicy {
  return {
    ...(backend.availability?.ttlMs === undefined ? {} : { ttlMs: backend.availability.ttlMs }),
    ...(backend.availability?.failureGraceMs === undefined
      ? {}
      : { failureGraceMs: backend.availability.failureGraceMs }),
    check: () => checkAgentCoreShellExecutionBackendAvailability(backend),
  };
}

// 默认本地执行后端。后续 macOS sandbox、容器或 SSH 后端应该实现同一个接口。
export const localAgentCoreShellExecutionBackend: AgentCoreShellExecutionBackend = {
  kind: "local",
  label: "Local shell",
  remote: false,
  sandboxed: false,
  cwdTrackingMode: "file",
  availability: {
    ttlMs: 60_000,
    failureGraceMs: 5 * 60_000,
    check: () => ({
      available: true,
      reason: `Local shell backend is available on ${process.platform}.`,
    }),
  },
  spawn(args) {
    return spawn(args.file, args.args, {
      cwd: args.cwd,
      detached: args.detached,
      env: args.env,
      shell: args.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
  },
};
