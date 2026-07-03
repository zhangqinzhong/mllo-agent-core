import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type PackageJson = {
  version?: string;
};

function readVersionAt(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function readMlloCliPackageVersion(startDir: string): string {
  let currentDir = startDir;
  while (true) {
    const packagePath = join(currentDir, "package.json");
    if (existsSync(packagePath)) {
      return readVersionAt(packagePath) ?? "0.0.0";
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return "0.0.0";
    }
    currentDir = parentDir;
  }
}
