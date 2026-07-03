import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import type { AgentCoreMessage, AgentCoreQueryEvent } from "../query-loop/agent-core-query-types";
import type { AgentCoreToolCall } from "../tools/agent-core-tool-types";
import { isAgentCoreShellSecretLikeEnvName } from "../tools/shell-environment-policy";

const REDACTED_ENV_VALUE = "[redacted shell environment value]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretNamesFromRisk(decision: AgentCorePermissionDecision | undefined): Set<string> {
  return new Set(
    decision?.risk?.kind === "remote-secret-env"
      ? decision.risk.names.map((name) => name.toUpperCase())
      : [],
  );
}

function shouldRedactEnvName(args: {
  name: string;
  decision?: AgentCorePermissionDecision;
}): boolean {
  return (
    isAgentCoreShellSecretLikeEnvName(args.name) ||
    secretNamesFromRisk(args.decision).has(args.name.toUpperCase())
  );
}

function redactShellCommandInput(args: {
  input: Record<string, unknown>;
  decision?: AgentCorePermissionDecision;
}): Record<string, unknown> {
  const env = args.input.env;
  if (!isRecord(env)) {
    return args.input;
  }
  const redactedEnv = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      shouldRedactEnvName({
        name,
        decision: args.decision,
      })
        ? REDACTED_ENV_VALUE
        : value,
    ]),
  );
  return {
    ...args.input,
    env: redactedEnv,
  };
}

// permission 审计/UI 不能保存 env secret 值；执行层仍使用原始 tool call。
export function redactAgentCorePermissionCallInput(args: {
  call: AgentCoreToolCall;
  decision: AgentCorePermissionDecision;
}): AgentCoreToolCall {
  return redactAgentCoreToolCallInput({
    call: args.call,
    decision: args.decision,
  });
}

export function redactAgentCoreToolCallInput(args: {
  call: AgentCoreToolCall;
  decision?: AgentCorePermissionDecision;
}): AgentCoreToolCall {
  if (args.call.name !== "shell_command" || !isRecord(args.call.input)) {
    return args.call;
  }
  return {
    ...args.call,
    input: redactShellCommandInput({
      input: args.call.input,
      decision: args.decision,
    }),
  };
}

export function redactAgentCorePermissionEventInput<T extends { call: AgentCoreToolCall }>(args: {
  event: T;
  decision: AgentCorePermissionDecision;
}): T {
  return {
    ...args.event,
    call: redactAgentCorePermissionCallInput({
      call: args.event.call,
      decision: args.decision,
    }),
  };
}

export function redactAgentCoreEventInput(event: AgentCoreQueryEvent): AgentCoreQueryEvent {
  switch (event.type) {
    case "tool-call":
      return {
        ...event,
        call: redactAgentCoreToolCallInput({
          call: event.call,
        }),
      };
    case "tool-result":
      return {
        ...event,
        call: redactAgentCoreToolCallInput({
          call: event.call,
        }),
      };
    case "permission-required":
    case "permission-denied":
      return redactAgentCorePermissionEventInput({
        event,
        decision: event.decision,
      });
    default:
      return event;
  }
}

export function redactAgentCoreMessageInput(message: AgentCoreMessage): AgentCoreMessage {
  if (message.role !== "assistant" || message.toolCalls === undefined) {
    return message;
  }
  return {
    ...message,
    toolCalls: message.toolCalls.map((call) =>
      redactAgentCoreToolCallInput({
        call,
      }),
    ),
  };
}
