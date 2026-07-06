import type { LangfuseGeneration } from "@langfuse/tracing";
import type {
  AgentCoreModelAdapter,
  AgentCoreModelRequest,
  AgentCoreModelResponse,
  AgentCoreModelStreamEvent,
} from "../query-loop/agent-core-query-types";
import type { AgentCoreLangfuseRunTrace } from "./agent-core-langfuse-run-trace";
import {
  createAgentCoreLangfuseModelInput,
  createAgentCoreLangfuseModelOutput,
  createAgentCoreLangfuseModelParameters,
  createAgentCoreLangfuseUsageDetails,
} from "./agent-core-langfuse-summaries";

function startModelGeneration(args: {
  trace: AgentCoreLangfuseRunTrace;
  request: AgentCoreModelRequest;
  mode: "complete" | "stream";
}): LangfuseGeneration {
  return args.trace.root.startObservation(
    `model.${args.mode}`,
    {
      input: createAgentCoreLangfuseModelInput({
        request: args.request,
        captureContent: args.trace.config.captureContent,
      }),
      model: args.trace.provider.model,
      modelParameters: createAgentCoreLangfuseModelParameters(args.trace.provider),
      metadata: {
        protocol: args.trace.provider.protocol,
        provider: args.trace.provider.name ?? args.trace.provider.protocol,
        toolCount: args.request.tools.length,
        messageCount: args.request.messages.length,
      },
    },
    {
      asType: "generation",
    },
  );
}

function updateGenerationSuccess(args: {
  generation: LangfuseGeneration;
  trace: AgentCoreLangfuseRunTrace;
  response: AgentCoreModelResponse;
}): void {
  args.generation.update({
    output: createAgentCoreLangfuseModelOutput({
      response: args.response,
      captureContent: args.trace.config.captureContent,
    }),
    usageDetails: createAgentCoreLangfuseUsageDetails(args.response.usage),
  });
}

function updateGenerationError(args: { generation: LangfuseGeneration; error: unknown }): void {
  args.generation.update({
    level: "ERROR",
    statusMessage: args.error instanceof Error ? args.error.message : String(args.error),
  });
}

async function traceCompleteModelCall(args: {
  trace: AgentCoreLangfuseRunTrace;
  request: AgentCoreModelRequest;
  complete: NonNullable<Extract<AgentCoreModelAdapter, { complete?: unknown }>["complete"]>;
}): Promise<AgentCoreModelResponse> {
  const generation = startModelGeneration({
    trace: args.trace,
    request: args.request,
    mode: "complete",
  });
  try {
    const response = await args.complete(args.request);
    updateGenerationSuccess({
      generation,
      trace: args.trace,
      response,
    });
    return response;
  } catch (error) {
    updateGenerationError({
      generation,
      error,
    });
    throw error;
  } finally {
    generation.end();
  }
}

async function* traceStreamModelCall(args: {
  trace: AgentCoreLangfuseRunTrace;
  request: AgentCoreModelRequest;
  stream: NonNullable<Extract<AgentCoreModelAdapter, { stream?: unknown }>["stream"]>;
}): AsyncIterable<AgentCoreModelStreamEvent> {
  const generation = startModelGeneration({
    trace: args.trace,
    request: args.request,
    mode: "stream",
  });
  let content = "";
  const toolCalls: AgentCoreModelResponse["toolCalls"] = [];
  let usage: AgentCoreModelResponse["usage"];
  try {
    for await (const event of args.stream(args.request)) {
      if (event.type === "text-delta") {
        content += event.content;
      }
      if (event.type === "tool-call") {
        toolCalls.push(event.call);
      }
      if (event.type === "message-end") {
        usage = event.usage;
      }
      yield event;
    }
    updateGenerationSuccess({
      generation,
      trace: args.trace,
      response: {
        content,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(usage === undefined ? {} : { usage }),
      },
    });
  } catch (error) {
    updateGenerationError({
      generation,
      error,
    });
    throw error;
  } finally {
    generation.end();
  }
}

export function createAgentCoreLangfuseModelAdapter(args: {
  model: AgentCoreModelAdapter;
  trace?: AgentCoreLangfuseRunTrace;
}): AgentCoreModelAdapter {
  if (args.trace === undefined) {
    return args.model;
  }
  return {
    complete:
      args.model.complete === undefined
        ? undefined
        : (request) =>
            traceCompleteModelCall({
              trace: args.trace as AgentCoreLangfuseRunTrace,
              request,
              complete: args.model.complete as NonNullable<typeof args.model.complete>,
            }),
    stream:
      args.model.stream === undefined
        ? undefined
        : (request) =>
            traceStreamModelCall({
              trace: args.trace as AgentCoreLangfuseRunTrace,
              request,
              stream: args.model.stream as NonNullable<typeof args.model.stream>,
            }),
  } as AgentCoreModelAdapter;
}
