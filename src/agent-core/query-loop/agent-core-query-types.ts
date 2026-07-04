import type {
  AgentCoreElicitationRequest,
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolErrorKind,
  AgentCoreToolProgress,
  AgentCoreToolResult,
} from "../tools/agent-core-tool-types";
import type {
  AgentCoreWorkerId,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../workers/agent-core-worker-types";
import type { AgentCoreHookDefinition, AgentCoreHookEvent } from "../hooks/agent-core-hook-types";
import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreModelErrorCode } from "../model/agent-core-model-error-classification";
import type { AgentCoreMiddleware } from "../middleware/agent-core-middleware-types";
import type { AgentCoreToolBatchSummary } from "./agent-core-tool-batch-summary";

// Query loop 内部消息格式。它先保持模型无关，后续再由 adapter 转成具体模型协议格式。
export type AgentCoreMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: AgentCoreToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
      errorKind?: AgentCoreToolErrorKind;
      outputTruncated?: boolean;
      outputOriginalChars?: number;
      outputMaxChars?: number;
      outputBlobPath?: string;
      outputBlobBytes?: number;
    };

// 模型一次回复的标准形态。文本和 toolCalls 可以同时存在，兼容流式和工具调用输出。
export type AgentCoreModelResponse = {
  content: string;
  toolCalls?: AgentCoreToolCall[];
};

// 模型调用参数。stream 和 complete 共享它，避免 adapter 两套上下文漂移。
export type AgentCoreModelRequest = {
  systemPrompt?: string;
  messages: readonly AgentCoreMessage[];
  tools: readonly AgentCoreToolDefinition[];
  signal?: AbortSignal;
};

// 模型流式事件。text-delta 给 GUI 逐字更新，tool-call 表示模型已经请求工具。
export type AgentCoreModelStreamEvent =
  | {
      type: "text-delta";
      content: string;
    }
  | {
      type: "tool-call";
      call: AgentCoreToolCall;
    }
  | {
      type: "message-end";
    };

// 模型适配器接口。query loop 不知道底层是哪种模型或 worker。
export type AgentCoreModelAdapter =
  | {
      complete: (args: AgentCoreModelRequest) => Promise<AgentCoreModelResponse>;
      stream?: (args: AgentCoreModelRequest) => AsyncIterable<AgentCoreModelStreamEvent>;
    }
  | {
      complete?: (args: AgentCoreModelRequest) => Promise<AgentCoreModelResponse>;
      stream: (args: AgentCoreModelRequest) => AsyncIterable<AgentCoreModelStreamEvent>;
    };

export type AgentCoreToolResultBlobReference = {
  outputBlobPath: string;
  outputBlobBytes: number;
};

export type AgentCoreToolResultBlobStore = (args: {
  call: AgentCoreToolCall;
  content: string;
  originalChars: number;
}) => Promise<AgentCoreToolResultBlobReference>;

// 外部调用 query loop 时传入的配置。maxTurns 防止工具递归把 GUI 卡死。
export type AgentCoreQueryLoopArgs = {
  cwd: string;
  systemPrompt?: string;
  turnContext?: string;
  messages: readonly AgentCoreMessage[];
  model: AgentCoreModelAdapter;
  toolSummaryModel?: AgentCoreModelAdapter;
  tools?: readonly AgentCoreToolDefinition[];
  hooks?: readonly AgentCoreHookDefinition[];
  middlewares?: readonly AgentCoreMiddleware[];
  signal?: AbortSignal;
  maxTurns?: number;
  requestWorkerPermission?: (
    request: AgentCoreWorkerPermissionRequest & {
      workerId: AgentCoreWorkerId;
    },
  ) => Promise<AgentCoreWorkerPermissionDecision>;
  storeToolResultBlob?: AgentCoreToolResultBlobStore;
};

// query loop 对外发出的 timeline 事件。GUI 可以直接订阅这些事件渲染进度。
export type AgentCoreQueryEvent =
  | AgentCoreHookEvent
  | {
      type: "turn-start";
      turn: number;
    }
  | {
      type: "assistant-message";
      content: string;
    }
  | {
      type: "assistant-delta";
      content: string;
    }
  | {
      type: "tool-call";
      call: AgentCoreToolCall;
    }
  | {
      type: "tool-progress";
      call: AgentCoreToolCall;
      progress: AgentCoreToolProgress;
    }
  | {
      type: "tool-result";
      call: AgentCoreToolCall;
      result: AgentCoreToolResult;
    }
  | {
      type: "tool-batch-summary";
      turn: number;
      summary: AgentCoreToolBatchSummary;
    }
  | {
      type: "permission-required";
      call: AgentCoreToolCall;
      decision: AgentCorePermissionDecision;
    }
  | {
      type: "permission-denied";
      call: AgentCoreToolCall;
      decision: AgentCorePermissionDecision;
    }
  | {
      type: "elicitation-required";
      call: AgentCoreToolCall;
      request: AgentCoreElicitationRequest;
    }
  | {
      type: "final";
      content: string;
    }
  | {
      type: "stopped";
      reason: string;
    }
  | {
      type: "error";
      message: string;
    };

// query loop 的最终状态。事件用于展示，result 用于持久化 session/turn。
export type AgentCoreQueryLoopResult =
  | {
      status: "completed";
      messages: AgentCoreMessage[];
    }
  | {
      status: "waiting-for-permission";
      messages: AgentCoreMessage[];
      call: AgentCoreToolCall;
      decision: AgentCorePermissionDecision;
    }
  | {
      status: "waiting-for-elicitation";
      messages: AgentCoreMessage[];
      call: AgentCoreToolCall;
      request: AgentCoreElicitationRequest;
    }
  | {
      status: "denied";
      messages: AgentCoreMessage[];
      call: AgentCoreToolCall;
      decision: AgentCorePermissionDecision;
    }
  | {
      status: "stopped";
      messages: AgentCoreMessage[];
      reason: string;
    }
  | {
      status: "error";
      messages: AgentCoreMessage[];
      message: string;
      errorCode?: AgentCoreModelErrorCode;
    };
