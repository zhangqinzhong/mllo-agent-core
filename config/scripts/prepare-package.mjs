import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(npmCommand, ["run", "clean"]);
run(npmCommand, ["run", "build"]);

const huskyBin = join("node_modules", ".bin", process.platform === "win32" ? "husky.cmd" : "husky");

if (existsSync(".git") && existsSync(".husky") && existsSync(huskyBin)) {
  run(huskyBin, []);
}
