import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { computeMlloCommandHookTrustedHash } from "../hooks/agent-core-command-hook-trust";
import {
  MLLO_HOOK_PHASES,
  type MlloHookDraft,
  type MlloHookSaveResult,
  type MlloHookSummary,
} from "../hooks/agent-core-command-hook-protocol";
import type { AgentCoreHttpModelConfig } from "./agent-core-http-model-config";
import { MlloShellPermissionRuleSchema } from "./agent-core-mllo-shell-permission-rule-schema";
import { AGENT_CORE_PROMPT_PROFILES } from "../context/agent-core-prompt-profile";

const MlloModelProviderSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  anthropicVersion: z.string().optional(),
  promptProfile: z.enum(AGENT_CORE_PROMPT_PROFILES).optional(),
});

const MlloCommandHookSchema = z.object({
  name: z.string().min(1),
  phase: z.enum(MLLO_HOOK_PHASES),
  command: z.string().min(1),
  trustedHash: z.string().min(1).optional(),
  matcher: z
    .object({
      toolNames: z.array(z.string().min(1)).optional(),
      filePathGlobs: z.array(z.string().min(1)).optional(),
      cwdGlobs: z.array(z.string().min(1)).optional(),
      userPromptIncludes: z.array(z.string().min(1)).optional(),
      workerIds: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const MlloMcpServersSchema = z.record(z.string(), z.unknown());

const MlloAgentCoreConfigSchema = z.object({
  defaultProvider: z.string().min(1),
  providers: z.array(MlloModelProviderSchema).min(1),
  hooks: z.array(MlloCommandHookSchema).optional(),
  mcpServers: MlloMcpServersSchema.optional(),
  shellPermissionRules: z.array(MlloShellPermissionRuleSchema).optional(),
  requireSandboxedShell: z.boolean().optional(),
});

const PRIVATE_CONFIG_MODE = 0o600;

export type MlloAgentCoreConfig = z.infer<typeof MlloAgentCoreConfigSchema>;
type MlloModelProviderConfig = MlloAgentCoreConfig["providers"][number];
type MlloCommandHookConfig = NonNullable<MlloAgentCoreConfig["hooks"]>[number];

const MlloCommandHookDraftSchema = MlloCommandHookSchema.omit({
  trustedHash: true,
});

export type MlloCommandHookApprovalResult = {
  status: "updated" | "already-trusted";
  hookName: string;
  trustedHash: string;
};

function commandHookTrustStatus(
  hook: MlloCommandHookConfig,
  expectedTrustedHash: string,
): MlloHookSummary["trustStatus"] {
  if (hook.trustedHash === undefined) {
    return "untrusted";
  }
  return hook.trustedHash === expectedTrustedHash ? "trusted" : "changed";
}

// 摘要是设置页和 IPC 的稳定形状，hash 判断只在 main 进程做一次。
function toMlloCommandHookSummary(hook: MlloCommandHookConfig): MlloHookSummary {
  const expectedTrustedHash = computeMlloCommandHookTrustedHash(hook.command);
  const summary: MlloHookSummary = {
    name: hook.name,
    phase: hook.phase,
    command: hook.command,
    trustStatus: commandHookTrustStatus(hook, expectedTrustedHash),
    expectedTrustedHash,
  };
  if (hook.trustedHash !== undefined) {
    summary.trustedHash = hook.trustedHash;
  }
  if (hook.matcher !== undefined) {
    summary.matcher = hook.matcher;
  }
  if (hook.timeoutMs !== undefined) {
    summary.timeoutMs = hook.timeoutMs;
  }
  return summary;
}

// 读取 mllo agent 配置。解析失败要显式报错，避免静默落回错误模型。
export async function readMlloAgentCoreConfig(configPath: string): Promise<MlloAgentCoreConfig> {
  const content = await readFile(configPath, "utf8");
  return MlloAgentCoreConfigSchema.parse(JSON.parse(content));
}

// 写入 mllo agent 配置。创建目录由这里负责，调用方只需要注入明确 configPath。
export async function writeMlloAgentCoreConfig(
  config: MlloAgentCoreConfig,
  configPath: string,
): Promise<void> {
  const parsed = MlloAgentCoreConfigSchema.parse(config);
  await mkdir(dirname(configPath), {
    recursive: true,
  });
  // 迁移配置可能包含明文模型 key，覆盖旧文件后也要收紧权限。
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_CONFIG_MODE,
  });
  await tightenMlloConfigMode(configPath);
}

// 查找唯一 command hook。审批必须定位到单个 hook，避免同名 hook 被误批准。
function findUniqueMlloCommandHook(
  config: MlloAgentCoreConfig,
  hookName: string,
): MlloCommandHookConfig {
  const matches = (config.hooks ?? []).filter((hook) => hook.name === hookName);
  if (matches.length === 0) {
    throw new Error(`mllo command hook not found: ${hookName}`);
  }
  if (matches.length > 1) {
    throw new Error(`mllo command hook name is ambiguous: ${hookName}`);
  }
  return matches[0];
}

// 保存 hook 时清理空 matcher 数组，避免配置文件积累无效字段。
function normalizeMlloCommandHookDraft(draft: MlloHookDraft): MlloCommandHookConfig {
  const parsed = MlloCommandHookDraftSchema.parse(draft);
  const name = parsed.name.trim();
  const command = parsed.command.trim();
  if (name.length === 0) {
    throw new Error("mllo command hook name is required.");
  }
  if (command.length === 0) {
    throw new Error("mllo command hook command is required.");
  }
  const normalized: MlloCommandHookConfig = {
    name,
    phase: parsed.phase,
    command,
  };
  const matcher = parsed.matcher;
  if (matcher !== undefined) {
    const nextMatcher: NonNullable<MlloCommandHookConfig["matcher"]> = {};
    if (matcher.toolNames?.length) {
      nextMatcher.toolNames = matcher.toolNames;
    }
    if (matcher.filePathGlobs?.length) {
      nextMatcher.filePathGlobs = matcher.filePathGlobs;
    }
    if (matcher.cwdGlobs?.length) {
      nextMatcher.cwdGlobs = matcher.cwdGlobs;
    }
    if (matcher.userPromptIncludes?.length) {
      nextMatcher.userPromptIncludes = matcher.userPromptIncludes;
    }
    if (matcher.workerIds?.length) {
      nextMatcher.workerIds = matcher.workerIds;
    }
    if (Object.keys(nextMatcher).length > 0) {
      normalized.matcher = nextMatcher;
    }
  }
  if (parsed.timeoutMs !== undefined) {
    normalized.timeoutMs = parsed.timeoutMs;
  }
  return normalized;
}

// 编辑定位必须唯一；同名 hook 会让 approve 无法判断用户批准的是哪一个。
function findUniqueMlloCommandHookIndex(config: MlloAgentCoreConfig, hookName: string): number {
  const hooks = config.hooks ?? [];
  const matches = hooks
    .map((hook, index) => ({ hook, index }))
    .filter((entry) => entry.hook.name === hookName);
  if (matches.length === 0) {
    return -1;
  }
  if (matches.length > 1) {
    throw new Error(`mllo command hook name is ambiguous: ${hookName}`);
  }
  return matches[0].index;
}

// 批准一个 command hook。它只更新宿主注入的配置文件，不执行 hook command。
export async function approveMlloCommandHookTrustedHash(
  hookName: string,
  configPath: string,
): Promise<MlloCommandHookApprovalResult> {
  const config = await readMlloAgentCoreConfig(configPath);
  const hook = findUniqueMlloCommandHook(config, hookName);
  const trustedHash = computeMlloCommandHookTrustedHash(hook.command);
  if (hook.trustedHash === trustedHash) {
    return {
      status: "already-trusted",
      hookName,
      trustedHash,
    };
  }
  hook.trustedHash = trustedHash;
  await writeMlloAgentCoreConfig(config, configPath);
  return {
    status: "updated",
    hookName,
    trustedHash,
  };
}

// 保存或新增 command hook。命令变更会清掉 trustedHash，强制用户重新确认执行内容。
export async function saveMlloCommandHookConfig(
  draft: MlloHookDraft,
  originalName: string | undefined,
  configPath: string,
): Promise<MlloHookSaveResult> {
  const config = await readMlloAgentCoreConfig(configPath);
  const nextHook = normalizeMlloCommandHookDraft(draft);
  const hooks = [...(config.hooks ?? [])];
  const targetName = originalName?.trim();
  const existingIndex =
    targetName && targetName.length > 0 ? findUniqueMlloCommandHookIndex(config, targetName) : -1;
  if (targetName && targetName.length > 0 && existingIndex < 0) {
    throw new Error(`mllo command hook not found: ${targetName}`);
  }
  const duplicateIndex = hooks.findIndex(
    (hook, index) => hook.name === nextHook.name && index !== existingIndex,
  );
  if (duplicateIndex >= 0) {
    throw new Error(`mllo command hook already exists: ${nextHook.name}`);
  }
  if (existingIndex >= 0) {
    const previous = hooks[existingIndex];
    if (previous.command === nextHook.command && previous.trustedHash !== undefined) {
      nextHook.trustedHash = previous.trustedHash;
    }
    hooks[existingIndex] = nextHook;
  } else {
    hooks.push(nextHook);
  }
  await writeMlloAgentCoreConfig({ ...config, hooks }, configPath);
  return {
    hook: toMlloCommandHookSummary(nextHook),
  };
}

// 列出 command hooks 给设置页使用。调用方拿到的是摘要，不需要重复实现 hash 判断。
export async function listMlloCommandHooks(configPath: string): Promise<MlloHookSummary[]> {
  const config = await readMlloAgentCoreConfig(configPath);
  return (config.hooks ?? []).map(toMlloCommandHookSummary);
}

async function tightenMlloConfigMode(configPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await chmod(configPath, PRIVATE_CONFIG_MODE);
}

// 按名称选择 provider。benchmark/GUI 需要同一份配置跑不同协议对照。
export function getMlloModelProvider(
  config: MlloAgentCoreConfig,
  providerName: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentCoreHttpModelConfig {
  const provider = config.providers.find((candidate) => candidate.name === providerName);
  if (provider === undefined) {
    throw new Error(`mllo provider not found: ${providerName}`);
  }
  return resolveMlloModelProvider(provider, env);
}

// 选择默认 provider。Agent Core 主循环只拿最终模型配置，不关心配置文件结构。
export function getDefaultMlloModelProvider(
  config: MlloAgentCoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): AgentCoreHttpModelConfig {
  return getMlloModelProvider(config, config.defaultProvider, env);
}

function resolveApiKey(provider: MlloModelProviderConfig, env: NodeJS.ProcessEnv): string {
  const apiKey =
    provider.apiKey ?? (provider.apiKeyEnv === undefined ? undefined : env[provider.apiKeyEnv]);
  if (apiKey === undefined || apiKey.trim().length === 0) {
    const source = provider.apiKeyEnv === undefined ? "apiKey" : `apiKeyEnv ${provider.apiKeyEnv}`;
    throw new Error(`mllo provider ${provider.name} is missing API key from ${source}.`);
  }
  return apiKey;
}

function resolveMlloModelProvider(
  provider: MlloModelProviderConfig,
  env: NodeJS.ProcessEnv,
): AgentCoreHttpModelConfig {
  const resolved: AgentCoreHttpModelConfig = {
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: resolveApiKey(provider, env),
    model: provider.model,
  };
  if (provider.maxTokens !== undefined) {
    resolved.maxTokens = provider.maxTokens;
  }
  if (provider.temperature !== undefined) {
    resolved.temperature = provider.temperature;
  }
  if (provider.anthropicVersion !== undefined) {
    resolved.anthropicVersion = provider.anthropicVersion;
  }
  if (provider.promptProfile !== undefined) {
    resolved.promptProfile = provider.promptProfile;
  }
  return resolved;
}

// 从配置文件直接加载默认模型 provider，给 IPC/run controller 使用。
export async function loadDefaultMlloModelProvider(
  configPath: string,
): Promise<AgentCoreHttpModelConfig> {
  return getDefaultMlloModelProvider(await readMlloAgentCoreConfig(configPath));
}
