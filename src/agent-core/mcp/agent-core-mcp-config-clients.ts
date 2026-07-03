import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canInspectLocalMcpConfigRoot, type McpConfigCandidate } from '../../../shared/mcp-config'
import { listAgentCoreMcpConfigSearchEntries } from './agent-core-mcp-config-search'
import {
  createAgentCoreHttpMcpClient,
  type AgentCoreHttpMcpTransportKind
} from './agent-core-http-mcp-client'
import { createAgentCoreStdioMcpClient } from './agent-core-stdio-mcp-client'
import type { AgentCoreMcpClient } from './agent-core-mcp-client-types'

type RawMcpServerConfig = {
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  httpUrl?: unknown
  type?: unknown
  enabled?: unknown
  disabled?: unknown
  headers?: unknown
}

export type AgentCoreMcpConfigClientOptions = {
  cwd: string
  candidates?: readonly McpConfigCandidate[]
  reservedServerNames?: readonly string[]
}

export type AgentCoreMcpServerConfigMap = Record<string, unknown>

async function readOptionalTextFile(path: string): Promise<string | null> {
  return await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
}

function extractObjectAtPath(
  value: unknown,
  pathSegments: readonly string[]
): Record<string, unknown> | null {
  let current = value
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = value.filter((item): item is string => typeof item === 'string')
  return values.length === value.length ? values : undefined
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [
      key,
      typeof rawValue === 'string' ? rawValue : String(rawValue)
    ])
  )
}

function isDisabledServer(raw: RawMcpServerConfig): boolean {
  if (raw.enabled === false || raw.disabled === true) {
    return true
  }
  return false
}

function isEnabledStdioServer(raw: RawMcpServerConfig): boolean {
  return (
    !isDisabledServer(raw) &&
    (raw.type === undefined || raw.type === 'local' || raw.type === 'stdio')
  )
}

function readServerCommand(raw: RawMcpServerConfig): string | undefined {
  if (typeof raw.command === 'string') {
    return raw.command
  }
  if (Array.isArray(raw.command) && typeof raw.command[0] === 'string') {
    return raw.command[0]
  }
  return undefined
}

function readServerUrl(raw: RawMcpServerConfig): string | undefined {
  if (typeof raw.url === 'string') {
    return raw.url
  }
  if (typeof raw.httpUrl === 'string') {
    return raw.httpUrl
  }
  return undefined
}

function readRemoteTransportKind(raw: RawMcpServerConfig): AgentCoreHttpMcpTransportKind {
  return raw.type === 'sse' ? 'sse' : 'streamable-http'
}

function readServerCwd(args: {
  rootPath: string
  configPath: string
  raw: RawMcpServerConfig
}): string {
  if (typeof args.raw.cwd !== 'string' || args.raw.cwd.length === 0) {
    return args.rootPath
  }
  return resolve(dirname(args.configPath), args.raw.cwd)
}

function createClientFromServer(args: {
  rootPath: string
  configPath: string
  serverName: string
  raw: RawMcpServerConfig
}): AgentCoreMcpClient | null {
  const url = readServerUrl(args.raw)
  if (!isDisabledServer(args.raw) && url !== undefined && args.raw.type !== 'local') {
    return createAgentCoreHttpMcpClient({
      serverName: args.serverName,
      url,
      transportKind: readRemoteTransportKind(args.raw),
      headers: readStringRecord(args.raw.headers)
    })
  }

  if (!isEnabledStdioServer(args.raw)) {
    return null
  }

  const command = readServerCommand(args.raw)
  if (command === undefined) {
    return null
  }

  return createAgentCoreStdioMcpClient({
    serverName: args.serverName,
    command,
    args: readStringArray(args.raw.args),
    env: readStringRecord(args.raw.env),
    cwd: readServerCwd(args)
  })
}

function parseConfigClients(args: {
  rootPath: string
  configPath: string
  candidate: McpConfigCandidate
  content: string
  seenServerNames: Set<string>
}): AgentCoreMcpClient[] {
  const parsed = JSON.parse(args.content) as unknown
  const rawServers = extractObjectAtPath(parsed, args.candidate.serversPath)
  if (rawServers === null) {
    return []
  }

  return createAgentCoreMcpClientsFromServerConfigMap({
    rootPath: args.rootPath,
    configPath: args.configPath,
    servers: rawServers,
    seenServerNames: args.seenServerNames
  })
}

export function createAgentCoreMcpClientsFromServerConfigMap(args: {
  rootPath: string
  configPath: string
  servers: AgentCoreMcpServerConfigMap
  seenServerNames?: Set<string>
}): AgentCoreMcpClient[] {
  const seenServerNames = args.seenServerNames ?? new Set<string>()
  const clients: AgentCoreMcpClient[] = []
  for (const [serverName, raw] of Object.entries(args.servers)) {
    if (seenServerNames.has(serverName)) {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const client = createClientFromServer({
      rootPath: args.rootPath,
      configPath: args.configPath,
      serverName,
      raw: raw as RawMcpServerConfig
    })
    if (client !== null) {
      clients.push(client)
      // 配置按候选顺序读取；同名 server 只保留优先级最高的一个。
      seenServerNames.add(serverName)
    }
  }
  return clients
}

export async function readAgentCoreMcpClientsFromConfig(
  options: AgentCoreMcpConfigClientOptions
): Promise<AgentCoreMcpClient[]> {
  const rootPath = resolve(options.cwd)
  if (!canInspectLocalMcpConfigRoot(rootPath, process.platform === 'win32')) {
    return []
  }

  const clients: AgentCoreMcpClient[] = []
  const seenServerNames = new Set(options.reservedServerNames ?? [])
  for (const entry of listAgentCoreMcpConfigSearchEntries(options)) {
    const content = await readOptionalTextFile(entry.configPath)
    if (content === null) {
      continue
    }
    clients.push(
      ...parseConfigClients({
        rootPath: entry.rootPath,
        configPath: entry.configPath,
        candidate: entry.candidate,
        content,
        seenServerNames
      })
    )
  }
  return clients
}
