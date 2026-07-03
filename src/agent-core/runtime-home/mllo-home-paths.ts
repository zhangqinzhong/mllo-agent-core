import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getMlloProjectKey } from './mllo-project-key'
import type {
  MlloRuntimeHomeLayout,
  MlloRuntimeHomeOptions,
  MlloThreadRuntimePathArgs,
  MlloThreadRolloutPathArgs
} from './mllo-runtime-home-types'

function getRuntimeEnv(options: MlloRuntimeHomeOptions = {}): NodeJS.ProcessEnv {
  return options.env ?? process.env
}

function formatRolloutTimestamp(startedAt: Date | number | string): string {
  const date = startedAt instanceof Date ? startedAt : new Date(startedAt)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid mllo thread rollout timestamp: ${String(startedAt)}`)
  }
  return date.toISOString().replace(/[:.]/g, '-')
}

function sanitizeThreadId(threadId: string): string {
  const sanitized = threadId
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (sanitized.length === 0) {
    throw new Error('mllo threadId is required to build a rollout path.')
  }
  return sanitized
}

// 解析 mllo runtime home 根目录，允许测试和便携安装覆盖默认的 ~/.mllo。
export function getMlloHomePath(options: MlloRuntimeHomeOptions = {}): string {
  const env = getRuntimeEnv(options)
  return resolve(
    options.homePath ?? env.MLLO_HOME ?? env.MLLO_CONFIG_DIR ?? join(homedir(), '.mllo')
  )
}

// 返回 mllo 主配置文件路径，后续模型、权限和 worker 配置都应从这里进入。
export function getMlloConfigPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'config.json')
}

// 返回全局输入历史 JSONL 路径，后续 GUI/CLI 都从这里恢复用户输入历史。
export function getMlloHistoryPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'history.jsonl')
}

// 返回完整 prompt dump 目录；这是显式调试日志，不能混入主 transcript。
export function getMlloDumpPromptsDir(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'dump-prompts')
}

// 返回单个 session 的 prompt dump 路径，文件名沿用 thread/session id 的安全化规则。
export function getMlloDumpPromptsPath(
  sessionId: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloDumpPromptsDir(options), `${sanitizeThreadId(sessionId)}.jsonl`)
}

// 返回会话发现索引 JSONL 路径，避免 GUI 为找会话全量扫描所有 rollout 文件。
export function getMlloSessionIndexPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'session_index.jsonl')
}

// 返回 mllo 状态数据库路径；SQLite 只存索引和当前状态，不替代 JSONL 事实记录。
export function getMlloStateDbPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'state.sqlite')
}

// 返回 mllo 日志数据库路径，避免把运行日志和长期状态混在同一个文件里。
export function getMlloLogsDbPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'logs.sqlite')
}

// 返回活跃 session 索引目录，用于 GUI 发现正在运行或可恢复的 agent 进程。
export function getMlloSessionsDir(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'sessions')
}

// 返回已归档 session 目录，避免历史会话继续污染活跃进程列表。
export function getMlloArchivedSessionsDir(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'archived_sessions')
}

// 返回所有项目 runtime 数据的根目录，按 project 维度组织。
export function getMlloProjectsDir(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'projects')
}

// 返回单个项目的 runtime 目录，确保 project memory、rollout 和任务状态有稳定归属。
export function getMlloProjectDir(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectsDir(options), getMlloProjectKey(projectPath))
}

// 返回单个项目的 memory 目录，避免把 mllo 私有记忆写进仓库 docs。
export function getMlloProjectMemoryDir(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'memory')
}

// 返回全局 memory 目录，存放跨项目的长期偏好和摘要。
export function getMlloMemoriesDir(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloHomePath(options), 'memories')
}

// 返回全局 MEMORY.md 路径，供 context builder 注入长期规则。
export function getMlloGlobalMemoryPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloMemoriesDir(options), 'MEMORY.md')
}

// 返回全局 memory summary 路径，优先注入压缩后的长期摘要。
export function getMlloMemorySummaryPath(options: MlloRuntimeHomeOptions = {}): string {
  return join(getMlloMemoriesDir(options), 'memory_summary.md')
}

// 返回项目 MEMORY.md 路径，项目私有记忆不能写进仓库 docs。
export function getMlloProjectMemoryPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectMemoryDir(projectPath, options), 'MEMORY.md')
}

// 返回项目文件变更历史 JSONL 路径，用于审计 agent 写文件行为。
export function getMlloProjectFileHistoryPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloHomePath(options), 'file-history', `${getMlloProjectKey(projectPath)}.jsonl`)
}

// 返回项目 checkpoint 目录。写工具执行前的快照放这里，避免依赖用户 git 状态。
export function getMlloProjectCheckpointsDir(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'checkpoints')
}

// 返回项目 shell task journal 路径，用于恢复后台 shell 任务列表和输出尾部。
export function getMlloProjectShellTasksPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'shell_tasks.jsonl')
}

// 返回项目 shell 输出目录。远程/SSH 场景下输出和 journal 必须同属项目 runtime home。
export function getMlloProjectShellOutputDir(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'shell-output')
}

// 返回项目 shell cwd 状态路径，用于恢复下一轮 shell 命令的工作目录。
export function getMlloProjectShellCwdPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'shell_cwd.json')
}

// 返回项目 plan journal 路径；无 session 的兼容 run 仍需要可恢复计划。
export function getMlloProjectPlanPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'plan.jsonl')
}

// 返回项目 workflow journal 路径，用于恢复多 agent workflow 的任务状态。
export function getMlloProjectWorkflowRunsPath(
  projectPath: string,
  options: MlloRuntimeHomeOptions = {}
): string {
  return join(getMlloProjectDir(projectPath, options), 'workflow_runs.jsonl')
}

// 返回单个 thread 的运行态目录；shell/workflow/checkpoint 不能在同项目多会话之间串线。
export function getMlloThreadRuntimeDir(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloProjectDir(args.projectPath, args), 'threads', sanitizeThreadId(args.threadId))
}

// 返回 thread 级 checkpoint 目录。正常 agent session 应使用它，project 级路径只做兼容。
export function getMlloThreadCheckpointsDir(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'checkpoints')
}

// 返回 thread 级 file history。project 级 file-history 只用于兼容旧数据和跨 session 聚合。
export function getMlloThreadFileHistoryPath(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'file_history.jsonl')
}

// 返回 thread 级 shell task journal，避免两个会话互相看到后台任务。
export function getMlloThreadShellTasksPath(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'shell_tasks.jsonl')
}

// 返回 thread 级 shell output 目录，后台命令输出跟随 session 生命周期。
export function getMlloThreadShellOutputDir(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'shell-output')
}

// 返回 thread 级 shell cwd 状态。cd 只影响当前会话，不影响同 cwd 的其他会话。
export function getMlloThreadShellCwdPath(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'shell_cwd.json')
}

// 返回 thread 级 plan journal，避免同项目多个会话互相覆盖当前计划。
export function getMlloThreadPlanPath(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'plan.jsonl')
}

// 返回 thread 级 workflow journal，让多 agent workflow 状态绑定发起它的会话。
export function getMlloThreadWorkflowRunsPath(args: MlloThreadRuntimePathArgs): string {
  return join(getMlloThreadRuntimeDir(args), 'workflow_runs.jsonl')
}

// 返回 thread rollout JSONL 路径，append-only 记录用于 resume、compact 和 GUI timeline 重建。
export function getMlloThreadRolloutPath(args: MlloThreadRolloutPathArgs): string {
  const timestamp = formatRolloutTimestamp(args.startedAt)
  return join(
    getMlloProjectDir(args.projectPath, args),
    'rollouts',
    `${timestamp}-${sanitizeThreadId(args.threadId)}.jsonl`
  )
}

// 汇总 runtime home 第一批稳定路径，减少调用方各自拼目录导致结构漂移。
export function getMlloRuntimeHomeLayout(
  options: MlloRuntimeHomeOptions = {}
): MlloRuntimeHomeLayout {
  const homePath = getMlloHomePath(options)
  return {
    homePath,
    configPath: join(homePath, 'config.json'),
    historyPath: join(homePath, 'history.jsonl'),
    sessionIndexPath: join(homePath, 'session_index.jsonl'),
    stateDbPath: join(homePath, 'state.sqlite'),
    logsDbPath: join(homePath, 'logs.sqlite'),
    sessionsDir: join(homePath, 'sessions'),
    archivedSessionsDir: join(homePath, 'archived_sessions'),
    projectsDir: join(homePath, 'projects'),
    memoriesDir: join(homePath, 'memories'),
    fileHistoryDir: join(homePath, 'file-history'),
    tasksDir: join(homePath, 'tasks'),
    teamsDir: join(homePath, 'teams'),
    pluginsDir: join(homePath, 'plugins'),
    skillsDir: join(homePath, 'skills'),
    shellSnapshotsDir: join(homePath, 'shell_snapshots'),
    sessionEnvDir: join(homePath, 'session-env'),
    pasteCacheDir: join(homePath, 'paste-cache'),
    cacheDir: join(homePath, 'cache')
  }
}
