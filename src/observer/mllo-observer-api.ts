import type { IncomingMessage, ServerResponse } from "node:http";
import { listMlloExternalTraceLogs, readMlloExternalTraceLog } from "./mllo-external-trace-jsonl";
import { listMlloObserverSessions, readMlloObserverSessionDetail } from "./mllo-observer-sessions";
import type { MlloObserverOptions } from "./mllo-observer-types";

type ApiRouteContext = {
  options: MlloObserverOptions;
};

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function parseRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function readPositiveInt(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | null): boolean {
  return value === "1" || value === "true";
}

function methodAllowed(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }
  sendJson(response, 405, {
    error: "method_not_allowed",
  });
  return false;
}

async function sendSessions(
  requestUrl: URL,
  response: ServerResponse,
  context: ApiRouteContext,
): Promise<void> {
  const sessions = await listMlloObserverSessions({
    homePath: context.options.homePath,
    includeArchived: readBoolean(requestUrl.searchParams.get("includeArchived")),
    limit: readPositiveInt(requestUrl.searchParams.get("limit"), 100),
  });
  sendJson(response, 200, {
    sessions,
  });
}

async function sendExternalTraceLogs(
  response: ServerResponse,
  context: ApiRouteContext,
): Promise<void> {
  const traces = await listMlloExternalTraceLogs({
    homePath: context.options.homePath,
  });
  sendJson(response, 200, {
    traces,
  });
}

async function sendExternalTraceLog(
  requestUrl: URL,
  response: ServerResponse,
  context: ApiRouteContext,
  source: string,
): Promise<void> {
  const trace = await readMlloExternalTraceLog({
    homePath: context.options.homePath,
    source,
    maxEntries: readPositiveInt(requestUrl.searchParams.get("limit"), 300),
    maxBytes: readPositiveInt(requestUrl.searchParams.get("maxBytes"), 4 * 1024 * 1024),
    redactSecrets: context.options.redactSecrets,
  });
  sendJson(response, 200, trace);
}

async function sendSessionDetail(
  requestUrl: URL,
  response: ServerResponse,
  context: ApiRouteContext,
  sessionId: string,
): Promise<void> {
  const detail = await readMlloObserverSessionDetail({
    homePath: context.options.homePath,
    sessionId,
    maxEntries: readPositiveInt(requestUrl.searchParams.get("limit"), 300),
    maxBytes: readPositiveInt(requestUrl.searchParams.get("maxBytes"), 4 * 1024 * 1024),
    redactSecrets: context.options.redactSecrets,
  });
  if (detail === undefined) {
    sendJson(response, 404, {
      error: "session_not_found",
    });
    return;
  }
  sendJson(response, 200, detail);
}

async function sendSessionTranscript(
  requestUrl: URL,
  response: ServerResponse,
  context: ApiRouteContext,
  sessionId: string,
): Promise<void> {
  const detail = await readMlloObserverSessionDetail({
    homePath: context.options.homePath,
    sessionId,
    maxEntries: readPositiveInt(requestUrl.searchParams.get("limit"), 300),
    maxBytes: readPositiveInt(requestUrl.searchParams.get("maxBytes"), 4 * 1024 * 1024),
    redactSecrets: context.options.redactSecrets,
  });
  if (detail === undefined) {
    sendJson(response, 404, {
      error: "session_not_found",
    });
    return;
  }
  sendJson(response, 200, detail.transcript);
}

async function sendSessionPrompts(
  requestUrl: URL,
  response: ServerResponse,
  context: ApiRouteContext,
  sessionId: string,
): Promise<void> {
  const detail = await readMlloObserverSessionDetail({
    homePath: context.options.homePath,
    sessionId,
    maxEntries: readPositiveInt(requestUrl.searchParams.get("limit"), 300),
    maxBytes: readPositiveInt(requestUrl.searchParams.get("maxBytes"), 4 * 1024 * 1024),
    redactSecrets: context.options.redactSecrets,
  });
  if (detail === undefined) {
    sendJson(response, 404, {
      error: "session_not_found",
    });
    return;
  }
  sendJson(response, 200, detail.prompts);
}

export async function handleMlloObserverApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MlloObserverOptions,
): Promise<boolean> {
  const requestUrl = parseRequestUrl(request);
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") {
    return false;
  }
  if (!methodAllowed(request, response)) {
    return true;
  }
  const context = {
    options,
  };
  try {
    if (parts.length === 1 && parts[0] === "api") {
      sendJson(response, 200, {
        name: "mllo observer",
        endpoints: ["/api/sessions", "/api/sessions/:id", "/api/external-traces"],
      });
      return true;
    }
    if (parts.length === 2 && parts[1] === "sessions") {
      await sendSessions(requestUrl, response, context);
      return true;
    }
    if (parts.length === 2 && parts[1] === "external-traces") {
      await sendExternalTraceLogs(response, context);
      return true;
    }
    if (parts.length === 3 && parts[1] === "external-traces") {
      await sendExternalTraceLog(requestUrl, response, context, decodeURIComponent(parts[2]!));
      return true;
    }
    if (parts.length >= 3 && parts[1] === "sessions") {
      const sessionId = decodeURIComponent(parts[2]!);
      if (parts.length === 3) {
        await sendSessionDetail(requestUrl, response, context, sessionId);
        return true;
      }
      if (parts.length === 4 && parts[3] === "transcript") {
        await sendSessionTranscript(requestUrl, response, context, sessionId);
        return true;
      }
      if (parts.length === 4 && parts[3] === "prompts") {
        await sendSessionPrompts(requestUrl, response, context, sessionId);
        return true;
      }
    }
    sendJson(response, 404, {
      error: "not_found",
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, {
      error: "observer_error",
      message,
    });
    return true;
  }
}
