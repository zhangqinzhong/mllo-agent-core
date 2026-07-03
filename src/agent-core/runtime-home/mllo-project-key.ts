import { resolve } from 'node:path'

// 为项目目录生成稳定 key，确保同一个 cwd 的 runtime 数据不会随 UI 标题变化。
export function getMlloProjectKey(projectPath: string): string {
  const resolved = resolve(projectPath).normalize('NFC')
  const withoutDriveColon = resolved.replace(/^[A-Za-z]:/, (drive) =>
    drive.slice(0, 1).toLowerCase()
  )
  const key = withoutDriveColon
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-+$/g, '')
  return key.length === 0 ? 'workspace' : key
}
