import { createHash } from 'node:crypto'

// 计算 command hook 的信任 hash。先只绑定 command 文本，后续审批 UI 可展示同一值。
export function computeMlloCommandHookTrustedHash(command: string): string {
  return `sha256:${createHash('sha256').update(command).digest('hex')}`
}
