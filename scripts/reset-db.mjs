import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

process.env.SYMPOSE_DATA_MODE ??= "synthetic-evaluator";
if (process.env.SYMPOSE_DATA_MODE !== "synthetic-evaluator") {
  throw new Error("Refusing to reset a database outside synthetic-evaluator mode");
}

const root = resolve(process.cwd());
const databasePath = resolve(process.env.SYMPOSE_DB_PATH ?? "data/sympose.db");

if (!databasePath.startsWith(`${root}${sep}`) || !databasePath.endsWith(".db")) {
  throw new Error(`Refusing to reset database outside this Sympose worktree: ${databasePath}`);
}

for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
  rmSync(target, { force: true });
}

process.stdout.write(`Reset local synthetic database: ${databasePath}\n`);
