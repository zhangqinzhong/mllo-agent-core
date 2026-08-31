#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const DEFAULT_STATE_PATH = join(homedir(), ".mllo", "claude-code-trace-proxy-state.json");
const DEFAULT_PROXY_URL = "http://127.0.0.1:43111";
const DEFAULT_UPSTREAM_URL = "https://api.deepseek.com/anthropic";

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const parsed = {
    command,
    settingsPath: DEFAULT_SETTINGS_PATH,
    statePath: DEFAULT_STATE_PATH,
    proxyUrl: DEFAULT_PROXY_URL,
    upstreamUrl: undefined,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--settings") {
      parsed.settingsPath = requireValue(flag, value);
      index += 1;
      continue;
    }
    if (flag === "--state") {
      parsed.statePath = requireValue(flag, value);
      index += 1;
      continue;
    }
    if (flag === "--proxy-url") {
      parsed.proxyUrl = requireValue(flag, value);
      index += 1;
      continue;
    }
    if (flag === "--upstream") {
      parsed.upstreamUrl = requireValue(flag, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return parsed;
}

function requireValue(flag, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node scripts/configure-claude-code-trace-proxy.mjs enable [--proxy-url URL] [--upstream URL]
  node scripts/configure-claude-code-trace-proxy.mjs restore [--upstream URL]
  node scripts/configure-claude-code-trace-proxy.mjs status

Defaults:
  proxy-url: ${DEFAULT_PROXY_URL}
  upstream:  ${DEFAULT_UPSTREAM_URL}`);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readEnv(settings) {
  if (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env)) {
    settings.env = {};
  }
  return settings.env;
}

function assertUrl(label, value) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL: ${value}`);
  }
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

async function backupSettings(settingsPath) {
  const backupPath = join(
    homedir(),
    ".mllo",
    "claude-settings-backups",
    `settings.${timestampForFile()}.json`,
  );
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(settingsPath, backupPath);
  return backupPath;
}

async function readState(path) {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function enableTraceProxy(args) {
  assertUrl("proxy-url", args.proxyUrl);
  if (args.upstreamUrl !== undefined) {
    assertUrl("upstream", args.upstreamUrl);
  }
  const settings = await readJsonFile(args.settingsPath);
  const env = readEnv(settings);
  const currentBaseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
  const upstreamUrl =
    args.upstreamUrl ??
    (currentBaseUrl !== "" && currentBaseUrl !== args.proxyUrl
      ? currentBaseUrl
      : DEFAULT_UPSTREAM_URL);

  if (currentBaseUrl === args.proxyUrl) {
    console.log(`Already enabled: ANTHROPIC_BASE_URL=${args.proxyUrl}`);
    return;
  }

  const backupPath = await backupSettings(args.settingsPath);
  env.ANTHROPIC_BASE_URL = args.proxyUrl;
  await writeJsonFile(args.settingsPath, settings);
  await writeJsonFile(args.statePath, {
    settingsPath: args.settingsPath,
    proxyUrl: args.proxyUrl,
    upstreamUrl,
    previousBaseUrl: currentBaseUrl,
    backupPath,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Enabled Claude Code trace proxy: ${args.proxyUrl}`);
  console.log(`Upstream to use when starting mllo observer: ${upstreamUrl}`);
  console.log(`Backup: ${backupPath}`);
}

async function restoreDirectUpstream(args) {
  const settings = await readJsonFile(args.settingsPath);
  const env = readEnv(settings);
  const state = await readState(args.statePath);
  const restoreUrl = args.upstreamUrl ?? state?.previousBaseUrl ?? DEFAULT_UPSTREAM_URL;
  assertUrl("restore upstream", restoreUrl);
  const backupPath = await backupSettings(args.settingsPath);
  env.ANTHROPIC_BASE_URL = restoreUrl;
  await writeJsonFile(args.settingsPath, settings);
  await rm(args.statePath, { force: true });
  console.log(`Restored Claude Code upstream: ${restoreUrl}`);
  console.log(`Backup: ${backupPath}`);
}

async function printStatus(args) {
  const settings = await readJsonFile(args.settingsPath);
  const env = readEnv(settings);
  const state = await readState(args.statePath);
  console.log(`settings: ${args.settingsPath}`);
  console.log(`ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL ?? "(unset)"}`);
  console.log(`state: ${state === undefined ? "(none)" : args.statePath}`);
  if (state !== undefined) {
    console.log(`proxy-url: ${state.proxyUrl}`);
    console.log(`upstream: ${state.upstreamUrl}`);
    console.log(`previous: ${state.previousBaseUrl || "(unset)"}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printUsage();
    return;
  }
  if (args.command === "enable") {
    await enableTraceProxy(args);
    return;
  }
  if (args.command === "restore") {
    await restoreDirectUpstream(args);
    return;
  }
  if (args.command === "status") {
    await printStatus(args);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
