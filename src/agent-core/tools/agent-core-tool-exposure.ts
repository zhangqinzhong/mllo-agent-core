import { z } from "zod";
import type { AgentCorePermissionDecision } from "../permissions/agent-core-permission-types";
import { createAgentCoreToolInputValidationResult } from "./agent-core-tool-input-validation";
import type {
  AgentCoreToolDefinition,
  AgentCoreToolResult,
  AgentCoreToolRunContext,
} from "./agent-core-tool-types";

export type AgentCoreToolExposureMode = "direct" | "deferred";

const DEFERRED_TOOL_NAMES = new Set([
  "glob_files",
  "grep_files",
  "read_skill",
  "call_mcp_tool",
  "shell_cancel",
  "run_agent_workflow",
]);

const searchDeferredToolsInputSchema = z.object({
  query: z.string().optional(),
});

const callDeferredToolInputSchema = z.object({
  name: z.string().min(1),
  input: z.unknown().optional(),
});

function normalizeSearchText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function scoreTool(queryTokens: readonly string[], tool: AgentCoreToolDefinition): number {
  if (queryTokens.length === 0) {
    return 1;
  }
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  return queryTokens.filter((token) => haystack.includes(token)).length;
}

function findDeferredTool(
  tools: readonly AgentCoreToolDefinition[],
  name: string,
): AgentCoreToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

function renderDeferredTool(tool: AgentCoreToolDefinition): string {
  return [`name: ${tool.name}`, `description: ${tool.description}`].join("\n");
}

function createSearchDeferredToolsTool(
  deferredTools: readonly AgentCoreToolDefinition[],
): AgentCoreToolDefinition {
  return {
    name: "search_deferred_tools",
    description: [
      "Search less frequently used tools by intent before calling them.",
      "Use this when the direct tool list does not expose a capability such as grep/glob, reading full skills, MCP calls, workflow execution, or shell task cancellation.",
    ].join(" "),
    inputSchema: searchDeferredToolsInputSchema,
    isConcurrencySafe: () => true,
    run: async (input) => {
      const parsed = searchDeferredToolsInputSchema.safeParse(input);
      const query = parsed.success ? (parsed.data.query ?? "") : "";
      const queryTokens = normalizeSearchText(query);
      const matches = deferredTools
        .map((tool) => ({
          tool,
          score: scoreTool(queryTokens, tool),
        }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.tool.name.localeCompare(right.tool.name),
        )
        .slice(0, 8);
      const listed =
        matches.length === 0 ? deferredTools.slice(0, 8) : matches.map((match) => match.tool);
      return {
        content: [
          "Deferred tools:",
          listed.map(renderDeferredTool).join("\n\n"),
          "",
          "Call one with call_deferred_tool using { name, input }.",
        ].join("\n"),
      };
    },
  };
}

function evaluateDeferredPermission(args: {
  deferredTools: readonly AgentCoreToolDefinition[];
  input: unknown;
}): AgentCorePermissionDecision {
  const parsed = callDeferredToolInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return {
      status: "allow",
      capability: "file-read",
      reason: "Invalid call_deferred_tool input will be returned as schema feedback.",
    };
  }
  const tool = findDeferredTool(args.deferredTools, parsed.data.name);
  return (
    tool?.evaluatePermission?.(parsed.data.input ?? {}) ?? {
      status: "allow",
      capability: "file-read",
      reason: "Deferred tool has no additional permission gate.",
    }
  );
}

async function runDeferredTool(args: {
  deferredTools: readonly AgentCoreToolDefinition[];
  input: unknown;
  context: AgentCoreToolRunContext;
}): Promise<AgentCoreToolResult> {
  const parsed = callDeferredToolInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return createAgentCoreToolInputValidationResult({
      toolName: "call_deferred_tool",
      error: parsed.error,
      input: args.input,
      schema: callDeferredToolInputSchema,
    });
  }
  const tool = findDeferredTool(args.deferredTools, parsed.data.name);
  if (tool === undefined) {
    return {
      content: `Deferred tool is not available: ${parsed.data.name}. Use search_deferred_tools first.`,
      isError: true,
      errorKind: "unknown-tool",
    };
  }
  const toolInput = parsed.data.input ?? {};
  const validation = tool.inputSchema?.safeParse(toolInput);
  if (validation !== undefined && !validation.success) {
    return createAgentCoreToolInputValidationResult({
      toolName: tool.name,
      error: validation.error,
      input: toolInput,
      schema: tool.inputSchema,
    });
  }
  return await tool.run(toolInput, args.context);
}

function createCallDeferredToolTool(
  deferredTools: readonly AgentCoreToolDefinition[],
): AgentCoreToolDefinition {
  return {
    name: "call_deferred_tool",
    description: [
      "Execute one tool returned by search_deferred_tools.",
      "Use exact name and arguments for the deferred tool.",
    ].join(" "),
    inputSchema: callDeferredToolInputSchema,
    maxResultSizeChars: Math.max(0, ...deferredTools.map((tool) => tool.maxResultSizeChars ?? 0)),
    evaluatePermission: (input) =>
      evaluateDeferredPermission({
        deferredTools,
        input,
      }),
    isConcurrencySafe: (input) => {
      const parsed = callDeferredToolInputSchema.safeParse(input);
      const tool = parsed.success ? findDeferredTool(deferredTools, parsed.data.name) : undefined;
      return tool?.isConcurrencySafe?.(parsed.success ? (parsed.data.input ?? {}) : {}) ?? false;
    },
    cancelSiblingToolsOnError: (input) => {
      const parsed = callDeferredToolInputSchema.safeParse(input);
      const tool = parsed.success ? findDeferredTool(deferredTools, parsed.data.name) : undefined;
      return (
        tool?.cancelSiblingToolsOnError?.(parsed.success ? (parsed.data.input ?? {}) : {}) ?? false
      );
    },
    run: async (input, context) =>
      await runDeferredTool({
        deferredTools,
        input,
        context,
      }),
  };
}

export function applyAgentCoreToolExposure(args: {
  mode: AgentCoreToolExposureMode;
  tools: readonly AgentCoreToolDefinition[];
}): AgentCoreToolDefinition[] {
  if (args.mode === "direct") {
    return [...args.tools];
  }
  const directTools = args.tools.filter((tool) => !DEFERRED_TOOL_NAMES.has(tool.name));
  const deferredTools = args.tools.filter((tool) => DEFERRED_TOOL_NAMES.has(tool.name));
  if (deferredTools.length === 0) {
    return directTools;
  }
  return [
    ...directTools,
    createSearchDeferredToolsTool(deferredTools),
    createCallDeferredToolTool(deferredTools),
  ];
}
