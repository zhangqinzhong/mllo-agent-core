import type {
  AgentCorePermissionContext,
  AgentCorePermissionMode,
  AgentCoreShellPermissionRule,
} from "../permissions/agent-core-permission-types";
import type {
  AgentCoreMessage,
  AgentCoreModelAdapter,
  AgentCoreQueryLoopArgs,
} from "../query-loop/agent-core-query-types";
import type { AgentCorePromptBlock } from "../query-loop/agent-core-prompt-block-types";
import type { AgentCoreToolDefinition } from "../tools/agent-core-tool-types";
import type { AgentCoreShellExecutionBackend } from "../tools/shell-execution-backend";
import type { AgentCoreToolAvailabilityCache } from "../tools/agent-core-tool-availability";
import type { AgentCoreWorker } from "../workers/agent-core-worker-types";
import type { AgentCoreMcpClient } from "../mcp/agent-core-mcp-client-types";
import type { AgentCoreJsonlSessionStore } from "../session/agent-core-jsonl-session-store";
import type { AgentCoreResumeResult } from "../session/agent-core-session-resume";
import type { AgentCoreSessionHandle } from "../session/agent-core-session-types";
import type {
  AgentCoreBudgetPromptState,
  AgentCoreModelProfile,
  AgentCorePromptContext,
} from "./agent-core-prompt-context";
import type { AgentCoreRunSandboxPolicy } from "../runtime/agent-core-run-sandbox-policy";
import type { MlloRuntimeHomeOptions } from "../runtime-home/mllo-runtime-home-types";
import type { AgentCorePromptProfile } from "./agent-core-prompt-profile";
import type { AgentCoreMiddleware } from "../middleware/agent-core-middleware-types";
import type { AgentCoreToolExposureMode } from "../tools/agent-core-tool-exposure";

export type AgentCoreContextBuilderOptions = {
  cwd: string;
  workspaceRoots?: string[];
  deniedPaths?: string[];
  permissionMode?: AgentCorePermissionMode;
  shellPermissionRules?: readonly AgentCoreShellPermissionRule[];
  model: AgentCoreModelAdapter;
  workers?: readonly AgentCoreWorker[];
  mcpClients?: readonly AgentCoreMcpClient[];
  session?: {
    store: AgentCoreJsonlSessionStore;
    handle: AgentCoreSessionHandle;
    resume?: boolean;
    maxIndexedResumeEntries?: number;
    maxIndexedResumeBytes?: number;
  };
  newMessages?: readonly AgentCoreMessage[];
  signal?: AbortSignal;
  maxTurns?: number;
  middlewares?: readonly AgentCoreMiddleware[];
  runtimeHome?: MlloRuntimeHomeOptions;
  skillHomeDir?: string;
  budget?: Partial<AgentCoreBudgetPromptState>;
  modelProfile?: AgentCoreModelProfile;
  promptProfile?: AgentCorePromptProfile;
  sandboxPolicy?: AgentCoreRunSandboxPolicy;
  toolAvailabilityCache?: AgentCoreToolAvailabilityCache;
  toolAvailabilityNowMs?: number;
  shellExecutionBackend?: AgentCoreShellExecutionBackend;
  requireSandboxedShell?: boolean;
  toolExposureMode?: AgentCoreToolExposureMode;
};

export type AgentCoreBuiltContext = {
  cwd: string;
  permissionContext: AgentCorePermissionContext;
  tools: AgentCoreToolDefinition[];
  messages: AgentCoreMessage[];
  queryArgs: AgentCoreQueryLoopArgs;
  promptContext: AgentCorePromptContext;
  promptProfile: AgentCorePromptProfile;
  systemPrompt: string;
  systemPromptBlocks: readonly AgentCorePromptBlock[];
  resume?: AgentCoreResumeResult;
  checkpointPath?: string;
};
