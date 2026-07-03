import { z } from 'zod'
import type {
  AgentCorePermissionContext,
  AgentCorePermissionDecision
} from '../permissions/agent-core-permission-types'
import type {
  AgentCoreToolAvailabilityPolicy,
  AgentCoreToolDefinition,
  AgentCoreToolResult
} from '../tools/agent-core-tool-types'
import type {
  AgentCoreMcpClient,
  AgentCoreMcpToolCallRequest,
  AgentCoreMcpToolDescriptor
} from './agent-core-mcp-client-types'
import { formatAgentCoreMcpToolResult } from './agent-core-mcp-tool-result'

const callMcpToolInputSchema = z.object({
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional()
})

export type AgentCoreMcpToolsOptions = {
  permissionContext: AgentCorePermissionContext
  clients: readonly AgentCoreMcpClient[]
}

function validationErrorResult(error: z.ZodError): AgentCoreToolResult {
  return {
    content: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
    isError: true
  }
}

function clientLabel(client: AgentCoreMcpClient): string {
  return client.label ?? client.serverName
}

function findMcpClient(
  clients: readonly AgentCoreMcpClient[],
  serverName: string
): AgentCoreMcpClient | undefined {
  return clients.find((client) => client.serverName === serverName)
}

function describeMcpClients(clients: readonly AgentCoreMcpClient[]): string {
  return clients.length === 0
    ? 'none'
    : clients.map((client) => `${client.serverName}: ${clientLabel(client)}`).join('\n')
}

function mcpCallPermission(args: {
  context: AgentCorePermissionContext
  serverName: string
  toolName: string
}): AgentCorePermissionDecision {
  if (args.context.mode === 'dangerously-bypass') {
    return {
      status: 'allow',
      capability: 'network',
      reason: `Dangerously bypass mode allows MCP tool ${args.serverName}/${args.toolName}.`
    }
  }
  return {
    status: 'ask',
    capability: 'network',
    reason: `Calling MCP tool ${args.serverName}/${args.toolName} can run external code or network actions.`
  }
}

async function checkClientAvailability(client: AgentCoreMcpClient): Promise<string | null> {
  const check = client.availability?.check
  if (check === undefined) {
    return null
  }
  try {
    const result = await check()
    return result.available ? null : (result.reason ?? 'No reason provided.')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function createMcpToolsAvailability(
  clients: readonly AgentCoreMcpClient[]
): AgentCoreToolAvailabilityPolicy {
  return {
    ttlMs: Math.min(...clients.map((client) => client.availability?.ttlMs ?? 60_000)),
    failureGraceMs: Math.max(
      ...clients.map((client) => client.availability?.failureGraceMs ?? 5 * 60_000)
    ),
    async check() {
      const unavailable: string[] = []
      for (const client of clients) {
        const reason = await checkClientAvailability(client)
        if (reason !== null) {
          unavailable.push(`${client.serverName}: ${reason}`)
        }
      }
      return unavailable.length === clients.length
        ? {
            available: false,
            reason: `All MCP clients are unavailable. ${unavailable.join('; ')}`
          }
        : {
            available: true,
            reason:
              unavailable.length === 0
                ? 'At least one MCP client is configured.'
                : `Some MCP clients are unavailable. ${unavailable.join('; ')}`
          }
    }
  }
}

function formatMcpToolDescriptor(args: {
  client: AgentCoreMcpClient
  tool: AgentCoreMcpToolDescriptor
}): string {
  const description =
    args.tool.description === undefined || args.tool.description.length === 0
      ? 'No description.'
      : args.tool.description
  const schema =
    args.tool.inputSchema === undefined
      ? 'inputSchema: none'
      : `inputSchema: ${JSON.stringify(args.tool.inputSchema)}`
  return [
    `server: ${args.client.serverName}`,
    `tool: ${args.tool.name}`,
    `description: ${description}`,
    schema
  ].join('\n')
}

async function listMcpTools(clients: readonly AgentCoreMcpClient[]): Promise<AgentCoreToolResult> {
  const sections: string[] = []
  for (const client of clients) {
    const unavailable = await checkClientAvailability(client)
    if (unavailable !== null) {
      sections.push(`server: ${client.serverName}\nstatus: unavailable\nreason: ${unavailable}`)
      continue
    }
    try {
      const tools = await client.listTools()
      sections.push(
        tools.length === 0
          ? `server: ${client.serverName}\nstatus: available\ntools: none`
          : tools.map((tool) => formatMcpToolDescriptor({ client, tool })).join('\n\n')
      )
    } catch (error) {
      sections.push(
        `server: ${client.serverName}\nstatus: error\nreason: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return {
    content: sections.length === 0 ? 'No MCP clients are configured.' : sections.join('\n\n---\n\n')
  }
}

export function createAgentCoreListMcpToolsTool(
  options: AgentCoreMcpToolsOptions
): AgentCoreToolDefinition {
  return {
    name: 'list_mcp_tools',
    description: [
      'List tools exposed by configured MCP clients.',
      'Configured MCP clients:',
      describeMcpClients(options.clients)
    ].join('\n'),
    availability: createMcpToolsAvailability(options.clients),
    isConcurrencySafe: () => true,
    async run() {
      return await listMcpTools(options.clients)
    }
  }
}

export function createAgentCoreCallMcpTool(
  options: AgentCoreMcpToolsOptions
): AgentCoreToolDefinition {
  return {
    name: 'call_mcp_tool',
    description: [
      'Call a tool on a configured MCP client.',
      'Use list_mcp_tools first to discover available serverName/toolName pairs.',
      'Configured MCP clients:',
      describeMcpClients(options.clients)
    ].join('\n'),
    inputSchema: callMcpToolInputSchema,
    availability: createMcpToolsAvailability(options.clients),
    evaluatePermission(input) {
      const parsed = callMcpToolInputSchema.safeParse(input)
      return parsed.success
        ? mcpCallPermission({
            context: options.permissionContext,
            serverName: parsed.data.serverName,
            toolName: parsed.data.toolName
          })
        : {
            status: 'deny',
            capability: 'network',
            reason: 'Invalid call_mcp_tool input.'
          }
    },
    async run(input, context) {
      const parsed = callMcpToolInputSchema.safeParse(input)
      if (!parsed.success) {
        return validationErrorResult(parsed.error)
      }
      const client = findMcpClient(options.clients, parsed.data.serverName)
      if (client === undefined) {
        return {
          content: `MCP client is not configured: ${parsed.data.serverName}`,
          isError: true
        }
      }
      const unavailable = await checkClientAvailability(client)
      if (unavailable !== null) {
        return {
          content: `MCP client is unavailable: ${client.serverName}. ${unavailable}`,
          isError: true
        }
      }
      const request: AgentCoreMcpToolCallRequest = {
        toolName: parsed.data.toolName
      }
      if (parsed.data.arguments !== undefined) {
        request.arguments = parsed.data.arguments
      }
      if (context.signal !== undefined) {
        request.signal = context.signal
      }
      const result = await client.callTool(request)
      const toolResult: AgentCoreToolResult = {
        content: formatAgentCoreMcpToolResult(result)
      }
      if (result.isError !== undefined) {
        toolResult.isError = result.isError
      }
      return toolResult
    }
  }
}
