import type {
  AgentCoreWorkerEvent,
  AgentCoreWorkerPermissionDecision,
  AgentCoreWorkerPermissionRequest,
} from "../../agent-core/workers/agent-core-worker-types";
import {
  codexCliRecordPermissionRequest,
  codexCliRecordText,
  codexCliRecordToolEvent,
  codexCliRecordToolResultEvent,
  parseCodexCliJsonLine,
} from "./codex-cli-jsonl-record-events";

type CodexCliJsonlProgress = {
  allowed: boolean;
  permissionSequence: number;
  toolInvocationSequence: number;
  activeShellInvocationId?: string;
};

async function handleJsonLine(args: {
  line: string;
  parts: string[];
  onEvent?: (event: AgentCoreWorkerEvent) => void;
  permissionSequence: number;
  toolInvocationSequence: number;
  activeShellInvocationId?: string;
  onPermissionRequest?: (
    request: AgentCoreWorkerPermissionRequest,
  ) => Promise<AgentCoreWorkerPermissionDecision>;
}): Promise<CodexCliJsonlProgress> {
  const record = parseCodexCliJsonLine(args.line);
  if (record === null) {
    return {
      allowed: true,
      permissionSequence: args.permissionSequence,
      toolInvocationSequence: args.toolInvocationSequence,
      ...(args.activeShellInvocationId === undefined
        ? {}
        : { activeShellInvocationId: args.activeShellInvocationId }),
    };
  }
  let toolInvocationSequence = args.toolInvocationSequence;
  let activeShellInvocationId = args.activeShellInvocationId;
  const text = codexCliRecordText(record);
  if (text !== undefined) {
    args.parts.push(text);
    args.onEvent?.({
      type: "assistant-delta",
      workerId: "codex-cli",
      content: text,
    });
  }
  const toolEvent = codexCliRecordToolEvent(record, toolInvocationSequence + 1);
  if (toolEvent !== null) {
    toolInvocationSequence += 1;
    if (record.type === "exec_command_begin") {
      activeShellInvocationId = toolEvent.invocationId;
    }
    args.onEvent?.(toolEvent.event);
  }
  const toolResultEvent = codexCliRecordToolResultEvent(record, activeShellInvocationId);
  if (toolResultEvent !== null) {
    if (toolResultEvent.clearsActiveShell) {
      activeShellInvocationId = undefined;
    }
    args.onEvent?.(toolResultEvent.event);
  }
  const permissionSequence =
    toolEvent === null ? args.permissionSequence : args.permissionSequence + 1;
  const permissionRequest = codexCliRecordPermissionRequest(record, permissionSequence);
  if (permissionRequest === null) {
    return {
      allowed: true,
      permissionSequence,
      toolInvocationSequence,
      ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
    };
  }
  const decision = (await args.onPermissionRequest?.(permissionRequest)) ?? {
    status: "deny",
    reason: "Codex CLI worker needs mllo permission bridge before internal tool use.",
  };
  args.onEvent?.({
    type: "permission-decision",
    workerId: "codex-cli",
    requestId: permissionRequest.requestId,
    status: decision.status,
    reason:
      decision.status === "allow" ? "Allowed by mllo worker permission bridge." : decision.reason,
  });
  return {
    allowed: decision.status === "allow",
    permissionSequence,
    toolInvocationSequence,
    ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
  };
}

// stdout 可能按任意 chunk 切开，所以保留未完成行，等下一块数据拼起来再解析。
export async function consumeCodexCliJsonLines(args: {
  chunk: Buffer;
  buffer: string;
  parts: string[];
  onEvent?: (event: AgentCoreWorkerEvent) => void;
  permissionSequence: number;
  toolInvocationSequence: number;
  activeShellInvocationId?: string;
  onPermissionRequest?: (
    request: AgentCoreWorkerPermissionRequest,
  ) => Promise<AgentCoreWorkerPermissionDecision>;
}): Promise<CodexCliJsonlProgress & { buffer: string }> {
  const content = args.buffer + args.chunk.toString("utf8");
  const lines = content.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? "";
  let allowed = true;
  let permissionSequence = args.permissionSequence;
  let toolInvocationSequence = args.toolInvocationSequence;
  let activeShellInvocationId = args.activeShellInvocationId;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const result = await handleJsonLine({
        line,
        parts: args.parts,
        onEvent: args.onEvent,
        permissionSequence,
        toolInvocationSequence,
        ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
        onPermissionRequest: args.onPermissionRequest,
      });
      permissionSequence = result.permissionSequence;
      toolInvocationSequence = result.toolInvocationSequence;
      activeShellInvocationId = result.activeShellInvocationId;
      allowed = allowed && result.allowed;
    }
  }
  return {
    allowed,
    buffer: nextBuffer,
    permissionSequence,
    toolInvocationSequence,
    ...(activeShellInvocationId === undefined ? {} : { activeShellInvocationId }),
  };
}

// 进程退出时补处理最后一行，避免没有换行符的最终消息丢失。
export async function finishCodexCliBufferedJsonLine(args: {
  buffer: string;
  parts: string[];
  onEvent?: (event: AgentCoreWorkerEvent) => void;
  permissionSequence: number;
  toolInvocationSequence: number;
  activeShellInvocationId?: string;
  onPermissionRequest?: (
    request: AgentCoreWorkerPermissionRequest,
  ) => Promise<AgentCoreWorkerPermissionDecision>;
}): Promise<CodexCliJsonlProgress> {
  const line = args.buffer.trim();
  if (line.length === 0) {
    return {
      allowed: true,
      permissionSequence: args.permissionSequence,
      toolInvocationSequence: args.toolInvocationSequence,
      ...(args.activeShellInvocationId === undefined
        ? {}
        : { activeShellInvocationId: args.activeShellInvocationId }),
    };
  }
  return await handleJsonLine({
    line,
    parts: args.parts,
    onEvent: args.onEvent,
    permissionSequence: args.permissionSequence,
    toolInvocationSequence: args.toolInvocationSequence,
    ...(args.activeShellInvocationId === undefined
      ? {}
      : { activeShellInvocationId: args.activeShellInvocationId }),
    onPermissionRequest: args.onPermissionRequest,
  });
}
