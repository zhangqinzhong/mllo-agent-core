export type MlloRuntimeHomeOptions = {
  homePath?: string
  env?: NodeJS.ProcessEnv
}

export type MlloThreadRolloutPathArgs = MlloRuntimeHomeOptions & {
  projectPath: string
  threadId: string
  startedAt: Date | number | string
}

export type MlloThreadRuntimePathArgs = MlloRuntimeHomeOptions & {
  projectPath: string
  threadId: string
}

export type MlloRuntimeHomeLayout = {
  homePath: string
  configPath: string
  historyPath: string
  sessionIndexPath: string
  stateDbPath: string
  logsDbPath: string
  sessionsDir: string
  archivedSessionsDir: string
  projectsDir: string
  memoriesDir: string
  fileHistoryDir: string
  tasksDir: string
  teamsDir: string
  pluginsDir: string
  skillsDir: string
  shellSnapshotsDir: string
  sessionEnvDir: string
  pasteCacheDir: string
  cacheDir: string
}
