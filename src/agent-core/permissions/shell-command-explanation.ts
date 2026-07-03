const READONLY_COMMANDS = new Set([
  'cat',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'sed',
  'tail',
  'tree',
  'wc'
])

const READONLY_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'remote',
  'rev-parse',
  'show',
  'status'
])

const MUTATING_COMMANDS = new Set([
  'chmod',
  'chown',
  'cp',
  'install',
  'mkdir',
  'mv',
  'npm',
  'pnpm',
  'rm',
  'rmdir',
  'sudo',
  'touch',
  'yarn'
])

const SHELL_CONTROL_RE = /(^|[^\\])(?:>>?|<<?|[;&|])/
const COMMAND_SUBSTITUTION_RE = /`|\$\(|\$\{/
const BLOCKING_SLEEP_RE = /^sleep\s+(\d+(?:\.\d+)?)\s*(?:(?:&&|;)\s*(.+))?$/

export type AgentCoreShellCommandRisk =
  | 'empty'
  | 'blocking-sleep'
  | 'command-substitution'
  | 'shell-control'
  | 'readonly'
  | 'mutating'
  | 'unknown'

export type AgentCoreShellCommandExplanation = {
  commandPreview: string
  firstWord: string
  gitSubcommand: string | null
  risk: AgentCoreShellCommandRisk
  readonlyCommand: boolean
  reason: string
}

// 截断命令用于权限解释。权限弹窗需要可读，但不能让超长命令撑爆 UI。
export function previewAgentCoreShellCommand(command: string): string {
  return command.length > 120 ? `${command.slice(0, 120)}...` : command
}

// 取 shell 命令的第一个词，用来做第一层命令分类；复杂 shell 语义不在这里展开。
function firstShellWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

// 读取 git 的子命令，例如 `git status` 会返回 status；非 git 命令返回 null。
function gitSubcommand(command: string): string | null {
  const parts = command.trim().split(/\s+/)
  return parts[0] === 'git' ? (parts[1] ?? null) : null
}

// 前台 sleep 会让 agent 原地等待；长等待应转成后台任务或直接轮询状态。
export function detectAgentCoreBlockingSleepPattern(command: string): string | null {
  const match = command.trim().match(BLOCKING_SLEEP_RE)
  if (match === null) {
    return null
  }
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds < 2) {
    return null
  }
  const rest = match[2]?.trim()
  return rest === undefined || rest.length === 0
    ? `standalone sleep ${match[1]}`
    : `sleep ${match[1]} followed by: ${rest}`
}

function isReadonlyGitCommand(command: string): boolean {
  const subcommand = gitSubcommand(command)
  if (subcommand === null || !READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false
  }
  if (/\s--output(?:=|\s)/.test(command)) {
    return false
  }
  if (subcommand === 'branch') {
    // `git branch` 默认是查看，但删除/移动分支会修改 repo 状态，不能自动放行。
    return !/\s(?:-[A-Za-z]*[dDmMcC]|--delete|--move|--copy|--set-upstream-to|--unset-upstream)\b/.test(
      command
    )
  }
  if (subcommand === 'remote') {
    // 只允许 remote 的查看类子命令；add/remove/set-url 会改仓库配置。
    return /\bgit\s+remote(?:\s+(?:-v|show|get-url)\b|\s*$)/.test(command)
  }
  return true
}

function hasUsuallyReadonlyWriteBehavior(command: string): boolean {
  const first = firstShellWord(command)
  if (first === 'find') {
    // find 本身是遍历，但 -delete/-exec/-ok 能写文件或执行任意子命令。
    return /\s-(?:delete|exec|execdir|ok|okdir)\b/.test(command)
  }
  if (first === 'sed') {
    return /(?:^|\s)(?:-[A-Za-z]*i[^\s]*|--in-place(?:=|\s|$))/.test(command)
  }
  if (first === 'rg') {
    // ripgrep --pre 会执行外部预处理命令，不能当普通只读搜索处理。
    return /\s--pre(?:=|\s)/.test(command)
  }
  return false
}

// 判断命令是否属于可自动放行的只读命令。sed -i 这种会写文件，所以单独排除。
function isReadonlyCommand(command: string): boolean {
  const first = firstShellWord(command)
  if (first === 'git') {
    return isReadonlyGitCommand(command)
  }
  if (hasUsuallyReadonlyWriteBehavior(command)) {
    return false
  }
  return READONLY_COMMANDS.has(first)
}

// 判断命令是否明显会修改系统或 workspace。未知命令不在这里判定，交给外层 ask。
function isMutatingCommand(command: string): boolean {
  const first = firstShellWord(command)
  return (
    MUTATING_COMMANDS.has(first) ||
    hasUsuallyReadonlyWriteBehavior(command) ||
    (first === 'git' && !isReadonlyCommand(command))
  )
}

// 分析 shell 命令风险。这个函数不看权限模式，方便 GUI 和审计复用同一份 explain。
export function explainAgentCoreShellCommand(command: string): AgentCoreShellCommandExplanation {
  const trimmed = command.trim()
  const preview = previewAgentCoreShellCommand(trimmed)
  const firstWord = firstShellWord(trimmed)
  const subcommand = gitSubcommand(trimmed)
  if (trimmed.length === 0) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'empty',
      readonlyCommand: false,
      reason: 'Empty shell commands are not executable.'
    }
  }
  const blockingSleep = detectAgentCoreBlockingSleepPattern(trimmed)
  if (blockingSleep !== null) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'blocking-sleep',
      readonlyCommand: false,
      reason: `Blocking foreground sleep is not useful for agent progress: ${blockingSleep}`
    }
  }
  if (COMMAND_SUBSTITUTION_RE.test(trimmed)) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'command-substitution',
      readonlyCommand: false,
      reason: `Command substitution can execute hidden shell code and requires approval: ${preview}`
    }
  }
  if (SHELL_CONTROL_RE.test(trimmed)) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'shell-control',
      readonlyCommand: false,
      reason: `Shell control operators, pipes, or redirects require approval: ${preview}`
    }
  }
  if (isReadonlyCommand(trimmed)) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'readonly',
      readonlyCommand: true,
      reason: `Recognized read-only shell command: ${preview}`
    }
  }
  if (isMutatingCommand(trimmed)) {
    return {
      commandPreview: preview,
      firstWord,
      gitSubcommand: subcommand,
      risk: 'mutating',
      readonlyCommand: false,
      reason: `Command may modify the workspace or environment and requires approval: ${preview}`
    }
  }
  return {
    commandPreview: preview,
    firstWord,
    gitSubcommand: subcommand,
    risk: 'unknown',
    readonlyCommand: false,
    reason: `Unknown shell command requires approval before execution: ${preview}`
  }
}
