import { resolve } from 'node:path'

export type AgentCoreShellCwdChange = {
  previousCwd: string
  currentCwd: string
}

// shell cwd 跟踪器。它只影响 shell 命令，不改变 session 的项目根和权限根。
export class AgentCoreShellCwdTracker {
  private currentCwd: string
  private readonly onChange: ((change: AgentCoreShellCwdChange) => void) | undefined

  // shell cwd 和项目根目录分开保存。cd 只影响后续 shell，不改变 workspace 身份。
  constructor(
    initialCwd: string,
    options: { onChange?: (change: AgentCoreShellCwdChange) => void } = {}
  ) {
    this.currentCwd = resolve(initialCwd)
    this.onChange = options.onChange
  }

  // 返回当前 shell 工作目录。runner 每次启动命令前都从这里取值。
  getCwd(): string {
    return this.currentCwd
  }

  // 记录前台命令产生的 cwd 变化。未变化时返回 undefined，避免写无意义事件。
  setCwd(nextCwd: string): AgentCoreShellCwdChange | undefined {
    const resolved = resolve(nextCwd)
    if (resolved === this.currentCwd) {
      return undefined
    }
    const change = {
      previousCwd: this.currentCwd,
      currentCwd: resolved
    }
    this.currentCwd = resolved
    this.onChange?.(change)
    return change
  }
}
