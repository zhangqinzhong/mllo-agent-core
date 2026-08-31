import type { AgentCorePermissionContext } from "../permissions/agent-core-permission-types";
import type { AgentCoreRunSandboxPolicy } from "../runtime/agent-core-run-sandbox-policy";
import type { AgentCoreResumeResult } from "../session/agent-core-session-resume";
import type { AgentCoreSessionHandle } from "../session/agent-core-session-types";
import type { AgentCoreToolAvailabilityRecord } from "../tools/agent-core-tool-availability";
import type { AgentCoreToolDefinition } from "../tools/agent-core-tool-types";
import type { MlloRuntimeHomeOptions } from "../runtime-home/mllo-runtime-home-types";
import { readLatestAgentCoreWorkflowJournal } from "../tools/agent-core-workflow-journal";
import { readLatestAgentCoreShellTaskJournal } from "../tools/shell-task-journal";
import { readLatestAgentCorePlanJournal } from "../tools/agent-core-plan-journal";
import { readAgentCoreMemory } from "./agent-core-memory";
import {
  createAgentCorePromptSessionState,
  describeAgentCoreShellBackendForPrompt,
  describeAgentCoreTools,
  type AgentCoreBudgetPromptState,
  type AgentCoreModelProfile,
  type AgentCorePromptContext,
} from "./agent-core-prompt-context";
import { readAgentCoreProjectInstructions } from "./agent-core-project-instructions";
import { createAgentCorePlanPromptState } from "./agent-core-plan-prompt-state";
import { createAgentCoreShellTaskPromptState } from "./agent-core-shell-task-prompt-state";
import { createAgentCoreWorkflowPromptState } from "./agent-core-workflow-prompt-state";
import type { AgentCoreShellExecutionBackend } from "../tools/shell-execution-backend";
import { readAgentCoreMcpConfigPromptState } from "./agent-core-mcp-config-prompt-state";
import { createAgentCoreSkillsPromptState } from "../skills/agent-core-skills-prompt-state";

// 构建 prompt budget 状态。完整 compact engine 后续会覆盖 estimated/compacted 字段。
function buildBudgetPromptState(
  budget: Partial<AgentCoreBudgetPromptState> | undefined,
  resume: AgentCoreResumeResult | undefined,
): AgentCoreBudgetPromptState {
  const compactedFromSession = (resume?.compactRecords.length ?? 0) > 0;
  return {
    inputBudgetTokens: budget?.inputBudgetTokens,
    outputBudgetTokens: budget?.outputBudgetTokens,
    estimatedInputTokens: budget?.estimatedInputTokens,
    compacted: budget?.compacted ?? compactedFromSession,
  };
}

// 构建结构化 prompt context。它同时供 system snapshot、TurnContext 和 GUI 调试使用。
export async function buildAgentCorePromptContext(args: {
  cwd: string;
  shellCwd: string;
  sandboxPolicy: AgentCoreRunSandboxPolicy;
  shellExecutionBackend: AgentCoreShellExecutionBackend;
  workspaceRoots: string[];
  permissionContext: AgentCorePermissionContext;
  tools: AgentCoreToolDefinition[];
  toolAvailabilityRecords: AgentCoreToolAvailabilityRecord[];
  session:
    | {
        handle: AgentCoreSessionHandle;
      }
    | undefined;
  resume: AgentCoreResumeResult | undefined;
  runtimeHome: MlloRuntimeHomeOptions | undefined;
  skillHomeDir: string | undefined;
  shellTaskJournalPath: string;
  planJournalPath: string;
  workflowJournalPath: string;
  budget: Partial<AgentCoreBudgetPromptState> | undefined;
  modelProfile: AgentCoreModelProfile | undefined;
}): Promise<AgentCorePromptContext> {
  return {
    identity: {
      productName: "mllo",
      role: "agent-core",
    },
    generatedAt: new Date().toISOString(),
    cwd: args.cwd,
    shellCwd: args.shellCwd,
    runtime: {
      sandboxPolicy: args.sandboxPolicy,
      shellBackend: describeAgentCoreShellBackendForPrompt(args.shellExecutionBackend),
    },
    shellTasks: createAgentCoreShellTaskPromptState(
      await readLatestAgentCoreShellTaskJournal({
        journalPath: args.shellTaskJournalPath,
      }),
    ),
    workspaceRoots: args.workspaceRoots,
    permissionContext: args.permissionContext,
    tools: describeAgentCoreTools(args.tools, args.toolAvailabilityRecords),
    toolAvailability: args.toolAvailabilityRecords.map((record) => ({
      toolName: record.toolName,
      status: record.status,
      visible: record.visible,
      checkedAtMs: record.checkedAtMs,
      reason: record.reason,
      lastAvailableAtMs: record.lastAvailableAtMs,
    })),
    skills: await createAgentCoreSkillsPromptState({
      cwd: args.cwd,
      homeDir: args.skillHomeDir,
      runtimeHome: args.runtimeHome,
    }),
    mcpConfigs: await readAgentCoreMcpConfigPromptState({
      cwd: args.cwd,
    }),
    memory: await readAgentCoreMemory({
      ...args.runtimeHome,
      cwd: args.cwd,
    }),
    plan: createAgentCorePlanPromptState(
      await readLatestAgentCorePlanJournal({
        journalPath: args.planJournalPath,
      }),
    ),
    workflowRuns: createAgentCoreWorkflowPromptState(
      await readLatestAgentCoreWorkflowJournal({
        journalPath: args.workflowJournalPath,
      }),
    ),
    projectInstructions: await readAgentCoreProjectInstructions({
      cwd: args.cwd,
      workspaceRoots: args.workspaceRoots,
    }),
    session: createAgentCorePromptSessionState({
      session: args.session?.handle,
      resume: args.resume,
    }),
    budget: buildBudgetPromptState(args.budget, args.resume),
    modelProfile: args.modelProfile,
  };
}
