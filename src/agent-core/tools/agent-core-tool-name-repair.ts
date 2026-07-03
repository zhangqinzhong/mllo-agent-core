import type { AgentCoreToolCall, AgentCoreToolDefinition } from "./agent-core-tool-types";

const MAX_CLOSEST_TOOL_SUGGESTIONS = 3;

const TOOL_NAME_ALIASES: ReadonlyArray<{
  alias: string;
  target: string;
}> = [
  {
    alias: "read",
    target: "read_file",
  },
  {
    alias: "ls",
    target: "list_dir",
  },
  {
    alias: "list",
    target: "list_dir",
  },
  {
    alias: "write",
    target: "write_file",
  },
  {
    alias: "edit",
    target: "edit_file",
  },
  {
    alias: "grep",
    target: "grep_files",
  },
  {
    alias: "glob",
    target: "glob_files",
  },
  {
    alias: "bash",
    target: "shell_command",
  },
  {
    alias: "shell",
    target: "shell_command",
  },
  {
    alias: "plan",
    target: "update_plan",
  },
  {
    alias: "ask",
    target: "ask_user",
  },
  {
    alias: "agent",
    target: "delegate_agent",
  },
  {
    alias: "task",
    target: "delegate_agent",
  },
];

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const insertCost = (previous[rightIndex - 1] ?? 0) + 1;
      const deleteCost = above + 1;
      const replaceCost = diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      previous[rightIndex] = Math.min(insertCost, deleteCost, replaceCost);
      diagonal = above;
    }
  }
  return previous[right.length] ?? left.length;
}

function registeredToolNames(tools: readonly AgentCoreToolDefinition[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

function aliasSuggestion(args: {
  requestedName: string;
  registeredNames: readonly string[];
}): string | undefined {
  const normalizedRequestedName = normalizeToolName(args.requestedName);
  const registered = new Set(args.registeredNames);
  return TOOL_NAME_ALIASES.find(
    (item) =>
      normalizeToolName(item.alias) === normalizedRequestedName && registered.has(item.target),
  )?.target;
}

export function repairAgentCoreToolCallNameAlias(args: {
  call: AgentCoreToolCall;
  tools: readonly AgentCoreToolDefinition[];
}): AgentCoreToolCall {
  const names = registeredToolNames(args.tools);
  if (names.includes(args.call.name)) {
    return args.call;
  }
  const alias = aliasSuggestion({
    requestedName: args.call.name,
    registeredNames: names,
  });
  if (alias === undefined) {
    return args.call;
  }
  return {
    ...args.call,
    name: alias,
    nameRepairStatus: {
      status: "tool-alias-renamed",
      originalName: args.call.nameRepairStatus?.originalName ?? args.call.name,
      targetName: alias,
    },
  };
}

function closestToolSuggestions(args: {
  requestedName: string;
  registeredNames: readonly string[];
}): string[] {
  const normalizedRequestedName = normalizeToolName(args.requestedName);
  if (normalizedRequestedName.length === 0) {
    return [];
  }
  return args.registeredNames
    .map((name) => ({
      name,
      distance: levenshteinDistance(normalizedRequestedName, normalizeToolName(name)),
    }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(normalizedRequestedName.length / 3)))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, MAX_CLOSEST_TOOL_SUGGESTIONS)
    .map((item) => item.name);
}

export function registeredAgentCoreToolNamesText(
  tools: readonly AgentCoreToolDefinition[],
): string {
  const names = registeredToolNames(tools);
  return names.length === 0 ? "(none)" : names.join(", ");
}

export function createAgentCoreUnknownToolMessage(args: {
  requestedName: string;
  tools: readonly AgentCoreToolDefinition[];
}): string {
  const names = registeredToolNames(args.tools);
  const alias = aliasSuggestion({
    requestedName: args.requestedName,
    registeredNames: names,
  });
  const closest = closestToolSuggestions({
    requestedName: args.requestedName,
    registeredNames: names,
  }).filter((name) => name !== alias);

  return [
    `Tool is not registered: ${args.requestedName}`,
    `Registered tools: ${names.length === 0 ? "(none)" : names.join(", ")}`,
    "Repair instruction: call one registered tool by exact name, or explain the blocker if no registered tool matches.",
    ...(alias === undefined
      ? []
      : [`Alias suggestion: use ${alias} instead of ${args.requestedName}.`]),
    ...(closest.length === 0 ? [] : [`Closest registered tools: ${closest.join(", ")}`]),
  ].join("\n");
}
