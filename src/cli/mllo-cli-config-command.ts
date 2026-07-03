import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  writeMlloAgentCoreConfig,
  type MlloAgentCoreConfig,
} from "../agent-core/model/agent-core-mllo-config";
import { getMlloRuntimeHomeLayout } from "../agent-core/runtime-home/mllo-home-paths";
import type { MlloCliParsedArgs } from "./mllo-cli-types";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function getMlloCliConfigPath(parsed: MlloCliParsedArgs): string {
  if (parsed.configPath !== undefined) {
    return resolve(parsed.configPath);
  }
  return getMlloRuntimeHomeLayout({ homePath: parsed.homePath }).configPath;
}

export function createMlloCliStarterConfig(): MlloAgentCoreConfig {
  return {
    defaultProvider: "local-openai",
    providers: [
      {
        name: "local-openai",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "local-key",
        model: "local-model",
        promptProfile: "local-compact",
      },
    ],
  };
}

export async function initializeMlloCliConfig(parsed: MlloCliParsedArgs): Promise<string> {
  const configPath = getMlloCliConfigPath(parsed);
  if (!parsed.force && (await pathExists(configPath))) {
    throw new Error(`mllo config already exists: ${configPath}\nUse --force to overwrite it.`);
  }
  await writeMlloAgentCoreConfig(createMlloCliStarterConfig(), configPath);
  return configPath;
}
