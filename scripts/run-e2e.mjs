import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const temporaryPath = resolve(".tmp/playwright");
const browsersPath = resolve(".tmp/ms-playwright");
mkdirSync(temporaryPath, { recursive: true });

const result = spawnSync(
  process.execPath,
  [resolve("node_modules/@playwright/test/cli.js"), "test", ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TMPDIR: temporaryPath,
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
