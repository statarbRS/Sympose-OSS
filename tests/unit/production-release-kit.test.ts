import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_MANIFEST_SCHEMA,
  BUILD_RECEIPT_SCHEMA,
  CONFIG_SCHEMA,
  PRODUCTION_CONFIG_SCHEMA,
  PRODUCTION_STATE_SCHEMA,
  RECEIPT_SCHEMA,
  RESTORE_CRASH_PHASES,
  ReleaseKitError,
  acquireOperationLock,
  canonicalJson,
  createBackup,
  createProductionStartPlan,
  exactFullSha,
  initializeState,
  parseReleaseConfig,
  productionServerExitCode,
  recoverInterruptedRestore,
  recordRunningVerification,
  releaseOperationLock,
  requestExactHealth,
  restoreBackup,
  restoreConfirmationToken,
  runProductionBuild,
  startProductionRelease,
  terminateOwnedChild,
  validateReceiptPayload,
  validateStateLayout,
  verifyBackupDirectory,
  verifyDependencies,
  verifyGitCandidate,
  verifyProductionBuild,
  verifyRunningRelease,
  waitForOperationLock,
  waitForExactHealth,
  waitForStartupOutcome,
} from "../../scripts/production-release/lib.mjs";

type ReleaseConfig = ReturnType<typeof parseReleaseConfig>;

type BuildResult = Readonly<{
  receipt: Readonly<{
    schema: string;
    schemaVersion: number;
    inputs: Readonly<{
      nextCli: Readonly<{ links: readonly unknown[]; mode: number; type: string }>;
      packageJson: Readonly<{ mode: number; type: string }>;
    }>;
  }>;
  receiptSha256: string;
}>;

type BackupFile = Readonly<{
  path: string;
  size: number;
  sha256: string;
}>;

type BackupResult = Readonly<{
  manifest: Readonly<{
    schema: string;
    releaseSha: string;
    sqlite: Readonly<{
      checkpoint: string;
      quickCheck: string;
      serviceState: string;
    }>;
    files: readonly BackupFile[];
  }>;
  manifestSha256: string;
}>;

const parseConfig = parseReleaseConfig as unknown as (
  value: unknown,
  options?: { repositoryRoot?: string; homeRoot?: string },
) => ReleaseConfig;

const buildProduction = runProductionBuild as unknown as (
  repositoryRoot: string,
  releaseSha: string,
) => BuildResult;

const inspectState = validateStateLayout as unknown as (
  config: ReleaseConfig,
  options?: { allowEmptyDatabase?: boolean },
) => Readonly<{ sqlite: Readonly<{ state: string }> }>;

const backupState = createBackup as unknown as (
  repositoryRoot: string,
  config: ReleaseConfig,
  outputRoot: string,
) => BackupResult;

const restoreState = restoreBackup as unknown as (
  repositoryRoot: string,
  config: ReleaseConfig,
  backupRoot: string,
  options: {
    confirmReplace?: string | null;
    crashAtPhase?: string | null;
    operationId: string;
    fromSha: string;
    onInitialPreparation?: (() => void) | null;
  },
) => Readonly<{ priorStateId: string }>;

const exitCodeFor = productionServerExitCode as unknown as (
  outcome: Readonly<{ kind: string; code?: number | null; signal?: NodeJS.Signals | null }>,
  requestedSignal: NodeJS.Signals | null,
  signalForwarded?: boolean,
) => number;

const startRelease = startProductionRelease as unknown as (
  repositoryRoot: string,
  config: ReleaseConfig,
  options: {
    checkPort?: boolean;
    spawnImpl?: (...args: unknown[]) => EventEmitter;
    fetchImpl?: (...args: unknown[]) => Promise<Response>;
    onReady?: (value: unknown) => unknown;
    signalEmitter?: EventEmitter;
    terminationGraceMs?: number;
    terminationKillWaitMs?: number;
  },
) => Promise<number>;

const recoverRestore = recoverInterruptedRestore as unknown as (
  config: ReleaseConfig,
  options?: { buildReceiptSha256?: string },
) => Readonly<{ recoveryOutcome: string }>;

type Fixture = Readonly<{
  outer: string;
  repository: string;
  stateRoot: string;
  config: ReleaseConfig;
  sha: string;
  build: BuildResult | null;
  schemaVersion: number;
  productionBootstrapToken: string | null;
  productionTokenFile: string | null;
}>;

const fixtureRoots: string[] = [];
const FIXTURE_NEXT_STORE = ".pnpm/next@16.3.0/node_modules/next";
const FIXTURE_RUNTIME_STORE = ".pnpm/next-runtime@16.3.0/node_modules/next";

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function rawConfig(releaseSha: string, stateRoot: string, runtimeProfile = "synthetic-evaluator") {
  return {
    schema: CONFIG_SCHEMA,
    dataClassification: "PUBLIC_SYNTHETIC",
    host: "127.0.0.1",
    instanceId: "sympose-test-instance",
    port: 43117,
    releaseSha,
    runtimeProfile,
    state: {
      root: stateRoot,
      database: join(stateRoot, "database", "sympose.db"),
      artifacts: join(stateRoot, "artifacts"),
      temporary: join(stateRoot, "tmp"),
      receipts: join(stateRoot, "receipts"),
      logs: join(stateRoot, "logs"),
      runtime: join(stateRoot, "runtime"),
    },
  };
}

function rawProductionConfig(
  releaseSha: string,
  stateRoot: string,
  bootstrap: null | { issuedAt: string; tokenFile: string },
) {
  return {
    ...rawConfig(releaseSha, stateRoot, "base"),
    schema: PRODUCTION_CONFIG_SCHEMA,
    dataClassification: "ORGANIZER_PRIVATE",
    runtimeProfile: "production",
    bootstrap,
  };
}

function createFixture({
  ambientRuntimeState = false,
  build = true,
  database = true,
  initialize = true,
  runtimeLinkTarget = FIXTURE_RUNTIME_STORE,
  schemaVersion = 17,
  production = false,
}: {
  ambientRuntimeState?: boolean;
  build?: boolean;
  database?: boolean;
  initialize?: boolean;
  runtimeLinkTarget?: string;
  schemaVersion?: number;
  production?: boolean;
} = {}): Fixture {
  if (!initialize && database) throw new Error("database requires initialization");
  const outer = mkdtempSync(join(tmpdir(), "sympose-production-release-test-"));
  fixtureRoots.push(outer);
  const repository = join(outer, "repository");
  const stateRoot = join(outer, "state-root");
  mkdirSync(repository, { mode: 0o700 });
  writeFileSync(join(repository, ".gitignore"), ".next/\nnode_modules/\n.env*\n", { mode: 0o600 });
  writeFileSync(join(repository, "source.txt"), "committed source\n", { mode: 0o600 });
  writeFileSync(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", { mode: 0o600 });
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({
    name: "release-fixture",
    private: true,
    type: "module",
    packageManager: "pnpm@9.14.2",
    dependencies: { next: "16.3.0" },
  }, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(join(repository, "src", "server"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(repository, "src", "server", "schema.ts"),
    `export const SCHEMA_VERSION = ${schemaVersion};\n`,
    { mode: 0o600 },
  );

  const modulesRoot = join(repository, "node_modules");
  const nextRoot = join(modulesRoot, ...FIXTURE_NEXT_STORE.split("/"));
  mkdirSync(join(nextRoot, "dist", "bin"), { recursive: true, mode: 0o700 });
  symlinkSync(FIXTURE_NEXT_STORE, join(modulesRoot, "next"));
  writeFileSync(join(nextRoot, "package.json"), '{"version":"16.3.0"}\n', { mode: 0o600 });
  writeFileSync(join(nextRoot, "dist", "bin", "next"), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv[2] !== 'build') process.exit(2);",
    "const root = process.argv[3];",
    "fs.mkdirSync(path.join(root, '.next', 'server'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'standalone', '.next'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'standalone', 'node_modules'), { recursive: true });",
    ...(ambientRuntimeState ? [
      "fs.mkdirSync(path.join(root, '.next', 'standalone', 'data'), { recursive: true });",
      "fs.writeFileSync(path.join(root, '.next', 'standalone', 'data', 'sympose.db'), 'ambient state\\n');",
      "fs.writeFileSync(path.join(root, '.next', 'standalone', 'data', 'sympose.db-wal'), 'ambient wal\\n');",
    ] : []),
    "fs.mkdirSync(path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'next-runtime@16.3.0', 'node_modules', 'next'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'fixture-helper@1.0.0', 'node_modules', 'fixture-helper'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'node_modules'), { recursive: true });",
    "fs.mkdirSync(path.join(root, '.next', 'server', 'app', '[workspace]', '(detail)'), { recursive: true });",
    "fs.writeFileSync(path.join(root, '.next', 'BUILD_ID'), 'fixture-build-id\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'standalone', '.next', 'BUILD_ID'), 'fixture-build-id\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'standalone', 'package.json'), '{\"type\":\"commonjs\"}\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'standalone', 'server.js'), 'require(\"./node_modules/next/runtime.js\");\\n');",
    `fs.symlinkSync(${JSON.stringify(runtimeLinkTarget)}, path.join(root, '.next', 'standalone', 'node_modules', 'next'));`,
    "fs.symlinkSync('../../fixture-helper@1.0.0/node_modules/fixture-helper', path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'next-runtime@16.3.0', 'node_modules', 'fixture-helper'));",
    "fs.symlinkSync('../fixture-helper@1.0.0/node_modules/fixture-helper', path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'node_modules', 'fixture-helper'));",
    "fs.writeFileSync(path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'fixture-helper@1.0.0', 'node_modules', 'fixture-helper', 'index.js'), 'module.exports = true;\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'standalone', 'node_modules', '.pnpm', 'next-runtime@16.3.0', 'node_modules', 'next', 'runtime.js'), 'module.exports = require(\"fixture-helper\");\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'outside-runtime.js'), 'module.exports = false;\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'static', 'app.js'), 'self.__fixture = true;\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'required-server-files.json'), '{}\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'server', 'app-paths-manifest.json'), '{}\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'server', 'entry.js'), 'export const built = true;\\n');",
    "fs.writeFileSync(path.join(root, '.next', 'server', 'app', '[workspace]', '(detail)', 'page.js'), 'export default 1;\\n');",
  ].join("\n"), { mode: 0o700 });

  git(repository, "init", "-q");
  git(repository, "config", "user.name", "Release Fixture");
  git(repository, "config", "user.email", "release-fixture@example.invalid");
  git(repository, "add", ".gitignore", "package.json", "pnpm-lock.yaml", "source.txt", "src/server/schema.ts");
  git(repository, "commit", "-qm", "fixture");
  const sha = git(repository, "rev-parse", "HEAD");
  const productionBootstrapToken = production ? `fixture-production-bootstrap-${randomUUID()}` : null;
  const productionTokenFile = production ? join(outer, "production-bootstrap-token") : null;
  const productionIssuedAt = new Date(Date.now() - 5_000).toISOString();
  if (productionTokenFile && productionBootstrapToken) {
    writeFileSync(productionTokenFile, `${productionBootstrapToken}\n`, { mode: 0o600 });
  }
  const config = parseConfig(
    production
      ? rawProductionConfig(sha, stateRoot, {
          issuedAt: productionIssuedAt,
          tokenFile: productionTokenFile!,
        })
      : rawConfig(sha, stateRoot),
    { repositoryRoot: repository },
  );
  if (initialize) initializeState(config);

  if (database) {
    const sqlite = new DatabaseSync(config.state.database);
    sqlite.exec([
      "PRAGMA journal_mode = WAL;",
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      `INSERT INTO meta (key, value) VALUES ('schema_version', '${schemaVersion}');`,
      production
        ? "INSERT INTO meta (key, value) VALUES ('runtime_mode', 'production');"
        : "INSERT INTO meta (key, value) VALUES ('seed_version', '1');",
      "CREATE TABLE durable_value (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
      "INSERT INTO durable_value (id, value) VALUES (1, 'before');",
    ].join("\n"));
    sqlite.close();
    chmodSync(config.state.database, 0o600);
    writeFileSync(join(config.state.artifacts, "artifact0001.bin"), "artifact bytes", { mode: 0o600 });
  }

  const buildResult = build ? buildProduction(repository, sha) : null;
  return Object.freeze({
    outer,
    repository,
    stateRoot,
    config,
    sha,
    build: buildResult,
    schemaVersion,
    productionBootstrapToken,
    productionTokenFile,
  });
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseKitError);
    expect((error as ReleaseKitError).code).toBe(code);
  }
}

async function expectAsyncCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseKitError);
    expect((error as ReleaseKitError).code).toBe(code);
  }
}

function readReceipts(config: ReleaseConfig): unknown[] {
  return readdirSync(config.state.receipts)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(config.state.receipts, name), "utf8")) as unknown);
}

function treeSymlinks(root: string): string[] {
  const links: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) links.push(path);
      else if (metadata.isDirectory()) visit(path);
    }
  };
  visit(root);
  return links;
}

async function unusedLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("loopback port allocation failed"));
        return;
      }
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root?.startsWith(`${resolve(tmpdir())}/sympose-production-release-test-`)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("production release candidate and build binding", () => {
  it("rejects absent, malformed, mismatched, tracked-dirty, and untracked-dirty candidates", () => {
    const fixture = createFixture();

    expectCode(() => exactFullSha(undefined), "SHA_INVALID");
    expectCode(() => exactFullSha("a".repeat(39)), "SHA_INVALID");
    expectCode(() => exactFullSha("A".repeat(40)), "SHA_INVALID");
    expectCode(() => verifyGitCandidate(fixture.repository, "f".repeat(40)), "SHA_MISMATCH");

    writeFileSync(join(fixture.repository, "untracked.txt"), "untracked\n", { mode: 0o600 });
    expectCode(() => verifyGitCandidate(fixture.repository, fixture.sha), "GIT_DIRTY");
    unlinkSync(join(fixture.repository, "untracked.txt"));

    writeFileSync(join(fixture.repository, "source.txt"), "changed source\n", { mode: 0o600 });
    expectCode(() => verifyGitCandidate(fixture.repository, fixture.sha), "GIT_DIRTY");
    writeFileSync(join(fixture.repository, "source.txt"), "committed source\n", { mode: 0o600 });
    expect(verifyGitCandidate(fixture.repository, fixture.sha)).toBe(fixture.sha);
  });

  it("requires pinned dependencies and a complete untampered production-build receipt", () => {
    const missing = createFixture({ build: false });
    expectCode(() => verifyProductionBuild(missing.repository, missing.sha), "BUILD_INVALID");

    const built = createFixture();
    expect(built.build?.receipt.schema).toBe(BUILD_RECEIPT_SCHEMA);
    expect(verifyProductionBuild(built.repository, built.sha).receiptSha256).toBe(
      built.build?.receiptSha256,
    );
    writeFileSync(join(built.repository, ".next", "server", "entry.js"), "tampered\n");
    expectCode(() => verifyProductionBuild(built.repository, built.sha), "BUILD_INVALID");

    const runtime = createFixture();
    writeFileSync(
      join(runtime.repository, ".next", "standalone", "node_modules", "next", "runtime.js"),
      "tampered runtime\n",
    );
    expectCode(() => verifyProductionBuild(runtime.repository, runtime.sha), "BUILD_INVALID");

    const runtimeLink = createFixture();
    const runtimeFile = join(
      runtimeLink.repository,
      ".next",
      "standalone",
      "node_modules",
      "next",
      "runtime.js",
    );
    unlinkSync(runtimeFile);
    symlinkSync(join(runtimeLink.repository, "source.txt"), runtimeFile);
    expectCode(() => verifyProductionBuild(runtimeLink.repository, runtimeLink.sha), "BUILD_INVALID");

    const runtimeSpecial = createFixture();
    const specialFile = join(runtimeSpecial.repository, ".next", "standalone", "special-runtime");
    execFileSync("mkfifo", [specialFile], { stdio: "ignore" });
    expectCode(
      () => verifyProductionBuild(runtimeSpecial.repository, runtimeSpecial.sha),
      "BUILD_INVALID",
    );

    const buildCli = createFixture();
    writeFileSync(
      join(buildCli.repository, "node_modules", "next", "dist", "bin", "next"),
      "process.exit(0);\n",
      { mode: 0o700 },
    );
    expectCode(() => verifyProductionBuild(buildCli.repository, buildCli.sha), "BUILD_INVALID");

    const dependencies = createFixture();
    unlinkSync(join(dependencies.repository, "node_modules", "next", "dist", "bin", "next"));
    expectCode(() => verifyDependencies(dependencies.repository), "DEPENDENCIES_MISSING");
  });

  it("materializes pnpm runtime links and binds every build-input type, mode, and raw link hop", () => {
    const built = createFixture();
    expect(built.build?.receipt.schemaVersion).toBe(17);
    expect(built.build?.receipt.inputs.packageJson).toMatchObject({ type: "file", mode: 0o600 });
    expect(built.build?.receipt.inputs.nextCli).toMatchObject({ type: "file", mode: 0o700 });
    expect(built.build?.receipt.inputs.nextCli.links).toEqual([
      { path: "node_modules/next", target: FIXTURE_NEXT_STORE, mode: 0o777 },
    ]);
    expect(treeSymlinks(join(built.repository, ".next", "standalone"))).toEqual([]);

    const packageMode = createFixture();
    chmodSync(join(packageMode.repository, "package.json"), 0o640);
    expectCode(
      () => verifyProductionBuild(packageMode.repository, packageMode.sha),
      "BUILD_INVALID",
    );

    const cliMode = createFixture();
    const cliPath = join(
      cliMode.repository,
      "node_modules",
      ...FIXTURE_NEXT_STORE.split("/"),
      "dist",
      "bin",
      "next",
    );
    chmodSync(cliPath, 0o600);
    expectCode(() => verifyProductionBuild(cliMode.repository, cliMode.sha), "BUILD_INVALID");

    const equivalentLink = createFixture();
    const nextLink = join(equivalentLink.repository, "node_modules", "next");
    unlinkSync(nextLink);
    symlinkSync(`./${FIXTURE_NEXT_STORE}`, nextLink);
    expectCode(
      () => verifyProductionBuild(equivalentLink.repository, equivalentLink.sha),
      "BUILD_INVALID",
    );

    const runtimeMode = createFixture();
    chmodSync(join(runtimeMode.repository, ".next", "standalone", "server.js"), 0o4700);
    expectCode(
      () => verifyProductionBuild(runtimeMode.repository, runtimeMode.sha),
      "BUILD_INVALID",
    );
    const runtimeDirectoryMode = createFixture();
    chmodSync(join(runtimeDirectoryMode.repository, ".next", "standalone", "node_modules"), 0o1700);
    expectCode(
      () => verifyProductionBuild(runtimeDirectoryMode.repository, runtimeDirectoryMode.sha),
      "BUILD_INVALID",
    );
  });

  it("rejects escaping or cyclic runtime links and runs the materialized export without live dependencies", () => {
    const escaping = createFixture({ build: false, runtimeLinkTarget: "../../outside-runtime.js" });
    expectCode(() => buildProduction(escaping.repository, escaping.sha), "BUILD_INVALID");

    const cyclic = createFixture({ build: false, runtimeLinkTarget: "next" });
    expectCode(() => buildProduction(cyclic.repository, cyclic.sha), "BUILD_INVALID");

    const independent = createFixture();
    const nextLink = join(independent.repository, "node_modules", "next");
    unlinkSync(nextLink);
    try {
      expectCode(() => verifyDependencies(independent.repository), "DEPENDENCIES_MISSING");
      expect(() => execFileSync(
        process.execPath,
        [join(independent.repository, ".next", "standalone", "server.js")],
        {
          cwd: join(independent.repository, ".next", "standalone"),
          stdio: "ignore",
        },
      )).not.toThrow();
    } finally {
      symlinkSync(FIXTURE_NEXT_STORE, nextLink);
    }
    expect(verifyProductionBuild(independent.repository, independent.sha).receiptSha256).toBe(
      independent.build?.receiptSha256,
    );
  });

  it("rejects ignored ambient application state traced into the standalone runtime", () => {
    const ambient = createFixture({ ambientRuntimeState: true, build: false });
    expectCode(() => buildProduction(ambient.repository, ambient.sha), "BUILD_INVALID");
  });

  it("derives and seals the exact committed application schema version without a brittle duplicate", () => {
    const version18 = createFixture({ schemaVersion: 18 });
    expect(version18.config.applicationSchemaVersion).toBe("18");
    expect(version18.build?.receipt.schemaVersion).toBe(18);
    expect(inspectState(version18.config, { allowEmptyDatabase: false }).sqlite.state).toBe("ready");
    const staleDatabase = new DatabaseSync(version18.config.state.database);
    staleDatabase.prepare("UPDATE meta SET value = '17' WHERE key = 'schema_version'").run();
    staleDatabase.close();
    chmodSync(version18.config.state.database, 0o600);
    expectCode(
      () => inspectState(version18.config, { allowEmptyDatabase: false }),
      "SQLITE_INVALID",
    );

    const malformed = createFixture({ build: false });
    writeFileSync(
      join(malformed.repository, "src", "server", "schema.ts"),
      "export const SCHEMA_VERSION=17;\n",
      { mode: 0o600 },
    );
    expectCode(() => verifyDependencies(malformed.repository), "DEPENDENCIES_MISSING");
    expectCode(
      () => parseConfig(rawConfig(malformed.sha, malformed.stateRoot), {
        repositoryRoot: malformed.repository,
      }),
      "DEPENDENCIES_MISSING",
    );

    const ambiguous = createFixture({ build: false });
    writeFileSync(
      join(ambiguous.repository, "src", "server", "schema.ts"),
      "export const SCHEMA_VERSION = 17;\nexport const SCHEMA_VERSION = 18;\n",
      { mode: 0o600 },
    );
    expectCode(() => verifyDependencies(ambiguous.repository), "DEPENDENCIES_MISSING");
  });

  it("runs only the sealed standalone server on explicit loopback and gates synthetic flags", () => {
    const fixture = createFixture();
    const build = verifyProductionBuild(fixture.repository, fixture.sha);
    const synthetic = createProductionStartPlan(fixture.repository, fixture.config, build);
    expect(synthetic.args).toEqual([
      join(fixture.repository, ".next", "standalone", "server.js"),
    ]);
    expect(synthetic.cwd).toBe(join(fixture.repository, ".next", "standalone"));
    expect(synthetic.environment).toMatchObject({
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      SYMPOSE_BUILD_SHA: fixture.sha,
      SYMPOSE_DATA_MODE: "synthetic-evaluator",
      SYMPOSE_EVALUATOR_PROFILE: "local",
      SYMPOSE_PUBLIC_SYNTHETIC_DEMO: "1",
    });
    expect(synthetic.environment).not.toHaveProperty("HOME");

    const baseConfig = parseConfig(rawConfig(fixture.sha, fixture.stateRoot, "base"), {
      repositoryRoot: fixture.repository,
    });
    const base = createProductionStartPlan(fixture.repository, baseConfig, build);
    expect(base.environment.NODE_ENV).toBe("production");
    expect((base.environment as Readonly<Record<string, string>>).SYMPOSE_DATA_MODE)
      .toBe("synthetic-evaluator");
    expect(base.environment).not.toHaveProperty("SYMPOSE_EVALUATOR_PROFILE");
    expect(base.environment).not.toHaveProperty("SYMPOSE_PUBLIC_SYNTHETIC_DEMO");
    expect(base.environment).not.toHaveProperty("SYMPOSE_APPLICANT_VERIFICATION_DELIVERY");
  });

  it("builds a distinct production plan with only production storage and bootstrap references", () => {
    const fixture = createFixture({ production: true });
    if (!("bootstrap" in fixture.config) || !fixture.config.bootstrap) {
      throw new Error("production fixture missing bootstrap reference");
    }
    const build = verifyProductionBuild(fixture.repository, fixture.sha);
    const plan = createProductionStartPlan(fixture.repository, fixture.config, build);

    expect(plan.expectedDataMode).toBe("production");
    expect(plan.environment).toEqual({
      HOSTNAME: "127.0.0.1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      PORT: String(fixture.config.port),
      SYMPOSE_BUILD_SHA: fixture.sha,
      SYMPOSE_DATA_MODE: "production",
      SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT: fixture.config.state.artifacts,
      SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT: fixture.config.bootstrap.issuedAt,
      SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN_FILE: fixture.productionTokenFile,
      SYMPOSE_PRODUCTION_DB_PATH: fixture.config.state.database,
      TMPDIR: fixture.config.state.temporary,
      TZ: "UTC",
    });
    for (const forbidden of [
      "SYMPOSE_ARTIFACT_STORE_ROOT",
      "SYMPOSE_DB_PATH",
      "SYMPOSE_EVALUATOR_PROFILE",
      "SYMPOSE_PUBLIC_SYNTHETIC_DEMO",
      "SYMPOSE_CONNECTOR_EXECUTION_MODE",
      "SYMPOSE_CONNECTOR_NETWORK_ENABLED",
      "SYMPOSE_CONNECTOR_VAULT_KEY",
    ]) {
      expect(plan.environment).not.toHaveProperty(forbidden);
    }
    expect(plan.args).toEqual([join(fixture.repository, ".next", "standalone", "server.js")]);
    expect(canonicalJson(plan)).not.toContain(fixture.productionBootstrapToken);
  });

  it("rejects ignored .env files and symlinks before build, verification, and start planning", () => {
    const beforeBuild = createFixture({ build: false });
    const ignoredFile = join(beforeBuild.repository, ".env.production.local");
    writeFileSync(ignoredFile, "SYMPOSE_BUILD_SHA=attacker\n", { mode: 0o600 });
    expectCode(() => buildProduction(beforeBuild.repository, beforeBuild.sha), "ENV_FILE");
    unlinkSync(ignoredFile);
    const ignoredLink = join(beforeBuild.repository, ".env.local");
    symlinkSync(join(beforeBuild.repository, "source.txt"), ignoredLink);
    expectCode(() => buildProduction(beforeBuild.repository, beforeBuild.sha), "ENV_FILE");

    const afterBuild = createFixture();
    writeFileSync(join(afterBuild.repository, ".env"), "PORT=1\n", { mode: 0o600 });
    expectCode(() => verifyProductionBuild(afterBuild.repository, afterBuild.sha), "ENV_FILE");
    expectCode(() => createProductionStartPlan(afterBuild.repository, afterBuild.config), "ENV_FILE");
  });
});

describe("production release paths and ownership", () => {
  it("keeps the evaluator schema unchanged and validates a separate production config and state classification", () => {
    const evaluator = createFixture();
    expect(evaluator.config).toMatchObject({
      schema: CONFIG_SCHEMA,
      dataClassification: "PUBLIC_SYNTHETIC",
      runtimeProfile: "synthetic-evaluator",
    });
    expect(evaluator.config).not.toHaveProperty("bootstrap");

    const production = createFixture({ production: true });
    expect(production.config).toMatchObject({
      schema: PRODUCTION_CONFIG_SCHEMA,
      dataClassification: "ORGANIZER_PRIVATE",
      runtimeProfile: "production",
      bootstrap: {
        tokenFile: production.productionTokenFile,
      },
    });
    expect(JSON.parse(readFileSync(join(production.stateRoot, "state.json"), "utf8"))).toMatchObject({
      schema: PRODUCTION_STATE_SCHEMA,
      dataClassification: "ORGANIZER_PRIVATE",
    });
    expect(inspectState(production.config, { allowEmptyDatabase: false }).sqlite).toMatchObject({
      state: "ready",
      runtimeMode: "production",
      seedVersion: null,
    });

    const postBootstrapConfig = parseConfig(
      rawProductionConfig(production.sha, production.stateRoot, null),
      { repositoryRoot: production.repository },
    );
    expect(inspectState(postBootstrapConfig, { allowEmptyDatabase: false }).sqlite.state).toBe("ready");
    const plan = createProductionStartPlan(
      production.repository,
      postBootstrapConfig,
      verifyProductionBuild(production.repository, production.sha),
    );
    expect(plan.environment).not.toHaveProperty("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN_FILE");
    expect(plan.environment).not.toHaveProperty("SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT");
  });

  it("rejects mixed production/evaluator keys and malformed, relative, symlinked, or insecure bootstrap references", () => {
    const fixture = createFixture({ production: true });
    if (!("bootstrap" in fixture.config) || !fixture.config.bootstrap) {
      throw new Error("production fixture missing bootstrap reference");
    }
    const issuedAt = fixture.config.bootstrap.issuedAt;
    const tokenFile = fixture.productionTokenFile!;

    expectCode(() => parseConfig({
      ...rawConfig(fixture.sha, fixture.stateRoot),
      schema: PRODUCTION_CONFIG_SCHEMA,
    }, { repositoryRoot: fixture.repository }), "CONFIG_INVALID");
    expectCode(() => parseConfig({
      ...rawProductionConfig(fixture.sha, fixture.stateRoot, { issuedAt, tokenFile }),
      evaluator: true,
    }, { repositoryRoot: fixture.repository }), "CONFIG_INVALID");
    expectCode(() => parseConfig({
      ...rawProductionConfig(fixture.sha, fixture.stateRoot, { issuedAt, tokenFile }),
      bootstrap: { issuedAt, tokenFile, token: "must-not-be-configurable" },
    }, { repositoryRoot: fixture.repository }), "CONFIG_INVALID");
    expectCode(() => parseConfig(
      rawProductionConfig(fixture.sha, fixture.stateRoot, { issuedAt, tokenFile: "relative-token" }),
      { repositoryRoot: fixture.repository },
    ), "CONFIG_INVALID");

    chmodSync(tokenFile, 0o644);
    expectCode(() => parseConfig(
      rawProductionConfig(fixture.sha, fixture.stateRoot, { issuedAt, tokenFile }),
      { repositoryRoot: fixture.repository },
    ), "CONFIG_PERMISSION");
    chmodSync(tokenFile, 0o600);

    const link = join(fixture.outer, "bootstrap-token-link");
    symlinkSync(tokenFile, link);
    expectCode(() => parseConfig(
      rawProductionConfig(fixture.sha, fixture.stateRoot, { issuedAt, tokenFile: link }),
      { repositoryRoot: fixture.repository },
    ), "CONFIG_PERMISSION");
    expectCode(() => parseConfig(
      rawProductionConfig(fixture.sha, fixture.stateRoot, {
        issuedAt: "not-an-instant",
        tokenFile,
      }),
      { repositoryRoot: fixture.repository },
    ), "CONFIG_INVALID");
  });

  it("accepts only production runtime metadata without synthetic seed provenance", () => {
    const fixture = createFixture({ production: true });
    const database = new DatabaseSync(fixture.config.state.database);
    database.prepare("INSERT INTO meta (key, value) VALUES ('seed_version', '1')").run();
    database.close();
    chmodSync(fixture.config.state.database, 0o600);
    expectCode(() => inspectState(fixture.config, { allowEmptyDatabase: false }), "SQLITE_INVALID");

    const repair = new DatabaseSync(fixture.config.state.database);
    repair.prepare("DELETE FROM meta WHERE key = 'seed_version'").run();
    repair.prepare("UPDATE meta SET value = 'synthetic-evaluator' WHERE key = 'runtime_mode'").run();
    repair.close();
    chmodSync(fixture.config.state.database, 0o600);
    expectCode(() => inspectState(fixture.config, { allowEmptyDatabase: false }), "SQLITE_INVALID");
  });

  it("rejects relative, broad, repository, home, and overlapping state paths", () => {
    const fixture = createFixture();
    const relativeConfig = rawConfig(fixture.sha, "relative-state");
    expectCode(
      () => parseConfig(relativeConfig, { repositoryRoot: fixture.repository }),
      "PATH_UNSAFE",
    );

    const repositoryState = rawConfig(fixture.sha, join(fixture.repository, "state-root"));
    expectCode(
      () => parseConfig(repositoryState, { repositoryRoot: fixture.repository }),
      "PATH_UNSAFE",
    );

    const homeState = rawConfig(fixture.sha, join(homedir(), "sympose-state-test"));
    expectCode(
      () => parseConfig(homeState, { repositoryRoot: fixture.repository }),
      "PATH_UNSAFE",
    );

    const overlapping = rawConfig(fixture.sha, join(fixture.outer, "other-state"));
    overlapping.state.artifacts = overlapping.state.database;
    expectCode(
      () => parseConfig(overlapping, { repositoryRoot: fixture.repository }),
      "PATH_OVERLAP",
    );
  });

  it("fails closed on insecure state directory or database permissions", () => {
    const fixture = createFixture();
    chmodSync(fixture.config.state.artifacts, 0o755);
    expectCode(() => inspectState(fixture.config), "STATE_PERMISSION");
    chmodSync(fixture.config.state.artifacts, 0o700);
    chmodSync(fixture.config.state.database, 0o644);
    expectCode(() => inspectState(fixture.config), "STATE_PERMISSION");
  });

  it("requires the canonical state parent to be owner-controlled and non-writable by group or world", () => {
    const beforeInit = createFixture({ build: false, database: false, initialize: false });
    chmodSync(beforeInit.outer, 0o777);
    expectCode(() => initializeState(beforeInit.config), "STATE_PERMISSION");
    chmodSync(beforeInit.outer, 0o700);
    initializeState(beforeInit.config);
    expect(inspectState(beforeInit.config).sqlite.state).toBe("explicit-empty");

    const beforeLock = createFixture();
    chmodSync(beforeLock.outer, 0o777);
    expectCode(() => acquireOperationLock(beforeLock.config, "start"), "STATE_PERMISSION");
    expectCode(
      () => backupState(beforeLock.repository, beforeLock.config, join(beforeLock.outer, "unsafe-backup")),
      "STATE_PERMISSION",
    );
    chmodSync(beforeLock.outer, 0o700);
  });

  it("permits only an explicit empty initialized database or the exact ready metadata", () => {
    const empty = createFixture({ database: false });
    expect(inspectState(empty.config).sqlite.state).toBe("explicit-empty");
    expectCode(
      () => inspectState(empty.config, { allowEmptyDatabase: false }),
      "SQLITE_INVALID",
    );

    const malformed = createFixture({ database: false });
    const sqlite = new DatabaseSync(malformed.config.state.database);
    sqlite.exec("PRAGMA journal_mode = WAL; CREATE TABLE unexpected (id INTEGER PRIMARY KEY);");
    sqlite.close();
    chmodSync(malformed.config.state.database, 0o600);
    expectCode(() => inspectState(malformed.config), "SQLITE_INVALID");
  });
});

describe("exact health and startup supervision", () => {
  function healthFetch(body: unknown, status = 200) {
    return async () => {
      const bytes = JSON.stringify(body);
      return new Response(bytes, {
        status,
        headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(bytes)),
        },
      });
    };
  }

  it("accepts only HTTP 200 with the exact three-field health body and no-store", async () => {
    const sha = "a".repeat(40);
    const plan = { healthUrl: "http://127.0.0.1:43117/health" };
    await expect(requestExactHealth(plan, sha, {
      fetchImpl: healthFetch({ status: "ok", buildSha: sha, dataMode: "synthetic-evaluator" }),
    })).resolves.toEqual({ status: "ok", buildSha: sha, dataMode: "synthetic-evaluator" });

    await expectAsyncCode(
      () => requestExactHealth(plan, sha, {
        fetchImpl: healthFetch({
          status: "ok",
          buildSha: sha,
          dataMode: "synthetic-evaluator",
          unexpected: true,
        }),
      }),
      "HEALTH_INVALID",
    );

    await expectAsyncCode(
      () => requestExactHealth(plan, sha, {
        fetchImpl: healthFetch({
          status: "ok",
          buildSha: "b".repeat(40),
          dataMode: "synthetic-evaluator",
        }),
      }),
      "HEALTH_INVALID",
    );
  });

  it("requires the exact production health mode for a production plan", async () => {
    const sha = "a".repeat(40);
    const plan = {
      healthUrl: "http://127.0.0.1:43117/health",
      expectedDataMode: "production",
    };
    await expect(requestExactHealth(plan, sha, {
      fetchImpl: healthFetch({ status: "ok", buildSha: sha, dataMode: "production" }),
    })).resolves.toEqual({ status: "ok", buildSha: sha, dataMode: "production" });
    await expectAsyncCode(
      () => requestExactHealth(plan, sha, {
        fetchImpl: healthFetch({ status: "ok", buildSha: sha, dataMode: "synthetic-evaluator" }),
      }),
      "HEALTH_INVALID",
    );
    await expectAsyncCode(
      () => requestExactHealth(plan, sha, {
        fetchImpl: healthFetch({ status: "ok", buildSha: sha, dataMode: "production", extra: true }),
      }),
      "HEALTH_INVALID",
    );
  });

  it("fails when the owned server exits before health is established", async () => {
    class ExitingChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    const child = new ExitingChild();
    const neverHealthy = new Promise<never>(() => {});
    setImmediate(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });
    await expectAsyncCode(
      () => waitForStartupOutcome(child, neverHealthy, { stabilityMs: 5 }),
      "STARTUP_EXIT",
    );
  });

  it("requires positive forwarding proof and only accepts the matching controlled-stop outcome", () => {
    expect(exitCodeFor({ kind: "exit", code: 0, signal: null }, null)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 1, signal: null }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGINT" }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGTERM" }, "SIGTERM", true)).toBe(0);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGINT" }, "SIGINT", true)).toBe(0);
    expect(exitCodeFor({ kind: "exit", code: 130, signal: null }, "SIGINT", true)).toBe(0);
    expect(exitCodeFor({ kind: "exit", code: 143, signal: null }, "SIGTERM", true)).toBe(0);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGINT" }, "SIGINT", false)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 130, signal: null }, "SIGINT", false)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGTERM" }, "SIGTERM", false)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 143, signal: null }, "SIGTERM", false)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 130, signal: null }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 143, signal: null }, "SIGINT", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 129, signal: null }, "SIGINT", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 144, signal: null }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: null, signal: "SIGKILL" }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "exit", code: 143, signal: "SIGTERM" }, "SIGTERM", true)).toBe(1);
    expect(exitCodeFor({ kind: "error" }, "SIGTERM", true)).toBe(1);
  });

  it("boundedly waits for the exact delayed start lock before checking exact health", async () => {
    const fixture = createFixture();
    let lock: ReturnType<typeof acquireOperationLock> | null = null;
    setTimeout(() => {
      lock = acquireOperationLock(fixture.config, "start");
    }, 30);
    const result = await verifyRunningRelease(fixture.repository, fixture.config, {
      waitMs: 500,
      fetchImpl: healthFetch({
        status: "ok",
        buildSha: fixture.sha,
        dataMode: "synthetic-evaluator",
      }),
    });
    expect(result.kind).toBe("running");
    if (!lock) throw new Error("delayed lock was not acquired");
    releaseOperationLock(fixture.config, lock);
  });

  it("materializes the unit's recover/preflight/start/verify order and exercises its delayed-lock equivalent", async () => {
    const fixture = createFixture();
    const template = readFileSync(
      resolve("deployment/sympose/sympose-evaluator.service.in"),
      "utf8",
    );
    const materialized = template
      .replaceAll("@NODE_BINARY@", process.execPath)
      .replaceAll("@REPOSITORY_ROOT@", fixture.repository)
      .replaceAll("@CONFIG_PATH@", join(fixture.outer, "config.json"))
      .replaceAll("@SERVICE_USER@", "sympose-test")
      .replaceAll("@SERVICE_GROUP@", "sympose-test")
      .replaceAll("@STATE_PARENT@", fixture.outer)
      .replaceAll("@LOG_ROOT@", fixture.config.state.logs);
    const recoverIndex = materialized.indexOf("release.mjs recover");
    const preflightIndex = materialized.indexOf("release.mjs preflight");
    const startIndex = materialized.indexOf("release.mjs start");
    const verifyIndex = materialized.indexOf("release.mjs verify");
    expect(recoverIndex).toBeGreaterThan(0);
    expect(preflightIndex).toBeGreaterThan(recoverIndex);
    expect(startIndex).toBeGreaterThan(preflightIndex);
    expect(verifyIndex).toBeGreaterThan(startIndex);
    expect(materialized).toContain("--wait-ms 90000");

    const productionTemplate = readFileSync(
      resolve("deployment/sympose/sympose-production.service.in"),
      "utf8",
    );
    expect(productionTemplate).not.toContain("LoadCredential=");
    expect(productionTemplate).toContain(
      "ReadOnlyPaths=@REPOSITORY_ROOT@ @CONFIG_PATH@ -@BOOTSTRAP_TOKEN_SOURCE@",
    );
    expect(productionTemplate).toContain("release.mjs recover");
    expect(productionTemplate).toContain("release.mjs preflight");
    expect(productionTemplate).toContain("release.mjs start");
    expect(productionTemplate).toContain("release.mjs verify");
    expect(productionTemplate).not.toMatch(
      /SYMPOSE_CONNECTOR_(?:EXECUTION_MODE|NETWORK_ENABLED|VAULT_KEY)/u,
    );
    const productionExample = JSON.parse(readFileSync(
      resolve("deployment/sympose/production-config.example.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(productionExample).toMatchObject({
      schema: PRODUCTION_CONFIG_SCHEMA,
      dataClassification: "ORGANIZER_PRIVATE",
      runtimeProfile: "production",
      bootstrap: {
        tokenFile: "/var/lib/sympose-production/bootstrap/bootstrap-token",
      },
    });
    expect(canonicalJson(productionExample)).not.toMatch(/"(?:secret|token)"\s*:/iu);

    let lock: ReturnType<typeof acquireOperationLock> | null = null;
    setTimeout(() => {
      lock = acquireOperationLock(fixture.config, "start");
    }, 20);
    await expect(waitForOperationLock(fixture.config, "start", { waitMs: 500 })).resolves.toMatchObject({
      record: { kind: "start" },
    });
    if (!lock) throw new Error("materialized ordering lock was not acquired");
    releaseOperationLock(fixture.config, lock);
  });

  it("returns failure when a healthy owned server exits cleanly without a shutdown request", async () => {
    class CleanExitChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = 4242;

      kill(): boolean {
        return true;
      }

      exit(code: number): void {
        this.exitCode = code;
        this.emit("exit", code, null);
      }
    }
    const fixture = createFixture();
    const child = new CleanExitChild();
    const code = await startRelease(fixture.repository, fixture.config, {
      checkPort: false,
      spawnImpl: () => child,
      fetchImpl: healthFetch({
        status: "ok",
        buildSha: fixture.sha,
        dataMode: "synthetic-evaluator",
      }),
      onReady: () => setImmediate(() => child.exit(0)),
    });
    expect(code).toBe(1);
    const stopped = readReceipts(fixture.config)
      .map((receipt) => validateReceiptPayload(receipt))
      .find((receipt) => receipt.kind === "start-stopped");
    expect(stopped?.details).toMatchObject({ exitCode: 1, requestedSignal: "none" });
  });

  it("accepts only the matching controlled-stop outcome and rejects a forwarded failed exit", async () => {
    class SignalChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = 4545;

      constructor(private readonly outcome: "code" | "failure" | "signal") {
        super();
      }

      kill(signal: NodeJS.Signals): boolean {
        if (this.outcome === "failure") {
          this.exitCode = 1;
          this.emit("exit", 1, null);
        } else if (this.outcome === "code") {
          this.exitCode = signal === "SIGINT" ? 130 : 143;
          this.emit("exit", this.exitCode, null);
        } else {
          this.signalCode = signal;
          this.emit("exit", null, signal);
        }
        return true;
      }
    }
    const exactFetch = (sha: string) => healthFetch({
      status: "ok",
      buildSha: sha,
      dataMode: "synthetic-evaluator",
    });

    const controlled = createFixture();
    const controlledSignals = new EventEmitter();
    expect(await startRelease(controlled.repository, controlled.config, {
      checkPort: false,
      spawnImpl: () => new SignalChild("signal"),
      fetchImpl: exactFetch(controlled.sha),
      signalEmitter: controlledSignals,
      onReady: () => setImmediate(() => controlledSignals.emit("SIGTERM")),
    })).toBe(0);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const conventional = createFixture();
      const conventionalSignals = new EventEmitter();
      expect(await startRelease(conventional.repository, conventional.config, {
        checkPort: false,
        spawnImpl: () => new SignalChild("code"),
        fetchImpl: exactFetch(conventional.sha),
        signalEmitter: conventionalSignals,
        onReady: () => setImmediate(() => conventionalSignals.emit(signal)),
      })).toBe(0);
      const stopped = readReceipts(conventional.config)
        .map((receipt) => validateReceiptPayload(receipt))
        .find((receipt) => receipt.kind === "start-stopped");
      expect(stopped?.details).toMatchObject({
        exitCode: 0,
        exitKind: "code",
        requestedSignal: signal,
        signalForwarded: true,
      });
    }

    const failed = createFixture();
    const failedSignals = new EventEmitter();
    expect(await startRelease(failed.repository, failed.config, {
      checkPort: false,
      spawnImpl: () => new SignalChild("failure"),
      fetchImpl: exactFetch(failed.sha),
      signalEmitter: failedSignals,
      onReady: () => setImmediate(() => failedSignals.emit("SIGTERM")),
    })).toBe(1);
  });

  it("records a bounded production ready/controlled-stop lifecycle without provider or secret material", async () => {
    class ProductionSignalChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = 4747;

      kill(signal: NodeJS.Signals): boolean {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        return true;
      }
    }
    const fixture = createFixture({ production: true });
    const signals = new EventEmitter();
    let ready: unknown;
    expect(await startRelease(fixture.repository, fixture.config, {
      checkPort: false,
      spawnImpl: () => new ProductionSignalChild(),
      fetchImpl: healthFetch({ status: "ok", buildSha: fixture.sha, dataMode: "production" }),
      signalEmitter: signals,
      onReady: (value) => {
        ready = value;
        setImmediate(() => signals.emit("SIGTERM"));
      },
    })).toBe(0);
    expect(ready).toMatchObject({ dataMode: "production", releaseSha: fixture.sha });
    const receipts = readReceipts(fixture.config).map((receipt) => validateReceiptPayload(receipt));
    expect(receipts.map(({ kind }) => kind)).toEqual([
      "start-requested",
      "start-ready",
      "start-stopped",
    ]);
    expect(receipts.find(({ kind }) => kind === "start-ready")?.details).toMatchObject({
      dataMode: "production",
      runtimeProfile: "production",
    });
    const serialized = canonicalJson(receipts);
    expect(serialized).not.toContain(fixture.productionBootstrapToken);
    expect(serialized).not.toContain(fixture.productionTokenFile);
    expect(serialized).not.toMatch(/airtable|hubspot|salesforce|provider-network/iu);
  });

  it("fails closed when signal forwarding fails before a matching conventional exit", async () => {
    const cases = [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const;

    for (const [signal, conventionalCode] of cases) {
      class FailedForwardChild extends EventEmitter {
        exitCode: number | null = null;
        signalCode: NodeJS.Signals | null = null;
        pid = 4646;
        killAttempts = 0;

        kill(): boolean {
          this.killAttempts += 1;
          if (this.killAttempts === 1) {
            setImmediate(() => {
              this.exitCode = conventionalCode;
              this.emit("exit", conventionalCode, null);
            });
          }
          return false;
        }
      }

      const fixture = createFixture();
      const child = new FailedForwardChild();
      const signals = new EventEmitter();
      expect(await startRelease(fixture.repository, fixture.config, {
        checkPort: false,
        spawnImpl: () => child,
        fetchImpl: healthFetch({
          status: "ok",
          buildSha: fixture.sha,
          dataMode: "synthetic-evaluator",
        }),
        signalEmitter: signals,
        onReady: () => setImmediate(() => signals.emit(signal)),
      })).toBe(1);
      expect(child.killAttempts).toBeGreaterThanOrEqual(1);
      const stopped = readReceipts(fixture.config)
        .map((receipt) => validateReceiptPayload(receipt))
        .find((receipt) => receipt.kind === "start-stopped");
      expect(stopped?.details).toMatchObject({
        exitCode: 1,
        exitKind: "code",
        requestedSignal: signal,
        signalForwarded: false,
      });
    }
  });

  it("awaits delayed SIGKILL exit and retains the start lock when termination is unproven", async () => {
    class DelayedKillChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = 4343;
      signals: string[] = [];

      kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        if (signal === "SIGKILL") {
          setTimeout(() => {
            this.signalCode = "SIGKILL";
            this.emit("exit", null, "SIGKILL");
          }, 25);
        }
        return true;
      }
    }
    const delayed = new DelayedKillChild();
    const started = Date.now();
    await terminateOwnedChild(delayed, undefined, { graceMs: 5, killWaitMs: 100 });
    expect(delayed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);

    class NeverExitChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      pid = 4444;

      kill(): boolean {
        return true;
      }
    }
    const fixture = createFixture();
    await expectAsyncCode(
      () => startRelease(fixture.repository, fixture.config, {
        checkPort: false,
        spawnImpl: () => new NeverExitChild(),
        fetchImpl: healthFetch({ status: "wrong" }),
        terminationGraceMs: 1,
        terminationKillWaitMs: 1,
      }),
      "TERMINATION_UNPROVEN",
    );
    expect(existsSync(join(fixture.outer, ".state-root.sympose-operation.lock"))).toBe(true);
  });

  it.runIf(process.env.SYMPOSE_REAL_RELEASE_PROOF === "1")(
    "proves exact health and conventional SIGINT/SIGTERM shutdown against the pinned real standalone",
    async () => {
      const repository = resolve(".");
      const sha = git(repository, "rev-parse", "HEAD");
      expect(verifyProductionBuild(repository, sha).receipt.schemaVersion).toBeGreaterThan(0);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const outer = mkdtempSync(join(tmpdir(), "sympose-production-release-test-"));
        fixtureRoots.push(outer);
        const stateRoot = join(outer, `real-${signal.toLowerCase()}`);
        const config = parseConfig(
          {
            ...rawConfig(sha, stateRoot),
            instanceId: `sympose-real-${signal.toLowerCase()}`,
            port: await unusedLoopbackPort(),
          },
          { repositoryRoot: repository },
        );
        initializeState(config);
        const signalEmitter = new EventEmitter();
        let resolveReady!: (value: unknown) => void;
        const ready = new Promise<unknown>((resolveValue) => {
          resolveReady = resolveValue;
        });
        const started = startRelease(repository, config, {
          signalEmitter,
          onReady: resolveReady,
        });
        const readyResult = await Promise.race([
          ready,
          started.then((code) => {
            throw new Error(`real standalone exited before readiness with ${code}`);
          }),
        ]) as { dataMode: string; releaseSha: string };
        expect(readyResult).toMatchObject({
          dataMode: "synthetic-evaluator",
          releaseSha: sha,
        });
        await expect(verifyRunningRelease(repository, config, { waitMs: 5_000 })).resolves.toMatchObject({
          health: { status: "ok", buildSha: sha, dataMode: "synthetic-evaluator" },
        });
        signalEmitter.emit(signal);
        await expect(started).resolves.toBe(0);
        const stopped = readReceipts(config)
          .map((receipt) => validateReceiptPayload(receipt))
          .find((receipt) => receipt.kind === "start-stopped");
        expect(stopped?.details).toMatchObject({
          exitCode: 0,
          exitKind: "code",
          requestedSignal: signal,
        });
      }

      const isolatedOuter = mkdtempSync(join(tmpdir(), "sympose-production-release-test-"));
      fixtureRoots.push(isolatedOuter);
      const isolatedRuntime = join(isolatedOuter, "sealed-runtime");
      cpSync(join(repository, ".next", "standalone"), isolatedRuntime, {
        recursive: true,
        preserveTimestamps: true,
      });
      expect(treeSymlinks(isolatedRuntime)).toEqual([]);
      const isolatedState = join(isolatedOuter, "isolated-state");
      const isolatedConfig = parseConfig(
        {
          ...rawConfig(sha, isolatedState),
          instanceId: "sympose-real-isolated",
          port: await unusedLoopbackPort(),
        },
        { repositoryRoot: repository },
      );
      initializeState(isolatedConfig);
      const isolatedPlan = createProductionStartPlan(repository, isolatedConfig);
      const isolatedChild: ChildProcess = spawn(
        isolatedPlan.executable,
        [join(isolatedRuntime, "server.js")],
        {
          cwd: isolatedRuntime,
          env: { ...isolatedPlan.environment } as NodeJS.ProcessEnv,
          stdio: "inherit",
        },
      );
      try {
        await expect(waitForExactHealth(isolatedPlan, sha, { waitMs: 30_000 })).resolves.toEqual({
          status: "ok",
          buildSha: sha,
          dataMode: "synthetic-evaluator",
        });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolveExit) => isolatedChild.once("exit", (code, signal) => resolveExit({ code, signal })),
        );
        isolatedChild.kill("SIGTERM");
        await expect(exit).resolves.toEqual({ code: 143, signal: null });
      } finally {
        if (isolatedChild.exitCode === null && isolatedChild.signalCode === null) {
          isolatedChild.kill("SIGKILL");
        }
      }

      const productionOuter = mkdtempSync(join(tmpdir(), "sympose-production-release-test-"));
      fixtureRoots.push(productionOuter);
      const productionState = join(productionOuter, "production-state");
      const productionTokenFile = join(productionOuter, "bootstrap-token");
      const productionToken = `sympose-production-bootstrap-${randomUUID()}`;
      const productionIssuedAt = new Date(Date.now() - 5_000).toISOString();
      writeFileSync(productionTokenFile, `${productionToken}\n`, { mode: 0o600 });
      const productionConfig = parseConfig(
        rawProductionConfig(sha, productionState, {
          issuedAt: productionIssuedAt,
          tokenFile: productionTokenFile,
        }),
        { repositoryRoot: repository },
      );
      initializeState(productionConfig);
      const productionSignalEmitter = new EventEmitter();
      let resolveProductionReady!: (value: unknown) => void;
      const productionReady = new Promise<unknown>((resolveValue) => {
        resolveProductionReady = resolveValue;
      });
      const productionStarted = startRelease(repository, productionConfig, {
        signalEmitter: productionSignalEmitter,
        onReady: resolveProductionReady,
      });
      const productionReadyResult = await Promise.race([
        productionReady,
        productionStarted.then((code) => {
          throw new Error(`production standalone exited before readiness with ${code}`);
        }),
      ]) as { dataMode: string; releaseSha: string };
      expect(productionReadyResult).toMatchObject({ dataMode: "production", releaseSha: sha });
      await expect(verifyRunningRelease(repository, productionConfig, { waitMs: 5_000 }))
        .resolves.toMatchObject({
          health: { status: "ok", buildSha: sha, dataMode: "production" },
        });

      vi.stubEnv("SYMPOSE_DATA_MODE", "production");
      vi.stubEnv("SYMPOSE_PRODUCTION_DB_PATH", productionConfig.state.database);
      vi.stubEnv("SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT", productionConfig.state.artifacts);
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN", "");
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN_FILE", productionTokenFile);
      vi.stubEnv("SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT", productionIssuedAt);
      const [{ closeDb, openDb }, { resolveSession }, productionAuth] = await Promise.all([
        import("@/server/db"),
        import("@/server/auth"),
        import("@/server/production-auth"),
      ]);
      const productionDb = openDb({ path: productionConfig.state.database, seed: false });
      try {
        expect(productionDb.prepare(
          "SELECT key, value FROM meta WHERE key IN ('runtime_mode', 'seed_version') ORDER BY key",
        ).all()).toEqual([{ key: "runtime_mode", value: "production" }]);
        const bootstrap = productionAuth.bootstrapProductionWorkspace(productionDb, {
          token: productionToken,
          workspaceName: "Release Proof Workspace",
          workspaceSlug: "release-proof-workspace",
          displayName: "Release Proof Owner",
          email: "release-proof-owner@example.test",
          password: "Release-Proof-Owner-Password-2026!",
        });
        expect(resolveSession(productionDb, bootstrap.token)?.id).toBe(bootstrap.session.id);
        const login = productionAuth.loginProductionAccount(productionDb, bootstrap.token, {
          workspaceSlug: "release-proof-workspace",
          email: "release-proof-owner@example.test",
          password: "Release-Proof-Owner-Password-2026!",
        });
        expect(resolveSession(productionDb, bootstrap.token)).toBeNull();
        expect(resolveSession(productionDb, login.token)?.id).toBe(login.session.id);
        expect(productionDb.prepare(
          "SELECT consumed_at IS NOT NULL AS consumed, salt, verifier FROM production_bootstrap_challenges WHERE id = 1",
        ).get()).toEqual({ consumed: 1, salt: null, verifier: null });
        expect(productionDb.prepare("SELECT COUNT(*) AS count FROM sessions").get())
          .toEqual({ count: 1 });
        expect(productionDb.prepare("SELECT COUNT(*) AS count FROM connector_runs").get())
          .toEqual({ count: 0 });
      } finally {
        closeDb(productionDb);
        vi.unstubAllEnvs();
      }

      productionSignalEmitter.emit("SIGTERM");
      await expect(productionStarted).resolves.toBe(0);
      const productionReceipts = canonicalJson(readReceipts(productionConfig));
      expect(productionReceipts).toContain('"dataMode":"production"');
      expect(productionReceipts).toContain('"runtimeProfile":"production"');
      expect(productionReceipts).not.toContain(productionToken);
      expect(productionReceipts).not.toContain(productionTokenFile);
      expect(productionReceipts).not.toMatch(/airtable|hubspot|salesforce|smtp/iu);
    },
    180_000,
  );
});

describe("stopped-state backup, restore, and rollback", () => {
  it("refuses backup while a launcher start lock is held", () => {
    const fixture = createFixture();
    const lock = acquireOperationLock(fixture.config, "start");
    try {
      expectCode(
        () => backupState(fixture.repository, fixture.config, join(fixture.outer, "blocked-backup")),
        "LOCKED",
      );
    } finally {
      releaseOperationLock(fixture.config, lock);
    }
  });

  it("refuses restore and interrupted-restore recovery below a world-writable state parent", () => {
    const restoreFixture = createFixture();
    const restoreBackupRoot = join(restoreFixture.outer, "parent-restore-backup");
    const restoreBackupResult = backupState(
      restoreFixture.repository,
      restoreFixture.config,
      restoreBackupRoot,
    );
    chmodSync(restoreFixture.outer, 0o777);
    expectCode(
      () => restoreState(restoreFixture.repository, restoreFixture.config, restoreBackupRoot, {
        operationId: randomUUID(),
        fromSha: "f".repeat(40),
        confirmReplace: restoreConfirmationToken(
          restoreFixture.config,
          restoreBackupResult.manifestSha256,
        ),
      }),
      "STATE_PERMISSION",
    );
    chmodSync(restoreFixture.outer, 0o700);

    const recoveryFixture = createFixture();
    const recoveryBackupRoot = join(recoveryFixture.outer, "parent-recovery-backup");
    const recoveryBackupResult = backupState(
      recoveryFixture.repository,
      recoveryFixture.config,
      recoveryBackupRoot,
    );
    expectCode(
      () => restoreState(recoveryFixture.repository, recoveryFixture.config, recoveryBackupRoot, {
        operationId: randomUUID(),
        fromSha: "f".repeat(40),
        confirmReplace: restoreConfirmationToken(
          recoveryFixture.config,
          recoveryBackupResult.manifestSha256,
        ),
        crashAtPhase: "journal-staging",
      }),
      "RESTORE_INTERRUPTED",
    );
    chmodSync(recoveryFixture.outer, 0o777);
    expectCode(() => recoverRestore(recoveryFixture.config), "STATE_PERMISSION");
    chmodSync(recoveryFixture.outer, 0o700);
    expectCode(
      () => recoverRestore(recoveryFixture.config, { buildReceiptSha256: "a".repeat(64) }),
      "RECOVERY_INVALID",
    );
    expect(recoverRestore(recoveryFixture.config, {
      buildReceiptSha256: recoveryFixture.build!.receiptSha256,
    }).recoveryOutcome).toBe("aborted-staging");
  });

  it("creates a SQLite-consistent bounded manifest and detects payload tampering", () => {
    const fixture = createFixture();
    const backupRoot = join(fixture.outer, "backup-one");
    const backup = backupState(fixture.repository, fixture.config, backupRoot);

    expect(backup.manifest.schema).toBe(BACKUP_MANIFEST_SCHEMA);
    expect(backup.manifest.releaseSha).toBe(fixture.sha);
    expect(backup.manifest.sqlite).toEqual({
      checkpoint: "complete",
      quickCheck: "ok",
      serviceState: "stopped",
    });
    expect(backup.manifest.files.map((entry) => entry.path)).toEqual([
      "artifacts/artifact0001.bin",
      "database/sympose.db",
    ].sort());

    const artifactEntry = backup.manifest.files.find((entry) => entry.path.startsWith("artifacts/"));
    if (!artifactEntry) throw new Error("artifact entry");
    writeFileSync(join(backupRoot, "payload", ...artifactEntry.path.split("/")), "tampered");
    expectCode(() => verifyBackupDirectory(backupRoot), "BACKUP_HASH_MISMATCH");
    expectCode(
      () => restoreState(fixture.repository, fixture.config, backupRoot, {
        operationId: randomUUID(),
        fromSha: "f".repeat(40),
      }),
      "BACKUP_HASH_MISMATCH",
    );
  });

  it("rejects traversal and symlink payloads before restore", () => {
    const traversalFixture = createFixture();
    const traversalRoot = join(traversalFixture.outer, "backup-traversal");
    backupState(traversalFixture.repository, traversalFixture.config, traversalRoot);
    const manifestPath = join(traversalRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    const artifact = manifest.files.find((entry) => entry.path.startsWith("artifacts/"));
    if (!artifact) throw new Error("artifact manifest entry");
    artifact.path = "artifacts/../escape";
    writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o600 });
    expectCode(() => verifyBackupDirectory(traversalRoot), "TREE_UNSAFE");
    expectCode(
      () => restoreState(traversalFixture.repository, traversalFixture.config, traversalRoot, {
        operationId: randomUUID(),
        fromSha: "f".repeat(40),
      }),
      "TREE_UNSAFE",
    );

    const symlinkFixture = createFixture();
    const symlinkRoot = join(symlinkFixture.outer, "backup-symlink");
    const symlinkBackup = backupState(symlinkFixture.repository, symlinkFixture.config, symlinkRoot);
    const symlinkEntry = symlinkBackup.manifest.files.find((entry) => entry.path.startsWith("artifacts/"));
    if (!symlinkEntry) throw new Error("symlink manifest entry");
    const payloadPath = join(symlinkRoot, "payload", ...symlinkEntry.path.split("/"));
    unlinkSync(payloadPath);
    symlinkSync(symlinkFixture.config.state.database, payloadPath);
    expectCode(() => verifyBackupDirectory(symlinkRoot), "TREE_UNSAFE");
    expectCode(
      () => restoreState(symlinkFixture.repository, symlinkFixture.config, symlinkRoot, {
        operationId: randomUUID(),
        fromSha: "f".repeat(40),
      }),
      "TREE_UNSAFE",
    );
  });

  it("requires exact replacement confirmation, restores hashes, and preserves prior state", () => {
    const fixture = createFixture();
    const backupRoot = join(fixture.outer, "backup-rollback");
    const backup = backupState(fixture.repository, fixture.config, backupRoot);
    const changed = new DatabaseSync(fixture.config.state.database);
    changed.prepare("UPDATE durable_value SET value = 'after' WHERE id = 1").run();
    changed.close();
    chmodSync(fixture.config.state.database, 0o600);
    const operationId = randomUUID();
    const fromSha = "f".repeat(40);

    expectCode(
      () => restoreState(fixture.repository, fixture.config, backupRoot, { operationId, fromSha }),
      "RESTORE_CONFIRMATION",
    );
    const confirmation = restoreConfirmationToken(fixture.config, backup.manifestSha256);
    const restored = restoreState(fixture.repository, fixture.config, backupRoot, {
      operationId,
      fromSha,
      confirmReplace: confirmation,
    });

    const database = new DatabaseSync(fixture.config.state.database, { readOnly: true });
    const row = database.prepare("SELECT value FROM durable_value WHERE id = 1").get() as { value: string };
    database.close();
    expect(row.value).toBe("before");
    const priorRoot = join(
      dirname(fixture.config.state.root),
      `.${fixture.config.state.root.split("/").at(-1)}.sympose-prior-${restored.priorStateId}`,
    );
    expect(readdirSync(priorRoot)).toContain("database");

    recordRunningVerification(
      fixture.config,
      fixture.build!.receiptSha256,
      "rollback-verified",
      operationId,
    );
    const receipts = readReceipts(fixture.config).map((receipt) => validateReceiptPayload(receipt));
    expect(receipts.some((receipt) => receipt.kind === "restore-completed")).toBe(true);
    expect(receipts.some((receipt) => receipt.kind === "rollback-verified")).toBe(true);
    const serialized = receipts.map((receipt) => canonicalJson(receipt)).join("");
    expect(serialized).not.toContain(fixture.outer);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.length).toBeLessThan(32 * 1024);
  });

  it("distinguishes a live initial restore from a real SIGKILL-abandoned transaction and aborts it", async () => {
    const fixture = createFixture();
    const backupRoot = join(fixture.outer, "backup-real-sigkill");
    const backup = backupState(fixture.repository, fixture.config, backupRoot);
    const changed = new DatabaseSync(fixture.config.state.database);
    changed.prepare("UPDATE durable_value SET value = 'after' WHERE id = 1").run();
    changed.close();
    chmodSync(fixture.config.state.database, 0o600);
    const operationId = randomUUID();
    const child = spawn(
      process.execPath,
      [resolve("tests/fixtures/production-release-restore-child.mjs")],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      child.stdin.end(JSON.stringify({
        repositoryRoot: fixture.repository,
        homeRoot: join(fixture.outer, "unused-home"),
        config: rawConfig(fixture.sha, fixture.stateRoot),
        backupRoot,
        confirmReplace: restoreConfirmationToken(fixture.config, backup.manifestSha256),
        fromSha: "f".repeat(40),
        operationId,
      }));
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          rejectReady(new Error(`restore child exited before durable transaction: ${code}/${signal}`));
        };
        child.once("exit", onExit);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (!output.includes("TRANSACTION_DURABLE\n")) return;
          child.removeListener("exit", onExit);
          resolveReady();
        });
      });

      expect(existsSync(join(fixture.outer, ".state-root.sympose-operation.lock"))).toBe(true);
      expectCode(
        () => recoverRestore(fixture.config, {
          buildReceiptSha256: fixture.build!.receiptSha256,
        }),
        "LOCKED",
      );
      expect(child.kill("SIGKILL")).toBe(true);
      const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
      );
      expect(killed).toEqual({ code: null, signal: "SIGKILL" });

      expect(recoverRestore(fixture.config, {
        buildReceiptSha256: fixture.build!.receiptSha256,
      }).recoveryOutcome).toBe("aborted-staging");
      expect(existsSync(join(fixture.outer, ".state-root.sympose-operation.lock"))).toBe(false);
      expect(existsSync(join(fixture.outer, ".state-root.sympose-restore-journal.json"))).toBe(false);
      expect(
        readdirSync(fixture.outer).filter((name) => name.startsWith(".state-root.sympose-prior-")),
      ).toHaveLength(0);
      const active = new DatabaseSync(fixture.config.state.database, { readOnly: true });
      const row = active.prepare("SELECT value FROM durable_value WHERE id = 1").get() as { value: string };
      active.close();
      expect(row.value).toBe("after");
      const receipts = readReceipts(fixture.config).map((receipt) => validateReceiptPayload(receipt));
      expect(receipts.some((receipt) => receipt.kind === "backup-completed")).toBe(true);
      expect(receipts.some((receipt) => receipt.kind === "restore-recovered")).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("recovers a real SIGKILL before atomic initial transaction publication without touching active state", async () => {
    const fixture = createFixture();
    const backupRoot = join(fixture.outer, "backup-real-prepublication-sigkill");
    const backup = backupState(fixture.repository, fixture.config, backupRoot);
    const changed = new DatabaseSync(fixture.config.state.database);
    changed.prepare("UPDATE durable_value SET value = 'after' WHERE id = 1").run();
    changed.close();
    chmodSync(fixture.config.state.database, 0o600);
    const child = spawn(
      process.execPath,
      [resolve("tests/fixtures/production-release-restore-child.mjs")],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      child.stdin.end(JSON.stringify({
        repositoryRoot: fixture.repository,
        homeRoot: join(fixture.outer, "unused-home"),
        config: rawConfig(fixture.sha, fixture.stateRoot),
        backupRoot,
        confirmReplace: restoreConfirmationToken(fixture.config, backup.manifestSha256),
        fromSha: "f".repeat(40),
        operationId: randomUUID(),
        pauseAt: "preparation",
      }));
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          rejectReady(new Error(`restore child exited before durable preparation: ${code}/${signal}`));
        };
        child.once("exit", onExit);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (!output.includes("PREPARATION_DURABLE\n")) return;
          child.removeListener("exit", onExit);
          resolveReady();
        });
      });

      const transaction = join(fixture.outer, ".state-root.sympose-operation.lock");
      const preparation = join(fixture.outer, ".state-root.sympose-restore-journal.json");
      expect(existsSync(transaction)).toBe(false);
      expect(existsSync(preparation)).toBe(true);
      expectCode(
        () => recoverRestore(fixture.config, {
          buildReceiptSha256: fixture.build!.receiptSha256,
        }),
        "LOCKED",
      );
      expect(child.kill("SIGKILL")).toBe(true);
      const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
      );
      expect(killed).toEqual({ code: null, signal: "SIGKILL" });

      expect(recoverRestore(fixture.config, {
        buildReceiptSha256: fixture.build!.receiptSha256,
      }).recoveryOutcome).toBe("aborted-initialization");
      expect(existsSync(transaction)).toBe(false);
      expect(existsSync(preparation)).toBe(false);
      expect(
        readdirSync(fixture.outer).filter((name) => (
          name.startsWith(".state-root.sympose-prior-")
          || name.startsWith(".state-root.sympose-restore-")
        )),
      ).toHaveLength(0);
      const active = new DatabaseSync(fixture.config.state.database, { readOnly: true });
      const row = active.prepare("SELECT value FROM durable_value WHERE id = 1").get() as { value: string };
      active.close();
      expect(row.value).toBe("after");
      const receipts = readReceipts(fixture.config).map((receipt) => validateReceiptPayload(receipt));
      expect(receipts.some((receipt) => receipt.kind === "backup-completed")).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("removes an abandoned pre-publication restore preparation without touching active state", () => {
    const fixture = createFixture();
    const preparation = join(fixture.outer, ".state-root.sympose-restore-journal.json");
    writeFileSync(preparation, "incomplete-before-atomic-publication", { mode: 0o600 });
    expect(recoverRestore(fixture.config).recoveryOutcome).toBe("aborted-initialization");
    expect(existsSync(preparation)).toBe(false);
    expect(existsSync(join(fixture.outer, ".state-root.sympose-operation.lock"))).toBe(false);
    const active = new DatabaseSync(fixture.config.state.database, { readOnly: true });
    const row = active.prepare("SELECT value FROM durable_value WHERE id = 1").get() as { value: string };
    active.close();
    expect(row.value).toBe("before");
    expect(readReceipts(fixture.config).some((receipt) => (
      receipt as { kind?: string }
    ).kind === "backup-completed")).toBe(false);
  });

  it("recovers deterministically from every durable restore crash phase without losing active or prior receipts", async () => {
    for (const crashAtPhase of RESTORE_CRASH_PHASES) {
      const fixture = createFixture();
      const backupRoot = join(fixture.outer, `backup-${crashAtPhase}`);
      const backup = backupState(fixture.repository, fixture.config, backupRoot);
      const changed = new DatabaseSync(fixture.config.state.database);
      changed.prepare("UPDATE durable_value SET value = 'after' WHERE id = 1").run();
      changed.close();
      chmodSync(fixture.config.state.database, 0o600);
      const operationId = randomUUID();
      const confirmation = restoreConfirmationToken(fixture.config, backup.manifestSha256);

      expectCode(
        () => restoreState(fixture.repository, fixture.config, backupRoot, {
          operationId,
          fromSha: "f".repeat(40),
          confirmReplace: confirmation,
          crashAtPhase,
        }),
        "RESTORE_INTERRUPTED",
      );
      recoverRestore(fixture.config, {
        buildReceiptSha256: fixture.build!.receiptSha256,
      });
      expect(inspectState(fixture.config, { allowEmptyDatabase: false }).sqlite.state).toBe("ready");
      expect(existsSync(join(fixture.outer, ".state-root.sympose-operation.lock"))).toBe(false);
      expect(existsSync(join(fixture.outer, ".state-root.sympose-restore-journal.json"))).toBe(false);
      expect(
        readdirSync(fixture.outer).filter((name) => name.startsWith(".state-root.sympose-restore-")),
      ).toHaveLength(0);

      const activeDatabase = new DatabaseSync(fixture.config.state.database, { readOnly: true });
      const activeRow = activeDatabase.prepare("SELECT value FROM durable_value WHERE id = 1").get() as {
        value: string;
      };
      activeDatabase.close();
      const activeReceipts = readReceipts(fixture.config).map((receipt) => validateReceiptPayload(receipt));

      if (crashAtPhase === "journal-staging") {
        expect(activeRow.value).toBe("after");
        expect(
          readdirSync(fixture.outer).filter((name) => name.startsWith(".state-root.sympose-prior-")),
        ).toHaveLength(0);
        expect(activeReceipts.some((receipt) => receipt.kind === "backup-completed")).toBe(true);
        expect(activeReceipts.some((receipt) => receipt.kind === "restore-recovered")).toBe(true);
      } else {
        expect(activeRow.value).toBe("before");
        const priorNames = readdirSync(fixture.outer)
          .filter((name) => name.startsWith(".state-root.sympose-prior-"));
        expect(priorNames).toHaveLength(1);
        const priorRoot = join(fixture.outer, priorNames[0]!);
        const priorDatabase = new DatabaseSync(join(priorRoot, "database", "sympose.db"), {
          readOnly: true,
        });
        const priorRow = priorDatabase.prepare("SELECT value FROM durable_value WHERE id = 1").get() as {
          value: string;
        };
        priorDatabase.close();
        expect(priorRow.value).toBe("after");
        expect(readdirSync(join(priorRoot, "receipts")).some((name) => name.endsWith(".json"))).toBe(true);
        expect(activeReceipts.some((receipt) => receipt.kind === "restore-completed")).toBe(true);
      }
    }
  }, 60_000);
});

describe("receipt redaction and bounds", () => {
  function receipt(details: Record<string, unknown>) {
    return {
      schema: RECEIPT_SCHEMA,
      receiptId: randomUUID(),
      kind: "restart-verified",
      instanceId: "sympose-test-instance",
      releaseSha: "a".repeat(40),
      buildReceiptSha256: "b".repeat(64),
      occurredAt: "2026-08-14T12:00:00.000Z",
      operationId: randomUUID(),
      details,
    };
  }

  it("accepts only bounded allowlisted metadata and rejects secrets, URLs, and paths", () => {
    expect(validateReceiptPayload(receipt({ healthStatus: "ok", verification: "exact" }))).toMatchObject({
      kind: "restart-verified",
    });
    expectCode(() => validateReceiptPayload(receipt({ authorization: "redacted" })), "RECEIPT_INVALID");
    expectCode(() => validateReceiptPayload(receipt({ note: "Bearer example" })), "RECEIPT_INVALID");
    expectCode(() => validateReceiptPayload(receipt({ note: "https://example.invalid" })), "RECEIPT_INVALID");
    expectCode(() => validateReceiptPayload(receipt({ note: "/var/lib/state" })), "RECEIPT_INVALID");
    expectCode(() => validateReceiptPayload(receipt({ note: "x".repeat(513) })), "RECEIPT_INVALID");
  });
});
