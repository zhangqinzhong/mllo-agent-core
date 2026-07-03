import type { AgentCorePermissionRisk } from './agent-core-permission-types'

type AgentCoreSensitiveShellFileReadRisk = Extract<
  AgentCorePermissionRisk,
  { kind: 'sensitive-shell-file-read' }
>

const READ_PATH_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'grep', 'rg', 'wc'])
const SENSITIVE_BASENAME_RE =
  /(^|[/\\])(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_rsa|id_ed25519|known_hosts)$/i
const SENSITIVE_EXTENSION_RE = /\.(?:key|pem|p12|pfx|crt|cer)$/i

function shellTokens(command: string): string[] {
  return (
    command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ??
    []
  )
}

function isFlag(token: string): boolean {
  return token.startsWith('-')
}

function isSensitivePathToken(token: string): boolean {
  if (token.length === 0 || isFlag(token)) {
    return false
  }
  return SENSITIVE_BASENAME_RE.test(token) || SENSITIVE_EXTENSION_RE.test(token)
}

export function createAgentCoreShellSensitiveFileReadRisk(args: {
  command: string
  commandPreview: string
}): AgentCoreSensitiveShellFileReadRisk | undefined {
  const tokens = shellTokens(args.command)
  const commandName = tokens[0]
  if (commandName === undefined || !READ_PATH_COMMANDS.has(commandName)) {
    return undefined
  }
  const paths = tokens.slice(1).filter(isSensitivePathToken)
  if (paths.length === 0) {
    return undefined
  }
  return {
    kind: 'sensitive-shell-file-read',
    severity: 'high',
    title: 'Sensitive file read',
    detail: 'This shell command reads files that commonly contain credentials or secrets.',
    names: paths,
    commandPreview: args.commandPreview,
    paths
  }
}
