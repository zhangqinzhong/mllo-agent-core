import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentCoreToolAvailabilityPolicy } from "../tools/agent-core-tool-types";
import type {
  AgentCoreMcpClient,
  AgentCoreMcpToolCallRequest,
  AgentCoreMcpToolCallResult,
  AgentCoreMcpToolDescriptor,
} from "./agent-core-mcp-client-types";
import {
  toAgentCoreMcpToolCallResult,
  toAgentCoreMcpToolDescriptor,
} from "./agent-core-mcp-sdk-wire";

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 20_000;

export type AgentCoreHttpMcpTransportKind = "streamable-http" | "sse";

export type AgentCoreHttpMcpClientOptions = {
  serverName: string;
  label?: string;
  url: string;
  transportKind?: AgentCoreHttpMcpTransportKind;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  availability?: AgentCoreToolAvailabilityPolicy;
};

function createRequestOptions(args: { signal?: AbortSignal; timeoutMs: number }): RequestOptions {
  const options: RequestOptions = {
    timeout: args.timeoutMs,
  };
  if (args.signal !== undefined) {
    options.signal = args.signal;
  }
  return options;
}

function validateRemoteUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? null
      : `Unsupported MCP URL protocol: ${parsed.protocol}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function createStaticAvailability(url: string): AgentCoreToolAvailabilityPolicy {
  return {
    ttlMs: 60_000,
    check() {
      const invalidReason = validateRemoteUrl(url);
      return invalidReason === null
        ? {
            available: true,
            reason: "Remote MCP URL is configured.",
          }
        : {
            available: false,
            reason: invalidReason,
          };
    },
  };
}

function readHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function mergeHeaders(
  configuredHeaders: Record<string, string> | undefined,
  initHeaders: HeadersInit | undefined,
): Record<string, string> {
  return {
    ...readHeaders(initHeaders),
    ...configuredHeaders,
  };
}

function createHeaderFetch(configuredHeaders: Record<string, string> | undefined): FetchLike {
  return async (url, init) =>
    await fetch(url, {
      ...init,
      headers: mergeHeaders(configuredHeaders, init?.headers),
    });
}

function createRequestInit(headers: Record<string, string> | undefined): RequestInit | undefined {
  return headers === undefined
    ? undefined
    : {
        headers,
      };
}

function createTransport(args: {
  url: string;
  headers: Record<string, string> | undefined;
  transportKind: AgentCoreHttpMcpTransportKind;
}): Transport {
  const url = new URL(args.url);
  const requestInit = createRequestInit(args.headers);
  if (args.transportKind === "sse") {
    return new SSEClientTransport(url, {
      eventSourceInit:
        args.headers === undefined
          ? undefined
          : {
              // SSE 初始 GET 需要自定义 fetch 才能携带配置里的认证 header。
              fetch: createHeaderFetch(args.headers),
            },
      requestInit,
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit,
  });
}

// 远程 MCP 也是外部能力；core 只封 transport，不耦合具体服务商。
export class AgentCoreHttpMcpClient implements AgentCoreMcpClient {
  readonly serverName: string;
  readonly label?: string;
  readonly availability: AgentCoreToolAvailabilityPolicy;

  private readonly url: string;
  private readonly transportKind: AgentCoreHttpMcpTransportKind;
  private readonly headers?: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private client: Client | undefined;
  private transport: Transport | undefined;
  private connecting: Promise<Client> | undefined;
  private errorTail = "";

  // 构造阶段不发网络请求，避免读取项目 context 时偷连远程 MCP。
  constructor(options: AgentCoreHttpMcpClientOptions) {
    this.serverName = options.serverName;
    this.label = options.label;
    this.url = options.url;
    this.transportKind = options.transportKind ?? "streamable-http";
    this.headers = options.headers;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    this.availability = options.availability ?? createStaticAvailability(options.url);
  }

  // 列工具时才建立连接，避免每个会话启动都打远程 MCP。
  async listTools(): Promise<AgentCoreMcpToolDescriptor[]> {
    const client = await this.connect();
    const result = await client.listTools(
      undefined,
      createRequestOptions({
        timeoutMs: this.requestTimeoutMs,
      }),
    );
    return result.tools.map(toAgentCoreMcpToolDescriptor);
  }

  // 远程 MCP 工具调用走同一条 session，保留 server 侧会话状态。
  async callTool(request: AgentCoreMcpToolCallRequest): Promise<AgentCoreMcpToolCallResult> {
    const client = await this.connect();
    const result = await client.callTool(
      {
        name: request.toolName,
        arguments: request.arguments,
      },
      CallToolResultSchema,
      createRequestOptions({
        signal: request.signal,
        timeoutMs: this.requestTimeoutMs,
      }),
    );
    return toAgentCoreMcpToolCallResult(result);
  }

  // run controller 结束时要关闭连接，防止 HTTP/SSE session 悬挂。
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    await client?.close();
    await transport?.close();
  }

  // 并发工具发现和调用共享连接 promise，避免并发建多个 MCP session。
  private async connect(): Promise<Client> {
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.connecting !== undefined) {
      return await this.connecting;
    }

    this.connecting = this.createConnection();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  // 把 SDK transport 生命周期关在 adapter 内，给上层只暴露 core client。
  private async createConnection(): Promise<Client> {
    const client = new Client({
      name: "mllo-agent-core",
      version: "0.1.0",
    });
    const transport = createTransport({
      url: this.url,
      headers: this.headers,
      transportKind: this.transportKind,
    });
    client.onerror = (error) => {
      this.errorTail = `${this.errorTail}${error.message}\n`.slice(-8_000);
    };
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
      }
    };

    try {
      await client.connect(
        transport,
        createRequestOptions({
          timeoutMs: this.connectTimeoutMs,
        }),
      );
    } catch (error) {
      await transport.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const suffix =
        this.errorTail.trim().length === 0 ? "" : `\nMCP error:\n${this.errorTail.trim()}`;
      throw new Error(`${message}${suffix}`);
    }

    this.client = client;
    this.transport = transport;
    return client;
  }
}

export function createAgentCoreHttpMcpClient(
  options: AgentCoreHttpMcpClientOptions,
): AgentCoreHttpMcpClient {
  return new AgentCoreHttpMcpClient(options);
}
