import { mkdir } from 'node:fs/promises'
import { getMlloRuntimeHomeLayout } from './mllo-home-paths'
import type { MlloRuntimeHomeLayout, MlloRuntimeHomeOptions } from './mllo-runtime-home-types'

function getInitialRuntimeDirs(layout: MlloRuntimeHomeLayout): string[] {
  return [
    layout.homePath,
    layout.sessionsDir,
    layout.archivedSessionsDir,
    layout.projectsDir,
    layout.memoriesDir,
    layout.fileHistoryDir,
    layout.tasksDir,
    layout.teamsDir,
    layout.pluginsDir,
    layout.skillsDir,
    layout.shellSnapshotsDir,
    layout.sessionEnvDir,
    layout.pasteCacheDir,
    layout.cacheDir
  ]
}

// 初始化 mllo runtime home 的第一批目录，只补齐缺失目录，不删除或覆盖用户已有数据。
export async function ensureMlloRuntimeHome(
  options: MlloRuntimeHomeOptions = {}
): Promise<MlloRuntimeHomeLayout> {
  const layout = getMlloRuntimeHomeLayout(options)
  for (const dir of getInitialRuntimeDirs(layout)) {
    await mkdir(dir, {
      recursive: true
    })
  }
  return layout
}
