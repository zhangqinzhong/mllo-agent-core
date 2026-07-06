#!/usr/bin/env node

const input = await readStdin();
const entries = JSON.parse(input);
const pack = entries[0];

if (!pack || !Array.isArray(pack.files)) {
  fail("npm pack did not return the expected file list.");
}

const packedPaths = new Set(pack.files.map((file) => file.path));
const requiredPaths = [
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "docs/ARCHITECTURE.md",
  "docs/EMBEDDING.md",
  "docs/RUNTIME_CONTRACT.md",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/cli/mllo-cli.js",
  "dist/src/observer/index.js",
  "dist/src/agent-core/tools/vendor/ripgrep/arm64-darwin/rg",
  "dist/src/agent-core/tools/vendor/ripgrep/x64-darwin/rg",
];

for (const requiredPath of requiredPaths) {
  if (!packedPaths.has(requiredPath)) {
    fail(`Package is missing required file: ${requiredPath}`);
  }
}

const forbiddenPatterns = [
  /^notes\//,
  /^tests\//,
  /^src\//,
  /^config\//,
  /^\.github\//,
  /^\.husky\//,
  /^\.idea\//,
  /\.jsonl$/,
  /\.sqlite(?:-|$)/,
  /^\.env(?:\.|$)/,
];

for (const packedPath of packedPaths) {
  if (forbiddenPatterns.some((pattern) => pattern.test(packedPath))) {
    fail(`Package includes a development-only file: ${packedPath}`);
  }
}

console.log(
  `Package check passed: ${pack.name}@${pack.version} includes ${pack.files.length} files.`,
);

async function readStdin() {
  let data = "";

  for await (const chunk of process.stdin) {
    data += chunk;
  }

  return data;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
