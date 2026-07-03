import type {
  AgentCoreWorkerEvent,
  AgentCoreWorkerPermissionRequest,
} from "../../agent-core/workers/agent-core-worker-types";

export type CodexCliJsonRecord = Record<string, unknown>;

export type CodexCliMappedToolEvent = {
  event: AgentCoreWorkerEvent;
  invocationId: string;
};

export type CodexCliMappedToolResultEvent = {
  event: AgentCoreWorkerEvent;
  clearsActiveShell: boolean;
};

function isCodexCliJsonRecord(value: unknown): value is CodexCliJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Codex exec stdout 是 JSONL；坏行忽略，避免一个脏事件中断整个 worker。
export function parseCodexCliJsonLine(line: string): CodexCliJsonRecord | null {
  try {
    const value = JSON.parse(line);
    return isCodexCliJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// 兼容 Codex CLI 不同版本的消息字段，让 mllo timeline 能持续显示文本增量。
export function codexCliRecordText(record: CodexCliJsonRecord): string | undefined {
  if (record.type === "agent_message" || record.type === "agent_message_delta") {
    return stringValue(record.message) ?? stringValue(record.delta);
  }
  if (record.type === "message" && (record.role === undefined || record.role === "assistant")) {
    return stringValue(record.content) ?? stringValue(record.text);
  }
  if (record.type === "assistant_message") {
    return stringValue(record.content) ?? stringValue(record.message);
  }
  return undefined;
}

function recordInvocationId(record: CodexCliJsonRecord): string | undefined {
  return (
    stringValue(record.tool_use_id) ??
    stringValue(record.toolUseId) ??
    stringValue(record.tool_call_id) ??
    stringValue(record.toolCallId) ??
    stringValue(record.call_id) ??
    stringValue(record.callId) ??
    stringValue(record.id)
  );
}

// 老版本 JSONL 不一定带 tool id；本地生成 id，避免 use/result 只能靠时间猜配对。
function codexToolUseInvocationId(record: CodexCliJsonRecord, sequence: number): string {
  return recordInvocationId(record) ?? `codex-cli-tool-${sequence}`;
}

export function codexCliRecordToolEvent(
  record: CodexCliJsonRecord,
  sequence: number,
): CodexCliMappedToolEvent | null {
  if (record.type === "exec_command_begin") {
    const invocationId = codexToolUseInvocationId(record, sequence);
    return {
      invocationId,
      event: {
        type: "tool-use",
        workerId: "codex-cli",
        invocationId,
        name: "shell_command",
        input: {
          command: record.command,
        },
      },
    };
  }
  if (record.type === "tool_call" && typeof record.name === "string") {
    const invocationId = codexToolUseInvocationId(record, sequence);
    return {
      invocationId,
      event: {
        type: "tool-use",
        workerId: "codex-cli",
        invocationId,
        name: record.name,
        input: record.input ?? {},
      },
    };
  }
  return null;
}

function commandExitCode(record: CodexCliJsonRecord): number | undefined {
  return (
    numberValue(record.exit_code) ??
    numberValue(record.exitCode) ??
    numberValue(record.code) ??
    numberValue(record.status_code)
  );
}

function commandDurationMs(record: CodexCliJsonRecord): number | undefined {
  return numberValue(record.duration_ms) ?? numberValue(record.durationMs);
}

function commandOutput(record: CodexCliJsonRecord): CodexCliJsonRecord {
  const exitCode = commandExitCode(record);
  return {
    command: record.command,
    stdout: record.stdout,
    stderr: record.stderr,
    exitCode,
    durationMs: commandDurationMs(record),
  };
}

export function codexCliRecordToolResultEvent(
  record: CodexCliJsonRecord,
  activeShellInvocationId: string | undefined,
): CodexCliMappedToolResultEvent | null {
  if (
    record.type === "exec_command_end" ||
    record.type === "exec_command_finish" ||
    record.type === "exec_command_done"
  ) {
    const exitCode = commandExitCode(record);
    const invocationId = recordInvocationId(record) ?? activeShellInvocationId;
    return {
      clearsActiveShell: true,
      event: {
        type: "tool-result",
        workerId: "codex-cli",
        ...(invocationId === undefined ? {} : { invocationId }),
        name: "shell_command",
        output: commandOutput(record),
        isError: exitCode !== undefined && exitCode !== 0,
      },
    };
  }
  if (
    record.type === "tool_result" ||
    record.type === "tool_call_result" ||
    record.type === "function_call_output" ||
    record.type === "custom_tool_call_output"
  ) {
    const invocationId = recordInvocationId(record);
    return {
      clearsActiveShell: false,
      event: {
        type: "tool-result",
        workerId: "codex-cli",
        ...(invocationId === undefined ? {} : { invocationId }),
        name: stringValue(record.name) ?? stringValue(record.tool) ?? "tool",
        output: record.output ?? record.result ?? record.content ?? record,
        isError: record.is_error === true || record.isError === true,
      },
    };
  }
  return null;
}

// 按 Codex 工具事件推断权限类型。未知工具只展示 timeline，不做阻塞。
export function codexCliRecordPermissionRequest(
  record: CodexCliJsonRecord,
  sequence: number,
): AgentCoreWorkerPermissionRequest | null {
  if (record.type === "exec_command_begin") {
    return {
      requestId: `codex-cli-exec-${sequence}`,
      toolName: "shell_command",
      capability: "shell-write",
      reason: "Codex CLI started a shell command inside the delegated task.",
      input: {
        command: record.command,
      },
    };
  }
  if (record.type !== "tool_call" || typeof record.name !== "string") {
    return null;
  }
  const name = record.name.toLowerCase();
  if (name.includes("write") || name.includes("edit") || name.includes("patch")) {
    return {
      requestId: `codex-cli-tool-${sequence}`,
      toolName: record.name,
      capability: "file-write",
      reason: `Codex CLI requested file mutation tool ${record.name}.`,
      input: record.input ?? {},
    };
  }
  if (name.includes("shell") || name.includes("exec") || name.includes("bash")) {
    return {
      requestId: `codex-cli-tool-${sequence}`,
      toolName: record.name,
      capability: "shell-write",
      reason: `Codex CLI requested shell tool ${record.name}.`,
      input: record.input ?? {},
    };
  }
  if (name.includes("web") || name.includes("fetch") || name.includes("search")) {
    return {
      requestId: `codex-cli-tool-${sequence}`,
      toolName: record.name,
      capability: "network",
      reason: `Codex CLI requested network tool ${record.name}.`,
      input: record.input ?? {},
    };
  }
  return null;
}
