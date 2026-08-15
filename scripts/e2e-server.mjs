import { mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const databasePath = resolve(process.env.SYMPOSE_DB_PATH ?? ".tmp/e2e/sympose.db");
if (!databasePath.startsWith(`${root}${sep}`) || !databasePath.endsWith(".db")) {
  throw new Error(`Refusing to use an E2E database outside this Sympose worktree: ${databasePath}`);
}
mkdirSync(dirname(databasePath), { recursive: true });
for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
  rmSync(target, { force: true });
}

const nextBin = resolve("node_modules/next/dist/bin/next");
const child = spawn(
  process.execPath,
  [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "-p", process.env.PORT ?? "3100"],
  {
    cwd: root,
    env: { ...process.env, SYMPOSE_DATA_MODE: "synthetic-evaluator", SYMPOSE_DB_PATH: databasePath },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
