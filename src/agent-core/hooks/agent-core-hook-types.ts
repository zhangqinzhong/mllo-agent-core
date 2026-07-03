import type {
  AgentCoreElicitationRequest,
  AgentCoreFileChangeProgress,
  AgentCoreToolCall,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";
import type { AgentCoreElicitationResumeDecision } from "../query-loop/agent-core-elicitation-resume";
import type { AgentCoreShellCwdChange } from "../tools/shell-cwd-tracker";
import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreWorkerEvent } from "../workers/agent-core-worker-types";
import type { MlloHookPhase } from "./agent-core-command-hook-protocol";
import type { AgentCoreCompactRecord } from "../budget/agent-core-budget-types";

export type AgentCoreHookPhase = MlloHookPhase;

export type AgentCoreHookStatus = "started" | "completed" | "failed";

export type AgentCoreCompactHookContext = {
  originalMessageCount: number;
  summarizedMessageCount: number;
  retainedMessageCount: number;
  estimatedInputTokens: number;
  compactId?: string;
  compactedAt?: string;
  summary?: string;
  record?: AgentCoreCompactRecord;
};

export type AgentCoreHookDecision =
  | {
      action: "continue";
      content?: string;
    }
  | {
      action: "block";
      reason: string;
    }
  | {
      action: "request-continue";
      reason: string;
    };

export type AgentCoreHookContext = {
  phase: AgentCoreHookPhase;
  cwd: string;
  call?: AgentCoreToolCall;
  result?: AgentCoreToolResult;
  permissionDecision?: AgentCorePermissionDecision;
  elicitationRequest?: AgentCoreElicitationRequest;
  elicitationDecision?: AgentCoreElicitationResumeDecision;
  finalContent?: string;
  userPrompt?: string;
  sessionStatus?: string;
  fileChange?: AgentCoreFileChangeProgress;
  cwdChange?: AgentCoreShellCwdChange;
  stopFailureReason?: string;
  subagentEvent?: AgentCoreWorkerEvent;
  compact?: AgentCoreCompactHookContext;
  signal?: AbortSignal;
};

export type AgentCoreHookDefinition = {
  name: string;
  phase: AgentCoreHookPhase;
  // matcher 命中前不应产出 hook 事件，避免 timeline 出现“被跳过”的噪音。
  shouldRun?: (context: AgentCoreHookContext) => boolean;
  run: (context: AgentCoreHookContext) => Promise<AgentCoreHookDecision | void>;
};

export type AgentCoreHookEvent = {
  type: "hook-event";
  hookName: string;
  phase: AgentCoreHookPhase;
  status: AgentCoreHookStatus;
  content?: string;
};

export type AgentCoreHookRunResult = {
  action: "continue" | "block" | "request-continue";
  reason?: string;
  failed?: boolean;
};
