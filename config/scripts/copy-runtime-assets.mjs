#!/usr/bin/env node

import { cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const assets = [
  {
    source: resolve("src/agent-core/tools/vendor"),
    target: resolve("dist/src/agent-core/tools/vendor"),
  },
];

for (const asset of assets) {
  if (!existsSync(asset.source)) {
    continue;
  }
  await cp(asset.source, asset.target, {
    recursive: true,
  });
}
