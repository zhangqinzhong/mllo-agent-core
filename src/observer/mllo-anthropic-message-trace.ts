import { redactMlloObserverValue } from "./mllo-observer-redaction";
import type {
  MlloExternalTraceRequestSummary,
  MlloExternalTraceResponseSummary,
} from "./mllo-external-trace-types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countSystemBlocks(system: unknown): number | undefined {
  if (system === undefined) {
    return undefined;
  }
  return Array.isArray(system) ? system.length : 1;
}

function readToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  const name = record?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function readToolUseNameFromEvent(event: Record<string, unknown>): string | undefined {
  const contentBlock = asRecord(event.content_block);
  if (contentBlock?.type !== "tool_use") {
    return undefined;
  }
  const name = contentBlock.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function parseJsonText(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: readonly string[]): string[] | undefined {
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique : undefined;
}

export function summarizeAnthropicMessageRequest(args: {
  method: string;
  pathname: string;
  body: Buffer;
  captureBodies?: boolean;
  redactSecrets?: boolean;
}): MlloExternalTraceRequestSummary {
  const parsed = parseJsonText(args.body.toString("utf8"));
  const record = asRecord(parsed);
  const tools = Array.isArray(record?.tools) ? record.tools : [];
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const toolNames = uniqueStrings(tools.flatMap((tool) => readToolName(tool) ?? []));
  const model = record?.model;
  return {
    method: args.method,
    pathname: args.pathname,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof record?.stream === "boolean" ? { stream: record.stream } : {}),
    messageCount: messages.length,
    ...(countSystemBlocks(record?.system) === undefined
      ? {}
      : { systemBlockCount: countSystemBlocks(record?.system) }),
    toolCount: tools.length,
    ...(toolNames === undefined ? {} : { toolNames }),
    bodyBytes: args.body.byteLength,
    ...(args.captureBodies
      ? {
          body: redactMlloObserverValue(parsed ?? args.body.toString("utf8"), {
            redactSecrets: args.redactSecrets,
          }),
        }
      : {}),
  };
}

export function summarizeAnthropicMessageResponse(args: {
  statusCode?: number;
  contentType?: string;
  body: Buffer;
  captureBodies?: boolean;
  redactSecrets?: boolean;
  truncatedBody?: boolean;
}): MlloExternalTraceResponseSummary {
  const text = args.body.toString("utf8");
  const isSse = args.contentType?.includes("text/event-stream") === true;
  const summary = isSse ? summarizeAnthropicSse(text) : summarizeAnthropicJson(text);
  return {
    ...(args.statusCode === undefined ? {} : { statusCode: args.statusCode }),
    ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
    ...summary,
    bodyBytes: args.body.byteLength,
    ...(args.captureBodies
      ? {
          bodyText: redactBodyText(text, args.redactSecrets),
          ...(isSse
            ? {}
            : {
                body: redactMlloObserverValue(parseJsonText(text) ?? text, {
                  redactSecrets: args.redactSecrets,
                }),
              }),
        }
      : {}),
    ...(args.truncatedBody ? { truncatedBody: true } : {}),
  };
}

function redactBodyText(text: string, redactSecrets?: boolean): string {
  return String(
    redactMlloObserverValue(text, {
      redactSecrets,
    }),
  );
}

function summarizeAnthropicJson(text: string): Partial<MlloExternalTraceResponseSummary> {
  const parsed = asRecord(parseJsonText(text));
  if (parsed === undefined) {
    return {};
  }
  const usage = parsed.usage;
  const stopReason = parsed.stop_reason;
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  const toolUseNames = uniqueStrings(
    content.flatMap((item) => {
      const block = asRecord(item);
      return block?.type === "tool_use" ? (readToolName(block) ?? []) : [];
    }),
  );
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(typeof stopReason === "string" ? { stopReason } : {}),
    ...(toolUseNames === undefined ? {} : { toolUseNames }),
  };
}

function summarizeAnthropicSse(text: string): Partial<MlloExternalTraceResponseSummary> {
  const eventTypes: string[] = [];
  const toolUseNames: string[] = [];
  let usage: unknown;
  let stopReason: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") {
      continue;
    }
    const event = asRecord(parseJsonText(data));
    if (event === undefined) {
      continue;
    }
    if (typeof event.type === "string") {
      eventTypes.push(event.type);
    }
    const message = asRecord(event.message);
    if (message?.usage !== undefined) {
      usage = message.usage;
    }
    const delta = asRecord(event.delta);
    if (delta?.stop_reason !== undefined && typeof delta.stop_reason === "string") {
      stopReason = delta.stop_reason;
    }
    const toolUseName = readToolUseNameFromEvent(event);
    if (toolUseName !== undefined) {
      toolUseNames.push(toolUseName);
    }
  }
  return {
    ...(uniqueStrings(eventTypes) === undefined ? {} : { eventTypes: uniqueStrings(eventTypes) }),
    ...(usage === undefined ? {} : { usage }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(uniqueStrings(toolUseNames) === undefined
      ? {}
      : { toolUseNames: uniqueStrings(toolUseNames) }),
  };
}
