import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreHookEvent } from "../hooks/agent-core-hook-types";
import type { ZodType } from "zod";
import type {
  AgentCoreWorkerEvent,
  AgentCoreWorkerId,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../workers/agent-core-worker-types";
import type { AgentCoreShellCwdChange } from "./shell-cwd-tracker";

export type AgentCoreWorkflowEvent = {
  taskId: string;
  agentId: string;
  status: "running" | "done" | "failed" | "skipped";
  text?: string;
};

export type AgentCoreFileChangeProgress = {
  path: string;
  replacementCount: number;
  beforeLines: number;
  afterLines: number;
  addedLines: number;
  removedLines: number;
  diffPreview: string;
  diffPreviewTruncated: boolean;
};

export type AgentCoreElicitationRequest = {
  question: string;
  context?: string;
  options?: string[];
  allowFreeform: boolean;
};

export type AgentCoreToolErrorKind =
  | "schema-validation"
  | "malformed-arguments"
  | "unknown-tool"
  | "duplicate-call"
  | "repeated-failure"
  | "runtime-exception"
  | "permission-denied"
  | "tool-error"
  | "cancelled-sibling"
  | "interrupted-tool-call";

export type AgentCoreToolInputParseStatus =
  | {
      status: "repaired-truncated-json";
      rawPreview: string;
    }
  | {
      status: "malformed-json";
      rawPreview: string;
    };

export type AgentCoreToolCallIdRepairStatus = {
  status: "duplicate-id-renamed";
  originalId: string;
  occurrence: number;
};

export type AgentCoreToolInputRepairStatus = {
  status: "parameter-alias-renamed";
  repairs: {
    from: string;
    to: string;
  }[];
};

// Agent Core 暴露给模型的工具调用。id 用来把结果稳定地回灌给模型。
export type AgentCoreToolCall = {
  id: string;
  name: string;
  input: unknown;
  inputParseStatus?: AgentCoreToolInputParseStatus;
  // 只记录确定安全的参数别名修复；schema 不兼容的输入仍交给 validation 失败闭环。
  inputRepairStatus?: AgentCoreToolInputRepairStatus;
  // 兼容端点偶尔复用 tool id；运行时必须改成唯一 id，同时保留原始 id 方便审计。
  idRepairStatus?: AgentCoreToolCallIdRepairStatus;
};

export type AgentCoreToolProgress =
  | {
      kind: "shell-output";
      stream: "stdout" | "stderr";
      chunk: string;
      fullOutput: string;
      elapsedMs: number;
      totalBytes: number;
      taskId?: string;
    }
  | {
      kind: "shell-backgrounded";
      taskId: string;
      outputPath: string;
      elapsedMs: number;
    }
  | {
      kind: "worker-event";
      event: AgentCoreWorkerEvent;
    }
  | {
      kind: "workflow-event";
      event: AgentCoreWorkflowEvent;
    }
  | {
      kind: "file-change";
      change: AgentCoreFileChangeProgress;
    }
  | {
      kind: "cwd-change";
      change: AgentCoreShellCwdChange;
    };

// 工具运行时上下文。permissionDecision 让工具层不用重复做权限判断。
export type AgentCoreToolRunContext = {
  cwd: string;
  permissionDecision?: AgentCorePermissionDecision;
  signal?: AbortSignal;
  onProgress?: (progress: AgentCoreToolProgress) => void;
  requestWorkerPermission?: (
    request: AgentCoreWorkerPermissionRequest & {
      workerId: AgentCoreWorkerId;
    },
  ) => Promise<AgentCoreWorkerPermissionDecision>;
};

// 工具执行成功或失败后的统一结果。失败也回灌给模型，由循环决定是否继续。
export type AgentCoreToolResult = {
  content: string;
  isError?: boolean;
  errorKind?: AgentCoreToolErrorKind;
  outputTruncated?: boolean;
  outputOriginalChars?: number;
  outputMaxChars?: number;
  outputBlobPath?: string;
  outputBlobBytes?: number;
  elicitation?: AgentCoreElicitationRequest;
};

export type AgentCoreToolAvailabilityCheckResult = {
  available: boolean;
  reason?: string;
};

export type AgentCoreToolAvailabilityPolicy = {
  cacheKey?: string;
  ttlMs?: number;
  failureGraceMs?: number;
  check?: () =>
    | AgentCoreToolAvailabilityCheckResult
    | Promise<AgentCoreToolAvailabilityCheckResult>;
};

// 单个工具的定义。权限检查是可选的，但有副作用的工具必须提供。
export type AgentCoreToolDefinition = {
  name: string;
  description: string;
  inputSchema?: ZodType;
  maxResultSizeChars?: number;
  availability?: AgentCoreToolAvailabilityPolicy;
  evaluatePermission?: (input: unknown) => AgentCorePermissionDecision;
  isConcurrencySafe?: (input: unknown) => boolean;
  cancelSiblingToolsOnError?: (input: unknown) => boolean;
  run: (input: unknown, context: AgentCoreToolRunContext) => Promise<AgentCoreToolResult>;
};

// 工具执行入口返回的状态。permission-required 用来把 GUI 确认接进来。
export type AgentCoreToolExecutionResult =
  | {
      status: "ok";
      result: AgentCoreToolResult;
    }
  | {
      status: "permission-required";
      decision: AgentCorePermissionDecision;
    }
  | {
      status: "permission-denied";
      decision: AgentCorePermissionDecision;
    }
  | {
      status: "not-found";
      message: string;
    };

// 工具编排层的更新事件。query loop 用它渲染 timeline，并决定是否继续下一轮模型。
export type AgentCoreToolOrchestrationUpdate =
  | AgentCoreHookEvent
  | {
      type: "tool-start";
      call: AgentCoreToolCall;
    }
  | {
      type: "tool-progress";
      call: AgentCoreToolCall;
      progress: AgentCoreToolProgress;
    }
  | {
      type: "tool-complete";
      call: AgentCoreToolCall;
      execution: AgentCoreToolExecutionResult;
    };
