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

function readOpenAIToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  const directName = record?.name;
  if (typeof directName === "string" && directName.length > 0) {
    return directName;
  }
  const fn = asRecord(record?.function);
  const functionName = fn?.name;
  return typeof functionName === "string" && functionName.length > 0 ? functionName : undefined;
}

function countResponsesInput(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  return Array.isArray(input) ? input.length : 1;
}

export function summarizeOpenAIRequest(args: {
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
  const inputCount = countResponsesInput(record?.input);
  const toolNames = uniqueStrings(tools.flatMap((tool) => readOpenAIToolName(tool) ?? []));
  const model = record?.model;
  return {
    method: args.method,
    pathname: args.pathname,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof record?.stream === "boolean" ? { stream: record.stream } : {}),
    ...(messages.length > 0 ? { messageCount: messages.length } : {}),
    ...(inputCount === undefined ? {} : { messageCount: inputCount }),
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

export function summarizeOpenAIResponse(args: {
  statusCode?: number;
  contentType?: string;
  body: Buffer;
  captureBodies?: boolean;
  redactSecrets?: boolean;
  truncatedBody?: boolean;
}): MlloExternalTraceResponseSummary {
  const text = args.body.toString("utf8");
  const isSse = args.contentType?.includes("text/event-stream") === true;
  const summary = isSse ? summarizeOpenAISse(text) : summarizeOpenAIJson(text);
  return {
    ...(args.statusCode === undefined ? {} : { statusCode: args.statusCode }),
    ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
    ...summary,
    bodyBytes: args.body.byteLength,
    ...(args.captureBodies
      ? {
          bodyText: String(
            redactMlloObserverValue(text, {
              redactSecrets: args.redactSecrets,
            }),
          ),
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

function summarizeOpenAIJson(text: string): Partial<MlloExternalTraceResponseSummary> {
  const parsed = asRecord(parseJsonText(text));
  if (parsed === undefined) {
    return {};
  }
  const usage = parsed.usage ?? asRecord(parsed.response)?.usage;
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const finishReasons = uniqueStrings(
    choices.flatMap((choice) => {
      const reason = asRecord(choice)?.finish_reason;
      return typeof reason === "string" ? reason : [];
    }),
  );
  const chatToolNames = choices.flatMap((choice) => {
    const message = asRecord(asRecord(choice)?.message);
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return toolCalls.flatMap((toolCall) => readOpenAIToolName(toolCall) ?? []);
  });
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const responseToolNames = output.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === "function_call" ? (readOpenAIToolName(record) ?? []) : [];
  });
  const toolUseNames = uniqueStrings([...chatToolNames, ...responseToolNames]);
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(finishReasons === undefined ? {} : { stopReason: finishReasons.join(",") }),
    ...(toolUseNames === undefined ? {} : { toolUseNames }),
  };
}

function summarizeOpenAISse(text: string): Partial<MlloExternalTraceResponseSummary> {
  const eventTypes: string[] = [];
  const finishReasons: string[] = [];
  const toolUseNames: string[] = [];
  let usage: unknown;
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
    if (event.usage !== undefined) {
      usage = event.usage;
    }
    const response = asRecord(event.response);
    if (response?.usage !== undefined) {
      usage = response.usage;
    }
    const item = asRecord(event.item);
    if (item?.type === "function_call") {
      const name = readOpenAIToolName(item);
      if (name !== undefined) {
        toolUseNames.push(name);
      }
    }
    collectOpenAIChoiceDelta(event, finishReasons, toolUseNames);
  }
  return {
    ...(uniqueStrings(eventTypes) === undefined ? {} : { eventTypes: uniqueStrings(eventTypes) }),
    ...(usage === undefined ? {} : { usage }),
    ...(uniqueStrings(finishReasons) === undefined
      ? {}
      : { stopReason: uniqueStrings(finishReasons)?.join(",") }),
    ...(uniqueStrings(toolUseNames) === undefined
      ? {}
      : { toolUseNames: uniqueStrings(toolUseNames) }),
  };
}

function collectOpenAIChoiceDelta(
  event: Record<string, unknown>,
  finishReasons: string[],
  toolUseNames: string[],
): void {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    const finishReason = choiceRecord?.finish_reason;
    if (typeof finishReason === "string") {
      finishReasons.push(finishReason);
    }
    const delta = asRecord(choiceRecord?.delta);
    const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const toolCall of toolCalls) {
      const name = readOpenAIToolName(toolCall);
      if (name !== undefined) {
        toolUseNames.push(name);
      }
    }
  }
}
