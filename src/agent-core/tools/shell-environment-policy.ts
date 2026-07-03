const VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PROTECTED_ENV_NAMES = new Set([
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ELECTRON_RUN_AS_NODE",
  "LD_PRELOAD",
  "NODE_OPTIONS",
]);

const RESERVED_ENV_NAMES = new Set([
  "MLLO_AGENT_CORE",
  "MLLO_AGENT_CORE_PROJECT_DIR",
  "MLLO_AGENT_CORE_RUNTIME_DIR",
  "MLLO_AGENT_CORE_SESSION_ID",
]);

const SECRET_LIKE_ENV_NAME_RE =
  /(^|_)(AUTH|BEARER|COOKIE|CREDENTIAL|KEY|PASSWORD|PASS|PRIVATE|SECRET|SESSION|TOKEN)(_|$)/iu;

export type AgentCoreShellRemoteEnvironmentPolicy = {
  allowedSecretLikeEnvNames?: readonly string[];
};

export type AgentCoreShellSessionEnvironment = {
  projectDir: string;
  runtimeDir: string;
  sessionId?: string;
};

export type AgentCoreShellEnvironmentResult = {
  env: NodeJS.ProcessEnv;
  forwardedEnv: NodeJS.ProcessEnv;
  warnings: string[];
};

export type AgentCoreShellRemoteEnvironmentInspection = {
  allowedSecretLikeNames: string[];
  blockedSecretLikeNames: string[];
};

// 校验结构化 env 名称，避免把非法键交给平台 shell 或 spawn。
function isValidShellEnvName(name: string): boolean {
  return VALID_ENV_NAME_RE.test(name);
}

// 某些变量能注入 loader 或影响 Node/Electron 进程，结构化 env 不允许覆盖。
function isProtectedShellEnvName(name: string): boolean {
  return PROTECTED_ENV_NAMES.has(name);
}

export function isAgentCoreShellSecretLikeEnvName(name: string): boolean {
  return SECRET_LIKE_ENV_NAME_RE.test(name);
}

function isAllowedRemoteSecretLikeEnvName(args: {
  name: string;
  policy?: AgentCoreShellRemoteEnvironmentPolicy;
}): boolean {
  const allowedNames = new Set(
    (args.policy?.allowedSecretLikeEnvNames ?? []).map((name) => name.toUpperCase()),
  );
  return allowedNames.has(args.name.toUpperCase());
}

export function inspectAgentCoreShellRemoteEnvironment(args: {
  overrides?: Record<string, string>;
  remote: boolean;
  policy?: AgentCoreShellRemoteEnvironmentPolicy;
}): AgentCoreShellRemoteEnvironmentInspection {
  if (!args.remote) {
    return {
      allowedSecretLikeNames: [],
      blockedSecretLikeNames: [],
    };
  }
  const allowedSecretLikeNames: string[] = [];
  const blockedSecretLikeNames: string[] = [];
  for (const name of Object.keys(args.overrides ?? {})) {
    if (
      !isValidShellEnvName(name) ||
      isProtectedShellEnvName(name) ||
      RESERVED_ENV_NAMES.has(name) ||
      !isAgentCoreShellSecretLikeEnvName(name)
    ) {
      continue;
    }
    if (
      isAllowedRemoteSecretLikeEnvName({
        name,
        policy: args.policy,
      })
    ) {
      allowedSecretLikeNames.push(name);
    } else {
      blockedSecretLikeNames.push(name);
    }
  }
  return {
    allowedSecretLikeNames,
    blockedSecretLikeNames,
  };
}

// 远端 shell 默认不转发疑似 secret；需要每个 backend/host 显式放行。
function shouldForwardShellEnvOverrideToRemote(args: {
  name: string;
  remote: boolean;
  policy?: AgentCoreShellRemoteEnvironmentPolicy;
}): boolean {
  return (
    !args.remote ||
    !isAgentCoreShellSecretLikeEnvName(args.name) ||
    isAllowedRemoteSecretLikeEnvName({
      name: args.name,
      policy: args.policy,
    })
  );
}

// mllo 内部环境由运行态注入，模型不能通过 env 参数伪造 session 身份。
function applyAgentCoreShellSessionEnvironment(args: {
  env: NodeJS.ProcessEnv;
  forwardedEnv: NodeJS.ProcessEnv;
  session?: AgentCoreShellSessionEnvironment;
}): void {
  args.env.MLLO_AGENT_CORE = "1";
  args.forwardedEnv.MLLO_AGENT_CORE = "1";
  if (args.session === undefined) {
    return;
  }
  args.env.MLLO_AGENT_CORE_PROJECT_DIR = args.session.projectDir;
  args.env.MLLO_AGENT_CORE_RUNTIME_DIR = args.session.runtimeDir;
  args.forwardedEnv.MLLO_AGENT_CORE_PROJECT_DIR = args.session.projectDir;
  args.forwardedEnv.MLLO_AGENT_CORE_RUNTIME_DIR = args.session.runtimeDir;
  if (args.session.sessionId !== undefined) {
    args.env.MLLO_AGENT_CORE_SESSION_ID = args.session.sessionId;
    args.forwardedEnv.MLLO_AGENT_CORE_SESSION_ID = args.session.sessionId;
  }
}

// 构建 shell 进程环境；默认继承宿主环境，但对模型传入的 override 做白名单式校验。
export function buildAgentCoreShellEnvironment(args: {
  baseEnv?: NodeJS.ProcessEnv;
  session?: AgentCoreShellSessionEnvironment;
  overrides?: Record<string, string>;
  remote?: boolean;
  remoteEnvironmentPolicy?: AgentCoreShellRemoteEnvironmentPolicy;
}): AgentCoreShellEnvironmentResult {
  const env: NodeJS.ProcessEnv = {
    ...(args.baseEnv ?? process.env),
  };
  const forwardedEnv: NodeJS.ProcessEnv = {};
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(args.overrides ?? {})) {
    if (!isValidShellEnvName(name)) {
      warnings.push(`Ignored invalid environment variable name: ${name}`);
      continue;
    }
    if (isProtectedShellEnvName(name)) {
      warnings.push(`Ignored protected environment variable: ${name}`);
      continue;
    }
    if (RESERVED_ENV_NAMES.has(name)) {
      warnings.push(`Ignored reserved environment variable: ${name}`);
      continue;
    }
    env[name] = value;
    if (
      shouldForwardShellEnvOverrideToRemote({
        name,
        remote: args.remote === true,
        policy: args.remoteEnvironmentPolicy,
      })
    ) {
      forwardedEnv[name] = value;
    } else {
      warnings.push(`Did not forward secret-like environment variable to remote shell: ${name}`);
    }
  }
  applyAgentCoreShellSessionEnvironment({
    env,
    forwardedEnv,
    session: args.session,
  });
  return {
    env,
    forwardedEnv,
    warnings,
  };
}
