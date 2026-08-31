#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;
const temporaryRoot = await mkdtemp(join(tmpdir(), "mllo-agent-core-pack-"));
const packageDirectory = join(temporaryRoot, "package");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });

  const packResult = run(
    npmCommand,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packageDirectory],
    { cwd: repoRoot, captureOutput: true },
  );
  const packEntries = JSON.parse(packResult.stdout);
  const packedFile = packEntries[0]?.filename;

  if (typeof packedFile !== "string" || packedFile.length === 0) {
    fail("npm pack did not report the generated tarball filename.");
  }

  const tarballPath = join(packageDirectory, packedFile);
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "mllo-agent-core-package-smoke",
        version: "0.0.0",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerDirectory, "smoke.cjs"),
    `"use strict";

const assert = require("node:assert/strict");

const entrypoints = [
  [".", require("@mllo/agent-core")],
  ["./codex-cli", require("@mllo/agent-core/codex-cli")],
  ["./observer", require("@mllo/agent-core/observer")],
  ["./desktop-host", require("@mllo/agent-core/desktop-host")],
];

for (const [entrypoint, exports] of entrypoints) {
  assert.equal(typeof exports, "object", entrypoint + " must export an object");
  assert.ok(Object.keys(exports).length > 0, entrypoint + " must expose runtime exports");
}

const manifest = require("@mllo/agent-core/package.json");
assert.equal(manifest.name, "@mllo/agent-core");
assert.equal(manifest.version, ${JSON.stringify(packageJson.version)});
assert.equal(typeof entrypoints[0][1].runAgentCoreQueryLoop, "function");
assert.equal(entrypoints[0][1].MLLO_AGENT_CORE_VERSION, manifest.version);
assert.equal(typeof require.resolve("@mllo/agent-core/claude-sdk"), "string");

console.log(
  "Package imports passed for " + manifest.name + "@" + manifest.version + ".",
);
`,
  );

  run(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumerDirectory,
  });
  run(nodeCommand, ["smoke.cjs"], { cwd: consumerDirectory });

  const claudeSdkPackage = "@anthropic-ai/claude-agent-sdk";
  const claudeSdkVersion = packageJson.devDependencies?.[claudeSdkPackage];

  if (typeof claudeSdkVersion !== "string") {
    fail(`${claudeSdkPackage} must be available to test its optional integration.`);
  }

  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-audit",
      "--no-fund",
      `${claudeSdkPackage}@${claudeSdkVersion}`,
    ],
    { cwd: consumerDirectory },
  );
  run(
    nodeCommand,
    [
      "-e",
      'const sdk = require("@mllo/agent-core/claude-sdk"); if (typeof sdk.createClaudeSdkWorker !== "function") process.exit(1);',
    ],
    { cwd: consumerDirectory },
  );

  const cliPath = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mllo.cmd" : "mllo",
  );
  const cliResult = run(cliPath, ["--help"], {
    cwd: consumerDirectory,
    captureOutput: true,
  });

  if (!cliResult.stdout.includes("mllo")) {
    fail("The installed mllo CLI did not return its help output.");
  }

  console.log(
    `Installed package smoke test passed for ${packageJson.name}@${packageJson.version}.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const { captureOutput = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: captureOutput ? "pipe" : "inherit",
    shell: false,
    ...spawnOptions,
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (captureOutput) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
