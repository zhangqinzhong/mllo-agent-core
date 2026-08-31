import type { AgentCoreMessage } from "../query-loop/agent-core-query-types";

function renderToolCalls(message: Extract<AgentCoreMessage, { role: "assistant" }>): string[] {
  if (message.toolCalls === undefined || message.toolCalls.length === 0) {
    return [];
  }
  return [
    "toolCalls:",
    ...message.toolCalls.map((call) =>
      [
        `- id: ${call.id}`,
        `  name: ${call.name}`,
        `  input: ${JSON.stringify(call.input)}`,
        ...(call.inputParseStatus === undefined
          ? []
          : [
              `  inputParseStatus: ${call.inputParseStatus.status}`,
              `  rawArgumentsPreview: ${call.inputParseStatus.rawPreview}`,
            ]),
        ...(call.inputRepairStatus === undefined
          ? []
          : [
              `  inputRepairStatus: ${call.inputRepairStatus.status}`,
              `  inputRepairs: ${call.inputRepairStatus.repairs
                .map((repair) => `${repair.from}->${repair.to}`)
                .join(", ")}`,
            ]),
        ...(call.idRepairStatus === undefined
          ? []
          : [
              `  idRepairStatus: ${call.idRepairStatus.status}`,
              `  originalToolCallId: ${call.idRepairStatus.originalId}`,
            ]),
        ...(call.nameRepairStatus === undefined
          ? []
          : [
              `  nameRepairStatus: ${call.nameRepairStatus.status}`,
              `  originalToolName: ${call.nameRepairStatus.originalName}`,
              `  targetToolName: ${call.nameRepairStatus.targetName}`,
            ]),
      ].join("\n"),
    ),
  ];
}

function renderMessage(index: number, message: AgentCoreMessage): string {
  if (message.role === "assistant") {
    return [
      `## Message ${index + 1}`,
      `role: ${message.role}`,
      "content:",
      message.content,
      ...renderToolCalls(message),
    ].join("\n");
  }
  if (message.role === "tool") {
    return [
      `## Message ${index + 1}`,
      `role: ${message.role}`,
      `toolCallId: ${message.toolCallId}`,
      `name: ${message.name}`,
      `isError: ${message.isError === true ? "yes" : "no"}`,
      ...(message.errorKind === undefined ? [] : [`errorKind: ${message.errorKind}`]),
      ...(message.outputTruncated === undefined
        ? []
        : [`outputTruncated: ${message.outputTruncated ? "yes" : "no"}`]),
      ...(message.outputOriginalChars === undefined
        ? []
        : [`outputOriginalChars: ${message.outputOriginalChars}`]),
      ...(message.outputMaxChars === undefined
        ? []
        : [`outputMaxChars: ${message.outputMaxChars}`]),
      ...(message.outputBlobPath === undefined
        ? []
        : [`outputBlobPath: ${message.outputBlobPath}`]),
      ...(message.outputBlobBytes === undefined
        ? []
        : [`outputBlobBytes: ${message.outputBlobBytes}`]),
      "content:",
      message.content,
    ].join("\n");
  }
  return [`## Message ${index + 1}`, `role: ${message.role}`, "content:", message.content].join(
    "\n",
  );
}

// compact 摘要模型需要结构化 transcript，裸 JSON 会让 tool call/result 关系变难读。
export function renderAgentCoreCompactTranscript(messages: readonly AgentCoreMessage[]): string {
  if (messages.length === 0) {
    return "No messages to summarize.";
  }
  return messages.map((message, index) => renderMessage(index, message)).join("\n\n---\n\n");
}
