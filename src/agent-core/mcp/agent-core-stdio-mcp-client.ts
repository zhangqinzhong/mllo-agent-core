import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { createAgentCoreMcpClientIdentity } from "./agent-core-mcp-client-identity";
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
const MAX_STDERR_TAIL_CHARS = 8_000;

export type AgentCoreStdioMcpClientOptions = {
  serverName: string;
  label?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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

function createStaticAvailability(command: string): AgentCoreToolAvailabilityPolicy {
  return {
    ttlMs: 60_000,
    check() {
      return command.trim().length === 0
        ? {
            available: false,
            reason: "MCP stdio command is empty.",
          }
        : {
            available: true,
            reason: "MCP stdio command is configured.",
          };
    },
  };
}

function appendBoundedStderr(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_STDERR_TAIL_CHARS ? next : next.slice(-MAX_STDERR_TAIL_CHARS);
}

function withStderrTail(error: unknown, stderrTail: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = stderrTail.trim().length === 0 ? "" : `\nMCP stderr:\n${stderrTail.trim()}`;
  return new Error(`${message}${suffix}`);
}

// stdio MCP server 是外部进程；这个类把 SDK 细节关在 core adapter 内部。
export class AgentCoreStdioMcpClient implements AgentCoreMcpClient {
  readonly serverName: string;
  readonly label?: string;
  readonly availability: AgentCoreToolAvailabilityPolicy;

  private readonly command: string;
  private readonly args?: string[];
  private readonly env?: Record<string, string>;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connecting: Promise<Client> | undefined;
  private stderrTail = "";

  // 只保存启动参数，不在构造阶段 spawn，避免仅构建 context 就启动外部进程。
  constructor(options: AgentCoreStdioMcpClientOptions) {
    this.serverName = options.serverName;
    this.label = options.label;
    this.command = options.command;
    this.args = options.args;
    this.env = options.env;
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    this.availability = options.availability ?? createStaticAvailability(options.command);
  }

  // 列工具时才懒连接，让 MCP server 生命周期跟真实工具需求绑定。
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

  // 工具调用沿用同一条连接，避免每次 tool call 都重新握手和丢 server 状态。
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

  // run controller 拥有自动创建的 client，结束时必须关闭子进程避免残留。
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    await client?.close();
    await transport?.close();
  }

  // 并发 list/call 共享同一个 connecting promise，避免同时 spawn 两个 server。
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

  // 真正创建 SDK client/transport，并把 stderr 尾部保留下来方便连接失败诊断。
  private async createConnection(): Promise<Client> {
    // mllo 使用自己的 client identity，避免 core 继续继承宿主应用品牌边界。
    const client = new Client(createAgentCoreMcpClientIdentity());
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      cwd: this.cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      this.stderrTail = appendBoundedStderr(this.stderrTail, chunk);
    });
    client.onerror = (error) => {
      this.stderrTail = appendBoundedStderr(this.stderrTail, `${error.message}\n`);
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
      throw withStderrTail(error, this.stderrTail);
    }

    this.client = client;
    this.transport = transport;
    return client;
  }
}

export function createAgentCoreStdioMcpClient(
  options: AgentCoreStdioMcpClientOptions,
): AgentCoreStdioMcpClient {
  return new AgentCoreStdioMcpClient(options);
}
