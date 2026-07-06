import type { AgentCoreBudgetPolicy, AgentCoreSummarizer } from "../budget/agent-core-budget-types";
import type { AgentCoreFileChangeCompactContextPolicy } from "../budget/agent-core-file-change-compact-context";
import type { AgentCoreHttpModelConfig } from "../model/agent-core-http-model-config";
import type {
  AgentCorePermissionMode,
  AgentCoreShellPermissionRule,
} from "../permissions/agent-core-permission-types";
import type { AgentCorePermissionResumeDecision } from "../query-loop/agent-core-permission-resume";
import type { AgentCoreElicitationResumeDecision } from "../query-loop/agent-core-elicitation-resume";
import type { AgentCoreQueryLoopResult } from "../query-loop/agent-core-query-types";
import type { AgentCoreSessionHandle } from "../session/agent-core-session-types";
import type {
  AgentCoreMemoryExtractor,
  AgentCoreMemoryMerger,
} from "./agent-core-session-memory-compact";
import type {
  AgentCoreWorker,
  AgentCoreWorkerId,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../workers/agent-core-worker-types";
import type { AgentCoreMcpClient } from "../mcp/agent-core-mcp-client-types";
import type { AgentCoreRunSessionOptions } from "./agent-core-run-session";
import type { AgentCoreHookDefinition } from "../hooks/agent-core-hook-types";
import type { AgentCoreShellExecutionBackend } from "../tools/shell-execution-backend";
import type { AgentCorePromptProfile } from "../context/agent-core-prompt-profile";
import type { AgentCoreMiddleware } from "../middleware/agent-core-middleware-types";
import type { AgentCoreLangfuseTracingOptions } from "../observability/agent-core-langfuse-options";

export type AgentCoreRunControllerOptions = {
  cwd: string;
  workspaceRoots?: string[];
  deniedPaths?: string[];
  permissionMode?: AgentCorePermissionMode;
  shellPermissionRules?: readonly AgentCoreShellPermissionRule[];
  input: string;
  signal?: AbortSignal;
  maxTurns?: number;
  elicitationTimeoutMs?: number;
  configPath?: string;
  providerName?: string;
  promptProfile?: AgentCorePromptProfile;
  skillHomeDir?: string;
  fetchImpl?: typeof fetch;
  modelProvider?: AgentCoreHttpModelConfig;
  shellExecutionBackend?: AgentCoreShellExecutionBackend;
  requireSandboxedShell?: boolean;
  hooks?: readonly AgentCoreHookDefinition[];
  middlewares?: readonly AgentCoreMiddleware[];
  workers?: readonly AgentCoreWorker[];
  mcpClients?: readonly AgentCoreMcpClient[];
  observability?: {
    langfuse?: AgentCoreLangfuseTracingOptions;
  };
  budget?: {
    policy?: Partial<AgentCoreBudgetPolicy>;
    summarizer?: AgentCoreSummarizer;
    memoryExtractor?: AgentCoreMemoryExtractor;
    memoryMerger?: AgentCoreMemoryMerger;
    memoryMergeTriggerChars?: number;
    writeSessionMemory?: boolean;
    fileChangeContext?: Partial<AgentCoreFileChangeCompactContextPolicy>;
  };
  session: AgentCoreRunSessionOptions;
  onPermissionRequest?: (
    result: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-permission" }>,
  ) => Promise<AgentCorePermissionResumeDecision>;
  onElicitationRequest?: (
    result: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-elicitation" }>,
  ) => Promise<AgentCoreElicitationResumeDecision>;
  onWorkerPermissionRequest?: (
    request: AgentCoreWorkerPermissionRequest & {
      workerId: AgentCoreWorkerId;
    },
  ) => Promise<AgentCoreWorkerPermissionDecision>;
};

export type AgentCoreRunControllerResult = AgentCoreQueryLoopResult & {
  session: AgentCoreSessionHandle;
};
