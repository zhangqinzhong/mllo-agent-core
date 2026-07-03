import { toJSONSchema, type ZodError, type ZodIssue, type ZodType } from "zod";
import type { AgentCoreToolInputParseStatus, AgentCoreToolResult } from "./agent-core-tool-types";

const MAX_SCHEMA_PREVIEW_CHARS = 2400;
const MAX_INPUT_PREVIEW_CHARS = 1600;
const MAX_VALIDATION_ISSUES = 12;

function issuePath(issue: ZodIssue): string {
  return issue.path.length === 0 ? "<root>" : issue.path.join(".");
}

function truncatePreview(content: string, maxChars: number): string {
  return content.length <= maxChars
    ? content
    : `${content.slice(0, maxChars)}\n[preview truncated]`;
}

function previewJson(value: unknown, maxChars: number): string {
  try {
    const encoded = JSON.stringify(value, null, 2);
    return truncatePreview(encoded === undefined ? String(value) : encoded, maxChars);
  } catch {
    return truncatePreview(String(value), maxChars);
  }
}

function renderValidationIssues(error: ZodError): string {
  const displayed = error.issues.slice(0, MAX_VALIDATION_ISSUES);
  const lines = displayed.map(
    (issue) => `- ${issuePath(issue)}: ${issue.message} (code: ${issue.code})`,
  );
  const omitted = error.issues.length - displayed.length;
  return omitted > 0
    ? [...lines, `- ... ${omitted} more issue(s) omitted`].join("\n")
    : lines.join("\n");
}

function renderExpectedJsonSchema(schema: ZodType | undefined): string | undefined {
  if (schema === undefined) {
    return undefined;
  }
  try {
    return previewJson(toJSONSchema(schema), MAX_SCHEMA_PREVIEW_CHARS);
  } catch {
    return undefined;
  }
}

export function createAgentCoreToolInputValidationResult(args: {
  toolName: string;
  error: ZodError;
  input: unknown;
  schema?: ZodType;
}): AgentCoreToolResult {
  const expectedSchema = renderExpectedJsonSchema(args.schema);
  return {
    isError: true,
    errorKind: "schema-validation",
    content: [
      `Tool input schema validation failed for ${args.toolName}.`,
      `Repair instruction: call ${args.toolName} again with corrected JSON object arguments that satisfy the expected schema.`,
      "Do not repeat the same invalid arguments.",
      "",
      "Validation issues:",
      renderValidationIssues(args.error),
      "",
      "Received arguments preview:",
      "```json",
      previewJson(args.input, MAX_INPUT_PREVIEW_CHARS),
      "```",
      ...(expectedSchema === undefined
        ? []
        : ["", "Expected JSON schema preview:", "```json", expectedSchema, "```"]),
    ].join("\n"),
  };
}

export function createAgentCoreToolMalformedArgumentsResult(args: {
  toolName: string;
  parseStatus: AgentCoreToolInputParseStatus;
}): AgentCoreToolResult | undefined {
  if (args.parseStatus.status !== "malformed-json") {
    return undefined;
  }
  return {
    isError: true,
    errorKind: "malformed-arguments",
    content: [
      `Tool arguments JSON parse failed for ${args.toolName}.`,
      `Repair instruction: call ${args.toolName} again with valid JSON object arguments.`,
      "Do not repeat the same malformed JSON.",
      "Raw arguments preview:",
      args.parseStatus.rawPreview,
    ].join("\n"),
  };
}
