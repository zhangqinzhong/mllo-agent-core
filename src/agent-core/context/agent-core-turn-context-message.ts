import type { AgentCorePromptContext } from "./agent-core-prompt-context";
import {
  isAgentCoreLocalCompactPromptProfile,
  type AgentCorePromptProfile,
} from "./agent-core-prompt-profile";

export type AgentCoreTurnContextBaselineMode = "omit-current-baseline" | "include-baseline-refresh";

// 渲染普通列表。TurnContext 里空集合也要显式写 none，避免模型误判为遗漏。
function renderList(items: readonly string[]): string {
  return items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
}

// 渲染 session 状态。本段是每轮冻结视图，不是可恢复对话历史。
function renderTurnSession(context: AgentCorePromptContext): string {
  if (context.session === undefined) {
    return "session: none";
  }
  return [
    `sessionId: ${context.session.sessionId}`,
    `resumed: ${context.session.resumed ? "yes" : "no"}`,
    `omittedResumableEntries: ${context.session.omittedResumableEntries}`,
    `omittedResumableBytes: ${context.session.omittedResumableBytes}`,
  ].join("\n");
}

// 渲染当前权限边界。system snapshot 可能是旧的，模型每轮必须看到最新权限状态。
function renderTurnPermissions(context: AgentCorePromptContext): string {
  const shellRules = context.permissionContext.shellRules ?? [];
  return [
    `mode: ${context.permissionContext.mode}`,
    `cwd: ${context.permissionContext.cwd}`,
    "workspaceRoots:",
    renderList(context.permissionContext.workspaceRoots),
    "deniedPaths:",
    renderList(context.permissionContext.deniedPaths ?? []),
    "shellRules:",
    renderList(shellRules.map((rule) => `${rule.action} ${rule.match}: ${rule.command}`)),
  ].join("\n");
}

// 渲染当前工具集。schema 才是事实，本段只给模型一个人类可读索引。
function renderTurnTools(context: AgentCorePromptContext): string {
  return renderList(
    context.tools.map((tool) => {
      const maxResult =
        tool.maxResultSizeChars === undefined
          ? "default result budget"
          : `maxResultSizeChars=${tool.maxResultSizeChars}`;
      return `${tool.name}: ${tool.concurrency}, ${maxResult}`;
    }),
  );
}

// 渲染全部工具探测状态。隐藏工具也要说明原因，方便模型理解为什么 schema 中缺失。
function renderTurnToolAvailability(context: AgentCorePromptContext): string {
  const unavailableRecords = context.toolAvailability.filter(
    (record) => record.status !== "available" || !record.visible,
  );
  if (unavailableRecords.length === 0) {
    return "- none";
  }
  return unavailableRecords
    .map((record) =>
      [
        `tool: ${record.toolName}`,
        `status: ${record.status}`,
        `visible: ${record.visible ? "yes" : "no"}`,
        `checkedAtMs: ${record.checkedAtMs}`,
        ...(record.lastAvailableAtMs === undefined
          ? []
          : [`lastAvailableAtMs: ${record.lastAvailableAtMs}`]),
        ...(record.reason === undefined ? [] : [`reason: ${record.reason}`]),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

// 渲染当前 skill 摘要。只有复用旧 system snapshot 时才作为基线刷新发送。
function renderTurnSkills(
  context: AgentCorePromptContext,
  profile: AgentCorePromptProfile | undefined,
): string {
  if (context.skills.length === 0) {
    return "- none";
  }
  if (isAgentCoreLocalCompactPromptProfile(profile)) {
    return [
      `availableSkillCount: ${context.skills.length}`,
      "Use list_skills when this turn needs a skill.",
    ].join("\n");
  }
  return context.skills
    .map((skill) => {
      const lines = [`id: ${skill.id}`, `name: ${skill.name}`, `source: ${skill.sourceLabel}`];
      if (skill.description !== undefined) {
        lines.push(`description: ${skill.description}`);
      }
      lines.push("fullInstructions: use read_skill");
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染当前 MCP 配置摘要。真实可调用工具仍以本轮 schema 为准。
function renderTurnMcpConfigs(context: AgentCorePromptContext): string {
  if (context.mcpConfigs.length === 0) {
    return "- none";
  }
  return context.mcpConfigs
    .map((config) => {
      const lines = [`source: ${config.path}`, `status: ${config.status}`];
      if (config.error !== undefined) {
        lines.push(`error: ${config.error}`);
      }
      lines.push("servers:");
      lines.push(
        ...(config.servers.length === 0
          ? ["- none"]
          : config.servers.map((server) => {
              const target = server.command ?? server.url ?? server.issue ?? "no target";
              return `- ${server.name}: ${server.status}, ${server.transport}, ${target}`;
            })),
      );
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染后台 shell 任务概要。完整输出仍通过 shell_tasks 工具读取。
function renderTurnShellTasks(context: AgentCorePromptContext): string {
  if (context.shellTasks.length === 0) {
    return "- none";
  }
  return context.shellTasks
    .map((task) => {
      const lines = [
        `taskId: ${task.taskId}`,
        `status: ${task.status}`,
        `command: ${task.command}`,
        `cwd: ${task.cwd}`,
        `outputPath: ${task.outputPath}`,
      ];
      if (task.backendKind !== undefined) {
        lines.push(`backend: ${task.backendKind}`);
      }
      if (task.sessionId !== undefined) {
        lines.push(`sessionId: ${task.sessionId}`);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染当前计划。turn context 必须反映最新 plan，而不是旧 system snapshot。
function renderTurnPlan(context: AgentCorePromptContext): string {
  if (context.plan === undefined) {
    return "- none";
  }
  const lines = [`updatedAt: ${context.plan.updatedAt}`];
  if (context.plan.explanation !== undefined) {
    lines.push(`explanation: ${context.plan.explanation}`);
  }
  lines.push("items:");
  lines.push(
    ...context.plan.items.map((item) => {
      const activeForm =
        item.activeForm === undefined || item.activeForm.length === 0
          ? ""
          : ` (active: ${item.activeForm})`;
      return `- ${item.status}: ${item.step}${activeForm}`;
    }),
  );
  return lines.join("\n");
}

// 渲染 workflow 状态概要。子任务详情留给 workflow 工具和 JSONL 审计。
function renderTurnWorkflowRuns(context: AgentCorePromptContext): string {
  if (context.workflowRuns.length === 0) {
    return "- none";
  }
  return context.workflowRuns
    .map((run) =>
      [
        `runId: ${run.runId}`,
        `goal: ${run.goal}`,
        `status: ${run.status}`,
        "tasks:",
        ...run.tasks.map((task) => `- ${task.id} [${task.agentId}]: ${task.status}`),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

// 渲染当前预算状态。compact 后的估算和标记属于本轮，而不是旧 system prompt。
function renderTurnBudget(context: AgentCorePromptContext): string {
  return [
    `inputBudgetTokens: ${context.budget.inputBudgetTokens ?? "unset"}`,
    `outputBudgetTokens: ${context.budget.outputBudgetTokens ?? "unset"}`,
    `estimatedInputTokens: ${context.budget.estimatedInputTokens ?? "unset"}`,
    `compacted: ${context.budget.compacted ? "yes" : "no"}`,
  ].join("\n");
}

// 渲染当前模型能力。不同 adapter 能力不同，本段必须随每轮请求刷新。
function renderTurnModelProfile(context: AgentCorePromptContext): string {
  if (context.modelProfile === undefined) {
    return "model: unknown";
  }
  return [
    `provider: ${context.modelProfile.provider}`,
    `model: ${context.modelProfile.model}`,
    `supportsStreaming: ${context.modelProfile.supportsStreaming ? "yes" : "no"}`,
    `supportsToolUse: ${context.modelProfile.supportsToolUse ? "yes" : "no"}`,
  ].join("\n");
}

// 渲染当前 memory。只有旧 snapshot 恢复时才需要在 turn context 里刷新。
function renderTurnMemory(context: AgentCorePromptContext): string {
  if (context.memory.length === 0) {
    return "- none";
  }
  return context.memory
    .map((entry) => `scope: ${entry.scope}\nsource: ${entry.path}\n${entry.content}`)
    .join("\n\n---\n\n");
}

// 渲染当前项目规则。旧 snapshot 恢复时用它暴露 AGENTS.md 变化。
function renderTurnProjectInstructions(context: AgentCorePromptContext): string {
  if (context.projectInstructions.length === 0) {
    return "- none";
  }
  return context.projectInstructions
    .map((instruction) =>
      [
        `source: ${instruction.path}`,
        `sourceType: ${instruction.source}`,
        `bytes: ${instruction.includedBytes}/${instruction.originalBytes}`,
        `truncated: ${instruction.truncated ? "yes" : "no"}`,
        instruction.content,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function renderBaselineRefreshSections(
  context: AgentCorePromptContext,
  profile: AgentCorePromptProfile | undefined,
): string[] {
  return [
    "",
    "# Tools",
    renderTurnTools(context),
    "",
    "# Skills",
    renderTurnSkills(context, profile),
    "",
    "# MCP Configs",
    renderTurnMcpConfigs(context),
    "",
    "# Memory",
    renderTurnMemory(context),
    "",
    "# Project Instructions",
    renderTurnProjectInstructions(context),
  ];
}

// 构造本轮模型请求的动态上下文。它不写入 transcript，避免污染可恢复对话历史。
export function renderAgentCoreTurnContextMessage(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
    baselineMode?: AgentCoreTurnContextBaselineMode;
  } = {},
): string {
  const baselineMode = options.baselineMode ?? "include-baseline-refresh";
  const baselineRefreshSections =
    baselineMode === "include-baseline-refresh"
      ? renderBaselineRefreshSections(context, options.profile)
      : [];
  return [
    "<mllo_turn_context>",
    "This is the current runtime context for this model request. It is not historical conversation.",
    "",
    "# Current Turn",
    `generatedAt: ${context.generatedAt}`,
    `cwd: ${context.cwd}`,
    `shellCwd: ${context.shellCwd}`,
    `sandboxPolicy: ${context.runtime.sandboxPolicy}`,
    `shellBackendKind: ${context.runtime.shellBackend.kind}`,
    `shellBackendLabel: ${context.runtime.shellBackend.label ?? "unset"}`,
    `shellBackendRemote: ${context.runtime.shellBackend.remote ? "yes" : "no"}`,
    `shellBackendSandboxed: ${context.runtime.shellBackend.sandboxed ? "yes" : "no"}`,
    `shellBackendCwdTrackingMode: ${context.runtime.shellBackend.cwdTrackingMode ?? "unset"}`,
    `shellBackendAllowedRemoteSecretLikeEnvNames: ${context.runtime.shellBackend.allowedRemoteSecretLikeEnvNames.join(", ") || "none"}`,
    "",
    "# Session",
    renderTurnSession(context),
    "",
    "# Permissions",
    renderTurnPermissions(context),
    "",
    "# Tool Availability",
    renderTurnToolAvailability(context),
    "",
    "# Model",
    renderTurnModelProfile(context),
    "",
    "# Budget",
    renderTurnBudget(context),
    "",
    "# Shell Tasks",
    renderTurnShellTasks(context),
    "",
    "# Plan",
    renderTurnPlan(context),
    "",
    "# Workflow Runs",
    renderTurnWorkflowRuns(context),
    ...baselineRefreshSections,
    "</mllo_turn_context>",
  ].join("\n");
}
