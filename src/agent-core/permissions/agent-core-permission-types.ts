// Agent Core 的权限模式。默认应从 ask/auto-readonly 起步，bypass 只给显式调试用。
export type AgentCorePermissionMode =
  | 'ask'
  | 'auto-readonly'
  | 'workspace-write'
  | 'dangerously-bypass'

// Agent Core 暴露给模型的能力分类。后续所有工具都要先声明自己属于哪类能力。
export type AgentCoreCapability =
  | 'file-read'
  | 'file-write'
  | 'shell-readonly'
  | 'shell-write'
  | 'network'
  | 'browser'

export type AgentCoreShellPermissionRuleAction = 'allow' | 'ask' | 'deny'

export type AgentCoreShellPermissionRuleMatch = 'exact' | 'prefix'

export type AgentCoreShellPermissionRuleScope = 'global' | 'project'

export type AgentCoreShellPermissionRule = {
  action: AgentCoreShellPermissionRuleAction
  match: AgentCoreShellPermissionRuleMatch
  command: string
  scope?: AgentCoreShellPermissionRuleScope
  cwd?: string
  source?: string
}

export type AgentCorePermissionRisk =
  | {
      kind: 'remote-secret-env'
      severity: 'high'
      title: string
      detail: string
      names: string[]
    }
  | {
      kind: 'destructive-shell-command'
      severity: 'high'
      title: string
      detail: string
      names: string[]
      commandPreview: string
    }
  | {
      kind: 'outside-workspace-shell-read'
      severity: 'high'
      title: string
      detail: string
      names: string[]
      commandPreview: string
      paths: string[]
    }
  | {
      kind: 'sensitive-shell-file-read'
      severity: 'high'
      title: string
      detail: string
      names: string[]
      commandPreview: string
      paths: string[]
    }

// 权限判断结果：允许、需要用户确认、直接拒绝。reason 用来展示到 GUI 和审计日志。
export type AgentCorePermissionDecision =
  | {
      status: 'allow'
      capability: AgentCoreCapability
      reason: string
      risk?: AgentCorePermissionRisk
      suggestedRules?: readonly AgentCoreShellPermissionRule[]
    }
  | {
      status: 'ask'
      capability: AgentCoreCapability
      reason: string
      risk?: AgentCorePermissionRisk
      suggestedRules?: readonly AgentCoreShellPermissionRule[]
    }
  | {
      status: 'deny'
      capability: AgentCoreCapability
      reason: string
      risk?: AgentCorePermissionRisk
      suggestedRules?: readonly AgentCoreShellPermissionRule[]
    }

// 单次 agent run 的权限上下文。它把 cwd、workspace 范围和显式禁区绑定在一起。
export type AgentCorePermissionContext = {
  mode: AgentCorePermissionMode
  cwd: string
  workspaceRoots: string[]
  deniedPaths?: string[]
  shellRules?: readonly AgentCoreShellPermissionRule[]
}

// 文件路径操作类型。读和写对应不同的权限能力。
export type AgentCorePathOperation = 'read' | 'write'
