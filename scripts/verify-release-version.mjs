#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (typeof releaseTag !== "string" || releaseTag.length === 0) {
  fail("Usage: node scripts/verify-release-version.mjs v<package-version>");
}

const semverTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!semverTagPattern.test(releaseTag)) {
  fail(`Release tag must use semantic versioning with a v prefix: ${releaseTag}`);
}

const packageJson = JSON.parse(await readFile(joinFromRoot("package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(joinFromRoot("package-lock.json"), "utf8"));
const tagVersion = releaseTag.slice(1);
const lockedVersion = packageLock.packages?.[""]?.version;

if (packageJson.version !== tagVersion) {
  fail(`Release tag ${releaseTag} does not match package.json version ${packageJson.version}.`);
}

if (packageLock.version !== tagVersion || lockedVersion !== tagVersion) {
  fail(
    `package-lock.json versions (${packageLock.version}, ${lockedVersion}) do not match ${tagVersion}.`,
  );
}

console.log(`Release version verified: ${packageJson.name}@${tagVersion} (${releaseTag}).`);

function joinFromRoot(path) {
  return resolve(repoRoot, path);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
