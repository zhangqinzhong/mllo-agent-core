import { readFile } from "node:fs/promises";
import {
  inspectMcpConfigContent,
  type McpServerSummary,
} from "../mcp/agent-core-mcp-config-schema";
import { listAgentCoreMcpConfigSearchEntries } from "../mcp/agent-core-mcp-config-search";

export type AgentCoreMcpConfigPromptServer = {
  name: string;
  transport: McpServerSummary["transport"];
  status: McpServerSummary["status"];
  command?: string;
  url?: string;
  issue?: string;
};

export type AgentCoreMcpConfigPromptRecord = {
  label: string;
  path: string;
  status: "valid" | "invalid";
  servers: AgentCoreMcpConfigPromptServer[];
  error?: string;
};

async function readOptionalTextFile(path: string): Promise<string | null> {
  return await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

function createPromptServer(server: McpServerSummary): AgentCoreMcpConfigPromptServer {
  const promptServer: AgentCoreMcpConfigPromptServer = {
    name: server.name,
    transport: server.transport,
    status: server.status,
  };
  if (server.command !== undefined) {
    promptServer.command = server.command;
  }
  if (server.url !== undefined) {
    promptServer.url = server.url;
  }
  if (server.issue !== undefined) {
    promptServer.issue = server.issue;
  }
  return promptServer;
}

// 读取 workspace 内常见 MCP 配置。只注入摘要，避免 prompt 泄露 env secret。
export async function readAgentCoreMcpConfigPromptState(args: {
  cwd: string;
}): Promise<AgentCoreMcpConfigPromptRecord[]> {
  const records: AgentCoreMcpConfigPromptRecord[] = [];
  for (const entry of listAgentCoreMcpConfigSearchEntries({ cwd: args.cwd })) {
    const inspection = inspectMcpConfigContent(
      entry.candidate,
      await readOptionalTextFile(entry.configPath),
    );
    if (!inspection.exists) {
      continue;
    }
    const record: AgentCoreMcpConfigPromptRecord = {
      label: entry.candidate.label,
      path: entry.displayPath,
      status: inspection.status === "invalid" ? "invalid" : "valid",
      servers: inspection.servers.map(createPromptServer),
    };
    if (inspection.error !== undefined) {
      record.error = inspection.error;
    }
    records.push(record);
  }
  return records;
}
