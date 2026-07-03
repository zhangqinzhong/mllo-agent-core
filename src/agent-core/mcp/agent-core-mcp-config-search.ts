import { dirname, join, parse, relative, resolve } from "node:path";
import { MCP_CONFIG_CANDIDATES, type McpConfigCandidate } from "./agent-core-mcp-config-schema";

export type AgentCoreMcpConfigSearchEntry = {
  rootPath: string;
  configPath: string;
  displayPath: string;
  candidate: McpConfigCandidate;
};

export type AgentCoreMcpConfigSearchOptions = {
  cwd: string;
  candidates?: readonly McpConfigCandidate[];
};

function getAncestorDirsFromNearest(options: { cwd: string }): string[] {
  const dirs: string[] = [];
  let currentDir = resolve(options.cwd);
  const rootDir = parse(currentDir).root;
  while (currentDir !== rootDir) {
    dirs.push(currentDir);
    const nextDir = dirname(currentDir);
    if (nextDir === currentDir) {
      break;
    }
    currentDir = nextDir;
  }
  return dirs;
}

function normalizeDisplayPath(cwd: string, configPath: string): string {
  const displayPath = relative(cwd, configPath);
  return displayPath.length === 0 ? configPath : displayPath;
}

export function listAgentCoreMcpConfigSearchEntries(
  options: AgentCoreMcpConfigSearchOptions,
): AgentCoreMcpConfigSearchEntry[] {
  const cwd = resolve(options.cwd);
  const candidates = options.candidates ?? MCP_CONFIG_CANDIDATES;
  const entries: AgentCoreMcpConfigSearchEntry[] = [];
  // 配置查找按“离当前 cwd 越近越优先”，同名 server 由第一条命中胜出。
  for (const rootPath of getAncestorDirsFromNearest({ cwd })) {
    for (const candidate of candidates) {
      const configPath = join(rootPath, candidate.relativePath);
      entries.push({
        rootPath,
        configPath,
        displayPath: normalizeDisplayPath(cwd, configPath),
        candidate,
      });
    }
  }
  return entries;
}
