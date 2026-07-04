import { resolve } from "node:path";
import type {
  AgentCorePermissionContext,
  AgentCorePermissionMode,
  AgentCoreShellPermissionRule,
} from "../permissions/agent-core-permission-types";
import type { AgentCoreQueryLoopArgs } from "../query-loop/agent-core-query-types";
import { createAgentCoreBaseTools } from "../tools/agent-core-base-tools";
import { localAgentCoreShellExecutionBackend } from "../tools/shell-execution-backend";
import {
  defaultAgentCoreToolAvailabilityCache,
  resolveAgentCoreToolAvailability,
} from "../tools/agent-core-tool-availability";
import { AgentCoreCheckpointStore } from "../checkpoint/agent-core-checkpoint-store";
import { getAgentCoreRunSandboxPolicy } from "../runtime/agent-core-run-sandbox-policy";
import {
  renderAgentCoreSystemPrompt,
  renderAgentCoreSystemPromptBlocks,
} from "./agent-core-prompt-renderer";
import { AgentCoreShellCwdTracker } from "../tools/shell-cwd-tracker";
import { readAgentCoreShellCwdState, writeAgentCoreShellCwdState } from "../tools/shell-cwd-state";
import { AgentCoreShellTaskRegistry } from "../tools/shell-task-registry";
import {
  combineAgentCoreContextMessages,
  maybeResumeAgentCoreContextSession,
} from "./agent-core-context-session-resume";
import { createAgentCoreSessionRuntimePaths } from "./agent-core-session-runtime-paths";
import { resolveAgentCoreSystemContextSnapshotResult } from "./agent-core-system-context-snapshot";
import { renderAgentCoreTurnContextMessage } from "./agent-core-turn-context-message";
import { buildAgentCorePromptContext } from "./agent-core-prompt-context-builder";
import { resolveAgentCorePromptProfile } from "./agent-core-prompt-profile";
import type {
  AgentCoreBuiltContext,
  AgentCoreContextBuilderOptions,
} from "./agent-core-context-builder-types";
import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";

// 规范化 cwd。所有相对路径权限判断都要基于同一个 cwd。
function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}

// 规范化 workspace roots。没有显式 roots 时，默认只允许当前 cwd。
function normalizeWorkspaceRoots(
  cwd: string,
  workspaceRoots: readonly string[] | undefined,
): string[] {
  return (workspaceRoots?.length ? workspaceRoots : [cwd]).map((root) => resolve(cwd, root));
}

// 规范化 denied paths。显式禁区要和 workspace roots 一样走 cwd 解析。
function normalizeDeniedPaths(
  cwd: string,
  deniedPaths: readonly string[] | undefined,
): string[] | undefined {
  return deniedPaths?.map((path) => resolve(cwd, path));
}

// 创建权限上下文。Context Builder 是权限模式进入 queryLoop 的唯一入口。
function buildPermissionContext(options: {
  cwd: string;
  workspaceRoots: string[];
  deniedPaths?: string[];
  permissionMode?: AgentCorePermissionMode;
  shellPermissionRules?: readonly AgentCoreShellPermissionRule[];
}): AgentCorePermissionContext {
  return {
    mode: options.permissionMode ?? "ask",
    cwd: options.cwd,
    workspaceRoots: options.workspaceRoots,
    deniedPaths: options.deniedPaths,
    ...(options.shellPermissionRules === undefined
      ? {}
      : { shellRules: options.shellPermissionRules }),
  };
}

// 创建 shell cwd tracker。正常 session 使用 thread 级状态，cd 不应串到同项目其他会话。
async function createShellCwdTracker(args: {
  statePath: string;
  fallbackCwd: string;
}): Promise<AgentCoreShellCwdTracker> {
  const initialCwd = await readAgentCoreShellCwdState({
    statePath: args.statePath,
    fallbackCwd: args.fallbackCwd,
  });
  return new AgentCoreShellCwdTracker(initialCwd, {
    onChange(change) {
      void writeAgentCoreShellCwdState({
        statePath: args.statePath,
        cwd: change.currentCwd,
      });
    },
  });
}

// 创建 checkpoint store。checkpoint 绑定 session；无 session 的一次性 run 不生成可恢复快照。
function createCheckpointStore(args: {
  cwd: string;
  input: string;
  session: AgentCoreContextBuilderOptions["session"];
  checkpointDir: string;
}): AgentCoreCheckpointStore | undefined {
  const sessionId = args.session?.handle.sessionId;
  if (sessionId === undefined) {
    return undefined;
  }
  return new AgentCoreCheckpointStore({
    checkpointsDir: args.checkpointDir,
    sessionId,
    cwd: args.cwd,
    prompt: args.input,
  });
}

function createLegacySystemPromptBlock(prompt: string): AgentCorePromptBlock[] {
  return [
    {
      name: "stored_system_context_snapshot",
      text: prompt,
      cacheScope: "session",
    },
  ];
}

// 构建一次 Agent Core run 的上下文。它不启动模型，只产出 queryLoop 可执行入参。
export async function buildAgentCoreContext(
  options: AgentCoreContextBuilderOptions,
): Promise<AgentCoreBuiltContext> {
  const cwd = normalizeCwd(options.cwd);
  const promptProfile = resolveAgentCorePromptProfile(options.promptProfile);
  const workspaceRoots = normalizeWorkspaceRoots(cwd, options.workspaceRoots);
  const deniedPaths = normalizeDeniedPaths(cwd, options.deniedPaths);
  const permissionContext = buildPermissionContext({
    cwd,
    workspaceRoots,
    deniedPaths,
    permissionMode: options.permissionMode,
    shellPermissionRules: options.shellPermissionRules,
  });
  const sandboxPolicy =
    options.sandboxPolicy ??
    getAgentCoreRunSandboxPolicy({
      permissionMode: options.permissionMode,
      shellExecutionBackend: options.shellExecutionBackend,
    });
  const shellExecutionBackend =
    options.shellExecutionBackend ?? localAgentCoreShellExecutionBackend;
  const runtimePaths = createAgentCoreSessionRuntimePaths({
    cwd,
    sessionHandle: options.session?.handle,
    runtimeHome: options.runtimeHome,
  });
  const cwdTracker = await createShellCwdTracker({
    statePath: runtimePaths.shellCwdPath,
    fallbackCwd: cwd,
  });
  const checkpointStore = createCheckpointStore({
    cwd,
    input:
      options.newMessages?.find((message) => message.role === "user")?.content ?? "Agent Core run",
    session: options.session,
    checkpointDir: runtimePaths.checkpointDir,
  });
  const candidateTools = createAgentCoreBaseTools({
    permissionContext,
    filesystem:
      checkpointStore === undefined
        ? undefined
        : {
            onBeforeFileWrite(snapshot) {
              return checkpointStore.snapshotFile(snapshot);
            },
            onAfterFileWrite(snapshot) {
              return checkpointStore.recordFileWrite(snapshot);
            },
          },
    plan: {
      journalPath: runtimePaths.planJournalPath,
    },
    skills: {
      cwd,
      runtimeHome: options.runtimeHome,
      homeDir: options.skillHomeDir,
    },
    shell: {
      cwdTracker,
      outputDir: runtimePaths.shellOutputDir,
      taskRegistry: new AgentCoreShellTaskRegistry({
        journalPath: runtimePaths.shellTaskJournalPath,
        readableOutputDirs: [runtimePaths.shellOutputDir],
      }),
      executionBackend: shellExecutionBackend,
      requireSandboxedBackend: options.requireSandboxedShell,
      sessionEnvironment: {
        projectDir: cwd,
        runtimeDir: runtimePaths.runtimeDir,
        sessionId: options.session?.handle.sessionId,
      },
    },
    mcpClients: options.mcpClients,
    delegatedAgents: {
      workers: options.workers ?? [],
      workflowJournalPath: runtimePaths.workflowJournalPath,
    },
  });
  const toolAvailability = await resolveAgentCoreToolAvailability({
    tools: candidateTools,
    cache: options.toolAvailabilityCache ?? defaultAgentCoreToolAvailabilityCache,
    nowMs: options.toolAvailabilityNowMs,
  });
  const tools = toolAvailability.tools;
  const resume = await maybeResumeAgentCoreContextSession(options.session);
  const messages = combineAgentCoreContextMessages(resume, options.newMessages);
  const promptContext = await buildAgentCorePromptContext({
    cwd,
    shellCwd: cwdTracker.getCwd(),
    sandboxPolicy,
    shellExecutionBackend,
    workspaceRoots,
    permissionContext,
    tools,
    toolAvailabilityRecords: toolAvailability.records,
    session: options.session,
    resume,
    runtimeHome: options.runtimeHome,
    skillHomeDir: options.skillHomeDir,
    shellTaskJournalPath: runtimePaths.shellTaskJournalPath,
    planJournalPath: runtimePaths.planJournalPath,
    workflowJournalPath: runtimePaths.workflowJournalPath,
    budget: options.budget,
    modelProfile: options.modelProfile,
  });
  const generatedSystemPromptBlocks = renderAgentCoreSystemPromptBlocks(promptContext, {
    profile: promptProfile,
  });
  const generatedSystemPrompt = renderAgentCoreSystemPrompt(promptContext, {
    profile: promptProfile,
  });
  const systemPromptSnapshot = await resolveAgentCoreSystemContextSnapshotResult({
    session: options.session,
    generatedPrompt: generatedSystemPrompt,
    generatedPromptBlocks: generatedSystemPromptBlocks,
    promptContext,
  });
  const systemPrompt = systemPromptSnapshot.prompt;
  const systemPromptBlocks =
    systemPromptSnapshot.promptBlocks ?? createLegacySystemPromptBlock(systemPrompt);
  const turnContextBaselineMode =
    systemPromptSnapshot.source === "generated"
      ? "omit-current-baseline"
      : "include-baseline-refresh";
  const queryArgs: AgentCoreQueryLoopArgs = {
    cwd,
    systemPrompt,
    systemPromptBlocks,
    turnContext: renderAgentCoreTurnContextMessage(promptContext, {
      profile: promptProfile,
      baselineMode: turnContextBaselineMode,
    }),
    messages,
    model: options.model,
    tools,
    middlewares: options.middlewares,
    signal: options.signal,
    maxTurns: options.maxTurns,
  };

  return {
    cwd,
    permissionContext,
    tools,
    messages,
    queryArgs,
    promptContext,
    promptProfile,
    systemPrompt,
    systemPromptBlocks,
    resume,
    checkpointPath: checkpointStore?.path(),
  };
}
