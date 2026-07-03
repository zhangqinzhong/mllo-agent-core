import { createAgentCoreSessionRuntimePaths } from "../context/agent-core-session-runtime-paths";
import { recordAgentCoreSystemContextSnapshot } from "../context/agent-core-system-context-snapshot";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../query-loop/agent-core-query-types";
import { runAgentCoreQueryLoop } from "../query-loop/agent-core-query-loop";
import { appendAgentCoreInputHistoryEntry } from "../session/agent-core-input-history";
import { applyAgentCoreRunBudgetWithHookRecording } from "./agent-core-run-budget-hook-recording";
import { resumeAgentCoreRunElicitation } from "./agent-core-run-elicitation";
import { resumeAgentCoreRunPermission } from "./agent-core-run-permission";
import { prepareRunSession } from "./agent-core-run-session";
import { createAgentCoreWorkerPermissionRequester } from "./agent-core-worker-permission-requester";
import {
  createAgentCoreReactiveCompactFailureMessage,
  createAgentCoreReactiveCompactBudget,
  renderAgentCoreRunSystemPrompt,
  shouldRunAgentCoreReactiveCompact,
  shouldStopAfterAgentCoreReactiveCompact,
} from "./agent-core-reactive-compact";
import {
  recordAgentCoreRunEvent,
  recordAgentCoreRunMessagesFrom,
} from "./agent-core-run-recording";
import { syncAndRecordAgentCoreThreadState } from "./agent-core-run-thread-state-recording";
import type {
  AgentCoreRunControllerOptions,
  AgentCoreRunControllerResult,
} from "./agent-core-run-controller-types";
import {
  loadAgentCoreRunConfig,
  loadAgentCoreRunHooks,
  loadAgentCoreRunModelProvider,
} from "./agent-core-run-controller-config";
import { createAgentCoreRunModelAdapter } from "./agent-core-run-model-adapter";
import { getAgentCoreRunSandboxPolicy } from "./agent-core-run-sandbox-policy";
import {
  closeAgentCoreRunMcpClients,
  resolveAgentCoreRunMcpClients,
  type AgentCoreRunMcpClients,
} from "./agent-core-run-mcp-clients";
import {
  getAgentCoreRunResumeOmittedBytes,
  getAgentCoreRunResumeOmittedEntries,
  normalizeAgentCoreRunCwd,
  normalizeAgentCoreRunWorkspaceRoots,
  persistedAgentCoreRunResumeMessageCount,
} from "./agent-core-run-context-metadata";
import { buildAgentCoreRunContext } from "./agent-core-run-build-context";
// 运行一次 Agent Core 对话。它串起 provider、context、tools、session 和 query loop。
export async function* runAgentCoreController(
  options: AgentCoreRunControllerOptions,
): AsyncGenerator<AgentCoreQueryEvent, AgentCoreRunControllerResult> {
  const cwd = normalizeAgentCoreRunCwd(options.cwd);
  const workspaceRoots = normalizeAgentCoreRunWorkspaceRoots(cwd, options.workspaceRoots);
  const session = await prepareRunSession({
    cwd,
    workspaceRoots,
    session: options.session,
  });
  let mcpClientResolution: AgentCoreRunMcpClients = {
    clients: [],
    ownedClients: [],
  };
  try {
    await appendAgentCoreInputHistoryEntry({
      configDir: options.session.configDir,
      sessionId: session.handle.sessionId,
      cwd: session.handle.cwd,
      input: options.input,
    });
    const loadedConfig = await loadAgentCoreRunConfig(options);
    const provider = loadAgentCoreRunModelProvider(options, loadedConfig);
    const runtimeHome = {
      homePath: options.session.configDir,
    };
    const runtimePaths = createAgentCoreSessionRuntimePaths({
      cwd,
      sessionHandle: session.handle,
      runtimeHome,
    });
    const hooks = loadAgentCoreRunHooks({
      config: loadedConfig,
      hooks: options.hooks,
      runtime: {
        runtimeDir: runtimePaths.runtimeDir,
        sessionId: session.handle.sessionId,
      },
    });
    const model = createAgentCoreRunModelAdapter({
      provider,
      session,
      fetchImpl: options.fetchImpl,
    });
    mcpClientResolution = await resolveAgentCoreRunMcpClients({
      cwd,
      config: loadedConfig,
      configPath: options.configPath,
      clients: options.mcpClients,
    });
    const context = await buildAgentCoreRunContext({
      cwd,
      workspaceRoots,
      options,
      loadedConfig,
      provider,
      model,
      mcpClients: mcpClientResolution.clients,
      runtimeHome,
      sessionStore: session.store,
      sessionHandle: session.handle,
    });
    const budgetRun = await applyAgentCoreRunBudgetWithHookRecording({
      messages: context.queryArgs.messages,
      model,
      session,
      budget: options.budget,
      hooks,
      signal: options.signal,
      workers: options.workers ?? [],
    });
    for (const event of budgetRun.hookEvents) {
      yield event;
    }
    const budgeted = budgetRun.budgeted;
    const sandboxPolicy = getAgentCoreRunSandboxPolicy({
      permissionMode: options.permissionMode,
      shellExecutionBackend: options.shellExecutionBackend,
    });
    let budgetState = budgeted.budgetState;
    let messages: readonly AgentCoreMessage[] = budgeted.messages;
    // 先落盘已接受的用户输入；即使模型请求前被 stop，也能从 transcript resume。
    let persistedMessageCount = await recordAgentCoreRunMessagesFrom({
      session,
      messages,
      startIndex: budgetState.compacted
        ? 0
        : persistedAgentCoreRunResumeMessageCount(context.resume),
    });
    const syncThreadState = async (result?: AgentCoreQueryLoopResult): Promise<void> => {
      await syncAndRecordAgentCoreThreadState({
        session,
        input: options.input,
        provider,
        permissionMode: context.permissionContext.mode,
        sandboxPolicy,
        estimatedInputTokens: budgetState.estimatedInputTokens,
        resumeOmittedEntries: getAgentCoreRunResumeOmittedEntries(context.resume),
        resumeOmittedBytes: getAgentCoreRunResumeOmittedBytes(context.resume),
        result,
      });
    };
    await syncThreadState();
    let systemPrompt = context.systemPrompt;
    if (budgeted.compacted) {
      systemPrompt = renderAgentCoreRunSystemPrompt({
        promptContext: context.promptContext,
        promptProfile: context.promptProfile,
        budgetState,
        budgetOptions: options.budget,
      });
      await recordAgentCoreSystemContextSnapshot({
        session,
        prompt: systemPrompt,
        promptContext: context.promptContext,
        reason: "compact",
      });
    }
    const requestWorkerPermission = createAgentCoreWorkerPermissionRequester({
      session,
      onRequest: options.onWorkerPermissionRequest,
    });
    let reactiveCompactRetried = false;
    while (true) {
      const generator = runAgentCoreQueryLoop({
        ...context.queryArgs,
        systemPrompt,
        messages,
        hooks,
        requestWorkerPermission,
      });
      let result: AgentCoreQueryLoopResult;
      while (true) {
        const item = await generator.next();
        if (item.done === true) {
          result = item.value;
          break;
        }
        const recordedEvent = await recordAgentCoreRunEvent({
          session,
          event: item.value,
          workers: options.workers ?? [],
        });
        yield recordedEvent;
      }
      if (
        shouldRunAgentCoreReactiveCompact({
          result,
          alreadyRetried: reactiveCompactRetried,
        })
      ) {
        const compactRun = await applyAgentCoreRunBudgetWithHookRecording({
          messages: result.messages,
          model,
          session,
          budget: createAgentCoreReactiveCompactBudget(options.budget),
          hooks,
          signal: options.signal,
          workers: options.workers ?? [],
        });
        for (const event of compactRun.hookEvents) {
          yield event;
        }
        const compacted = compactRun.budgeted;
        reactiveCompactRetried = true;
        budgetState = compacted.budgetState;
        messages = compacted.messages;
        if (budgetState.compacted) {
          persistedMessageCount = 0;
        }
        systemPrompt = renderAgentCoreRunSystemPrompt({
          promptContext: context.promptContext,
          promptProfile: context.promptProfile,
          budgetState,
          budgetOptions: options.budget,
        });
        await recordAgentCoreSystemContextSnapshot({
          session,
          prompt: systemPrompt,
          promptContext: context.promptContext,
          reason: "compact",
        });
        continue;
      }
      if (
        result.status === "error" &&
        shouldStopAfterAgentCoreReactiveCompact({
          result,
          alreadyRetried: reactiveCompactRetried,
        })
      ) {
        const message = createAgentCoreReactiveCompactFailureMessage(result.message);
        const event: AgentCoreQueryEvent = {
          type: "error",
          message,
        };
        const recordedEvent = await recordAgentCoreRunEvent({
          session,
          event,
          workers: options.workers ?? [],
        });
        yield recordedEvent;
        result = {
          ...result,
          message,
        };
      }
      persistedMessageCount = await recordAgentCoreRunMessagesFrom({
        session,
        messages: result.messages,
        startIndex: persistedMessageCount,
      });
      if (
        result.status === "waiting-for-elicitation" &&
        options.onElicitationRequest !== undefined
      ) {
        await syncThreadState(result);
        messages = yield* resumeAgentCoreRunElicitation({
          session,
          result,
          hooks,
          onElicitationRequest: options.onElicitationRequest,
          timeoutMs: options.elicitationTimeoutMs,
          signal: options.signal,
          workers: options.workers ?? [],
        });
        continue;
      }
      if (result.status !== "waiting-for-permission" || options.onPermissionRequest === undefined) {
        await syncThreadState(result);
        return {
          ...result,
          session: session.handle,
        };
      }
      await syncThreadState(result);
      messages = yield* resumeAgentCoreRunPermission({
        session,
        result,
        cwd,
        tools: context.tools,
        signal: options.signal,
        requestWorkerPermission,
        onPermissionRequest: options.onPermissionRequest,
        workers: options.workers ?? [],
      });
    }
  } finally {
    try {
      await closeAgentCoreRunMcpClients(mcpClientResolution.ownedClients);
    } finally {
      if (session.ownsStateStore) {
        session.stateStore.close();
      }
    }
  }
}
