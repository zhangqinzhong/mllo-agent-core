import type { Writable } from "node:stream";
import type {
  AgentCoreMessage,
  AgentCoreQueryEvent,
  AgentCoreQueryLoopResult,
} from "../agent-core/query-loop/agent-core-query-types";
import type { AgentCoreRunControllerResult } from "../agent-core/runtime/agent-core-run-controller-types";
import type {
  AgentCoreToolCall,
  AgentCoreToolResult,
} from "../agent-core/tools/agent-core-tool-types";
import type { AgentCoreWorkerEvent } from "../agent-core/workers/agent-core-worker-types";
import type { MlloCliOutputFormat } from "./mllo-cli-types";
import { writeCliLine, writeCliText } from "./mllo-cli-io";

export type MlloCliEventRendererOptions = {
  outputFormat: MlloCliOutputFormat;
  stdout: Writable;
  stderr: Writable;
};

export type MlloCliJsonRunEnvelope = {
  type: "run-result";
  status: AgentCoreQueryLoopResult["status"];
  sessionId: string;
  finalContent?: string;
  result: AgentCoreRunControllerResult;
  events: AgentCoreQueryEvent[];
};

function finalAssistantContent(messages: readonly AgentCoreMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return undefined;
}

function previewText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function renderToolInput(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function renderToolStart(call: AgentCoreToolCall): string {
  const input = renderToolInput(call.input);
  return `[mllo] tool ${call.name}${input === undefined ? "" : ` ${previewText(input, 160)}`}`;
}

function renderToolResult(call: AgentCoreToolCall, result: AgentCoreToolResult): string | null {
  if (result.isError === true) {
    return `[mllo] tool ${call.name} failed: ${previewText(result.content, 220)}`;
  }
  if (result.outputTruncated === true) {
    const location = result.outputBlobPath === undefined ? "" : `, saved: ${result.outputBlobPath}`;
    return `[mllo] tool ${call.name} output truncated: ${result.outputMaxChars}/${result.outputOriginalChars} chars${location}`;
  }
  return null;
}

function renderWorkerEvent(event: AgentCoreWorkerEvent): string | null {
  switch (event.type) {
    case "worker-start":
      return `[mllo] worker ${event.workerId} started: ${event.label}`;
    case "assistant-delta":
      return null;
    case "tool-use":
      return `[mllo] worker ${event.workerId} tool ${event.name}`;
    case "tool-result":
      return event.isError === true
        ? `[mllo] worker ${event.workerId} tool ${event.name} failed`
        : null;
    case "permission-request":
      return `[mllo] worker ${event.workerId} permission: ${event.reason}`;
    case "permission-decision":
      return `[mllo] worker ${event.workerId} permission ${event.status}: ${event.reason}`;
    case "worker-done":
      return `[mllo] worker ${event.workerId} done`;
    case "worker-error":
      return `[mllo] worker ${event.workerId} error: ${event.message}`;
  }
}

function renderContinuation(
  event: Extract<AgentCoreQueryEvent, { type: "continue" }>,
): string | null {
  if (event.continuation.reason === "next_turn") {
    return null;
  }
  return `[mllo] continue: ${event.continuation.reason}`;
}

export class MlloCliEventRenderer {
  private readonly outputFormat: MlloCliOutputFormat;
  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly events: AgentCoreQueryEvent[] = [];
  private wroteAssistantText = false;
  private needsAssistantNewline = false;

  constructor(options: MlloCliEventRendererOptions) {
    this.outputFormat = options.outputFormat;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }

  handleEvent(event: AgentCoreQueryEvent): void {
    if (this.outputFormat === "stream-json") {
      writeCliLine(this.stdout, JSON.stringify({ type: "event", event }));
      return;
    }
    if (this.outputFormat === "json") {
      this.events.push(event);
      return;
    }
    this.renderTextEvent(event);
  }

  finish(result: AgentCoreRunControllerResult): void {
    if (this.outputFormat === "stream-json") {
      writeCliLine(this.stdout, JSON.stringify(this.createJsonEnvelope(result, [])));
      return;
    }
    if (this.outputFormat === "json") {
      writeCliLine(
        this.stdout,
        JSON.stringify(this.createJsonEnvelope(result, this.events), null, 2),
      );
      return;
    }
    if (this.needsAssistantNewline) {
      writeCliLine(this.stdout);
      this.needsAssistantNewline = false;
    }
    if (!this.wroteAssistantText) {
      const content =
        result.status === "completed" ? finalAssistantContent(result.messages) : undefined;
      if (content !== undefined) {
        writeCliLine(this.stdout, content);
      }
    }
  }

  private createJsonEnvelope(
    result: AgentCoreRunControllerResult,
    events: AgentCoreQueryEvent[],
  ): MlloCliJsonRunEnvelope {
    return {
      type: "run-result",
      status: result.status,
      sessionId: result.session.sessionId,
      ...(result.status === "completed"
        ? { finalContent: finalAssistantContent(result.messages) }
        : {}),
      result,
      events,
    };
  }

  private renderTextEvent(event: AgentCoreQueryEvent): void {
    switch (event.type) {
      case "continue": {
        const line = renderContinuation(event);
        if (line !== null) {
          writeCliLine(this.stderr, line);
        }
        return;
      }
      case "turn-start":
        return;
      case "assistant-message":
      case "final":
        this.wroteAssistantText = true;
        writeCliLine(this.stdout, event.content);
        return;
      case "assistant-delta":
        this.wroteAssistantText = true;
        this.needsAssistantNewline = true;
        writeCliText(this.stdout, event.content);
        return;
      case "tool-call":
        writeCliLine(this.stderr, renderToolStart(event.call));
        return;
      case "tool-progress":
        this.renderToolProgress(event);
        return;
      case "tool-result": {
        const line = renderToolResult(event.call, event.result);
        if (line !== null) {
          writeCliLine(this.stderr, line);
        }
        return;
      }
      case "permission-required":
        writeCliLine(this.stderr, `[mllo] permission required: ${event.decision.reason}`);
        return;
      case "permission-denied":
        writeCliLine(this.stderr, `[mllo] permission denied: ${event.decision.reason}`);
        return;
      case "elicitation-required":
        writeCliLine(this.stderr, `[mllo] question: ${event.request.question}`);
        return;
      case "hook-event":
        if (event.status === "failed") {
          writeCliLine(this.stderr, `[mllo] hook ${event.hookName} failed: ${event.content ?? ""}`);
        }
        return;
      case "stopped":
        writeCliLine(this.stderr, `[mllo] stopped: ${event.reason}`);
        return;
      case "error":
        writeCliLine(this.stderr, `[mllo] error: ${event.message}`);
        return;
    }
  }

  private renderToolProgress(event: Extract<AgentCoreQueryEvent, { type: "tool-progress" }>): void {
    switch (event.progress.kind) {
      case "shell-output":
        writeCliText(this.stderr, event.progress.chunk);
        return;
      case "shell-backgrounded":
        writeCliLine(
          this.stderr,
          `[mllo] shell backgrounded ${event.progress.taskId}: ${event.progress.outputPath}`,
        );
        return;
      case "worker-event": {
        const line = renderWorkerEvent(event.progress.event);
        if (line !== null) {
          writeCliLine(this.stderr, line);
        }
        return;
      }
      case "workflow-event":
        writeCliLine(
          this.stderr,
          `[mllo] workflow ${event.progress.event.taskId} ${event.progress.event.status}`,
        );
        return;
      case "file-change":
        writeCliLine(
          this.stderr,
          `[mllo] changed ${event.progress.change.path}: +${event.progress.change.addedLines} -${event.progress.change.removedLines}`,
        );
        return;
      case "cwd-change":
        writeCliLine(this.stderr, `[mllo] cwd ${event.progress.change.currentCwd}`);
        return;
    }
  }
}
