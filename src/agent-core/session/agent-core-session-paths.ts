import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  getMlloHomePath,
  getMlloProjectDir,
  getMlloProjectsDir,
  getMlloThreadRolloutPath
} from '../runtime-home/mllo-home-paths'
import { getMlloProjectKey } from '../runtime-home/mllo-project-key'

function sanitizeSessionIdForRollout(sessionId: string): string {
  const sanitized = sessionId
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (sanitized.length === 0) {
    throw new Error('mllo sessionId is required to find a rollout transcript.')
  }
  return sanitized
}

function isMissingRolloutsDirError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

// 读取 mllo runtime home。core 只接受调用方注入的路径，默认位置由宿主应用决定。
export function getAgentCoreConfigDir(configDir: string): string {
  return getMlloHomePath({
    homePath: configDir
  })
}

// 返回 runtime-home 使用的项目 key，避免 session JSONL 和 state.sqlite 指向不同项目目录。
export function getAgentCoreProjectSlug(cwd: string): string {
  return getMlloProjectKey(resolve(cwd))
}

// 返回所有 Agent Core session 的 project 根目录。目录名按 project 维度组织。
export function getAgentCoreProjectsDir(configDir: string): string {
  return getMlloProjectsDir({
    homePath: getAgentCoreConfigDir(configDir)
  })
}

// 返回某个 cwd 对应的 project session 目录。
export function getAgentCoreProjectDir(cwd: string, configDir: string): string {
  return getMlloProjectDir(resolve(cwd), {
    homePath: getAgentCoreConfigDir(configDir)
  })
}

// 返回单个 session 的 JSONL 路径；新建会话走 rollout，未传 startedAt 时保留旧路径用于兼容恢复。
export function getAgentCoreTranscriptPath(args: {
  cwd: string
  sessionId: string
  configDir: string
  startedAt?: Date | number | string
}): string {
  if (args.startedAt !== undefined) {
    return getMlloThreadRolloutPath({
      homePath: getAgentCoreConfigDir(args.configDir),
      projectPath: resolve(args.cwd),
      threadId: args.sessionId,
      startedAt: args.startedAt
    })
  }
  return join(getAgentCoreProjectDir(args.cwd, args.configDir), `${args.sessionId}.jsonl`)
}

// 恢复会话时优先寻找 runtime-home rollout 文件，找不到再回退早期 session 路径。
export function findAgentCoreTranscriptPath(args: {
  cwd: string
  sessionId: string
  configDir: string
}): string {
  const projectDir = getAgentCoreProjectDir(args.cwd, args.configDir)
  const suffix = `-${sanitizeSessionIdForRollout(args.sessionId)}.jsonl`
  try {
    const matches = readdirSync(join(projectDir, 'rollouts'))
      .filter((fileName) => fileName.endsWith(suffix))
      .sort()
    const newest = matches.at(-1)
    if (newest !== undefined) {
      return join(projectDir, 'rollouts', newest)
    }
  } catch (error) {
    if (!isMissingRolloutsDirError(error)) {
      throw error
    }
    // 没有 rollouts 目录说明是早期会话或空项目，继续走旧路径兼容恢复。
  }
  return getAgentCoreTranscriptPath(args)
}
