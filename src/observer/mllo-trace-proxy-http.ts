import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type MlloTraceProxyCapturedResponse = {
  body: Buffer;
  truncated: boolean;
};

export function getMlloTraceProxyListenUrl(args: {
  serverAddress: AddressInfo | string | null;
  host: string;
  fallbackPort: number;
}): string {
  if (args.serverAddress === null || typeof args.serverAddress === "string") {
    return `http://${args.host}:${args.fallbackPort}`;
  }
  return `http://${args.host}:${args.serverAddress.port}`;
}

export function sendMlloTraceProxyJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function formatMlloTraceProxyError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

export function toMlloTraceProxyForwardHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || value === undefined) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

export async function readMlloTraceProxyRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`request body exceeds trace proxy limit (${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function toMlloTraceProxyFetchBody(
  method: string | undefined,
  body: Buffer,
): string | undefined {
  return method === "GET" || method === "HEAD" ? undefined : body.toString("utf8");
}

export function buildMlloTraceProxyUpstreamUrl(args: {
  request: IncomingMessage;
  upstreamBaseUrl: string;
  dedupeVersionPrefix?: string;
}): URL {
  const requestUrl = new URL(args.request.url ?? "/", "http://127.0.0.1");
  const upstream = new URL(args.upstreamBaseUrl);
  let requestPath = requestUrl.pathname.replace(/^\/+/, "");
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  const versionPrefix = args.dedupeVersionPrefix?.replace(/^\/+|\/+$/g, "");
  if (
    versionPrefix !== undefined &&
    versionPrefix.length > 0 &&
    (upstreamPath === `/${versionPrefix}` || upstreamPath.endsWith(`/${versionPrefix}`))
  ) {
    if (requestPath === versionPrefix) {
      requestPath = "";
    } else if (requestPath.startsWith(`${versionPrefix}/`)) {
      requestPath = requestPath.slice(versionPrefix.length + 1);
    }
  }
  upstream.pathname = `${upstreamPath}/${requestPath}`.replace(/\/{2,}/g, "/");
  upstream.search = requestUrl.search;
  return upstream;
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      record[key] = value;
    }
  }
  return record;
}

function appendCapturedChunk(args: {
  chunks: Buffer[];
  chunk: Buffer;
  capturedBytes: number;
  maxCapturedBytes: number;
}): { capturedBytes: number; truncated: boolean } {
  const remainingBytes = args.maxCapturedBytes - args.capturedBytes;
  if (remainingBytes <= 0) {
    return {
      capturedBytes: args.capturedBytes,
      truncated: true,
    };
  }
  const captured =
    args.chunk.byteLength <= remainingBytes ? args.chunk : args.chunk.subarray(0, remainingBytes);
  args.chunks.push(captured);
  return {
    capturedBytes: args.capturedBytes + captured.byteLength,
    truncated: captured.byteLength < args.chunk.byteLength,
  };
}

export async function pipeMlloTraceProxyUpstreamResponse(args: {
  upstreamResponse: Response;
  response: ServerResponse;
  maxCapturedResponseBytes: number;
}): Promise<MlloTraceProxyCapturedResponse> {
  args.response.writeHead(
    args.upstreamResponse.status,
    args.upstreamResponse.statusText,
    toHeaderRecord(args.upstreamResponse.headers),
  );
  if (args.upstreamResponse.body === null) {
    args.response.end();
    return {
      body: Buffer.alloc(0),
      truncated: false,
    };
  }
  const reader = args.upstreamResponse.body.getReader();
  const capturedChunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk = Buffer.from(result.value);
      args.response.write(chunk);
      const capture = appendCapturedChunk({
        chunks: capturedChunks,
        chunk,
        capturedBytes,
        maxCapturedBytes: args.maxCapturedResponseBytes,
      });
      capturedBytes = capture.capturedBytes;
      truncated = truncated || capture.truncated;
    }
  } finally {
    args.response.end();
    reader.releaseLock();
  }
  return {
    body: Buffer.concat(capturedChunks),
    truncated,
  };
}
