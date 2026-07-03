import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AgentCoreProjectInstruction = {
  source: 'AGENTS.md'
  path: string
  content: string
}

// 读取 workspace root 下的 AGENTS.md。第一版只读 root，后续再补层级覆盖规则。
export async function readAgentCoreProjectInstructions(args: {
  workspaceRoots: readonly string[]
}): Promise<AgentCoreProjectInstruction[]> {
  const instructions: AgentCoreProjectInstruction[] = []
  for (const root of args.workspaceRoots) {
    const path = join(root, 'AGENTS.md')
    try {
      instructions.push({
        source: 'AGENTS.md',
        path,
        content: await readFile(path, 'utf8')
      })
    } catch {
      // AGENTS.md 是可选项目规则文件；不存在或不可读时不阻塞 agent run。
    }
  }
  return instructions
}
