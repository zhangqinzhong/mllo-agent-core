import type { AgentCorePromptContext } from "./agent-core-prompt-context";
import { createAgentCoreSystemPolicy } from "./agent-core-system-policy";
import type { AgentCoreSystemPolicy } from "./agent-core-system-policy";
import {
  isAgentCoreLocalCompactPromptProfile,
  type AgentCorePromptProfile,
} from "./agent-core-prompt-profile";
import {
  joinAgentCorePromptBlocks,
  MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AgentCorePromptBlock,
  type AgentCorePromptCacheScope,
} from "../query-loop/agent-core-prompt-block-types";

// 渲染列表段落。空列表显式写 none，避免模型误以为信息遗漏。
function renderList(items: readonly string[]): string {
  return items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
}

function promptBlock(args: {
  name: string;
  text: string;
  cacheScope: AgentCorePromptCacheScope;
}): AgentCorePromptBlock {
  return {
    name: args.name,
    text: args.text.trim(),
    cacheScope: args.cacheScope,
  };
}

function promptBlockName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// 渲染系统策略头。身份信息必须在最前面，方便所有 provider 缓存共同前缀。
function renderSystemPolicyHeader(policy: AgentCoreSystemPolicy): string {
  return ["# System Policy", `productName: ${policy.productName}`, `role: ${policy.role}`].join(
    "\n",
  );
}

function renderSystemPolicySection(section: AgentCoreSystemPolicy["sections"][number]): string {
  return [`## ${section.title}`, renderList(section.bullets)].join("\n");
}

// 渲染稳定策略 blocks。静态层拆成多个块，后续协议层可以精确放置缓存断点。
function renderSystemPolicyBlocks(policy: AgentCoreSystemPolicy): AgentCorePromptBlock[] {
  return [
    promptBlock({
      name: "system_policy_header",
      text: renderSystemPolicyHeader(policy),
      cacheScope: "global",
    }),
    ...policy.sections.map((section) =>
      promptBlock({
        name: `system_policy_${promptBlockName(section.title)}`,
        text: renderSystemPolicySection(section),
        cacheScope: "global",
      }),
    ),
    promptBlock({
      name: "system_prompt_dynamic_boundary",
      text: MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      cacheScope: "global",
    }),
  ];
}

// 渲染 session 级上下文。它会写入 snapshot，动态状态另由 TurnContext 每轮刷新。
function renderSessionContextBlocks(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
  },
): AgentCorePromptBlock[] {
  return [
    promptBlock({
      name: "tools",
      cacheScope: "session",
      text: ["# Tools", renderTools(context)].join("\n"),
    }),
    promptBlock({
      name: "skills",
      cacheScope: "session",
      text: ["# Skills", renderSkills(context, options.profile)].join("\n"),
    }),
    promptBlock({
      name: "mcp_configs",
      cacheScope: "session",
      text: ["# MCP Configs", renderMcpConfigs(context)].join("\n"),
    }),
    promptBlock({
      name: "memory",
      cacheScope: "session",
      text: ["# Memory", renderMemory(context)].join("\n"),
    }),
    promptBlock({
      name: "project_instructions",
      cacheScope: "session",
      text: ["# Project Instructions", renderProjectInstructions(context)].join("\n"),
    }),
  ];
}

// 渲染旧版完整 system prompt。保留给调试和旧调用点，真实请求优先使用 blocks。
function renderLegacySystemPrompt(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
  } = {},
): string {
  const policy = createAgentCoreSystemPolicy();
  return [
    renderSystemPolicyHeader(policy),
    "",
    ...policy.sections.flatMap((section) => [renderSystemPolicySection(section), ""]),
    MLLO_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    "",
    "# Runtime Context",
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
    "# Permissions",
    renderPermissionContext(context),
    "",
    "# Tools",
    renderTools(context),
    "",
    "# Skills",
    renderSkills(context, options.profile),
    "",
    "# MCP Configs",
    renderMcpConfigs(context),
    "",
    "# Session",
    renderSessionState(context),
    "",
    "# Model",
    renderModelProfile(context),
    "",
    "# Budget",
    renderBudgetState(context),
    "",
    "# Shell Tasks",
    renderShellTasks(context),
    "",
    "# Plan",
    renderPlan(context),
    "",
    "# Workflow Runs",
    renderWorkflowRuns(context),
    "",
    "# Memory",
    renderMemory(context),
    "",
    "# Project Instructions",
    renderProjectInstructions(context),
  ].join("\n");
}

// 渲染权限上下文。权限规则必须进入 system prompt，否则模型不知道哪些动作会触发确认。
function renderPermissionContext(context: AgentCorePromptContext): string {
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

// 渲染工具说明。这里只描述协议，不把实现细节暴露给模型。
function renderTools(context: AgentCorePromptContext): string {
  return renderList(
    context.tools.map((tool) => {
      const maxResult =
        tool.maxResultSizeChars === undefined
          ? "default result budget"
          : `maxResultSizeChars=${tool.maxResultSizeChars}`;
      return `${tool.name}: ${tool.description} (${tool.concurrency}, ${maxResult})`;
    }),
  );
}

// 渲染 skill 摘要。完整 instructions 通过 read_skill 按需加载，避免撑爆 system prompt。
function renderSkills(
  context: AgentCorePromptContext,
  profile: AgentCorePromptProfile | undefined,
): string {
  if (context.skills.length === 0) {
    return "- none";
  }
  if (isAgentCoreLocalCompactPromptProfile(profile)) {
    return [
      `availableSkillCount: ${context.skills.length}`,
      "Use list_skills to inspect skill summaries, then read_skill for full instructions.",
    ].join("\n");
  }
  return context.skills
    .map((skill) => {
      const lines = [
        `id: ${skill.id}`,
        `name: ${skill.name}`,
        `source: ${skill.sourceLabel}`,
        `providers: ${skill.providers.join(", ")}`,
      ];
      if (skill.description !== undefined) {
        lines.push(`description: ${skill.description}`);
      }
      lines.push("fullInstructions: use read_skill");
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染项目声明的 MCP server 摘要。这里只显示配置事实，不代表 server 已连接。
function renderMcpConfigs(context: AgentCorePromptContext): string {
  if (context.mcpConfigs.length === 0) {
    return "- none";
  }
  return context.mcpConfigs
    .map((config) => {
      const lines = [
        `source: ${config.path}`,
        `label: ${config.label}`,
        `status: ${config.status}`,
      ];
      if (config.error !== undefined) {
        lines.push(`error: ${config.error}`);
      }
      lines.push("servers:");
      if (config.servers.length === 0) {
        lines.push("- none");
      } else {
        lines.push(
          ...config.servers.map((server) => {
            const target = server.command ?? server.url ?? server.issue ?? "no target";
            return `- ${server.name}: ${server.status}, ${server.transport}, ${target}`;
          }),
        );
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染项目规则。AGENTS.md 内容原样进入独立段落，便于后续做来源展示。
function renderProjectInstructions(context: AgentCorePromptContext): string {
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

// 渲染长期记忆。memory 是 mllo runtime 状态，不属于仓库文件规则。
function renderMemory(context: AgentCorePromptContext): string {
  if (context.memory.length === 0) {
    return "- none";
  }
  return context.memory
    .map((entry) => `scope: ${entry.scope}\nsource: ${entry.path}\n${entry.content}`)
    .join("\n\n---\n\n");
}

// 渲染 session 状态。恢复修复过的 tool call 要显式告诉模型。
function renderSessionState(context: AgentCorePromptContext): string {
  if (context.session === undefined) {
    return "session: none";
  }
  return [
    `sessionId: ${context.session.sessionId}`,
    `transcriptPath: ${context.session.transcriptPath}`,
    `resumed: ${context.session.resumed ? "yes" : "no"}`,
    `omittedResumableEntries: ${context.session.omittedResumableEntries}`,
    `omittedResumableBytes: ${context.session.omittedResumableBytes}`,
    "repairedToolCallIds:",
    renderList(context.session.repairedToolCallIds),
  ].join("\n");
}

// 渲染预算状态。真正 compact engine 后续会填充 token 和 compact 信息。
function renderBudgetState(context: AgentCorePromptContext): string {
  return [
    `contextWindowTokens: ${context.budget.contextWindowTokens ?? "unset"}`,
    `inputBudgetTokens: ${context.budget.inputBudgetTokens ?? "unset"}`,
    `outputBudgetTokens: ${context.budget.outputBudgetTokens ?? "unset"}`,
    `compactThresholdTokens: ${context.budget.compactThresholdTokens ?? "unset"}`,
    `estimatedInputTokens: ${context.budget.estimatedInputTokens ?? "unset"}`,
    `compacted: ${context.budget.compacted ? "yes" : "no"}`,
  ].join("\n");
}

// 渲染模型能力。模型需要知道当前 adapter 的能力边界，避免假设一定能 tool use 或流式输出。
function renderModelProfile(context: AgentCorePromptContext): string {
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

// 渲染后台 shell 任务索引。输出内容留给 shell_tasks，避免 system prompt 变成日志仓库。
function renderShellTasks(context: AgentCorePromptContext): string {
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
        `startedAt: ${new Date(task.startedAt).toISOString()}`,
        `updatedAt: ${new Date(task.updatedAt).toISOString()}`,
      ];
      if (task.backendKind !== undefined) {
        lines.push(`backend: ${task.backendKind}`);
      }
      if (task.backendRemote !== undefined) {
        lines.push(`backendRemote: ${task.backendRemote ? "true" : "false"}`);
      }
      if (task.backendSandboxed !== undefined) {
        lines.push(`backendSandboxed: ${task.backendSandboxed ? "true" : "false"}`);
      }
      if (task.sessionId !== undefined) {
        lines.push(`sessionId: ${task.sessionId}`);
      }
      if (task.completedAt !== undefined) {
        lines.push(`completedAt: ${new Date(task.completedAt).toISOString()}`);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 渲染当前计划。plan 是主 agent 的任务板，不等同于已派发的 workflow。
function renderPlan(context: AgentCorePromptContext): string {
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

// 渲染最近 workflow 状态。恢复后模型需要知道哪些子任务已经完成或失败。
function renderWorkflowRuns(context: AgentCorePromptContext): string {
  if (context.workflowRuns.length === 0) {
    return "- none";
  }
  return context.workflowRuns
    .map((run) => {
      const lines = [
        `runId: ${run.runId}`,
        `goal: ${run.goal}`,
        `status: ${run.status}`,
        `startedAt: ${run.startedAt}`,
        `updatedAt: ${run.updatedAt}`,
      ];
      if (run.completedAt !== undefined) {
        lines.push(`completedAt: ${run.completedAt}`);
      }
      lines.push("tasks:");
      lines.push(
        ...run.tasks.map(
          (task) => `- ${task.id} [${task.agentId}]: ${task.status} updatedAt=${task.updatedAt}`,
        ),
      );
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// 把结构化 prompt context 渲染成缓存友好的 system blocks。
export function renderAgentCoreSystemPromptBlocks(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
  } = {},
): AgentCorePromptBlock[] {
  return [
    ...renderSystemPolicyBlocks(createAgentCoreSystemPolicy()),
    ...renderSessionContextBlocks(context, options),
  ];
}

// 把结构化 prompt context 渲染成 system prompt。保留字符串形式用于兼容旧 adapter 和日志。
export function renderAgentCoreSystemPrompt(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
  } = {},
): string {
  return joinAgentCorePromptBlocks(renderAgentCoreSystemPromptBlocks(context, options));
}

export function renderAgentCoreLegacySystemPrompt(
  context: AgentCorePromptContext,
  options: {
    profile?: AgentCorePromptProfile;
  } = {},
): string {
  return renderLegacySystemPrompt(context, options);
}
