import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";
import type {
  AgentCoreToolCall,
  AgentCoreToolDefinition,
  AgentCoreToolInputRepairStatus,
  AgentCoreToolInputParseStatus,
} from "../tools/agent-core-tool-types";
import { toJSONSchema } from "zod";

export type AgentCoreJsonObject = Record<string, unknown>;

export type AgentCoreWireToolSchema = {
  name: string;
  description: string;
  parameters: AgentCoreJsonObject;
};

const EMPTY_TOOL_SCHEMA: AgentCoreJsonObject = {
  type: "object",
  properties: {},
};
const RAW_ARGUMENTS_PREVIEW_CHARS = 1000;
const PATH_BASED_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
  "multi_edit",
  "glob_files",
  "grep_files",
]);

function asAgentCoreJsonObject(value: unknown): AgentCoreJsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AgentCoreJsonObject)
    : undefined;
}

function removeJsonSchemaDialect(schema: AgentCoreJsonObject): AgentCoreJsonObject {
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}

function repairAgentCoreToolInputAliases(args: { toolName: string; input: unknown }): {
  input: unknown;
  repairStatus?: AgentCoreToolInputRepairStatus;
} {
  const inputObject = asAgentCoreJsonObject(args.input);
  if (
    inputObject === undefined ||
    !PATH_BASED_TOOL_NAMES.has(args.toolName) ||
    !("file_path" in inputObject) ||
    "path" in inputObject
  ) {
    return {
      input: args.input,
    };
  }

  const { file_path: filePath, ...rest } = inputObject;
  return {
    input: {
      ...rest,
      path: filePath,
    },
    repairStatus: {
      status: "parameter-alias-renamed",
      repairs: [
        {
          from: "file_path",
          to: "path",
        },
      ],
    },
  };
}

function toAgentCoreToolParameters(tool: AgentCoreToolDefinition): AgentCoreJsonObject {
  if (tool.inputSchema === undefined) {
    return EMPTY_TOOL_SCHEMA;
  }
  try {
    const schema = asAgentCoreJsonObject(toJSONSchema(tool.inputSchema));
    // 兼容端点只需要 parameters/input_schema 本体，顶层 $schema 反而可能触发严格校验失败。
    return schema === undefined ? EMPTY_TOOL_SCHEMA : removeJsonSchemaDialect(schema);
  } catch {
    return EMPTY_TOOL_SCHEMA;
  }
}

// 模型 wire schema 必须来自真实 inputSchema；空 schema 只作为兼容回退。
export function toAgentCoreWireToolSchema(tool: AgentCoreToolDefinition): AgentCoreWireToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toAgentCoreToolParameters(tool),
  };
}

// 将模型返回的 JSON 字符串转成工具输入。失败时保留原文，方便模型下一轮自修正。
export function parseAgentCoreToolArguments(raw: unknown): unknown {
  return parseAgentCoreToolArgumentsWithStatus(raw).input;
}

export function parseAgentCoreToolArgumentsWithStatus(raw: unknown): {
  input: unknown;
  parseStatus?: AgentCoreToolInputParseStatus;
} {
  if (typeof raw !== "string") {
    return {
      input: raw ?? {},
    };
  }
  if (raw.trim().length === 0) {
    return {
      input: {},
    };
  }
  try {
    return {
      input: JSON.parse(raw),
    };
  } catch {
    const repaired = repairTruncatedAgentCoreToolArguments(raw);
    return repaired === undefined
      ? {
          input: raw,
          parseStatus: {
            status: "malformed-json",
            rawPreview: previewRawToolArguments(raw),
          },
        }
      : {
          input: repaired,
          parseStatus: {
            status: "repaired-truncated-json",
            rawPreview: previewRawToolArguments(raw),
          },
        };
  }
}

function previewRawToolArguments(raw: string): string {
  return raw.length <= RAW_ARGUMENTS_PREVIEW_CHARS
    ? raw
    : `${raw.slice(0, RAW_ARGUMENTS_PREVIEW_CHARS)}\n[raw arguments truncated]`;
}

// 流式 JSON 偶尔在最后一个分片被截断；这里只补齐闭合符，不猜字段和值。
function repairTruncatedAgentCoreToolArguments(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  const completion = getTruncatedJsonCompletion(trimmed);
  if (completion === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(completion);
  } catch {
    return undefined;
  }
}

function getTruncatedJsonCompletion(input: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) {
        return undefined;
      }
    }
  }
  if (escaped) {
    return undefined;
  }
  let completion = input;
  if (!inString) {
    completion = completion.replace(/,\s*$/, "");
  }
  return `${completion}${inString ? '"' : ""}${stack.reverse().join("")}`;
}

// 将 Agent Core 工具输入转成 wire JSON 字符串。协议层只负责传输，不解释工具语义。
export function stringifyAgentCoreToolInput(input: unknown): string {
  if (input === undefined) {
    return "{}";
  }
  return JSON.stringify(input);
}

export function stringifyAgentCoreToolCallInput(call: AgentCoreToolCall): string {
  if (call.inputParseStatus?.status === "malformed-json") {
    // 历史消息必须能被协议端点接受，坏 JSON 原文放在 tool_result 里给模型修复。
    return "{}";
  }
  return stringifyAgentCoreToolInput(call.input);
}

// 修复发送到模型前的 tool pairing。中断恢复时不能把未回答的 tool_call 直接发给协议端点。
export function normalizeAgentCoreMessagesForWire(
  messages: readonly AgentCoreMessage[],
): AgentCoreMessage[] {
  const normalized: AgentCoreMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    normalized.push(message);
    if (message.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0) {
      continue;
    }

    const following = messages.slice(index + 1);
    const answered = new Set(
      following
        .filter((candidate) => candidate.role === "tool")
        .map((candidate) => candidate.toolCallId),
    );
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id)) {
        normalized.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "[no result: the previous turn was interrupted before this tool call completed]",
          isError: true,
          errorKind: "interrupted-tool-call",
        });
      }
    }
  }
  return normalized;
}

// 生成缺失 tool call id。部分 OpenAI 兼容端点可能只按 index 流/返工具调用。
export function createFallbackToolCallId(index: number): string {
  return `call_${index}`;
}

export type AgentCoreToolCallIdState = {
  counts: Map<string, number>;
};

export function createAgentCoreToolCallIdState(): AgentCoreToolCallIdState {
  return {
    counts: new Map(),
  };
}

// 同一轮重复 tool id 会让 tool_result 归属错乱；保留首个 id，后续加稳定后缀。
export function ensureAgentCoreToolCallUniqueId(
  call: AgentCoreToolCall,
  state: AgentCoreToolCallIdState,
): AgentCoreToolCall {
  const count = state.counts.get(call.id) ?? 0;
  state.counts.set(call.id, count + 1);
  if (count === 0) {
    return call;
  }
  const occurrence = count + 1;
  return {
    ...call,
    id: `${call.id}_${occurrence}`,
    idRepairStatus: {
      status: "duplicate-id-renamed",
      originalId: call.idRepairStatus?.originalId ?? call.id,
      occurrence,
    },
  };
}

export function ensureAgentCoreToolCallsUniqueIds(
  calls: readonly AgentCoreToolCall[],
): AgentCoreToolCall[] {
  const state = createAgentCoreToolCallIdState();
  return calls.map((call) => ensureAgentCoreToolCallUniqueId(call, state));
}

// 组装 Agent Core 工具调用。各协议 adapter 只需要提供 name/arguments/id。
export function createAgentCoreToolCall(args: {
  id: string | undefined;
  index: number;
  name: string;
  arguments: unknown;
}): AgentCoreToolCall {
  const parsed = parseAgentCoreToolArgumentsWithStatus(args.arguments);
  const repaired = repairAgentCoreToolInputAliases({
    toolName: args.name,
    input: parsed.input,
  });
  return {
    id: args.id && args.id.length > 0 ? args.id : createFallbackToolCallId(args.index),
    name: args.name,
    input: repaired.input,
    ...(parsed.parseStatus === undefined ? {} : { inputParseStatus: parsed.parseStatus }),
    ...(repaired.repairStatus === undefined ? {} : { inputRepairStatus: repaired.repairStatus }),
  };
}
