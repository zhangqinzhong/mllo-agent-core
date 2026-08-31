import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreElicitationResumeDecision } from "../query-loop/agent-core-elicitation-resume";
import type { AgentCorePermissionResumeDecision } from "../query-loop/agent-core-permission-resume";
import type {
  AgentCoreElicitationRequest,
  AgentCoreToolCall,
} from "../tools/agent-core-tool-types";

export const AGENT_CORE_INTERACTION_SCHEMA_VERSION = 1;

export type AgentCoreInteractionKind = "permission" | "elicitation";

export type AgentCoreInteractionRequest =
  | {
      kind: "permission";
      call: AgentCoreToolCall;
      decision: AgentCorePermissionDecision;
    }
  | {
      kind: "elicitation";
      call: AgentCoreToolCall;
      request: AgentCoreElicitationRequest;
    };

export type AgentCoreInteractionResolution =
  | {
      kind: "permission";
      decision: AgentCorePermissionResumeDecision;
    }
  | {
      kind: "elicitation";
      decision: AgentCoreElicitationResumeDecision;
    };

export type AgentCoreInteractionResolutionSource = "callback" | "external";

export type AgentCoreInteractionContext = {
  interactionId: string;
};

export type AgentCoreInteractionResolutionResult =
  | {
      status: "resolved" | "already-resolved";
      interaction: import("../runtime-state/mllo-interaction-records").MlloInteractionRecord;
    }
  | {
      status: "not-found";
      interactionId: string;
    }
  | {
      status: "conflict" | "invalid-resolution";
      interaction: import("../runtime-state/mllo-interaction-records").MlloInteractionRecord;
      message: string;
    };
