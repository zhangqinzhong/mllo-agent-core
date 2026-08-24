import { createAgentCoreSessionRuntimePaths } from "../context/agent-core-session-runtime-paths";
import { recordAgentCoreSystemContextSnapshot } from "../context/agent-core-system-context-snapshot";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopArgs,
  AgentCoreQueryLoopResult,
} from "../query-loop/agent-core-query-types";
import {
  createAgentCoreContinuationEvent,
  type AgentCoreContinuation,
} from "../query-loop/agent-core-continuation";
import { runAgentCoreQueryLoop } from "../query-loop/agent-core-query-loop";
import { appendAgentCoreInputHistoryEntry } from "../session/agent-core-input-history";
import { writeAgentCoreToolResultBlob } from "../tools/agent-core-tool-result-blob-store";
import { applyAgentCoreRunBudgetWithHookRecording } from "./agent-core-run-budget-hook-recording";
import { resumeAgentCoreRunElicitation } from "./agent-core-run-elicitation";
import { resumeAgentCoreRunPermission } from "./agent-core-run-permission";
import { prepareRunSession } from "./agent-core-run-session";
import { createAgentCoreWorkerPermissionRequester } from "./agent-core-worker-permission-requester";
import {
  createAgentCoreReactiveCompactFailureMessage,
  createAgentCoreReactiveCompactBudget,
  renderAgentCoreRunSystemPromptBlocks,
  renderAgentCoreRunTurnContext,
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
import { appendAgentCoreHostPromptBlocks } from "../context/agent-core-host-prompt-blocks";
import { joinAgentCorePromptBlocks } from "../query-loop/agent-core-prompt-block-types";
import {
  createAgentCoreLangfuseRunTrace,
  finishAgentCoreLangfuseRunTrace,
  type AgentCoreLangfuseRunTrace,
} from "../observability/agent-core-langfuse-run-trace";
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
  let langfuseTrace: AgentCoreLangfuseRunTrace | undefined;
  let finalResult: AgentCoreRunControllerResult | undefined;
  let finalError: unknown;
  try {
    await appendAgentCoreInputHistoryEntry({
      configDir: options.session.configDir,
      sessionId: session.handle.sessionId,
      cwd: session.handle.cwd,
      input: options.input,
    });
    const loadedConfig = await loadAgentCoreRunConfig(options);
    const provider = loadAgentCoreRunModelProvider(options, loadedConfig);
    langfuseTrace = await createAgentCoreLangfuseRunTrace({
      options: options.observability?.langfuse,
      sessionId: session.handle.sessionId,
      cwd,
      workspaceRoots,
      input: options.input,
      provider,
    });
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
      langfuseTrace,
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
      provider,
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
    let systemPromptBlocks = context.systemPromptBlocks;
    let turnContext = context.queryArgs.turnContext;
    let previousContinuation: AgentCoreContinuation | undefined;
    const rememberContinuationEvent = (event: AgentCoreQueryEvent): void => {
      if (event.type === "continue") {
        previousContinuation = event.continuation;
      }
    };
    const recordContinuation = async (args: {
      continuation: AgentCoreContinuation;
      messageCount: number;
    }): Promise<AgentCoreQueryEvent> => {
      const event = createAgentCoreContinuationEvent({
        continuation: args.continuation,
        previousContinuation,
        messageCount: args.messageCount,
      });
      previousContinuation = args.continuation;
      return await recordAgentCoreRunEvent({
        session,
        event,
        workers: options.workers ?? [],
      });
    };
    if (budgeted.compacted) {
      systemPromptBlocks = appendAgentCoreHostPromptBlocks(
        renderAgentCoreRunSystemPromptBlocks({
          promptContext: context.promptContext,
          promptProfile: context.promptProfile,
          budgetState,
          budgetOptions: options.budget,
        }),
        options.additionalSystemPromptBlocks,
      );
      systemPrompt = joinAgentCorePromptBlocks(systemPromptBlocks);
      turnContext = renderAgentCoreRunTurnContext({
        promptContext: context.promptContext,
        promptProfile: context.promptProfile,
        budgetState,
        budgetOptions: options.budget,
      });
      await recordAgentCoreSystemContextSnapshot({
        session,
        prompt: systemPrompt,
        promptBlocks: systemPromptBlocks,
        promptContext: context.promptContext,
        reason: "compact",
      });
    }
    const requestWorkerPermission = createAgentCoreWorkerPermissionRequester({
      session,
      onRequest: options.onWorkerPermissionRequest,
    });
    const storeToolResultBlob: AgentCoreQueryLoopArgs["storeToolResultBlob"] = async ({
      call,
      content,
      originalChars,
    }) => {
      const blob = await writeAgentCoreToolResultBlob({
        projectDir: session.handle.projectDir,
        sessionId: session.handle.sessionId,
        cwd: session.handle.cwd,
        toolCallId: call.id,
        toolName: call.name,
        content,
        originalChars,
      });
      return {
        outputBlobPath: blob.relativePath,
        outputBlobBytes: blob.byteLength,
      };
    };
    let reactiveCompactRetried = false;
    while (true) {
      const generator = runAgentCoreQueryLoop({
        ...context.queryArgs,
        systemPrompt,
        systemPromptBlocks,
        turnContext,
        messages,
        hooks,
        requestWorkerPermission,
        storeToolResultBlob,
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
        rememberContinuationEvent(recordedEvent);
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
          provider,
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
        systemPromptBlocks = appendAgentCoreHostPromptBlocks(
          renderAgentCoreRunSystemPromptBlocks({
            promptContext: context.promptContext,
            promptProfile: context.promptProfile,
            budgetState,
            budgetOptions: options.budget,
          }),
          options.additionalSystemPromptBlocks,
        );
        systemPrompt = joinAgentCorePromptBlocks(systemPromptBlocks);
        turnContext = renderAgentCoreRunTurnContext({
          promptContext: context.promptContext,
          promptProfile: context.promptProfile,
          budgetState,
          budgetOptions: options.budget,
        });
        await recordAgentCoreSystemContextSnapshot({
          session,
          prompt: systemPrompt,
          promptBlocks: systemPromptBlocks,
          promptContext: context.promptContext,
          reason: "compact",
        });
        yield await recordContinuation({
          continuation: {
            reason: "reactive_compact_retry",
          },
          messageCount: messages.length,
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
        yield await recordContinuation({
          continuation: {
            reason: "elicitation_resume",
          },
          messageCount: messages.length,
        });
        continue;
      }
      if (result.status !== "waiting-for-permission" || options.onPermissionRequest === undefined) {
        await syncThreadState(result);
        finalResult = {
          ...result,
          session: session.handle,
        };
        return finalResult;
      }
      let permissionResult: Extract<
        AgentCoreQueryLoopResult,
        { status: "waiting-for-permission" }
      > = result;
      while (true) {
        await syncThreadState(permissionResult);
        const resumeResult = yield* resumeAgentCoreRunPermission({
          session,
          result: permissionResult,
          cwd,
          tools: context.tools,
          signal: options.signal,
          requestWorkerPermission,
          storeToolResultBlob,
          onPermissionRequest: options.onPermissionRequest,
          workers: options.workers ?? [],
        });
        persistedMessageCount = await recordAgentCoreRunMessagesFrom({
          session,
          messages: resumeResult.messages,
          startIndex: persistedMessageCount,
        });
        if (resumeResult.status === "resumed") {
          messages = resumeResult.messages;
          yield await recordContinuation({
            continuation: {
              reason: "permission_resume",
            },
            messageCount: messages.length,
          });
          break;
        }
        if (
          resumeResult.status === "waiting-for-permission" &&
          options.onPermissionRequest !== undefined
        ) {
          permissionResult = resumeResult;
          yield await recordContinuation({
            continuation: {
              reason: "permission_followup",
            },
            messageCount: resumeResult.messages.length,
          });
          continue;
        }
        await syncThreadState(resumeResult);
        finalResult = {
          ...resumeResult,
          session: session.handle,
        };
        return finalResult;
      }
    }
  } catch (error) {
    finalError = error;
    throw error;
  } finally {
    try {
      try {
        await finishAgentCoreLangfuseRunTrace({
          trace: langfuseTrace,
          result: finalResult,
          error: finalError,
        });
      } finally {
        await closeAgentCoreRunMcpClients(mcpClientResolution.ownedClients);
      }
    } finally {
      if (session.ownsStateStore) {
        session.stateStore.close();
      }
    }
  }
}
