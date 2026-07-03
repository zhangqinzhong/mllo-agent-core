import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreElicitationResumeDecision } from "../query-loop/agent-core-elicitation-resume";
import type { AgentCoreCompactRecord } from "../budget/agent-core-budget-types";
import type { AgentCoreHookPhase } from "../hooks/agent-core-hook-types";
import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreToolCall } from "../tools/agent-core-tool-types";
import type {
  AgentCoreWorkerEvent,
  AgentCoreWorkerId,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../workers/agent-core-worker-types";

export type AgentCoreSessionEntryKind =
  | "session-metadata"
  | "system-context-snapshot"
  | "message"
  | "timeline-event"
  | "hook-event"
  | "permission-event"
  | "worker-tool-event"
  | "worker-tool-result-event"
  | "elicitation-event"
  | "thread-state-event"
  | "thread-metadata-event"
  | "thread-edge-event"
  | "budget-event"
  | "compact-record"
  | "memory-event"
  | "checkpoint-restore-event";

export type AgentCoreSessionMetadata = {
  sessionId: string;
  cwd: string;
  workspaceRoots: string[];
  createdAt: string;
};

export type AgentCoreSystemContextSnapshot = {
  version: 1;
  reason: "session-created" | "compact";
  prompt: string;
  promptContext: unknown;
};

export type AgentCoreThreadRunStatus = "running" | AgentCoreQueryLoopResult["status"];

export type AgentCoreThreadStateSnapshot = {
  id: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  modelProvider: string;
  model?: string;
  approvalMode: string;
  sandboxPolicy: string;
  tokensUsed: number;
  resumeOmittedEntries: number;
  resumeOmittedBytes: number;
  runStatus?: AgentCoreThreadRunStatus;
  runMessage?: string;
  archived: boolean;
  preview: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type AgentCoreThreadEdgeSnapshot = {
  parentThreadId: string;
  childThreadId: string;
  status: "active" | "completed" | "cancelled";
  createdAtMs: number;
};

export type AgentCoreThreadMetadataPatch = {
  title?: string;
  archived?: boolean;
  updatedAtMs: number;
  source: "user" | "system";
};

export type AgentCoreCheckpointRestoreSnapshot = {
  checkpointId: string;
  checkpointPath: string;
  conflictStrategy: "skip" | "force";
  requestedFilePaths?: string[];
  files: {
    path: string;
    resolvedPath: string;
    action: "restored" | "deleted" | "conflict";
    reason?: string;
    restoredAt?: string;
  }[];
};

export type AgentCoreWorkerToolUseSnapshot = Omit<
  Extract<AgentCoreWorkerEvent, { type: "tool-use" }>,
  "type"
>;

export type AgentCoreWorkerToolResultSnapshot = Omit<
  Extract<AgentCoreWorkerEvent, { type: "tool-result" }>,
  "type"
>;

export type AgentCoreSessionEntry =
  | {
      kind: "session-metadata";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      metadata: AgentCoreSessionMetadata;
    }
  | {
      kind: "system-context-snapshot";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      snapshot: AgentCoreSystemContextSnapshot;
    }
  | {
      kind: "message";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      message: AgentCoreMessage;
    }
  | {
      kind: "timeline-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      event: AgentCoreQueryEvent;
    }
  | {
      kind: "hook-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      hookName: string;
      phase: AgentCoreHookPhase;
      status: "started" | "completed" | "failed";
      content?: string;
    }
  | {
      kind: "permission-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      source?: "tool";
      call: AgentCoreToolCall;
      request: AgentCorePermissionDecision;
      response:
        | {
            status: "allow";
          }
        | {
            status: "deny";
            reason: string;
          };
    }
  | {
      kind: "permission-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      source: "worker";
      workerId: AgentCoreWorkerId;
      request: AgentCoreWorkerPermissionRequest;
      response: AgentCoreWorkerPermissionDecision;
    }
  | {
      kind: "worker-tool-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      tool: AgentCoreWorkerToolUseSnapshot;
    }
  | {
      kind: "worker-tool-result-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      result: AgentCoreWorkerToolResultSnapshot;
    }
  | {
      kind: "elicitation-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      call: AgentCoreToolCall;
      request: Extract<AgentCoreQueryLoopResult, { status: "waiting-for-elicitation" }>["request"];
      response: AgentCoreElicitationResumeDecision;
    }
  | {
      kind: "thread-state-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      snapshot: AgentCoreThreadStateSnapshot;
    }
  | {
      kind: "thread-metadata-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      patch: AgentCoreThreadMetadataPatch;
    }
  | {
      kind: "thread-edge-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      edge: AgentCoreThreadEdgeSnapshot;
    }
  | {
      kind: "budget-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      inputTokens?: number;
      outputTokens?: number;
      toolResultChars?: number;
      messageCount?: number;
      compacted?: boolean;
    }
  | {
      kind: "compact-record";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      record: AgentCoreCompactRecord;
    }
  | {
      kind: "memory-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      scope: "project";
      path: string;
      compactId: string;
      summary: string;
    }
  | {
      kind: "checkpoint-restore-event";
      uuid: string;
      timestamp: string;
      sessionId: string;
      cwd: string;
      restore: AgentCoreCheckpointRestoreSnapshot;
    };

export type AgentCoreSessionStoreOptions = {
  configDir: string;
};

export type AgentCoreSessionCreateOptions = {
  sessionId?: string;
  cwd: string;
  workspaceRoots: string[];
};

export type AgentCoreSessionHandle = {
  sessionId: string;
  cwd: string;
  projectDir: string;
  transcriptPath: string;
};
