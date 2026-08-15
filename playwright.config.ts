import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".tmp/ms-playwright");

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const e2eClockPath = resolve(".tmp/e2e/server-clock.txt");
const e2eClockPreload = resolve("tests/e2e/support/server-clock.cjs");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(port),
      SYMPOSE_DB_PATH: resolve(".tmp/e2e/sympose.db"),
      SYMPOSE_EVALUATOR_PROFILE: "local",
      SYMPOSE_APPLICANT_VERIFICATION_DELIVERY: "simulated",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      SYMPOSE_E2E_CLOCK_PATH: e2eClockPath,
      NODE_OPTIONS: `--require=${e2eClockPreload}`,
    },
  },
});
