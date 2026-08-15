import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export const CONFIG_SCHEMA = "sympose-production-evaluator-config/v1";
export const STATE_SCHEMA = "sympose-production-evaluator-state/v1";
export const PRODUCTION_CONFIG_SCHEMA = "sympose-production-config/v1";
export const PRODUCTION_STATE_SCHEMA = "sympose-production-state/v1";
export const BUILD_RECEIPT_SCHEMA = "sympose-production-build/v2";
export const BACKUP_MANIFEST_SCHEMA = "sympose-production-backup/v1";
export const RECEIPT_SCHEMA = "sympose-production-operation-receipt/v1";
export const VERIFY_SCHEMA = "sympose-production-verification/v1";
export const RESTORE_JOURNAL_SCHEMA = "sympose-production-restore-transaction/v2";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/u;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const ARTIFACT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{8,128}(?:\.bin)?$/u;

const CONFIG_MAX_BYTES = 32 * 1024;
const STATE_MARKER_MAX_BYTES = 8 * 1024;
const BUILD_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const BACKUP_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const RESTORE_JOURNAL_MAX_BYTES = 32 * 1024;
const RECEIPT_MAX_BYTES = 16 * 1024;
const HEALTH_MAX_BYTES = 4 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_BUILD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_BACKUP_FILES = 20_000;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_STATE_AUXILIARY_BYTES = 64 * 1024 * 1024;
const MAX_OPERATION_LOG_BYTES = 2 * 1024 * 1024;
const MAX_SYMLINK_HOPS = 64;
const MAX_SCHEMA_SOURCE_BYTES = 16 * 1024 * 1024;
const APPLICATION_SCHEMA_PATH = "src/server/schema.ts";
const REQUIRED_SEED_VERSION = "1";

const CONFIG_KEYS = [
  "dataClassification",
  "host",
  "instanceId",
  "port",
  "releaseSha",
  "runtimeProfile",
  "schema",
  "state",
];
const PRODUCTION_CONFIG_KEYS = [...CONFIG_KEYS, "bootstrap"];
const PRODUCTION_BOOTSTRAP_KEYS = ["issuedAt", "tokenFile"];
const STATE_KEYS = [
  "artifacts",
  "database",
  "logs",
  "receipts",
  "root",
  "runtime",
  "temporary",
];
const STATE_MARKER_KEYS = [
  "dataClassification",
  "initializedAt",
  "instanceId",
  "schema",
];
const BUILD_RECEIPT_KEYS = [
  "architecture",
  "buildId",
  "createdAt",
  "files",
  "inputs",
  "nextVersion",
  "nodeVersion",
  "platform",
  "releaseSha",
  "runtime",
  "schemaVersion",
  "schema",
  "totals",
];
const BACKUP_MANIFEST_KEYS = [
  "backupId",
  "buildReceiptSha256",
  "createdAt",
  "files",
  "instanceId",
  "releaseSha",
  "schema",
  "sqlite",
  "totals",
];
const FILE_ENTRY_KEYS = ["path", "sha256", "size"];
const BUILD_FILE_ENTRY_KEYS = ["mode", "path", "sha256", "size"];
const BUILD_INPUT_ENTRY_KEYS = ["links", "mode", "path", "resolvedPath", "sha256", "size", "type"];
const BUILD_INPUT_LINK_KEYS = ["mode", "path", "target"];
const RUNTIME_DIRECTORY_ENTRY_KEYS = ["mode", "path"];
const RUNTIME_KEYS = ["directories", "entrypoint", "root", "totals"];
const RESTORE_JOURNAL_KEYS = [
  "backupId",
  "buildReceiptSha256",
  "fromSha",
  "instanceId",
  "kind",
  "manifestSha256",
  "operationId",
  "phase",
  "previousDatabaseState",
  "priorStateId",
  "releaseSha",
  "schema",
  "stageId",
];
const RECEIPT_KEYS = [
  "buildReceiptSha256",
  "details",
  "instanceId",
  "kind",
  "occurredAt",
  "operationId",
  "receiptId",
  "releaseSha",
  "schema",
];

const RECEIPT_KINDS = new Set([
  "backup-completed",
  "restore-completed",
  "restore-recovered",
  "rollback-verified",
  "start-ready",
  "start-requested",
  "start-stopped",
  "restart-verified",
]);
const OPERATION_LOCK_KINDS = new Set(["backup", "build", "init", "restore", "start"]);
const RESTORE_PHASES = new Set([
  "staging",
  "prepared",
  "prior-moved",
  "installed",
  "committed",
  "aborted",
]);
export const RESTORE_CRASH_PHASES = Object.freeze([
  "journal-staging",
  "stage-prepared",
  "prior-renamed",
  "prior-recorded",
  "state-installed",
  "install-recorded",
  "receipt-durable",
  "commit-recorded",
  "recovery-metadata-removed",
  "lock-released",
  "journal-removed",
]);

const RESTORE_LEASE_WORKER_KIND = "sympose-production-restore-lease/v1";
const RESTORE_LEASE_PENDING = 0;
const RESTORE_LEASE_ACQUIRED = 1;
const RESTORE_LEASE_CONFLICT = 2;
const RESTORE_LEASE_FAILED = 3;
const RESTORE_LEASE_RELEASE = 4;
const RESTORE_LEASE_CLOSED = 5;

const ERROR_MESSAGES = Object.freeze({
  BACKUP_BUSY: "The service-stopped backup precondition is not satisfied.",
  BACKUP_HASH_MISMATCH: "A backup payload hash or size does not match its manifest.",
  BACKUP_INVALID: "The backup is malformed or outside the bounded backup contract.",
  BACKUP_OUTPUT_UNSAFE: "The backup destination is unsafe, broad, relative, or overlapping.",
  BUILD_FAILED: "The production build command failed.",
  BUILD_INVALID: "The production build receipt or output is missing, stale, or invalid.",
  CONFIG_INVALID: "The release configuration is malformed or unsupported.",
  CONFIG_PERMISSION: "The release configuration has insecure ownership or permissions.",
  DEPENDENCIES_MISSING: "Pinned production dependencies are missing or invalid.",
  DURABILITY_FAILED: "A required durable filesystem synchronization failed.",
  ENV_FILE: "A framework-loaded or runtime .env path is present.",
  GIT_DIRTY: "The repository contains tracked or untracked source changes.",
  GIT_INVALID: "The exact Git candidate could not be verified.",
  HEALTH_INVALID: "The health response does not match the exact release contract.",
  HEALTH_TIMEOUT: "The exact health contract was not reached before the bounded timeout.",
  LOCK_INVALID: "The release operation lock is missing, stale, or malformed.",
  LOCK_TIMEOUT: "The exact owned start lock was not reached before the bounded timeout.",
  LOCKED: "Another release operation owns this state root.",
  PATH_OVERLAP: "Configured state paths overlap or do not use the fixed layout.",
  PATH_UNSAFE: "A configured path is unsafe, broad, relative, or overlaps protected paths.",
  PORT_BUSY: "The configured loopback port is already in use.",
  RECEIPT_INVALID: "The operation receipt violates redaction or size bounds.",
  RECEIPT_WRITE: "The operation receipt could not be written safely.",
  RECOVERY_INVALID: "The interrupted restore journal or recovery topology is invalid.",
  RECOVERY_REQUIRED: "An interrupted restore must be recovered before this operation.",
  RESTORE_CONFIRMATION: "Replacing non-empty state requires the exact confirmation token.",
  RESTORE_FAILED: "The durable restore transaction could not complete or enter recoverable state.",
  RESTORE_INTERRUPTED: "The restore stopped at an injected crash boundary.",
  SHA_INVALID: "The release identity must be one lowercase full 40-character Git SHA.",
  SHA_MISMATCH: "The requested release SHA does not match the exact Git candidate.",
  SQLITE_INVALID: "The SQLite state is empty without initialization or fails the release contract.",
  STARTUP_EXIT: "The production server exited before exact health was stable.",
  STARTUP_FAILED: "The production server could not be started.",
  STATE_EXISTS: "State initialization refuses a non-empty destination.",
  STATE_INVALID: "The persistent state layout is absent, malformed, or contains unexpected entries.",
  STATE_PERMISSION: "Persistent state ownership or permissions are insecure.",
  TREE_UNSAFE: "A state or backup tree contains an unsafe path, symlink, or special file.",
  TERMINATION_UNPROVEN: "The owned production server did not conclusively terminate.",
});

export class ReleaseKitError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? "The release operation failed closed.");
    this.name = "ReleaseKitError";
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseKitError(code);
}

function exactKeys(value, keys, code = "CONFIG_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function exactIso(value, code = "RECEIPT_INVALID") {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) fail(code);
  return value;
}

export function exactFullSha(value, mismatchCode = "SHA_INVALID") {
  if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) fail(mismatchCode);
  return value;
}

function exactHash(value, code = "BACKUP_INVALID") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function exactUuid(value, code = "RECEIPT_INVALID") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(code);
  return value;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertCanonicalAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > 1024 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) fail("PATH_UNSAFE");
  return value;
}

function containsPath(parent, child) {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function pathsOverlap(first, second) {
  return containsPath(first, second) || containsPath(second, first);
}

const BROAD_ROOTS = new Set([
  "/",
  "/etc",
  "/home",
  "/opt",
  "/root",
  "/run",
  "/srv",
  "/tmp",
  "/usr",
  "/var",
  "/var/lib",
  "/var/tmp",
]);

export function assertSafeOperationalRoot(
  value,
  { repositoryRoot, homeRoot = homedir(), otherRoots = [] } = {},
) {
  const root = assertCanonicalAbsolutePath(value);
  if (BROAD_ROOTS.has(root) || !SAFE_SEGMENT_PATTERN.test(basename(root))) fail("PATH_UNSAFE");
  if (repositoryRoot && pathsOverlap(root, resolve(repositoryRoot))) fail("PATH_UNSAFE");
  if (homeRoot && containsPath(resolve(homeRoot), root)) fail("PATH_UNSAFE");
  for (const other of otherRoots) {
    if (pathsOverlap(root, resolve(other))) fail("PATH_UNSAFE");
  }
  return root;
}

function expectedStatePaths(root) {
  return Object.freeze({
    root,
    database: join(root, "database", "sympose.db"),
    artifacts: join(root, "artifacts"),
    temporary: join(root, "tmp"),
    receipts: join(root, "receipts"),
    logs: join(root, "logs"),
    runtime: join(root, "runtime"),
  });
}

function readApplicationSchema(repositoryRoot) {
  const input = fingerprintRepositoryInput(repositoryRoot, APPLICATION_SCHEMA_PATH, {
    code: "DEPENDENCIES_MISSING",
    requireDirect: true,
    maxBytes: MAX_SCHEMA_SOURCE_BYTES,
  });
  let source;
  try {
    source = readFileSync(join(repositoryRoot, ...input.resolvedPath.split("/")), "utf8");
  } catch {
    fail("DEPENDENCIES_MISSING");
  }
  const declarations = source.match(/^.*\bSCHEMA_VERSION\b.*$/gmu) ?? [];
  if (declarations.length !== 1) fail("DEPENDENCIES_MISSING");
  const match = /^export const SCHEMA_VERSION = ([1-9][0-9]*);$/u.exec(declarations[0]);
  if (!match) fail("DEPENDENCIES_MISSING");
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) fail("DEPENDENCIES_MISSING");
  return Object.freeze({ input, version, databaseVersion: String(version) });
}

export function parseReleaseConfig(value, { repositoryRoot, homeRoot = homedir() } = {}) {
  if (!isPlainObject(value)) fail("CONFIG_INVALID");
  const productionProfile = value.schema === PRODUCTION_CONFIG_SCHEMA;
  const record = exactKeys(value, productionProfile ? PRODUCTION_CONFIG_KEYS : CONFIG_KEYS);
  if (
    (!productionProfile && record.schema !== CONFIG_SCHEMA) ||
    (productionProfile
      ? record.dataClassification !== "ORGANIZER_PRIVATE" || record.runtimeProfile !== "production"
      : record.dataClassification !== "PUBLIC_SYNTHETIC" ||
        (record.runtimeProfile !== "base" && record.runtimeProfile !== "synthetic-evaluator")) ||
    record.host !== "127.0.0.1" ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    typeof record.instanceId !== "string" ||
    !INSTANCE_PATTERN.test(record.instanceId)
  ) fail("CONFIG_INVALID");
  const canonicalRepositoryRoot = assertCanonicalAbsolutePath(repositoryRoot);
  try {
    if (realpathSync(canonicalRepositoryRoot) !== canonicalRepositoryRoot) fail("CONFIG_INVALID");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("CONFIG_INVALID");
  }
  const applicationSchema = readApplicationSchema(canonicalRepositoryRoot);
  const releaseSha = exactFullSha(record.releaseSha);
  const stateRecord = exactKeys(record.state, STATE_KEYS);
  const root = assertSafeOperationalRoot(stateRecord.root, {
    repositoryRoot: canonicalRepositoryRoot,
    homeRoot,
  });
  const configured = {};
  for (const key of STATE_KEYS) configured[key] = assertCanonicalAbsolutePath(stateRecord[key]);
  const endpoints = STATE_KEYS.filter((key) => key !== "root");
  for (let first = 0; first < endpoints.length; first += 1) {
    for (let second = first + 1; second < endpoints.length; second += 1) {
      if (pathsOverlap(configured[endpoints[first]], configured[endpoints[second]])) {
        fail("PATH_OVERLAP");
      }
    }
  }
  const expected = expectedStatePaths(root);
  for (const key of STATE_KEYS) {
    if (configured[key] !== expected[key]) fail("PATH_OVERLAP");
  }
  let bootstrap;
  if (productionProfile) {
    bootstrap = parseProductionBootstrapReference(record.bootstrap, {
      repositoryRoot: canonicalRepositoryRoot,
      stateRoot: root,
    });
  }
  if (productionProfile) {
    return Object.freeze({
      schema: PRODUCTION_CONFIG_SCHEMA,
      dataClassification: "ORGANIZER_PRIVATE",
      host: "127.0.0.1",
      instanceId: record.instanceId,
      port: record.port,
      releaseSha,
      runtimeProfile: "production",
      applicationSchemaVersion: applicationSchema.databaseVersion,
      state: expected,
      bootstrap,
    });
  }
  return Object.freeze({
    schema: CONFIG_SCHEMA,
    dataClassification: "PUBLIC_SYNTHETIC",
    host: "127.0.0.1",
    instanceId: record.instanceId,
    port: record.port,
    releaseSha,
    runtimeProfile: record.runtimeProfile,
    applicationSchemaVersion: applicationSchema.databaseVersion,
    state: expected,
  });
}

function validateProductionBootstrapTokenFile(tokenFile) {
  let file;
  let parent;
  try {
    file = lstatSync(tokenFile);
    parent = lstatSync(dirname(tokenFile));
    if (realpathSync(tokenFile) !== tokenFile || realpathSync(dirname(tokenFile)) !== dirname(tokenFile)) {
      fail("CONFIG_PERMISSION");
    }
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("CONFIG_PERMISSION");
  }
  const uid = currentUid();
  if (
    file.isSymbolicLink() || !file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0 ||
    file.size < 32 || file.size > 513 || parent.isSymbolicLink() || !parent.isDirectory() ||
    parent.uid !== uid || (parent.mode & 0o022) !== 0
  ) fail("CONFIG_PERMISSION");
  let raw;
  try {
    raw = readFileSync(tokenFile, "utf8");
  } catch {
    fail("CONFIG_PERMISSION");
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (
    token.includes("\n") || token.includes("\r") ||
    /[\u0000-\u001f\u007f]/u.test(token) ||
    byteLength(token) < 32 || byteLength(token) > 512
  ) fail("CONFIG_INVALID");
}

function parseProductionBootstrapReference(value, { repositoryRoot, stateRoot }) {
  if (value === null) return null;
  const record = exactKeys(value, PRODUCTION_BOOTSTRAP_KEYS);
  const issuedAt = exactIso(record.issuedAt, "CONFIG_INVALID");
  if (Date.parse(issuedAt) > Date.now() + 5 * 60 * 1_000) fail("CONFIG_INVALID");
  let tokenFile;
  try {
    tokenFile = assertCanonicalAbsolutePath(record.tokenFile);
  } catch {
    fail("CONFIG_INVALID");
  }
  if (pathsOverlap(tokenFile, repositoryRoot) || pathsOverlap(tokenFile, stateRoot)) {
    fail("CONFIG_INVALID");
  }
  validateProductionBootstrapTokenFile(tokenFile);
  return Object.freeze({ issuedAt, tokenFile });
}

function dataModeForConfig(config) {
  return config.schema === PRODUCTION_CONFIG_SCHEMA ? "production" : "synthetic-evaluator";
}

function stateContractForConfig(config) {
  return config.schema === PRODUCTION_CONFIG_SCHEMA
    ? Object.freeze({ schema: PRODUCTION_STATE_SCHEMA, dataClassification: "ORGANIZER_PRIVATE" })
    : Object.freeze({ schema: STATE_SCHEMA, dataClassification: "PUBLIC_SYNTHETIC" });
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("STATE_PERMISSION");
  return process.getuid();
}

function fsyncDescriptor(descriptor, code = "DURABILITY_FAILED") {
  try {
    fsyncSync(descriptor);
  } catch {
    fail(code);
  }
}

function fsyncDirectory(path, code = "DURABILITY_FAILED") {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncDescriptor(descriptor, code);
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function durableRename(source, destination, code = "DURABILITY_FAILED") {
  try {
    renameSync(source, destination);
    fsyncDirectory(dirname(source), code);
    if (dirname(destination) !== dirname(source)) fsyncDirectory(dirname(destination), code);
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail(code);
  }
}

function durableUnlink(path, code = "DURABILITY_FAILED") {
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path), code);
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail(code);
  }
}

export function assertTrustedStateParent(config) {
  const parent = dirname(config.state.root);
  let metadata;
  try {
    metadata = lstatSync(parent);
  } catch {
    fail("STATE_PERMISSION");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o022) !== 0
  ) fail("STATE_PERMISSION");
  try {
    if (realpathSync(parent) !== parent) fail("STATE_PERMISSION");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("STATE_PERMISSION");
  }
  return parent;
}

export function assertNoFrameworkEnvFiles(root) {
  const projectRoot = assertCanonicalAbsolutePath(root);
  let metadata;
  let names;
  try {
    metadata = lstatSync(projectRoot);
    names = readdirSync(projectRoot);
  } catch {
    fail("ENV_FILE");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("ENV_FILE");
  if (names.some((name) => name.startsWith(".env"))) fail("ENV_FILE");
}

function assertNoAmbientApplicationState(root) {
  const runtimeRoot = assertCanonicalAbsolutePath(root);
  const visit = (directory, segments) => {
    for (const name of readdirSync(directory).sort()) {
      logicalBuildPath(name);
      const nextSegments = [...segments, name];
      const nodeModulesIndex = nextSegments.indexOf("node_modules");
      const applicationSegments = nodeModulesIndex === -1
        ? nextSegments
        : nextSegments.slice(0, nodeModulesIndex);
      if (
        applicationSegments.some((segment) => segment.startsWith(".sympose-artifacts-"))
        || /^sympose\.db(?:-(?:shm|wal))?$/u.test(applicationSegments.at(-1) ?? "")
      ) fail("BUILD_INVALID");
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail("BUILD_INVALID");
      if (metadata.isDirectory()) visit(path, nextSegments);
      else if (!metadata.isFile()) fail("BUILD_INVALID");
    }
  };
  visit(runtimeRoot, []);
}

function assertConfigurationFile(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("CONFIG_INVALID");
  }
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > CONFIG_MAX_BYTES ||
    (metadata.uid !== uid && metadata.uid !== 0) ||
    (metadata.mode & 0o022) !== 0
  ) fail("CONFIG_PERMISSION");
  try {
    if (realpathSync(path) !== path) fail("CONFIG_PERMISSION");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("CONFIG_PERMISSION");
  }
}

export function loadReleaseConfig(path, options = {}) {
  const configPath = assertCanonicalAbsolutePath(path);
  assertConfigurationFile(configPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    fail("CONFIG_INVALID");
  }
  return parseReleaseConfig(parsed, options);
}

function assertPrivateMetadata(metadata, kind) {
  const correctType = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (
    metadata.isSymbolicLink() ||
    !correctType ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== expectedMode
  ) fail("STATE_PERMISSION");
}

function privateMetadata(path, kind) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("STATE_INVALID");
  }
  assertPrivateMetadata(metadata, kind);
  return metadata;
}

function assertSafeSegment(name) {
  if (!SAFE_SEGMENT_PATTERN.test(name) || name === "." || name === "..") fail("TREE_UNSAFE");
}

function walkPrivateTree(root, { maxEntries = MAX_TREE_ENTRIES, maxBytes = MAX_STATE_AUXILIARY_BYTES } = {}) {
  privateMetadata(root, "directory");
  const files = [];
  const directories = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (directory, relativeDirectory) => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      assertSafeSegment(name);
      entries += 1;
      if (entries > maxEntries) fail("TREE_UNSAFE");
      const absolute = join(directory, name);
      const logical = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail("TREE_UNSAFE");
      if (metadata.isDirectory()) {
        assertPrivateMetadata(metadata, "directory");
        directories.push(logical);
        visit(absolute, logical);
      } else if (metadata.isFile()) {
        assertPrivateMetadata(metadata, "file");
        totalBytes += metadata.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) fail("TREE_UNSAFE");
        files.push(Object.freeze({ absolute, path: logical, size: metadata.size }));
      } else {
        fail("TREE_UNSAFE");
      }
    }
  };
  visit(root, "");
  return Object.freeze({ files, directories, entries, totalBytes });
}

function readBoundedJson(path, maximumBytes, code) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(code);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) fail(code);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code);
  }
  return value;
}

function stateMarkerPath(config) {
  return join(config.state.root, "state.json");
}

function validateStateMarker(config) {
  privateMetadata(stateMarkerPath(config), "file");
  const marker = exactKeys(
    readBoundedJson(stateMarkerPath(config), STATE_MARKER_MAX_BYTES, "STATE_INVALID"),
    STATE_MARKER_KEYS,
    "STATE_INVALID",
  );
  const expected = stateContractForConfig(config);
  if (
    marker.schema !== expected.schema ||
    marker.instanceId !== config.instanceId ||
    marker.dataClassification !== expected.dataClassification
  ) fail("STATE_INVALID");
  exactIso(marker.initializedAt, "STATE_INVALID");
  return marker;
}

function databaseSidecars(config) {
  return [`${config.state.database}-wal`, `${config.state.database}-shm`];
}

function validateDatabaseDirectory(config) {
  const directory = dirname(config.state.database);
  privateMetadata(directory, "directory");
  const allowed = new Set([basename(config.state.database), `${basename(config.state.database)}-wal`, `${basename(config.state.database)}-shm`]);
  for (const name of readdirSync(directory)) {
    if (!allowed.has(name)) fail("STATE_INVALID");
    privateMetadata(join(directory, name), "file");
  }
  return privateMetadata(config.state.database, "file");
}

function withPrivateUmask(operation) {
  let previous;
  try {
    previous = process.umask(0o077);
  } catch {
    // Vitest worker threads prohibit process-wide umask changes. All state files and directories
    // still receive explicit private modes; the operational CLI sets 0077 before dispatch.
    return operation();
  }
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
}

export function inspectSqliteState(config, { allowEmpty = true } = {}) {
  const metadata = validateDatabaseDirectory(config);
  if (metadata.size === 0) {
    if (!allowEmpty) fail("SQLITE_INVALID");
    return Object.freeze({ state: "explicit-empty", schemaVersion: null, seedVersion: null });
  }
  let database;
  try {
    database = withPrivateUmask(() => new DatabaseSync(config.state.database, { readOnly: true }));
    const quickRows = database.prepare("PRAGMA quick_check(1)").all();
    if (
      quickRows.length !== 1 ||
      !quickRows[0] ||
      Object.values(quickRows[0]).length !== 1 ||
      Object.values(quickRows[0])[0] !== "ok"
    ) fail("SQLITE_INVALID");
    const journalRow = database.prepare("PRAGMA journal_mode").get();
    if (!journalRow || String(Object.values(journalRow)[0]).toLowerCase() !== "wal") {
      fail("SQLITE_INVALID");
    }
    const productionProfile = dataModeForConfig(config) === "production";
    const rows = database.prepare(productionProfile
      ? "SELECT key, value FROM meta WHERE key IN ('runtime_mode', 'schema_version', 'seed_version') ORDER BY key"
      : "SELECT key, value FROM meta WHERE key IN ('schema_version', 'seed_version') ORDER BY key").all();
    const metadataMap = new Map(rows.map((row) => [row.key, row.value]));
    if (productionProfile) {
      if (
        metadataMap.size !== 2 ||
        metadataMap.get("schema_version") !== config.applicationSchemaVersion ||
        metadataMap.get("runtime_mode") !== "production" ||
        metadataMap.has("seed_version")
      ) fail("SQLITE_INVALID");
      return Object.freeze({
        state: "ready",
        schemaVersion: config.applicationSchemaVersion,
        seedVersion: null,
        runtimeMode: "production",
      });
    }
    if (
      metadataMap.size !== 2 ||
      metadataMap.get("schema_version") !== config.applicationSchemaVersion ||
      metadataMap.get("seed_version") !== REQUIRED_SEED_VERSION
    ) fail("SQLITE_INVALID");
    return Object.freeze({
      state: "ready",
      schemaVersion: config.applicationSchemaVersion,
      seedVersion: REQUIRED_SEED_VERSION,
    });
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("SQLITE_INVALID");
  } finally {
    try {
      database?.close();
    } catch {
      fail("SQLITE_INVALID");
    }
    for (const sidecar of databaseSidecars(config)) {
      if (existsSync(sidecar)) privateMetadata(sidecar, "file");
    }
  }
}

export function validateStateLayout(config, { allowEmptyDatabase = true } = {}) {
  privateMetadata(config.state.root, "directory");
  try {
    if (realpathSync(config.state.root) !== config.state.root) fail("STATE_INVALID");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("STATE_INVALID");
  }
  const expectedRootEntries = new Set([
    "artifacts",
    "database",
    "logs",
    "receipts",
    "runtime",
    "state.json",
    "tmp",
  ]);
  const actual = readdirSync(config.state.root).sort();
  if (actual.length !== expectedRootEntries.size || actual.some((name) => !expectedRootEntries.has(name))) {
    fail("STATE_INVALID");
  }
  validateStateMarker(config);
  const sqlite = inspectSqliteState(config, { allowEmpty: allowEmptyDatabase });
  const trees = {};
  trees.artifacts = walkPrivateTree(config.state.artifacts, {
    maxEntries: MAX_BACKUP_FILES,
    maxBytes: MAX_BACKUP_BYTES,
  });
  for (const key of ["temporary", "receipts", "logs", "runtime"]) {
    trees[key] = walkPrivateTree(config.state[key]);
  }
  return Object.freeze({ sqlite, trees: Object.freeze(trees) });
}

function assertNoSymlinkAncestors(path) {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  let canonical;
  try {
    canonical = realpathSync(current);
  } catch {
    fail("PATH_UNSAFE");
  }
  if (canonical !== resolve(current)) fail("PATH_UNSAFE");
}

function createPrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  privateMetadata(path, "directory");
  fsyncDirectory(path);
  fsyncDirectory(dirname(path));
}

function createPrivateFile(path, contents = "") {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    if (contents.length > 0) writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
  privateMetadata(path, "file");
  fsyncDirectory(dirname(path));
}

export function initializeState(config, { clock = () => new Date().toISOString() } = {}) {
  assertTrustedStateParent(config);
  requireNoOperationLock(config);
  assertNoSymlinkAncestors(config.state.root);
  if (existsSync(config.state.root)) {
    const metadata = lstatSync(config.state.root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("STATE_EXISTS");
    assertPrivateMetadata(metadata, "directory");
    if (readdirSync(config.state.root).length !== 0) fail("STATE_EXISTS");
  } else {
    createPrivateDirectory(config.state.root);
  }
  createPrivateDirectory(dirname(config.state.database));
  for (const key of ["artifacts", "temporary", "receipts", "logs", "runtime"]) {
    createPrivateDirectory(config.state[key]);
  }
  createPrivateFile(config.state.database);
  const stateContract = stateContractForConfig(config);
  createPrivateFile(stateMarkerPath(config), canonicalJson({
    schema: stateContract.schema,
    instanceId: config.instanceId,
    dataClassification: stateContract.dataClassification,
    initializedAt: exactIso(clock(), "STATE_INVALID"),
  }));
  return validateStateLayout(config);
}

function git(repositoryRoot, args) {
  return spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitText(repositoryRoot, args) {
  const result = git(repositoryRoot, args);
  if (result.status !== 0 || typeof result.stdout !== "string") fail("GIT_INVALID");
  return result.stdout.trim();
}

export function verifyGitCandidate(repositoryRoot, requestedSha) {
  const root = assertCanonicalAbsolutePath(repositoryRoot);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    fail("GIT_INVALID");
  }
  if (canonicalRoot !== root || resolve(gitText(root, ["rev-parse", "--show-toplevel"])) !== root) {
    fail("GIT_INVALID");
  }
  const head = exactFullSha(gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]), "GIT_INVALID");
  const expected = exactFullSha(requestedSha);
  if (head !== expected) fail("SHA_MISMATCH");
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (status.status !== 0 || typeof status.stdout !== "string") fail("GIT_INVALID");
  if (status.stdout.length !== 0) fail("GIT_DIRTY");
  return head;
}

export function hashFile(path, { maxBytes = MAX_BACKUP_BYTES, permission = null } = {}) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("TREE_UNSAFE");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) fail("TREE_UNSAFE");
  if (permission) assertPrivateMetadata(metadata, "file");
  const descriptor = openSync(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let observed = 0;
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      observed += count;
      if (observed > maxBytes) fail("TREE_UNSAFE");
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  if (observed !== metadata.size) fail("TREE_UNSAFE");
  return Object.freeze({ size: observed, sha256: digest.digest("hex") });
}

function exactFilesystemMode(metadata) {
  return metadata.mode & 0o7777;
}

function resolveRepositoryInput(repositoryRoot, inputPath, code, { allowDirectory = false } = {}) {
  try {
    const root = assertCanonicalAbsolutePath(repositoryRoot);
    const logicalInput = logicalBuildPath(inputPath);
    const pending = logicalInput.split("/");
    const resolvedSegments = [];
    const links = [];
    const seenStates = new Set();
    while (pending.length > 0) {
      const component = pending.shift();
      const candidate = join(root, ...resolvedSegments, component);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        if (links.length >= MAX_SYMLINK_HOPS) fail(code);
        const linkPath = logicalBuildPath(relative(root, candidate).split(sep).join("/"));
        const target = readlinkSync(candidate, "utf8");
        if (
          typeof target !== "string" ||
          target.length === 0 ||
          byteLength(target) > 2048 ||
          target.includes("\0") ||
          target.includes("\\") ||
          isAbsolute(target)
        ) fail(code);
        const targetAbsolute = resolve(dirname(candidate), target);
        if (!containsPath(root, targetAbsolute)) fail(code);
        const targetRelative = relative(root, targetAbsolute);
        const nextPending = [
          ...(targetRelative === "" ? [] : targetRelative.split(sep)),
          ...pending,
        ];
        const state = `${linkPath}\0${nextPending.join("/")}`;
        if (seenStates.has(state)) fail(code);
        seenStates.add(state);
        links.push(Object.freeze({
          path: linkPath,
          target,
          mode: exactFilesystemMode(metadata),
        }));
        pending.splice(0, pending.length, ...nextPending);
        resolvedSegments.splice(0, resolvedSegments.length);
        continue;
      }
      if (pending.length > 0 && !metadata.isDirectory()) fail(code);
      resolvedSegments.push(component);
    }
    const absolute = join(root, ...resolvedSegments);
    const metadata = lstatSync(absolute);
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isFile() && !(allowDirectory && metadata.isDirectory())) ||
      realpathSync(absolute) !== absolute
    ) fail(code);
    return Object.freeze({
      absolute,
      links: Object.freeze(links),
      metadata,
      path: logicalInput,
      resolvedPath: logicalBuildPath(resolvedSegments.join("/")),
    });
  } catch (error) {
    if (error instanceof ReleaseKitError && error.code === code) throw error;
    fail(code);
  }
}

function fingerprintRepositoryInput(
  repositoryRoot,
  inputPath,
  { code = "DEPENDENCIES_MISSING", maxBytes = MAX_BUILD_BYTES, requireDirect = false } = {},
) {
  const resolved = resolveRepositoryInput(repositoryRoot, inputPath, code);
  if (requireDirect && (resolved.links.length !== 0 || resolved.resolvedPath !== resolved.path)) fail(code);
  return Object.freeze({
    path: resolved.path,
    resolvedPath: resolved.resolvedPath,
    type: "file",
    mode: exactFilesystemMode(resolved.metadata),
    links: resolved.links,
    ...hashFile(resolved.absolute, { maxBytes }),
  });
}

function fingerprintDirectInput(path, logicalInputPath, maxBytes) {
  let metadata;
  try {
    metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || realpathSync(path) !== path) {
      fail("DEPENDENCIES_MISSING");
    }
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("DEPENDENCIES_MISSING");
  }
  const logical = logicalBuildPath(logicalInputPath);
  return Object.freeze({
    path: logical,
    resolvedPath: logical,
    type: "file",
    mode: exactFilesystemMode(metadata),
    links: Object.freeze([]),
    ...hashFile(path, { maxBytes }),
  });
}

function readPackageJson(repositoryRoot) {
  const packagePath = join(repositoryRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    fail("DEPENDENCIES_MISSING");
  }
  if (!packageJson || typeof packageJson !== "object" || packageJson.packageManager !== "pnpm@9.14.2") {
    fail("DEPENDENCIES_MISSING");
  }
  return {
    packageJson,
    packageFingerprint: fingerprintRepositoryInput(repositoryRoot, "package.json", {
      maxBytes: 2 * 1024 * 1024,
      requireDirect: true,
    }),
    lockFingerprint: fingerprintRepositoryInput(repositoryRoot, "pnpm-lock.yaml", {
      maxBytes: 16 * 1024 * 1024,
      requireDirect: true,
    }),
    applicationSchema: readApplicationSchema(repositoryRoot),
  };
}

export function verifyDependencies(repositoryRoot) {
  const root = assertCanonicalAbsolutePath(repositoryRoot);
  const {
    applicationSchema,
    packageJson,
    packageFingerprint,
    lockFingerprint,
  } = readPackageJson(root);
  const nextCliFingerprint = fingerprintRepositoryInput(root, "node_modules/next/dist/bin/next", {
    maxBytes: 32 * 1024 * 1024,
  });
  const nextPackageFingerprint = fingerprintRepositoryInput(root, "node_modules/next/package.json", {
    maxBytes: 2 * 1024 * 1024,
  });
  let nodeExecutable;
  try {
    nodeExecutable = realpathSync(process.execPath);
  } catch {
    fail("DEPENDENCIES_MISSING");
  }
  if (nodeExecutable !== process.execPath) fail("DEPENDENCIES_MISSING");
  let nextPackage;
  try {
    nextPackage = JSON.parse(readFileSync(
      join(root, ...nextPackageFingerprint.resolvedPath.split("/")),
      "utf8",
    ));
  } catch {
    fail("DEPENDENCIES_MISSING");
  }
  const declaredNext = packageJson.dependencies?.next;
  if (
    typeof nextPackage.version !== "string" ||
    nextPackage.version !== "16.3.0" ||
    declaredNext !== "16.3.0"
  ) fail("DEPENDENCIES_MISSING");
  return Object.freeze({
    applicationSchemaFingerprint: applicationSchema.input,
    schemaVersion: applicationSchema.version,
    nextBin: join(root, ...nextCliFingerprint.resolvedPath.split("/")),
    nextVersion: nextPackage.version,
    packageFingerprint,
    lockFingerprint,
    nextCliFingerprint,
    nextPackageFingerprint,
    nodeExecutableFingerprint: fingerprintDirectInput(
      nodeExecutable,
      "runtime/node-executable",
      512 * 1024 * 1024,
    ),
  });
}

function logicalPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    byteLength(relativePath) > 1024 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) fail("TREE_UNSAFE");
  const segments = relativePath.split("/");
  if (segments.some((segment) => !SAFE_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")) {
    fail("TREE_UNSAFE");
  }
  return relativePath;
}

function logicalBuildPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    byteLength(relativePath) > 2048 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) fail("BUILD_INVALID");
  const segments = relativePath.split("/");
  if (
    segments.some((segment) =>
      segment === "." ||
      segment === ".." ||
      segment.length === 0 ||
      byteLength(segment) > 255 ||
      !/^[\x20-\x7e]+$/u.test(segment)
    )
  ) fail("BUILD_INVALID");
  return relativePath;
}

function collectBuildFiles(buildRoot) {
  const files = [];
  const runtimeDirectories = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      logicalBuildPath(name);
      const logical = prefix ? `${prefix}/${name}` : name;
      if (logical === "cache" || logical.startsWith("cache/") || logical === "sympose-production-release.json") {
        continue;
      }
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) fail("BUILD_INVALID");
      const absolute = join(directory, name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail("BUILD_INVALID");
      if (metadata.isDirectory()) {
        if (logical === "standalone" || logical.startsWith("standalone/")) {
          runtimeDirectories.push(Object.freeze({
            path: logicalBuildPath(logical),
            mode: exactFilesystemMode(metadata),
          }));
        }
        visit(absolute, logical);
      } else if (metadata.isFile()) {
        const fingerprint = hashFile(absolute, { maxBytes: MAX_BUILD_BYTES });
        totalBytes += fingerprint.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUILD_BYTES) fail("BUILD_INVALID");
        files.push(Object.freeze({
          path: logicalBuildPath(logical),
          mode: exactFilesystemMode(metadata),
          ...fingerprint,
        }));
      } else {
        fail("BUILD_INVALID");
      }
    }
  };
  visit(buildRoot, "");
  files.sort((first, second) => {
    if (first.path < second.path) return -1;
    if (first.path > second.path) return 1;
    return 0;
  });
  runtimeDirectories.sort((first, second) => {
    if (first.path < second.path) return -1;
    if (first.path > second.path) return 1;
    return 0;
  });
  return Object.freeze({
    files,
    runtimeDirectories,
    totals: Object.freeze({ files: files.length, bytes: totalBytes }),
  });
}

function copyRuntimeTree(source, destination) {
  let metadata;
  try {
    metadata = lstatSync(source);
  } catch {
    fail("BUILD_INVALID");
  }
  if (metadata.isSymbolicLink() || existsSync(destination)) fail("BUILD_INVALID");
  if (metadata.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(source).sort()) {
      logicalBuildPath(name);
      copyRuntimeTree(join(source, name), join(destination, name));
    }
    chmodSync(destination, exactFilesystemMode(metadata));
    fsyncDirectory(destination, "BUILD_INVALID");
    fsyncDirectory(dirname(destination), "BUILD_INVALID");
    return;
  }
  if (!metadata.isFile()) fail("BUILD_INVALID");
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  const descriptor = openSync(destination, "r+");
  try {
    fchmodSync(descriptor, exactFilesystemMode(metadata));
    fsyncDescriptor(descriptor, "BUILD_INVALID");
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(destination), "BUILD_INVALID");
}

function copyMaterializedRuntimeTree(sourceRoot, source, destination, state, activeDirectories) {
  if (state.entries >= MAX_TREE_ENTRIES) fail("BUILD_INVALID");
  let metadata;
  try {
    metadata = lstatSync(source);
  } catch {
    fail("BUILD_INVALID");
  }
  if (metadata.isSymbolicLink()) {
    const sourcePath = logicalBuildPath(relative(sourceRoot, source).split(sep).join("/"));
    const resolved = resolveRepositoryInput(sourceRoot, sourcePath, "BUILD_INVALID", {
      allowDirectory: true,
    });
    return copyMaterializedRuntimeTree(
      sourceRoot,
      resolved.absolute,
      destination,
      state,
      activeDirectories,
    );
  }
  state.entries += 1;
  if (metadata.isDirectory()) {
    const identity = realpathSync(source);
    if (!containsPath(sourceRoot, identity) || activeDirectories.has(identity)) fail("BUILD_INVALID");
    activeDirectories.add(identity);
    try {
      if (existsSync(destination)) fail("BUILD_INVALID");
      mkdirSync(destination, { mode: 0o700 });
      for (const name of readdirSync(source).sort()) {
        logicalBuildPath(name);
        copyMaterializedRuntimeTree(
          sourceRoot,
          join(source, name),
          join(destination, name),
          state,
          activeDirectories,
        );
      }
      chmodSync(destination, exactFilesystemMode(metadata));
      fsyncDirectory(destination, "BUILD_INVALID");
    } finally {
      activeDirectories.delete(identity);
    }
    return;
  }
  if (!metadata.isFile() || existsSync(destination)) fail("BUILD_INVALID");
  state.bytes += metadata.size;
  if (!Number.isSafeInteger(state.bytes) || state.bytes > MAX_BUILD_BYTES) fail("BUILD_INVALID");
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  const descriptor = openSync(destination, "r+");
  try {
    fchmodSync(descriptor, exactFilesystemMode(metadata));
    fsyncDescriptor(descriptor, "BUILD_INVALID");
  } finally {
    closeSync(descriptor);
  }
}

function materializePnpmHoistedDependencies(
  sourceRoot,
  materializedRoot,
  state,
  activeDirectories,
) {
  const source = join(sourceRoot, "node_modules", ".pnpm", "node_modules");
  if (!existsSync(source)) return;
  let sourceMetadata;
  let destinationMetadata;
  const destination = join(materializedRoot, "node_modules");
  try {
    sourceMetadata = lstatSync(source);
    destinationMetadata = lstatSync(destination);
  } catch {
    fail("BUILD_INVALID");
  }
  if (
    sourceMetadata.isSymbolicLink()
    || !sourceMetadata.isDirectory()
    || destinationMetadata.isSymbolicLink()
    || !destinationMetadata.isDirectory()
  ) {
    fail("BUILD_INVALID");
  }
  for (const name of readdirSync(source).sort()) {
    logicalBuildPath(name);
    copyMaterializedRuntimeTree(
      sourceRoot,
      join(source, name),
      join(destination, name),
      state,
      activeDirectories,
    );
  }
}

function materializeStandaloneTree(buildRoot, runtimeRoot) {
  const stage = join(buildRoot, `.standalone-materialized-${randomUUID()}`);
  try {
    const state = { entries: 0, bytes: 0 };
    const activeDirectories = new Set();
    copyMaterializedRuntimeTree(
      runtimeRoot,
      runtimeRoot,
      stage,
      state,
      activeDirectories,
    );
    materializePnpmHoistedDependencies(runtimeRoot, stage, state, activeDirectories);
    syncRegularTree(stage, "BUILD_INVALID");
    return stage;
  } catch (error) {
    if (existsSync(stage)) {
      rmSync(stage, { recursive: true, force: true });
      fsyncDirectory(buildRoot, "BUILD_INVALID");
    }
    if (error instanceof ReleaseKitError) throw error;
    fail("BUILD_INVALID");
  }
}

function syncRegularTree(root, code) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) fail(code);
  if (metadata.isFile()) {
    const descriptor = openSync(root, "r");
    try {
      fsyncDescriptor(descriptor, code);
    } finally {
      closeSync(descriptor);
    }
    return;
  }
  if (!metadata.isDirectory()) fail(code);
  for (const name of readdirSync(root).sort()) {
    logicalBuildPath(name);
    syncRegularTree(join(root, name), code);
  }
  fsyncDirectory(root, code);
}

function prepareStandaloneRuntime(repositoryRoot) {
  const buildRoot = join(repositoryRoot, ".next");
  const runtimeRoot = join(buildRoot, "standalone");
  let runtimeMetadata;
  try {
    runtimeMetadata = lstatSync(runtimeRoot);
  } catch {
    fail("BUILD_INVALID");
  }
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) fail("BUILD_INVALID");
  const materialized = materializeStandaloneTree(buildRoot, runtimeRoot);
  const generated = join(buildRoot, `.standalone-generated-${randomUUID()}`);
  let generatedMoved = false;
  let installed = false;
  try {
    assertNoAmbientApplicationState(materialized);
    const publicRoot = join(repositoryRoot, "public");
    if (existsSync(publicRoot)) copyRuntimeTree(publicRoot, join(materialized, "public"));
    const staticRoot = join(buildRoot, "static");
    if (existsSync(staticRoot)) copyRuntimeTree(staticRoot, join(materialized, ".next", "static"));
    assertNoFrameworkEnvFiles(materialized);
    const entrypoint = join(materialized, "server.js");
    const runtimeBuildId = join(materialized, ".next", "BUILD_ID");
    if (!lstatSync(entrypoint).isFile() || !lstatSync(runtimeBuildId).isFile()) fail("BUILD_INVALID");
    syncRegularTree(materialized, "BUILD_INVALID");
    durableRename(runtimeRoot, generated, "BUILD_INVALID");
    generatedMoved = true;
    durableRename(materialized, runtimeRoot, "BUILD_INVALID");
    installed = true;
    rmSync(generated, { recursive: true, force: true });
    fsyncDirectory(buildRoot, "BUILD_INVALID");
  } catch (error) {
    if (!installed && generatedMoved && !existsSync(runtimeRoot) && existsSync(generated)) {
      durableRename(generated, runtimeRoot, "BUILD_INVALID");
    }
    if (existsSync(materialized)) {
      rmSync(materialized, { recursive: true, force: true });
      fsyncDirectory(buildRoot, "BUILD_INVALID");
    }
    if (error instanceof ReleaseKitError) throw error;
    fail("BUILD_INVALID");
  }
  syncRegularTree(runtimeRoot, "BUILD_INVALID");
  return Object.freeze({ root: "standalone", entrypoint: "standalone/server.js" });
}

function buildReceiptPath(repositoryRoot) {
  return join(repositoryRoot, ".next", "sympose-production-release.json");
}

function validateFileEntry(entry, code, pathValidator = logicalPath) {
  const record = exactKeys(entry, FILE_ENTRY_KEYS, code);
  const path = pathValidator(record.path);
  if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_BUILD_BYTES) fail(code);
  return Object.freeze({ path, size: record.size, sha256: exactHash(record.sha256, code) });
}

function validateBuildFileEntry(entry) {
  const record = exactKeys(entry, BUILD_FILE_ENTRY_KEYS, "BUILD_INVALID");
  const validated = validateFileEntry(
    { path: record.path, sha256: record.sha256, size: record.size },
    "BUILD_INVALID",
    logicalBuildPath,
  );
  if (!Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o7777) {
    fail("BUILD_INVALID");
  }
  return Object.freeze({ ...validated, mode: record.mode });
}

function validateBuildInputEntry(entry) {
  const record = exactKeys(entry, BUILD_INPUT_ENTRY_KEYS, "BUILD_INVALID");
  if (
    record.type !== "file" ||
    !Number.isSafeInteger(record.mode) ||
    record.mode < 0 ||
    record.mode > 0o7777 ||
    !Array.isArray(record.links) ||
    record.links.length > MAX_SYMLINK_HOPS
  ) fail("BUILD_INVALID");
  const validated = validateFileEntry(
    { path: record.path, sha256: record.sha256, size: record.size },
    "BUILD_INVALID",
    logicalBuildPath,
  );
  const resolvedPath = logicalBuildPath(record.resolvedPath);
  const links = record.links.map((value) => {
    const link = exactKeys(value, BUILD_INPUT_LINK_KEYS, "BUILD_INVALID");
    if (
      !Number.isSafeInteger(link.mode) ||
      link.mode < 0 ||
      link.mode > 0o7777 ||
      typeof link.target !== "string" ||
      link.target.length === 0 ||
      byteLength(link.target) > 2048 ||
      link.target.includes("\0") ||
      link.target.includes("\\") ||
      isAbsolute(link.target)
    ) fail("BUILD_INVALID");
    return Object.freeze({
      path: logicalBuildPath(link.path),
      target: link.target,
      mode: link.mode,
    });
  });
  return Object.freeze({
    ...validated,
    resolvedPath,
    type: "file",
    mode: record.mode,
    links: Object.freeze(links),
  });
}

function validateRuntimeDirectoryEntry(entry) {
  const record = exactKeys(entry, RUNTIME_DIRECTORY_ENTRY_KEYS, "BUILD_INVALID");
  const path = logicalBuildPath(record.path);
  if (
    (path !== "standalone" && !path.startsWith("standalone/")) ||
    !Number.isSafeInteger(record.mode) ||
    record.mode < 0 ||
    record.mode > 0o7777
  ) fail("BUILD_INVALID");
  return Object.freeze({ path, mode: record.mode });
}

function validateBuildReceipt(receipt) {
  const record = exactKeys(receipt, BUILD_RECEIPT_KEYS, "BUILD_INVALID");
  if (
    record.schema !== BUILD_RECEIPT_SCHEMA ||
    typeof record.buildId !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(record.buildId) ||
    typeof record.nodeVersion !== "string" ||
    !/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(record.nodeVersion) ||
    record.nextVersion !== "16.3.0" ||
    typeof record.platform !== "string" ||
    !/^[a-z0-9_-]{1,32}$/u.test(record.platform) ||
    typeof record.architecture !== "string" ||
    !/^[a-z0-9_-]{1,32}$/u.test(record.architecture) ||
    !Number.isSafeInteger(record.schemaVersion) ||
    record.schemaVersion < 1 ||
    !Array.isArray(record.files)
  ) fail("BUILD_INVALID");
  exactFullSha(record.releaseSha, "BUILD_INVALID");
  exactIso(record.createdAt, "BUILD_INVALID");
  const inputs = exactKeys(
    record.inputs,
    ["applicationSchema", "nextCli", "nextPackageJson", "nodeExecutable", "packageJson", "pnpmLock"],
    "BUILD_INVALID",
  );
  const applicationSchema = validateBuildInputEntry(inputs.applicationSchema);
  const packageJson = validateBuildInputEntry(inputs.packageJson);
  const pnpmLock = validateBuildInputEntry(inputs.pnpmLock);
  const nextCli = validateBuildInputEntry(inputs.nextCli);
  const nextPackageJson = validateBuildInputEntry(inputs.nextPackageJson);
  const nodeExecutable = validateBuildInputEntry(inputs.nodeExecutable);
  if (packageJson.path !== "package.json" || pnpmLock.path !== "pnpm-lock.yaml") fail("BUILD_INVALID");
  if (
    applicationSchema.path !== APPLICATION_SCHEMA_PATH ||
    !nextCli.path.startsWith("node_modules/") ||
    nextPackageJson.path !== "node_modules/next/package.json" ||
    nodeExecutable.path !== "runtime/node-executable"
  ) fail("BUILD_INVALID");
  const files = record.files.map(validateBuildFileEntry);
  const paths = files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || [...paths].sort().some((path, index) => path !== paths[index])) {
    fail("BUILD_INVALID");
  }
  const totals = exactKeys(record.totals, ["bytes", "files"], "BUILD_INVALID");
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (totals.files !== files.length || totals.bytes !== bytes || bytes > MAX_BUILD_BYTES) fail("BUILD_INVALID");
  const runtimeRecord = exactKeys(record.runtime, RUNTIME_KEYS, "BUILD_INVALID");
  if (
    runtimeRecord.root !== "standalone" ||
    runtimeRecord.entrypoint !== "standalone/server.js" ||
    !Array.isArray(runtimeRecord.directories)
  ) fail("BUILD_INVALID");
  const directories = runtimeRecord.directories.map(validateRuntimeDirectoryEntry);
  const directoryPaths = directories.map((entry) => entry.path);
  if (
    !directoryPaths.includes("standalone") ||
    new Set(directoryPaths).size !== directoryPaths.length ||
    [...directoryPaths].sort().some((path, index) => path !== directoryPaths[index])
  ) fail("BUILD_INVALID");
  const runtimeFiles = files.filter((entry) => entry.path.startsWith("standalone/"));
  if (
    !runtimeFiles.some((entry) => entry.path === runtimeRecord.entrypoint) ||
    runtimeFiles.some((entry) => entry.path.split("/").some((segment) => segment.startsWith(".env")))
  ) fail("BUILD_INVALID");
  const runtimeTotals = exactKeys(runtimeRecord.totals, ["bytes", "directories", "files"], "BUILD_INVALID");
  const runtimeBytes = runtimeFiles.reduce((sum, entry) => sum + entry.size, 0);
  if (
    runtimeTotals.files !== runtimeFiles.length ||
    runtimeTotals.directories !== directories.length ||
    runtimeTotals.bytes !== runtimeBytes
  ) fail("BUILD_INVALID");
  return Object.freeze({
    ...record,
    files,
    inputs: { applicationSchema, nextCli, nextPackageJson, nodeExecutable, packageJson, pnpmLock },
    runtime: { ...runtimeRecord, directories, totals: runtimeTotals },
    totals,
  });
}

function exactFileEntryEqual(first, second) {
  return first.path === second.path && first.size === second.size && first.sha256 === second.sha256;
}

function exactBuildFileEntryEqual(first, second) {
  return exactFileEntryEqual(first, second) && first.mode === second.mode;
}

function exactBuildInputEntryEqual(first, second) {
  return (
    exactFileEntryEqual(first, second) &&
    first.resolvedPath === second.resolvedPath &&
    first.type === second.type &&
    first.mode === second.mode &&
    canonicalJson(first.links) === canonicalJson(second.links)
  );
}

function exactRuntimeDirectoryEntryEqual(first, second) {
  return first.path === second.path && first.mode === second.mode;
}

export function verifyProductionBuild(repositoryRoot, releaseSha, dependencies = verifyDependencies(repositoryRoot)) {
  assertNoFrameworkEnvFiles(repositoryRoot);
  const buildRoot = join(repositoryRoot, ".next");
  let buildMetadata;
  try {
    buildMetadata = lstatSync(buildRoot);
  } catch {
    fail("BUILD_INVALID");
  }
  if (buildMetadata.isSymbolicLink() || !buildMetadata.isDirectory()) fail("BUILD_INVALID");
  const receiptFile = buildReceiptPath(repositoryRoot);
  const receipt = validateBuildReceipt(readBoundedJson(receiptFile, BUILD_RECEIPT_MAX_BYTES, "BUILD_INVALID"));
  if (
    receipt.releaseSha !== exactFullSha(releaseSha) ||
    receipt.nodeVersion !== process.version ||
    receipt.nextVersion !== dependencies.nextVersion ||
    receipt.schemaVersion !== dependencies.schemaVersion ||
    receipt.platform !== process.platform ||
    receipt.architecture !== process.arch ||
    !exactBuildInputEntryEqual(receipt.inputs.applicationSchema, dependencies.applicationSchemaFingerprint) ||
    !exactBuildInputEntryEqual(receipt.inputs.packageJson, dependencies.packageFingerprint) ||
    !exactBuildInputEntryEqual(receipt.inputs.pnpmLock, dependencies.lockFingerprint) ||
    !exactBuildInputEntryEqual(receipt.inputs.nextCli, dependencies.nextCliFingerprint) ||
    !exactBuildInputEntryEqual(receipt.inputs.nextPackageJson, dependencies.nextPackageFingerprint) ||
    !exactBuildInputEntryEqual(receipt.inputs.nodeExecutable, dependencies.nodeExecutableFingerprint)
  ) fail("BUILD_INVALID");
  let buildId;
  try {
    buildId = readFileSync(join(buildRoot, "BUILD_ID"), "utf8").trim();
  } catch {
    fail("BUILD_INVALID");
  }
  if (buildId !== receipt.buildId) fail("BUILD_INVALID");
  let runtimeBuildId;
  try {
    runtimeBuildId = readFileSync(join(buildRoot, receipt.runtime.root, ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    fail("BUILD_INVALID");
  }
  if (runtimeBuildId !== receipt.buildId) fail("BUILD_INVALID");
  assertNoFrameworkEnvFiles(join(buildRoot, receipt.runtime.root));
  assertNoAmbientApplicationState(join(buildRoot, receipt.runtime.root));
  const actual = collectBuildFiles(buildRoot);
  if (
    actual.files.length !== receipt.files.length ||
    actual.files.some((entry, index) => !exactBuildFileEntryEqual(entry, receipt.files[index])) ||
    actual.runtimeDirectories.length !== receipt.runtime.directories.length ||
    actual.runtimeDirectories.some(
      (entry, index) => !exactRuntimeDirectoryEntryEqual(entry, receipt.runtime.directories[index]),
    )
  ) fail("BUILD_INVALID");
  return Object.freeze({
    receipt,
    receiptSha256: hashFile(receiptFile, { maxBytes: BUILD_RECEIPT_MAX_BYTES }).sha256,
  });
}

function privateBuildEnvironment(buildSha, temporaryRoot) {
  return Object.freeze({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    SYMPOSE_ARTIFACT_STORE_ROOT: join(temporaryRoot, "artifacts"),
    SYMPOSE_BUILD_SHA: buildSha,
    SYMPOSE_DATA_MODE: "synthetic-evaluator",
    SYMPOSE_DB_PATH: join(temporaryRoot, "database", "sympose.db"),
    TMPDIR: join(temporaryRoot, "tmp"),
    TZ: "UTC",
  });
}

function atomicWrite(path, contents, mode = 0o600) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", mode);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, mode);
    fsyncDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
  durableRename(temporary, path);
}

export function runProductionBuild(
  repositoryRoot,
  releaseSha,
  { clock = () => new Date().toISOString(), spawnSyncImpl = spawnSync } = {},
) {
  assertNoFrameworkEnvFiles(repositoryRoot);
  verifyGitCandidate(repositoryRoot, releaseSha);
  const dependencies = verifyDependencies(repositoryRoot);
  const buildReceipt = buildReceiptPath(repositoryRoot);
  if (existsSync(buildReceipt)) durableUnlink(buildReceipt, "BUILD_INVALID");
  const buildTemporary = mkdtempSync(join(tmpdir(), "sympose-production-build-"));
  try {
    withPrivateUmask(() => {
      mkdirSync(join(buildTemporary, "artifacts"), { mode: 0o700 });
      mkdirSync(join(buildTemporary, "database"), { mode: 0o700 });
      mkdirSync(join(buildTemporary, "tmp"), { mode: 0o700 });
    });
    const result = spawnSyncImpl(
      process.execPath,
      [dependencies.nextBin, "build", repositoryRoot],
      {
        cwd: repositoryRoot,
        env: privateBuildEnvironment(releaseSha, buildTemporary),
        stdio: "inherit",
      },
    );
    if (result.status !== 0) fail("BUILD_FAILED");
    assertNoFrameworkEnvFiles(repositoryRoot);
    const buildRoot = join(repositoryRoot, ".next");
    const runtime = prepareStandaloneRuntime(repositoryRoot);
    const collected = collectBuildFiles(buildRoot);
    let buildId;
    try {
      buildId = readFileSync(join(buildRoot, "BUILD_ID"), "utf8").trim();
    } catch {
      fail("BUILD_INVALID");
    }
    const receipt = validateBuildReceipt({
      schema: BUILD_RECEIPT_SCHEMA,
      releaseSha,
      buildId,
      createdAt: exactIso(clock(), "BUILD_INVALID"),
      nodeVersion: process.version,
      nextVersion: dependencies.nextVersion,
      schemaVersion: dependencies.schemaVersion,
      platform: process.platform,
      architecture: process.arch,
      inputs: {
        applicationSchema: dependencies.applicationSchemaFingerprint,
        packageJson: dependencies.packageFingerprint,
        pnpmLock: dependencies.lockFingerprint,
        nextCli: dependencies.nextCliFingerprint,
        nextPackageJson: dependencies.nextPackageFingerprint,
        nodeExecutable: dependencies.nodeExecutableFingerprint,
      },
      files: collected.files,
      runtime: {
        root: runtime.root,
        entrypoint: runtime.entrypoint,
        directories: collected.runtimeDirectories,
        totals: {
          files: collected.files.filter((entry) => entry.path.startsWith(`${runtime.root}/`)).length,
          bytes: collected.files
            .filter((entry) => entry.path.startsWith(`${runtime.root}/`))
            .reduce((sum, entry) => sum + entry.size, 0),
          directories: collected.runtimeDirectories.length,
        },
      },
      totals: collected.totals,
    });
    atomicWrite(buildReceipt, canonicalJson(receipt));
    return verifyProductionBuild(repositoryRoot, releaseSha, dependencies);
  } finally {
    rmSync(buildTemporary, { recursive: true, force: true });
  }
}

function operationLockPath(config) {
  return join(dirname(config.state.root), `.${basename(config.state.root)}.sympose-operation.lock`);
}

function restoreJournalPath(config) {
  return join(dirname(config.state.root), `.${basename(config.state.root)}.sympose-restore-journal.json`);
}

function restoreLeaseAddress(config) {
  const identity = createHash("sha256")
    .update("sympose-production-restore-lease/v1\0", "utf8")
    .update(config.instanceId, "utf8")
    .update("\0", "utf8")
    .update(config.state.root, "utf8")
    .digest("hex");
  return `\0sympose-restore-${identity}`;
}

function notifyRestoreLeaseStatus(status, value) {
  Atomics.store(status, 0, value);
  Atomics.notify(status, 0);
}

function runRestoreLeaseWorker(data) {
  const status = new Int32Array(data.statusBuffer);
  const server = createServer((socket) => socket.destroy());
  let settled = false;
  const failWorker = (error) => {
    if (settled) return;
    settled = true;
    notifyRestoreLeaseStatus(
      status,
      error?.code === "EADDRINUSE" ? RESTORE_LEASE_CONFLICT : RESTORE_LEASE_FAILED,
    );
    parentPort?.close();
  };
  server.once("error", failWorker);
  server.listen({ path: data.address }, () => {
    settled = true;
    notifyRestoreLeaseStatus(status, RESTORE_LEASE_ACQUIRED);
  });
  parentPort?.once("message", (message) => {
    if (message !== "release") return;
    server.close(() => {
      notifyRestoreLeaseStatus(status, RESTORE_LEASE_CLOSED);
      parentPort?.close();
    });
  });
}

function acquireRestoreLease(config) {
  const status = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      kind: RESTORE_LEASE_WORKER_KIND,
      address: restoreLeaseAddress(config),
      statusBuffer: status.buffer,
    },
  });
  const waitResult = Atomics.wait(status, 0, RESTORE_LEASE_PENDING, 5_000);
  const observed = Atomics.load(status, 0);
  if (waitResult === "timed-out" || observed === RESTORE_LEASE_FAILED) {
    void worker.terminate();
    fail("RECOVERY_INVALID");
  }
  if (observed === RESTORE_LEASE_CONFLICT) {
    void worker.terminate();
    fail("LOCKED");
  }
  if (observed !== RESTORE_LEASE_ACQUIRED) {
    void worker.terminate();
    fail("RECOVERY_INVALID");
  }
  return { worker, status, released: false };
}

function releaseRestoreLease(lease) {
  if (!lease || lease.released) return;
  lease.worker.postMessage("release");
  const waitResult = Atomics.wait(lease.status, 0, RESTORE_LEASE_ACQUIRED, 5_000);
  const observed = Atomics.load(lease.status, 0);
  lease.released = true;
  if (waitResult === "timed-out" || observed !== RESTORE_LEASE_CLOSED) {
    void lease.worker.terminate();
    fail("RECOVERY_INVALID");
  }
}

function validateLockRecord(value, config, expectedKind = null) {
  const record = exactKeys(value, ["instanceId", "kind", "operationId", "releaseSha", "schema"], "LOCK_INVALID");
  if (
    record.schema !== "sympose-production-operation-lock/v1" ||
    record.instanceId !== config.instanceId ||
    record.releaseSha !== config.releaseSha ||
    !OPERATION_LOCK_KINDS.has(record.kind) ||
    (expectedKind !== null && record.kind !== expectedKind)
  ) fail("LOCK_INVALID");
  exactUuid(record.operationId, "LOCK_INVALID");
  return record;
}

export function acquireOperationLock(config, kind, operationId = randomUUID()) {
  assertTrustedStateParent(config);
  if (existsSync(restoreJournalPath(config))) fail("RECOVERY_REQUIRED");
  if (!OPERATION_LOCK_KINDS.has(kind)) fail("LOCK_INVALID");
  exactUuid(operationId, "LOCK_INVALID");
  const path = operationLockPath(config);
  const record = {
    schema: "sympose-production-operation-lock/v1",
    instanceId: config.instanceId,
    releaseSha: config.releaseSha,
    kind,
    operationId,
  };
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    fail("LOCKED");
  }
  try {
    writeFileSync(descriptor, canonicalJson(record), "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncDescriptor(descriptor, "LOCK_INVALID");
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path), "LOCK_INVALID");
  privateMetadata(path, "file");
  return Object.freeze({ path, record: Object.freeze(record) });
}

export function requireOperationLock(config, expectedKind = "start") {
  assertTrustedStateParent(config);
  const path = operationLockPath(config);
  privateMetadata(path, "file");
  const record = validateLockRecord(readBoundedJson(path, 4096, "LOCK_INVALID"), config, expectedKind);
  return Object.freeze({ path, record });
}

export function requireNoOperationLock(config) {
  assertTrustedStateParent(config);
  if (existsSync(restoreJournalPath(config))) fail("RECOVERY_REQUIRED");
  if (existsSync(operationLockPath(config))) fail("LOCKED");
}

export async function waitForOperationLock(
  config,
  expectedKind = "start",
  { waitMs = 0, retryMs = 25 } = {},
) {
  if (
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 120_000 ||
    !Number.isSafeInteger(retryMs) ||
    retryMs < 1 ||
    retryMs > 1_000
  ) fail("CONFIG_INVALID");
  const deadline = Date.now() + waitMs;
  do {
    if (existsSync(operationLockPath(config))) return requireOperationLock(config, expectedKind);
    if (Date.now() >= deadline) break;
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  fail("LOCK_TIMEOUT");
}

export function releaseOperationLock(config, lock) {
  if (!lock || lock.path !== operationLockPath(config)) fail("LOCK_INVALID");
  const current = requireOperationLock(config, lock.record.kind);
  if (canonicalJson(current.record) !== canonicalJson(lock.record)) fail("LOCK_INVALID");
  durableUnlink(lock.path, "LOCK_INVALID");
}

export async function requireLoopbackPortAvailable(config) {
  await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", () => rejectPort(new ReleaseKitError("PORT_BUSY")));
    server.listen({ host: config.host, port: config.port, exclusive: true }, () => {
      server.close((error) => {
        if (error) rejectPort(new ReleaseKitError("PORT_BUSY"));
        else resolvePort();
      });
    });
  });
}

export function createProductionStartPlan(
  repositoryRoot,
  config,
  build = verifyProductionBuild(repositoryRoot, config.releaseSha),
) {
  assertNoFrameworkEnvFiles(repositoryRoot);
  const runtimeRoot = join(repositoryRoot, ".next", build.receipt.runtime.root);
  assertNoFrameworkEnvFiles(runtimeRoot);
  const expectedDataMode = dataModeForConfig(config);
  const environment = {
    HOSTNAME: config.host,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    PORT: String(config.port),
    SYMPOSE_BUILD_SHA: config.releaseSha,
    TMPDIR: config.state.temporary,
    TZ: "UTC",
  };
  if (expectedDataMode === "production") {
    if (config.bootstrap !== null) validateProductionBootstrapTokenFile(config.bootstrap.tokenFile);
    Object.assign(environment, {
      SYMPOSE_DATA_MODE: "production",
      SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT: config.state.artifacts,
      SYMPOSE_PRODUCTION_DB_PATH: config.state.database,
      ...(config.bootstrap === null ? {} : {
        SYMPOSE_PRODUCTION_BOOTSTRAP_ISSUED_AT: config.bootstrap.issuedAt,
        SYMPOSE_PRODUCTION_BOOTSTRAP_TOKEN_FILE: config.bootstrap.tokenFile,
      }),
    });
  } else {
    Object.assign(environment, {
      SYMPOSE_ARTIFACT_STORE_ROOT: config.state.artifacts,
      SYMPOSE_DATA_MODE: "synthetic-evaluator",
      SYMPOSE_DB_PATH: config.state.database,
    });
  }
  if (expectedDataMode === "synthetic-evaluator" && config.runtimeProfile === "synthetic-evaluator") {
    Object.assign(environment, {
      SYMPOSE_EVALUATOR_PROFILE: "local",
      SYMPOSE_PUBLIC_SYNTHETIC_DEMO: "1",
    });
  }
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([join(repositoryRoot, ".next", build.receipt.runtime.entrypoint)]),
    cwd: runtimeRoot,
    environment: Object.freeze(environment),
    origin: `http://${config.host}:${config.port}`,
    healthUrl: `http://${config.host}:${config.port}/health`,
    expectedDataMode,
  });
}

export function isExactHealthPayload(payload, releaseSha, expectedDataMode = "synthetic-evaluator") {
  return (
    isPlainObject(payload) &&
    Object.keys(payload).length === 3 &&
    payload.status === "ok" &&
    payload.buildSha === releaseSha &&
    payload.dataMode === expectedDataMode
  );
}

function expectedDataModeForPlan(plan) {
  const value = plan.expectedDataMode ?? "synthetic-evaluator";
  if (value !== "synthetic-evaluator" && value !== "production") fail("HEALTH_INVALID");
  return value;
}

async function boundedResponseBody(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > HEALTH_MAX_BYTES)) {
    fail("HEALTH_INVALID");
  }
  if (!response.body) fail("HEALTH_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > HEALTH_MAX_BYTES) {
      await reader.cancel();
      fail("HEALTH_INVALID");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

export async function requestExactHealth(plan, releaseSha, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const expectedDataMode = expectedDataModeForPlan(plan);
  let response;
  try {
    response = await fetchImpl(plan.healthUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("HEALTH_TIMEOUT");
  }
  const contentType = response.headers.get("content-type") ?? "";
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (
    response.status !== 200 ||
    !contentType.toLowerCase().startsWith("application/json") ||
    !cacheControl.toLowerCase().includes("no-store")
  ) fail("HEALTH_INVALID");
  let payload;
  try {
    const body = await boundedResponseBody(response);
    const expectedBody = JSON.stringify({
      status: "ok",
      buildSha: releaseSha,
      dataMode: expectedDataMode,
    });
    if (body !== expectedBody) fail("HEALTH_INVALID");
    payload = JSON.parse(body);
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("HEALTH_INVALID");
  }
  if (!isExactHealthPayload(payload, releaseSha, expectedDataMode)) fail("HEALTH_INVALID");
  return Object.freeze({
    status: "ok",
    buildSha: releaseSha,
    dataMode: expectedDataMode,
  });
}

export async function waitForExactHealth(
  plan,
  releaseSha,
  { fetchImpl = fetch, waitMs = 90_000, retryMs = 250 } = {},
) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) fail("CONFIG_INVALID");
  const deadline = Date.now() + waitMs;
  let sawResponseFailure = null;
  do {
    try {
      return await requestExactHealth(plan, releaseSha, { fetchImpl });
    } catch (error) {
      if (!(error instanceof ReleaseKitError)) throw error;
      if (error.code === "HEALTH_INVALID") {
        sawResponseFailure = error;
        break;
      }
    }
    if (Date.now() >= deadline) break;
    await delay(retryMs);
  } while (Date.now() <= deadline);
  if (sawResponseFailure) throw sawResponseFailure;
  fail("HEALTH_TIMEOUT");
}

function childOutcome(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ kind: "exit", code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveOutcome) => {
    const onError = () => {
      child.removeListener("exit", onExit);
      resolveOutcome({ kind: "error" });
    };
    const onExit = (code, signal) => {
      child.removeListener("error", onError);
      resolveOutcome({ kind: "exit", code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function conclusiveChildExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ kind: "exit", code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ kind: "exit", code, signal }));
  });
}

export async function waitForStartupOutcome(
  child,
  healthPromise,
  { stabilityMs = 500, outcomePromise = childOutcome(child) } = {},
) {
  const outcome = outcomePromise;
  healthPromise.catch(() => {});
  const first = await Promise.race([
    healthPromise.then((health) => ({ kind: "health", health })),
    outcome,
  ]);
  if (first.kind !== "health") fail("STARTUP_EXIT");
  const stable = await Promise.race([
    delay(stabilityMs).then(() => ({ kind: "stable" })),
    outcome,
  ]);
  if (stable.kind !== "stable") fail("STARTUP_EXIT");
  return Object.freeze({ health: first.health, outcome });
}

export function productionServerExitCode(
  outcome,
  requestedSignal = null,
  signalForwarded = false,
) {
  if (outcome.kind !== "exit" || signalForwarded !== true) return 1;
  const conventionalCode = requestedSignal === "SIGINT"
    ? 130
    : requestedSignal === "SIGTERM"
      ? 143
      : null;
  if (conventionalCode === null) return 1;
  const directSignal = outcome.code === null && outcome.signal === requestedSignal;
  const conventionalExit = outcome.code === conventionalCode && outcome.signal === null;
  return directSignal || conventionalExit ? 0 : 1;
}

export async function terminateOwnedChild(
  child,
  outcomePromise = childOutcome(child),
  { graceMs = 10_000, killWaitMs = 10_000, signalAlreadySent = false } = {},
) {
  if (
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    graceMs > 60_000 ||
    !Number.isSafeInteger(killWaitMs) ||
    killWaitMs < 1 ||
    killWaitMs > 60_000 ||
    typeof signalAlreadySent !== "boolean"
  ) fail("CONFIG_INVALID");
  const waitForOutcome = async (waitMs) => Promise.race([
    outcomePromise,
    delay(waitMs).then(() => null),
  ]);
  const immediate = await waitForOutcome(0);
  if (immediate?.kind === "exit" || (immediate?.kind === "error" && child.pid === undefined)) {
    return immediate;
  }
  const exitPromise = conclusiveChildExit(child);
  const waitForExit = async (waitMs) => Promise.race([
    exitPromise,
    delay(waitMs).then(() => null),
  ]);
  if (!signalAlreadySent) child.kill("SIGTERM");
  const graceful = await waitForExit(graceMs);
  if (graceful?.kind === "exit") {
    return graceful;
  }
  child.kill("SIGKILL");
  const killed = await waitForExit(killWaitMs);
  if (killed?.kind === "exit") {
    return killed;
  }
  fail("TERMINATION_UNPROVEN");
}

function receiptStringSafe(value) {
  return (
    typeof value === "string" &&
    byteLength(value) <= 512 &&
    !/[\\/]/u.test(value) &&
    !/:\/\//u.test(value) &&
    !/\b(?:authorization|bearer|cookie|password|private[_ -]?key|secret|token)\b/iu.test(value)
  );
}

export function validateReceiptPayload(value) {
  const record = exactKeys(value, RECEIPT_KEYS, "RECEIPT_INVALID");
  if (
    record.schema !== RECEIPT_SCHEMA ||
    !RECEIPT_KINDS.has(record.kind) ||
    !INSTANCE_PATTERN.test(record.instanceId)
  ) fail("RECEIPT_INVALID");
  exactFullSha(record.releaseSha, "RECEIPT_INVALID");
  exactHash(record.buildReceiptSha256, "RECEIPT_INVALID");
  exactIso(record.occurredAt);
  exactUuid(record.operationId);
  exactUuid(record.receiptId);
  const inspect = (item, depth, state) => {
    if (depth > 4 || state.nodes > 128) fail("RECEIPT_INVALID");
    state.nodes += 1;
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Math.abs(item) > MAX_BACKUP_BYTES) fail("RECEIPT_INVALID");
      return;
    }
    if (typeof item === "string") {
      if (!receiptStringSafe(item)) fail("RECEIPT_INVALID");
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 32) fail("RECEIPT_INVALID");
      item.forEach((entry) => inspect(entry, depth + 1, state));
      return;
    }
    if (!isPlainObject(item) || Object.keys(item).length > 32) fail("RECEIPT_INVALID");
    for (const [key, entry] of Object.entries(item)) {
      if (
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key) ||
        /(?:authorization|cookie|credential|environment|header|password|path|secret|token|url)/iu.test(key)
      ) fail("RECEIPT_INVALID");
      inspect(entry, depth + 1, state);
    }
  };
  inspect(record.details, 0, { nodes: 0 });
  const serialized = canonicalJson(record);
  if (byteLength(serialized) > RECEIPT_MAX_BYTES) fail("RECEIPT_INVALID");
  return Object.freeze(record);
}

function operationLogPath(config) {
  return join(config.state.logs, "release-kit.jsonl");
}

function appendOperationLog(config, receipt) {
  const path = operationLogPath(config);
  const line = canonicalJson({
    buildReceiptSha256: receipt.buildReceiptSha256,
    instanceId: receipt.instanceId,
    kind: receipt.kind,
    occurredAt: receipt.occurredAt,
    operationId: receipt.operationId,
    receiptId: receipt.receiptId,
    releaseSha: receipt.releaseSha,
    schema: "sympose-production-operation-log/v1",
  });
  let currentSize = 0;
  if (existsSync(path)) currentSize = privateMetadata(path, "file").size;
  if (currentSize + byteLength(line) > MAX_OPERATION_LOG_BYTES) fail("RECEIPT_WRITE");
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(descriptor, line, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncDescriptor(descriptor, "RECEIPT_WRITE");
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path), "RECEIPT_WRITE");
}

export function writeOperationReceipt(
  config,
  buildReceiptSha256,
  { kind, operationId, details },
  { clock = () => new Date().toISOString(), receiptId = randomUUID() } = {},
) {
  privateMetadata(config.state.receipts, "directory");
  const receipt = validateReceiptPayload({
    schema: RECEIPT_SCHEMA,
    receiptId,
    kind,
    instanceId: config.instanceId,
    releaseSha: config.releaseSha,
    buildReceiptSha256,
    occurredAt: exactIso(clock()),
    operationId,
    details,
  });
  const filename = `${receipt.occurredAt.replaceAll(":", "-")}-${kind}-${receipt.receiptId}.json`;
  try {
    createPrivateFile(join(config.state.receipts, filename), canonicalJson(receipt));
    appendOperationLog(config, receipt);
  } catch (error) {
    if (error instanceof ReleaseKitError && error.code === "RECEIPT_INVALID") throw error;
    fail("RECEIPT_WRITE");
  }
  return receipt;
}

export async function runPreflight(repositoryRoot, config, { checkPort = true } = {}) {
  verifyGitCandidate(repositoryRoot, config.releaseSha);
  const dependencies = verifyDependencies(repositoryRoot);
  const build = verifyProductionBuild(repositoryRoot, config.releaseSha, dependencies);
  requireNoOperationLock(config);
  const state = validateStateLayout(config, { allowEmptyDatabase: true });
  if (dataModeForConfig(config) === "production") {
    if (state.sqlite.state === "explicit-empty" && config.bootstrap === null) fail("CONFIG_INVALID");
    if (config.bootstrap !== null) validateProductionBootstrapTokenFile(config.bootstrap.tokenFile);
  }
  if (checkPort) await requireLoopbackPortAvailable(config);
  return Object.freeze({
    schema: VERIFY_SCHEMA,
    status: "ok",
    kind: "preflight",
    releaseSha: config.releaseSha,
    buildReceiptSha256: build.receiptSha256,
    schemaVersion: build.receipt.schemaVersion,
    databaseState: state.sqlite.state,
    runtimeProfile: config.runtimeProfile,
    host: config.host,
    port: config.port,
  });
}

export async function verifyRunningRelease(
  repositoryRoot,
  config,
  { fetchImpl = fetch, waitMs = 0 } = {},
) {
  verifyGitCandidate(repositoryRoot, config.releaseSha);
  const dependencies = verifyDependencies(repositoryRoot);
  const build = verifyProductionBuild(repositoryRoot, config.releaseSha, dependencies);
  const lockWaitStarted = Date.now();
  if (waitMs > 0) await waitForOperationLock(config, "start", { waitMs });
  else requireOperationLock(config, "start");
  const state = validateStateLayout(config, { allowEmptyDatabase: true });
  const plan = createProductionStartPlan(repositoryRoot, config, build);
  const remainingWait = Math.max(0, waitMs - (Date.now() - lockWaitStarted));
  const health = waitMs > 0 && remainingWait > 0
    ? await waitForExactHealth(plan, config.releaseSha, { fetchImpl, waitMs: remainingWait })
    : await requestExactHealth(plan, config.releaseSha, { fetchImpl });
  return Object.freeze({
    schema: VERIFY_SCHEMA,
    status: "ok",
    kind: "running",
    releaseSha: config.releaseSha,
    buildReceiptSha256: build.receiptSha256,
    schemaVersion: build.receipt.schemaVersion,
    databaseState: state.sqlite.state,
    runtimeProfile: config.runtimeProfile,
    health,
  });
}

export async function startProductionRelease(
  repositoryRoot,
  config,
  {
    spawnImpl = spawn,
    fetchImpl = fetch,
    clock = () => new Date().toISOString(),
    onReady = () => {},
    checkPort = true,
    signalEmitter = process,
    terminationGraceMs = 10_000,
    terminationKillWaitMs = 10_000,
  } = {},
) {
  verifyGitCandidate(repositoryRoot, config.releaseSha);
  const recoveryDependencies = verifyDependencies(repositoryRoot);
  const recoveryBuild = verifyProductionBuild(repositoryRoot, config.releaseSha, recoveryDependencies);
  recoverInterruptedRestore(config, {
    clock,
    buildReceiptSha256: recoveryBuild.receiptSha256,
  });
  const preflight = await runPreflight(repositoryRoot, config, { checkPort });
  const operationId = randomUUID();
  const lock = acquireOperationLock(config, "start", operationId);
  let child;
  let outcomePromise;
  let requestedSignal = null;
  let signalForwarded = false;
  let retainLock = false;
  let resolveSupervisedShutdown;
  let rejectSupervisedShutdown;
  const supervisedShutdown = new Promise((resolveShutdown, rejectShutdown) => {
    resolveSupervisedShutdown = resolveShutdown;
    rejectSupervisedShutdown = rejectShutdown;
  });
  const signalHandlers = new Map();
  try {
    writeOperationReceipt(config, preflight.buildReceiptSha256, {
      kind: "start-requested",
      operationId,
      details: {
        databaseState: preflight.databaseState,
        port: config.port,
        runtimeProfile: config.runtimeProfile,
      },
    }, { clock });
    const dependencies = verifyDependencies(repositoryRoot);
    const build = verifyProductionBuild(repositoryRoot, config.releaseSha, dependencies);
    const plan = createProductionStartPlan(repositoryRoot, config, build);
    child = spawnImpl(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.environment,
      stdio: "inherit",
    });
    outcomePromise = childOutcome(child);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        if (requestedSignal !== null) return;
        requestedSignal = signal;
        signalForwarded = child.kill(signal) === true;
        terminateOwnedChild(child, outcomePromise, {
          graceMs: terminationGraceMs,
          killWaitMs: terminationKillWaitMs,
          signalAlreadySent: signalForwarded,
        }).then(resolveSupervisedShutdown, rejectSupervisedShutdown);
      };
      signalHandlers.set(signal, handler);
      signalEmitter.once(signal, handler);
    }
    const startup = await waitForStartupOutcome(
      child,
      waitForExactHealth(plan, config.releaseSha, { fetchImpl, waitMs: 90_000 }),
      { outcomePromise },
    );
    await requestExactHealth(plan, config.releaseSha, { fetchImpl });
    const readyReceipt = writeOperationReceipt(config, preflight.buildReceiptSha256, {
      kind: "start-ready",
      operationId,
      details: {
        dataMode: startup.health.dataMode,
        databaseState: preflight.databaseState,
        healthStatus: "ok",
        runtimeProfile: config.runtimeProfile,
      },
    }, { clock });
    onReady(Object.freeze({
      schema: VERIFY_SCHEMA,
      status: "ok",
      kind: "ready",
      releaseSha: config.releaseSha,
      buildReceiptSha256: preflight.buildReceiptSha256,
      schemaVersion: build.receipt.schemaVersion,
      operationId,
      receiptId: readyReceipt.receiptId,
      host: config.host,
      port: config.port,
      dataMode: plan.expectedDataMode,
    }));
    const outcome = await Promise.race([startup.outcome, supervisedShutdown]);
    if (outcome.kind !== "exit") fail("STARTUP_FAILED");
    const exitCode = productionServerExitCode(outcome, requestedSignal, signalForwarded);
    writeOperationReceipt(config, preflight.buildReceiptSha256, {
      kind: "start-stopped",
      operationId,
      details: {
        exitCode,
        exitKind: outcome.kind === "exit" ? (outcome.signal ? "signal" : "code") : "error",
        requestedSignal: requestedSignal ?? "none",
        signalForwarded,
      },
    }, { clock });
    return exitCode;
  } catch (error) {
    if (error instanceof ReleaseKitError && error.code === "TERMINATION_UNPROVEN") {
      retainLock = true;
      throw error;
    }
    if (child) {
      try {
        await terminateOwnedChild(
          child,
          outcomePromise ?? childOutcome(child),
          { graceMs: terminationGraceMs, killWaitMs: terminationKillWaitMs },
        );
      } catch (terminationError) {
        retainLock = true;
        throw terminationError;
      }
    }
    if (error instanceof ReleaseKitError) throw error;
    fail("STARTUP_FAILED");
  } finally {
    for (const [signal, handler] of signalHandlers) signalEmitter.removeListener(signal, handler);
    if (!retainLock) releaseOperationLock(config, lock);
  }
}

function stateHasRestorablePayload(config) {
  if (statSync(config.state.database).size > 0) return true;
  for (const key of ["artifacts", "temporary", "receipts", "logs", "runtime"]) {
    if (readdirSync(config.state[key]).length > 0) return true;
  }
  return databaseSidecars(config).some((path) => existsSync(path));
}

function checkpointSqlite(config) {
  inspectSqliteState(config, { allowEmpty: false });
  let database;
  try {
    database = withPrivateUmask(() => new DatabaseSync(config.state.database));
    database.exec("PRAGMA busy_timeout = 5000");
    const rows = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    if (
      rows.length !== 1 ||
      Object.values(rows[0]).some((value) => !Number.isSafeInteger(value)) ||
      Number(Object.values(rows[0])[0]) !== 0
    ) fail("SQLITE_INVALID");
    const quickRows = database.prepare("PRAGMA quick_check(1)").all();
    if (quickRows.length !== 1 || Object.values(quickRows[0])[0] !== "ok") fail("SQLITE_INVALID");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("SQLITE_INVALID");
  } finally {
    try {
      database?.close();
    } catch {
      fail("SQLITE_INVALID");
    }
  }
  const wal = `${config.state.database}-wal`;
  if (existsSync(wal) && privateMetadata(wal, "file").size !== 0) fail("SQLITE_INVALID");
  const shm = `${config.state.database}-shm`;
  if (existsSync(shm)) privateMetadata(shm, "file");
}

function artifactBackupFiles(config) {
  const tree = walkPrivateTree(config.state.artifacts, {
    maxEntries: MAX_BACKUP_FILES,
    maxBytes: MAX_BACKUP_BYTES,
  });
  for (const file of tree.files) {
    const segments = file.path.split("/");
    if (segments.some((segment) => !ARTIFACT_SEGMENT_PATTERN.test(segment))) fail("TREE_UNSAFE");
  }
  return tree.files;
}

function copyHashedFile(source, destination, expected) {
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  const descriptor = openSync(destination, "r+");
  try {
    fchmodSync(descriptor, 0o600);
    fsyncDescriptor(descriptor, "BACKUP_HASH_MISMATCH");
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(destination), "BACKUP_HASH_MISMATCH");
  const observed = hashFile(destination, { maxBytes: MAX_BACKUP_BYTES, permission: "private" });
  const sourceAfterCopy = hashFile(source, { maxBytes: MAX_BACKUP_BYTES, permission: "private" });
  if (
    observed.size !== expected.size ||
    observed.sha256 !== expected.sha256 ||
    sourceAfterCopy.size !== expected.size ||
    sourceAfterCopy.sha256 !== expected.sha256
  ) fail("BACKUP_HASH_MISMATCH");
}

function createDirectoryChain(root, logicalDirectory) {
  let current = root;
  if (logicalDirectory === "") return;
  for (const segment of logicalDirectory.split("/")) {
    assertSafeSegment(segment);
    current = join(current, segment);
    if (!existsSync(current)) createPrivateDirectory(current);
    else privateMetadata(current, "directory");
  }
}

function validateBackupFilePath(value) {
  const path = logicalPath(value);
  if (path === "database/sympose.db") return path;
  if (!path.startsWith("artifacts/")) fail("BACKUP_INVALID");
  const artifactSegments = path.slice("artifacts/".length).split("/");
  if (artifactSegments.some((segment) => !ARTIFACT_SEGMENT_PATTERN.test(segment))) fail("BACKUP_INVALID");
  return path;
}

function validateBackupManifest(value, expectedReleaseSha = null) {
  const record = exactKeys(value, BACKUP_MANIFEST_KEYS, "BACKUP_INVALID");
  if (
    record.schema !== BACKUP_MANIFEST_SCHEMA ||
    typeof record.instanceId !== "string" ||
    !INSTANCE_PATTERN.test(record.instanceId) ||
    !Array.isArray(record.files) ||
    record.files.length < 1 ||
    record.files.length > MAX_BACKUP_FILES
  ) fail("BACKUP_INVALID");
  exactUuid(record.backupId, "BACKUP_INVALID");
  const releaseSha = exactFullSha(record.releaseSha, "BACKUP_INVALID");
  if (expectedReleaseSha !== null && releaseSha !== expectedReleaseSha) fail("BACKUP_INVALID");
  exactHash(record.buildReceiptSha256, "BACKUP_INVALID");
  exactIso(record.createdAt, "BACKUP_INVALID");
  const sqlite = exactKeys(record.sqlite, ["checkpoint", "quickCheck", "serviceState"], "BACKUP_INVALID");
  if (sqlite.checkpoint !== "complete" || sqlite.quickCheck !== "ok" || sqlite.serviceState !== "stopped") {
    fail("BACKUP_INVALID");
  }
  const files = record.files.map((entry) => {
    const validated = validateFileEntry(entry, "BACKUP_INVALID");
    return Object.freeze({ ...validated, path: validateBackupFilePath(validated.path) });
  });
  const paths = files.map((entry) => entry.path);
  if (
    !paths.includes("database/sympose.db") ||
    new Set(paths).size !== paths.length ||
    [...paths].sort().some((path, index) => path !== paths[index])
  ) fail("BACKUP_INVALID");
  const totals = exactKeys(record.totals, ["bytes", "files"], "BACKUP_INVALID");
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (totals.files !== files.length || totals.bytes !== bytes || bytes > MAX_BACKUP_BYTES) {
    fail("BACKUP_INVALID");
  }
  return Object.freeze({ ...record, files, sqlite, totals });
}

export function verifyBackupDirectory(backupRoot, { expectedReleaseSha = null } = {}) {
  const root = assertCanonicalAbsolutePath(backupRoot);
  privateMetadata(root, "directory");
  try {
    if (realpathSync(root) !== root) fail("BACKUP_INVALID");
  } catch (error) {
    if (error instanceof ReleaseKitError) throw error;
    fail("BACKUP_INVALID");
  }
  const rootEntries = readdirSync(root).sort();
  if (rootEntries.length !== 2 || rootEntries[0] !== "manifest.json" || rootEntries[1] !== "payload") {
    fail("BACKUP_INVALID");
  }
  const manifestPath = join(root, "manifest.json");
  privateMetadata(manifestPath, "file");
  const manifest = validateBackupManifest(
    readBoundedJson(manifestPath, BACKUP_MANIFEST_MAX_BYTES, "BACKUP_INVALID"),
    expectedReleaseSha,
  );
  const payload = join(root, "payload");
  const tree = walkPrivateTree(payload, { maxEntries: MAX_BACKUP_FILES + 32, maxBytes: MAX_BACKUP_BYTES });
  const payloadPaths = tree.files.map((entry) => entry.path).sort();
  const manifestPaths = manifest.files.map((entry) => entry.path);
  if (
    payloadPaths.length !== manifestPaths.length ||
    payloadPaths.some((path, index) => path !== manifestPaths[index])
  ) fail("BACKUP_INVALID");
  for (const entry of manifest.files) {
    const observed = hashFile(join(payload, ...entry.path.split("/")), {
      maxBytes: MAX_BACKUP_BYTES,
      permission: "private",
    });
    if (observed.size !== entry.size || observed.sha256 !== entry.sha256) fail("BACKUP_HASH_MISMATCH");
  }
  return Object.freeze({
    manifest,
    manifestSha256: hashFile(manifestPath, { maxBytes: BACKUP_MANIFEST_MAX_BYTES, permission: "private" }).sha256,
  });
}

export function createBackup(
  repositoryRoot,
  config,
  outputRoot,
  { clock = () => new Date().toISOString() } = {},
) {
  verifyGitCandidate(repositoryRoot, config.releaseSha);
  const dependencies = verifyDependencies(repositoryRoot);
  const build = verifyProductionBuild(repositoryRoot, config.releaseSha, dependencies);
  requireNoOperationLock(config);
  const operationId = randomUUID();
  const lock = acquireOperationLock(config, "backup", operationId);
  let stage = null;
  let completed = false;
  try {
    validateStateLayout(config, { allowEmptyDatabase: false });
    const output = assertSafeOperationalRoot(outputRoot, {
      repositoryRoot,
      otherRoots: [config.state.root],
    });
    if (existsSync(output)) fail("BACKUP_OUTPUT_UNSAFE");
    assertNoSymlinkAncestors(output);
    const parent = dirname(output);
    stage = join(parent, `.sympose-backup-stage-${randomUUID()}`);
    checkpointSqlite(config);
    createPrivateDirectory(stage);
    const payload = join(stage, "payload");
    createPrivateDirectory(payload);
    createPrivateDirectory(join(payload, "database"));
    createPrivateDirectory(join(payload, "artifacts"));
    const sourceFiles = [
      { source: config.state.database, path: "database/sympose.db" },
      ...artifactBackupFiles(config).map((file) => ({
        source: file.absolute,
        path: `artifacts/${file.path}`,
      })),
    ].sort((first, second) => first.path.localeCompare(second.path, "en"));
    const files = [];
    let totalBytes = 0;
    for (const source of sourceFiles) {
      const fingerprint = hashFile(source.source, { maxBytes: MAX_BACKUP_BYTES, permission: "private" });
      totalBytes += fingerprint.size;
      if (totalBytes > MAX_BACKUP_BYTES) fail("BACKUP_INVALID");
      const entry = Object.freeze({ path: validateBackupFilePath(source.path), ...fingerprint });
      createDirectoryChain(payload, dirname(entry.path) === "." ? "" : dirname(entry.path));
      copyHashedFile(source.source, join(payload, ...entry.path.split("/")), entry);
      files.push(entry);
    }
    const manifest = validateBackupManifest({
      schema: BACKUP_MANIFEST_SCHEMA,
      backupId: randomUUID(),
      instanceId: config.instanceId,
      releaseSha: config.releaseSha,
      buildReceiptSha256: build.receiptSha256,
      createdAt: exactIso(clock(), "BACKUP_INVALID"),
      sqlite: { checkpoint: "complete", quickCheck: "ok", serviceState: "stopped" },
      files,
      totals: { files: files.length, bytes: totalBytes },
    }, config.releaseSha);
    createPrivateFile(join(stage, "manifest.json"), canonicalJson(manifest));
    verifyBackupDirectory(stage, { expectedReleaseSha: config.releaseSha });
    syncRegularTree(stage, "BACKUP_INVALID");
    durableRename(stage, output, "BACKUP_INVALID");
    completed = true;
    const verified = verifyBackupDirectory(output, { expectedReleaseSha: config.releaseSha });
    writeOperationReceipt(config, build.receiptSha256, {
      kind: "backup-completed",
      operationId,
      details: {
        backupId: manifest.backupId,
        bytes: manifest.totals.bytes,
        files: manifest.totals.files,
        manifestSha256: verified.manifestSha256,
      },
    }, { clock });
    return verified;
  } finally {
    if (!completed && stage !== null && existsSync(stage)) {
      rmSync(stage, { recursive: true, force: true });
      fsyncDirectory(dirname(stage), "BACKUP_INVALID");
    }
    releaseOperationLock(config, lock);
  }
}

export function restoreConfirmationToken(config, manifestSha256) {
  exactHash(manifestSha256, "BACKUP_INVALID");
  return createHash("sha256")
    .update("sympose-restore-confirmation/v1\0", "utf8")
    .update(config.instanceId, "utf8")
    .update("\0", "utf8")
    .update(config.releaseSha, "utf8")
    .update("\0", "utf8")
    .update(config.state.root, "utf8")
    .update("\0", "utf8")
    .update(manifestSha256, "utf8")
    .digest("hex");
}

const RESTORE_RECOVERY_MANIFEST = "restore-source-manifest.json";
const SIMULATED_RESTORE_CRASH = Symbol("sympose-simulated-restore-crash");

function stateConfigAtRoot(config, root) {
  return Object.freeze({ ...config, state: expectedStatePaths(root) });
}

function validateRestoreJournal(value, config) {
  const record = exactKeys(value, RESTORE_JOURNAL_KEYS, "RECOVERY_INVALID");
  if (
    record.schema !== RESTORE_JOURNAL_SCHEMA ||
    record.kind !== "restore" ||
    record.instanceId !== config.instanceId ||
    record.releaseSha !== config.releaseSha ||
    !RESTORE_PHASES.has(record.phase) ||
    (record.previousDatabaseState !== "explicit-empty" && record.previousDatabaseState !== "ready")
  ) fail("RECOVERY_INVALID");
  exactUuid(record.backupId, "RECOVERY_INVALID");
  exactUuid(record.operationId, "RECOVERY_INVALID");
  exactUuid(record.priorStateId, "RECOVERY_INVALID");
  exactUuid(record.stageId, "RECOVERY_INVALID");
  exactFullSha(record.fromSha, "RECOVERY_INVALID");
  exactHash(record.buildReceiptSha256, "RECOVERY_INVALID");
  exactHash(record.manifestSha256, "RECOVERY_INVALID");
  return Object.freeze(record);
}

function restoreTransactionPaths(config, journal) {
  const parent = assertTrustedStateParent(config);
  return Object.freeze({
    active: config.state.root,
    journal: operationLockPath(config),
    prior: join(parent, `.${basename(config.state.root)}.sympose-prior-${journal.priorStateId}`),
    stage: join(parent, `.${basename(config.state.root)}.sympose-restore-${journal.stageId}`),
  });
}

function readRestoreJournal(config) {
  const path = operationLockPath(config);
  privateMetadata(path, "file");
  return validateRestoreJournal(
    readBoundedJson(path, RESTORE_JOURNAL_MAX_BYTES, "RECOVERY_INVALID"),
    config,
  );
}

function writeRestoreJournal(config, journal) {
  const validated = validateRestoreJournal(journal, config);
  atomicWrite(operationLockPath(config), canonicalJson(validated));
  privateMetadata(operationLockPath(config), "file");
  return validated;
}

function publishInitialRestoreJournal(config, journal, onInitialPreparation = null) {
  const validated = validateRestoreJournal(journal, config);
  const preparation = restoreJournalPath(config);
  const transaction = operationLockPath(config);
  if (existsSync(preparation) || existsSync(transaction)) fail("LOCKED");
  const descriptor = openSync(preparation, "wx", 0o600);
  let linked = false;
  try {
    writeFileSync(descriptor, canonicalJson(validated), "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncDescriptor(descriptor, "RECOVERY_INVALID");
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(preparation), "RECOVERY_INVALID");
  try {
    onInitialPreparation?.();
    linkSync(preparation, transaction);
    linked = true;
    fsyncDirectory(dirname(transaction), "RECOVERY_INVALID");
    const preparationMetadata = privateMetadata(preparation, "file");
    const transactionMetadata = privateMetadata(transaction, "file");
    if (
      preparationMetadata.dev !== transactionMetadata.dev ||
      preparationMetadata.ino !== transactionMetadata.ino
    ) fail("RECOVERY_INVALID");
    durableUnlink(preparation, "RECOVERY_INVALID");
    return validated;
  } catch (error) {
    if (!linked && existsSync(preparation)) durableUnlink(preparation, "RECOVERY_INVALID");
    if (!linked && existsSync(transaction)) fail("LOCKED");
    if (error instanceof ReleaseKitError) throw error;
    fail("RECOVERY_INVALID");
  }
}

function removeRestorePreparationAlias(config) {
  const preparation = restoreJournalPath(config);
  if (!existsSync(preparation)) return;
  const transaction = operationLockPath(config);
  if (!existsSync(transaction)) {
    privateMetadata(preparation, "file");
    durableUnlink(preparation, "RECOVERY_INVALID");
    return;
  }
  const preparationMetadata = privateMetadata(preparation, "file");
  const transactionMetadata = privateMetadata(transaction, "file");
  if (
    preparationMetadata.dev !== transactionMetadata.dev ||
    preparationMetadata.ino !== transactionMetadata.ino
  ) fail("RECOVERY_INVALID");
  durableUnlink(preparation, "RECOVERY_INVALID");
}

function transitionRestoreJournal(config, journal, phase) {
  if (!RESTORE_PHASES.has(phase)) fail("RECOVERY_INVALID");
  return writeRestoreJournal(config, { ...journal, phase });
}

function maybeInjectRestoreCrash(crashAtPhase, phase) {
  if (crashAtPhase !== phase) return;
  const error = new ReleaseKitError("RESTORE_INTERRUPTED");
  error[SIMULATED_RESTORE_CRASH] = true;
  throw error;
}

function isSimulatedRestoreCrash(error) {
  return Boolean(error?.[SIMULATED_RESTORE_CRASH]);
}

function validateRestoredPayload(stateConfig, manifest) {
  const actual = [
    {
      path: "database/sympose.db",
      ...hashFile(stateConfig.state.database, { maxBytes: MAX_BACKUP_BYTES, permission: "private" }),
    },
    ...artifactBackupFiles(stateConfig).map((file) => ({
      path: `artifacts/${file.path}`,
      ...hashFile(file.absolute, { maxBytes: MAX_BACKUP_BYTES, permission: "private" }),
    })),
  ].sort((first, second) => {
    if (first.path < second.path) return -1;
    if (first.path > second.path) return 1;
    return 0;
  });
  if (
    actual.length !== manifest.files.length ||
    actual.some((entry, index) => !exactFileEntryEqual(entry, manifest.files[index]))
  ) fail("BACKUP_HASH_MISMATCH");
}

function recoveryManifestPath(stateConfig) {
  return join(stateConfig.state.runtime, RESTORE_RECOVERY_MANIFEST);
}

function readRecoveryManifest(stateConfig, journal) {
  const path = recoveryManifestPath(stateConfig);
  const observed = hashFile(path, {
    maxBytes: BACKUP_MANIFEST_MAX_BYTES,
    permission: "private",
  });
  if (observed.sha256 !== journal.manifestSha256) fail("RECOVERY_INVALID");
  const manifest = validateBackupManifest(
    readBoundedJson(path, BACKUP_MANIFEST_MAX_BYTES, "RECOVERY_INVALID"),
    stateConfig.releaseSha,
  );
  if (manifest.backupId !== journal.backupId) fail("RECOVERY_INVALID");
  return manifest;
}

function createRestoredStateStage(config, stage, verified, clock) {
  createPrivateDirectory(stage);
  const stagedConfig = stateConfigAtRoot(config, stage);
  createPrivateDirectory(dirname(stagedConfig.state.database));
  for (const key of ["artifacts", "temporary", "receipts", "logs", "runtime"]) {
    createPrivateDirectory(stagedConfig.state[key]);
  }
  const stateContract = stateContractForConfig(config);
  createPrivateFile(stateMarkerPath(stagedConfig), canonicalJson({
    schema: stateContract.schema,
    instanceId: config.instanceId,
    dataClassification: stateContract.dataClassification,
    initializedAt: exactIso(clock(), "STATE_INVALID"),
  }));
  const payload = join(verified.root, "payload");
  for (const entry of verified.manifest.files) {
    const source = join(payload, ...entry.path.split("/"));
    const destination = entry.path === "database/sympose.db"
      ? stagedConfig.state.database
      : join(stagedConfig.state.artifacts, ...entry.path.slice("artifacts/".length).split("/"));
    const destinationParentRelative = relative(stage, dirname(destination)).split(sep).filter(Boolean).join("/");
    createDirectoryChain(stage, destinationParentRelative);
    copyHashedFile(source, destination, entry);
  }
  const sourceManifest = join(verified.root, "manifest.json");
  const manifestFingerprint = hashFile(sourceManifest, {
    maxBytes: BACKUP_MANIFEST_MAX_BYTES,
    permission: "private",
  });
  if (manifestFingerprint.sha256 !== verified.manifestSha256) fail("RECOVERY_INVALID");
  copyHashedFile(
    sourceManifest,
    recoveryManifestPath(stagedConfig),
    { path: RESTORE_RECOVERY_MANIFEST, ...manifestFingerprint },
  );
  validateStateLayout(stagedConfig, { allowEmptyDatabase: false });
  const manifest = readRecoveryManifest(stagedConfig, {
    backupId: verified.manifest.backupId,
    manifestSha256: verified.manifestSha256,
  });
  validateRestoredPayload(stagedConfig, manifest);
  syncRegularTree(stage, "RECOVERY_INVALID");
  return stagedConfig;
}

function validateStateAtRoot(config, root, { allowEmptyDatabase = true } = {}) {
  if (!existsSync(root)) return null;
  const stateConfig = stateConfigAtRoot(config, root);
  validateStateLayout(stateConfig, { allowEmptyDatabase });
  return stateConfig;
}

function matchingOperationReceipt(config, kind, operationId) {
  for (const name of readdirSync(config.state.receipts).filter((entry) => entry.endsWith(".json")).sort()) {
    const receipt = validateReceiptPayload(
      readBoundedJson(join(config.state.receipts, name), RECEIPT_MAX_BYTES, "RECEIPT_INVALID"),
    );
    if (receipt.kind === kind && receipt.operationId === operationId) return receipt;
  }
  return null;
}

function ensureRestoreCompletedReceipt(config, journal, clock, recoveryMode) {
  const existing = matchingOperationReceipt(config, "restore-completed", journal.operationId);
  if (existing) {
    if (
      existing.buildReceiptSha256 !== journal.buildReceiptSha256 ||
      existing.details?.backupId !== journal.backupId ||
      existing.details?.manifestSha256 !== journal.manifestSha256 ||
      existing.details?.priorStateId !== journal.priorStateId
    ) fail("RECOVERY_INVALID");
    return existing;
  }
  return writeOperationReceipt(config, journal.buildReceiptSha256, {
    kind: "restore-completed",
    operationId: journal.operationId,
    details: {
      backupId: journal.backupId,
      fromSha: journal.fromSha,
      manifestSha256: journal.manifestSha256,
      priorStateId: journal.priorStateId,
      recoveryMode,
      replacement: "preserved",
    },
  }, { clock });
}

function requireRestoreCompletedReceipt(config, journal) {
  const existing = matchingOperationReceipt(config, "restore-completed", journal.operationId);
  if (
    !existing ||
    existing.buildReceiptSha256 !== journal.buildReceiptSha256 ||
    existing.details?.backupId !== journal.backupId ||
    existing.details?.manifestSha256 !== journal.manifestSha256 ||
    existing.details?.priorStateId !== journal.priorStateId
  ) fail("RECOVERY_INVALID");
  return existing;
}

function ensureRestoreAbortedReceipt(config, journal, clock) {
  const existing = matchingOperationReceipt(config, "restore-recovered", journal.operationId);
  if (existing) {
    if (
      existing.buildReceiptSha256 !== journal.buildReceiptSha256 ||
      existing.details?.backupId !== journal.backupId ||
      existing.details?.manifestSha256 !== journal.manifestSha256 ||
      existing.details?.priorStateId !== journal.priorStateId ||
      existing.details?.recoveryOutcome !== "aborted-staging"
    ) fail("RECOVERY_INVALID");
    return existing;
  }
  return writeOperationReceipt(config, journal.buildReceiptSha256, {
    kind: "restore-recovered",
    operationId: journal.operationId,
    details: {
      backupId: journal.backupId,
      fromSha: journal.fromSha,
      manifestSha256: journal.manifestSha256,
      priorStateId: journal.priorStateId,
      recoveryOutcome: "aborted-staging",
    },
  }, { clock });
}

function removeRestoreStage(stage) {
  if (!existsSync(stage)) return;
  privateMetadata(stage, "directory");
  rmSync(stage, { recursive: true, force: true });
  fsyncDirectory(dirname(stage), "RECOVERY_INVALID");
}

function finalizeRestoreJournal(config, journal, lease, crashAtPhase) {
  const current = readRestoreJournal(config);
  if (
    current.operationId !== journal.operationId ||
    (current.phase !== "committed" && current.phase !== "aborted")
  ) fail("RECOVERY_INVALID");
  durableUnlink(operationLockPath(config), "RECOVERY_INVALID");
  maybeInjectRestoreCrash(crashAtPhase, "journal-removed");
  releaseRestoreLease(lease);
  maybeInjectRestoreCrash(crashAtPhase, "lock-released");
}

function advanceRestoreTransaction(
  config,
  initialJournal,
  lease,
  { clock, crashAtPhase = null, recoveryMode },
) {
  let journal = initialJournal;
  const paths = restoreTransactionPaths(config, journal);

  if (journal.phase === "prepared") {
    const stageConfig = validateStateAtRoot(config, paths.stage, { allowEmptyDatabase: false });
    if (!stageConfig) fail("RECOVERY_INVALID");
    validateRestoredPayload(stageConfig, readRecoveryManifest(stageConfig, journal));
    const activeConfig = validateStateAtRoot(config, paths.active, { allowEmptyDatabase: true });
    const priorConfig = validateStateAtRoot(config, paths.prior, { allowEmptyDatabase: true });
    if (activeConfig && !priorConfig) {
      durableRename(paths.active, paths.prior, "RECOVERY_INVALID");
      maybeInjectRestoreCrash(crashAtPhase, "prior-renamed");
    } else if (activeConfig || !priorConfig) {
      fail("RECOVERY_INVALID");
    }
    journal = transitionRestoreJournal(config, journal, "prior-moved");
    maybeInjectRestoreCrash(crashAtPhase, "prior-recorded");
  }

  if (journal.phase === "prior-moved") {
    if (!validateStateAtRoot(config, paths.prior, { allowEmptyDatabase: true })) fail("RECOVERY_INVALID");
    const stageConfig = validateStateAtRoot(config, paths.stage, { allowEmptyDatabase: false });
    const activeConfig = validateStateAtRoot(config, paths.active, { allowEmptyDatabase: false });
    if (stageConfig && !activeConfig) {
      validateRestoredPayload(stageConfig, readRecoveryManifest(stageConfig, journal));
      durableRename(paths.stage, paths.active, "RECOVERY_INVALID");
      maybeInjectRestoreCrash(crashAtPhase, "state-installed");
    } else if (!stageConfig && activeConfig) {
      validateRestoredPayload(activeConfig, readRecoveryManifest(activeConfig, journal));
    } else {
      fail("RECOVERY_INVALID");
    }
    journal = transitionRestoreJournal(config, journal, "installed");
    maybeInjectRestoreCrash(crashAtPhase, "install-recorded");
  }

  if (journal.phase === "installed") {
    const activeConfig = validateStateAtRoot(config, paths.active, { allowEmptyDatabase: false });
    if (!activeConfig || !validateStateAtRoot(config, paths.prior, { allowEmptyDatabase: true })) {
      fail("RECOVERY_INVALID");
    }
    validateRestoredPayload(activeConfig, readRecoveryManifest(activeConfig, journal));
    ensureRestoreCompletedReceipt(activeConfig, journal, clock, recoveryMode);
    maybeInjectRestoreCrash(crashAtPhase, "receipt-durable");
    journal = transitionRestoreJournal(config, journal, "committed");
    maybeInjectRestoreCrash(crashAtPhase, "commit-recorded");
  }

  if (journal.phase !== "committed") fail("RECOVERY_INVALID");
  const activeConfig = validateStateAtRoot(config, paths.active, { allowEmptyDatabase: false });
  if (!activeConfig || !validateStateAtRoot(config, paths.prior, { allowEmptyDatabase: true })) {
    fail("RECOVERY_INVALID");
  }
  const recoveryManifest = recoveryManifestPath(activeConfig);
  if (existsSync(recoveryManifest)) {
    validateRestoredPayload(activeConfig, readRecoveryManifest(activeConfig, journal));
    durableUnlink(recoveryManifest, "RECOVERY_INVALID");
  }
  maybeInjectRestoreCrash(crashAtPhase, "recovery-metadata-removed");
  requireRestoreCompletedReceipt(activeConfig, journal);
  validateStateLayout(activeConfig, { allowEmptyDatabase: false });
  finalizeRestoreJournal(config, journal, lease, crashAtPhase);
  return Object.freeze({
    schema: VERIFY_SCHEMA,
    status: "ok",
    kind: recoveryMode === "direct" ? "restore" : "recovery",
    releaseSha: config.releaseSha,
    operationId: journal.operationId,
    manifestSha256: journal.manifestSha256,
    priorStateId: journal.priorStateId,
    previousDatabaseState: journal.previousDatabaseState,
    recoveryOutcome: "installed",
  });
}

export function recoverInterruptedRestore(
  config,
  { clock = () => new Date().toISOString(), buildReceiptSha256 = null } = {},
) {
  assertTrustedStateParent(config);
  const transactionPath = operationLockPath(config);
  const preparationPath = restoreJournalPath(config);
  if (!existsSync(transactionPath) && !existsSync(preparationPath)) {
    return Object.freeze({
      schema: VERIFY_SCHEMA,
      status: "ok",
      kind: "recovery",
      releaseSha: config.releaseSha,
      recoveryOutcome: "none",
    });
  }
  const lease = acquireRestoreLease(config);
  try {
    if (!existsSync(transactionPath)) {
      if (!existsSync(preparationPath)) {
        return Object.freeze({
          schema: VERIFY_SCHEMA,
          status: "ok",
          kind: "recovery",
          releaseSha: config.releaseSha,
          recoveryOutcome: "none",
        });
      }
      removeRestorePreparationAlias(config);
      return Object.freeze({
        schema: VERIFY_SCHEMA,
        status: "ok",
        kind: "recovery",
        releaseSha: config.releaseSha,
        recoveryOutcome: "aborted-initialization",
      });
    }
    removeRestorePreparationAlias(config);
    const rawRecord = readBoundedJson(transactionPath, RESTORE_JOURNAL_MAX_BYTES, "LOCK_INVALID");
    if (rawRecord?.schema !== RESTORE_JOURNAL_SCHEMA) fail("LOCKED");
    let journal = validateRestoreJournal(rawRecord, config);
    if (
      buildReceiptSha256 === null ||
      exactHash(buildReceiptSha256) !== journal.buildReceiptSha256
    ) {
      fail("RECOVERY_INVALID");
    }
    const paths = restoreTransactionPaths(config, journal);
    if (journal.phase === "staging") {
      if (!validateStateAtRoot(config, paths.active, { allowEmptyDatabase: true }) || existsSync(paths.prior)) {
        fail("RECOVERY_INVALID");
      }
      removeRestoreStage(paths.stage);
      ensureRestoreAbortedReceipt(config, journal, clock);
      journal = transitionRestoreJournal(config, journal, "aborted");
    }
    if (journal.phase === "aborted") {
      if (!validateStateAtRoot(config, paths.active, { allowEmptyDatabase: true }) || existsSync(paths.prior)) {
        fail("RECOVERY_INVALID");
      }
      removeRestoreStage(paths.stage);
      ensureRestoreAbortedReceipt(config, journal, clock);
      finalizeRestoreJournal(config, journal, lease, null);
      return Object.freeze({
        schema: VERIFY_SCHEMA,
        status: "ok",
        kind: "recovery",
        releaseSha: config.releaseSha,
        operationId: journal.operationId,
        manifestSha256: journal.manifestSha256,
        priorStateId: journal.priorStateId,
        previousDatabaseState: journal.previousDatabaseState,
        recoveryOutcome: "aborted-staging",
      });
    }
    return advanceRestoreTransaction(config, journal, lease, {
      clock,
      recoveryMode: "startup",
    });
  } finally {
    releaseRestoreLease(lease);
  }
}

export function restoreBackup(
  repositoryRoot,
  config,
  backupRoot,
  {
    confirmReplace = null,
    operationId = randomUUID(),
    fromSha,
    clock = () => new Date().toISOString(),
    crashAtPhase = null,
    onInitialPreparation = null,
    onInitialTransaction = null,
  } = {},
) {
  if (crashAtPhase !== null && !RESTORE_CRASH_PHASES.includes(crashAtPhase)) fail("CONFIG_INVALID");
  if (onInitialPreparation !== null && typeof onInitialPreparation !== "function") fail("CONFIG_INVALID");
  if (onInitialTransaction !== null && typeof onInitialTransaction !== "function") fail("CONFIG_INVALID");
  verifyGitCandidate(repositoryRoot, config.releaseSha);
  const dependencies = verifyDependencies(repositoryRoot);
  const build = verifyProductionBuild(repositoryRoot, config.releaseSha, dependencies);
  requireNoOperationLock(config);
  exactUuid(operationId, "RECEIPT_INVALID");
  exactFullSha(fromSha, "SHA_INVALID");
  const backup = assertSafeOperationalRoot(backupRoot, {
    repositoryRoot,
    otherRoots: [config.state.root],
  });
  const verifiedBackup = verifyBackupDirectory(backup, { expectedReleaseSha: config.releaseSha });
  const verified = Object.freeze({ ...verifiedBackup, root: backup });
  const priorStateId = randomUUID();
  const stageId = randomUUID();
  const destinationState = validateStateLayout(config, { allowEmptyDatabase: true });
  const nonEmpty = stateHasRestorablePayload(config);
  const expectedConfirmation = restoreConfirmationToken(config, verified.manifestSha256);
  if (nonEmpty && confirmReplace !== expectedConfirmation) fail("RESTORE_CONFIRMATION");
  verifyBackupDirectory(backup, { expectedReleaseSha: config.releaseSha });
  let journal = validateRestoreJournal({
    schema: RESTORE_JOURNAL_SCHEMA,
    kind: "restore",
    instanceId: config.instanceId,
    releaseSha: config.releaseSha,
    operationId,
    backupId: verified.manifest.backupId,
    manifestSha256: verified.manifestSha256,
    buildReceiptSha256: build.receiptSha256,
    fromSha,
    priorStateId,
    stageId,
    previousDatabaseState: destinationState.sqlite.state,
    phase: "staging",
  }, config);
  const lease = acquireRestoreLease(config);
  try {
    requireNoOperationLock(config);
    const paths = restoreTransactionPaths(config, journal);
    if (existsSync(paths.stage) || existsSync(paths.prior)) fail("RECOVERY_INVALID");
    journal = publishInitialRestoreJournal(config, journal, onInitialPreparation);
    onInitialTransaction?.();
    maybeInjectRestoreCrash(crashAtPhase, "journal-staging");
    createRestoredStateStage(config, paths.stage, verified, clock);
    journal = transitionRestoreJournal(config, journal, "prepared");
    maybeInjectRestoreCrash(crashAtPhase, "stage-prepared");
    return advanceRestoreTransaction(config, journal, lease, {
      clock,
      crashAtPhase,
      recoveryMode: "direct",
    });
  } catch (error) {
    if (isSimulatedRestoreCrash(error)) throw error;
    if (error instanceof ReleaseKitError) throw error;
    fail("RESTORE_FAILED");
  } finally {
    releaseRestoreLease(lease);
  }
}

export function recordRunningVerification(config, buildReceiptSha256, kind, operationId, clock) {
  if (kind !== "restart-verified" && kind !== "rollback-verified") fail("RECEIPT_INVALID");
  return writeOperationReceipt(config, buildReceiptSha256, {
    kind,
    operationId,
    details: {
      dataMode: dataModeForConfig(config),
      healthStatus: "ok",
      verification: "exact",
    },
  }, { clock });
}

if (!isMainThread && workerData?.kind === RESTORE_LEASE_WORKER_KIND) {
  runRestoreLeaseWorker(workerData);
}
