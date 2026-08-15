import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, deterministicUuid, fingerprintOf } from "./canonical";
import {
  DDL,
  SCHEMA_VERSION,
  V4_DDL,
  V5_DDL,
  V6_DDL,
  V7_DDL,
  V8_DDL,
  V9_DDL,
  V10_DDL,
  V11_DDL,
  V12_DDL,
  V13_DDL,
  V14_DDL,
  V15_DDL,
  V16_DDL,
  V17_DDL,
  V18_DDL,
  V19_DDL,
  V20_CONNECTOR_CONNECTIONS_DDL,
  V21_PRODUCTION_CONNECTOR_RUNTIME_DDL,
  V19_OBSERVATION_RECORDED_AT_COLUMN,
  V7_VERIFICATION_ISSUANCE_SEQUENCE_COLUMN,
} from "./schema";
import { seedWorkspaces } from "./seed";
import { seedEvaluatorDemo } from "./evaluator-demo";
import { getSpeakerArtifactStore } from "./services/artifact-records";
import {
  configuredDatabasePath,
  requireRuntimeDataMode,
  type RuntimeDataMode,
} from "./runtime-mode";
import {
  installProductionBootstrapChallenge,
  prepareProductionBootstrapChallenge,
} from "./production-bootstrap";
import {
  createAuthorityEvidence,
  createPurposeAuthorizationEvidence,
  createRetentionEvidence,
  preflightAuthorityPurpose,
} from "./services/authority-purpose-kernel";

export type Db = DatabaseSync;

export interface DbOptions {
  readonly path: string;
  readonly seed?: boolean;
}

export type MigrationFailurePoint =
  | "before-ddl"
  | "after-ddl"
  | "after-integrity-check"
  | "before-version-publication";

const LEGACY_SCHEMA_MANIFEST_SHA256 =
  "898ad03da81ef4db425d4028c66bdf1bb2b84b01578caa325fd317df58ec5533";
const EXPECTED_V3_MANIFEST_SHA256 =
  "c11246dd8077614523611f504418562e16b7da767f98804e9dfade2c763961ea";
const EXPECTED_V4_MANIFEST_SHA256 =
  "6c53baf5366e56ddafc29efa0cbf1ee4b27dd17630cab194904c6629b870d9d7";
const EXPECTED_V5_MANIFEST_SHA256 =
  "1f86f7e1cd441319222a8c84000d25641d1aeecae4a6a989e737dfa5021b9a1c";
const EXPECTED_V6_MANIFEST_SHA256 =
  "8ca73c15681439bf7f566ea64b64833e8aab7c061fe0536aec4fbbc89c226190";
const EXPECTED_V7_MANIFEST_SHA256 =
  "482077774bab4591c6ecc1761f5eaaf8152029a0d23e973277bf6f0c957eb360";
const EXPECTED_V8_MANIFEST_SHA256 =
  "6ddc50b3112f83b7e24e7ef72045019ca125b48b2a8b1a627603e3788409dd32";
const EXPECTED_V9_MANIFEST_SHA256 = "73dc680e5d947102e99066d2df640298c67f7e4c92d8e534b2d15f792f3a33f7";
const EXPECTED_V10_MANIFEST_SHA256 = "6cb0fd19a35a9867bb99b7bb2f78bf4c02d0ba90c55f65d15d8e0f1eebdd6628";
const EXPECTED_V11_MANIFEST_SHA256 = "e4bc117cf1792ba9f75f267593d164a430aa458788aaea258cc98534e803b0f6";
const EXPECTED_V12_MANIFEST_SHA256 = "12e210bbe3d4f2748252582d029e4105abb2f7af441bc49a55e1b1388c44bcb0";
const EXPECTED_V13_MANIFEST_SHA256 = "25b309b0ec0227b18125afdf37f11b914417bf2770ae441b68e6316ef056dbf6";
const EXPECTED_V14_MANIFEST_SHA256 = "b440beca07f87488ffee8ebe450d0bd71ca23be58c8965a954a80941be784719";
const EXPECTED_V15_MANIFEST_SHA256 = "b7876262ea8bf07b5d59f1b733b5aeb5302fdbbfd9cd801101e9da0eb8955c23";
const EXPECTED_V16_MANIFEST_SHA256 = "c8c036f3352256a85f2a227ebf3369ba5857319bcb05cdfaed5044251400b2bd";
const EXPECTED_V17_MANIFEST_SHA256 = "c73fccb75273fff2d3e1ec4e1b84fab3a0d580b62e2cb857635354f185c76dae";
const EXPECTED_V18_MANIFEST_SHA256 = "1c791e19b4a3706db26b21b5771402d848b8aed38496adbfa425186f77233aa6";
const EXPECTED_V19_MANIFEST_SHA256 = "6825e2fa8d73fe0681e785d0c3bf4c2bb7e2482111176409a85dc4a1f8d3784f";
const EXPECTED_V20_MANIFEST_SHA256 = "bddb89c157b9ef7a55c45316f2cf3f80a676e01bfa92d787bd2a5a0151cf2114";
const EXPECTED_V21_MANIFEST_SHA256 = "4f82143569670933cf9080e38d312a827bc348a13b3a0dfb6ad233a0867f761b";
const LEGACY_V14_MANIFEST_SHA256 = "fa777db4005a1ee11e51b571fe9dd70629874e8feed42fd7e785c87a53eb5c6a";
const PRIOR_HARDENED_V14_MANIFEST_SHA256 = "76e35b787f76bc8fa9344c8d45e93d943c5dc32b4b12568356047f7d26965044";
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21"]);
const SUPPORTED_SEED_VERSION = "1";
const POLICY_JSON_MAX_BYTES = 512 * 1024;
const JSON_MAX_BYTES = 4 * 1024 * 1024;
const RECEIPT_JSON_MAX_BYTES = 64 * 1024;

function acceptedCurrentPlanAssignmentId(db: Db, workspaceId: string, eventId: string, personId: string): string {
  const rows = db.prepare(
    `SELECT assignment.id AS assignmentId
     FROM events event_row
     JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
       AND plan.workspace_id = event_row.workspace_id AND plan.event_id = event_row.id
     JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
       AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = ?
     JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id
       AND accepted_speaker.event_id = event_row.id
       AND accepted_speaker.person_id = assignment.person_id
       AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
       AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
     JOIN program_units unit ON unit.id = assignment.program_unit_id
       AND unit.workspace_id = assignment.workspace_id AND unit.event_id = event_row.id
     JOIN approvals approval ON approval.plan_version_id = plan.id
       AND approval.workspace_id = plan.workspace_id AND approval.event_id = event_row.id
       AND approval.decision = 'approved'
     JOIN plan_states current_state ON current_state.plan_version_id = plan.id
       AND current_state.workspace_id = plan.workspace_id
       AND current_state.state = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM plan_states newer_state
         WHERE newer_state.workspace_id = current_state.workspace_id
           AND newer_state.plan_version_id = current_state.plan_version_id
           AND (newer_state.created_at > current_state.created_at
             OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
       )
       AND NOT EXISTS (
         SELECT 1 FROM plan_states superseded_state
         WHERE superseded_state.workspace_id = plan.workspace_id
           AND superseded_state.plan_version_id = plan.id
           AND superseded_state.state = 'superseded'
       )
     JOIN commitment_offers offer ON offer.plan_version_id = plan.id
       AND offer.workspace_id = plan.workspace_id AND offer.event_id = event_row.id
       AND offer.person_id = assignment.person_id
     JOIN commitment_responses response ON response.offer_id = offer.id
       AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id
       AND response.response = 'accepted'
     WHERE json_extract(offer.terms_json, '$.planVersionId') = plan.id
       AND json_extract(offer.terms_json, '$.eventId') = event_row.id
       AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
       AND CASE accepted_speaker.role_key
             WHEN 'SPEAKER' THEN 'SPEAKER'
             WHEN 'MODERATOR' THEN 'MODERATOR'
           END = CASE assignment.assignment_type
             WHEN 'SPEAKER' THEN 'SPEAKER'
             WHEN 'participant' THEN 'SPEAKER'
             WHEN 'MODERATOR' THEN 'MODERATOR'
             WHEN 'moderator' THEN 'MODERATOR'
           END
       AND CASE assignment.assignment_type
             WHEN 'SPEAKER' THEN 'SPEAKER'
             WHEN 'participant' THEN 'SPEAKER'
             WHEN 'MODERATOR' THEN 'MODERATOR'
             WHEN 'moderator' THEN 'MODERATOR'
           END = CASE json_extract(offer.terms_json, '$.role')
             WHEN 'SPEAKER' THEN 'SPEAKER'
             WHEN 'participant' THEN 'SPEAKER'
             WHEN 'MODERATOR' THEN 'MODERATOR'
             WHEN 'moderator' THEN 'MODERATOR'
           END
       AND (SELECT COUNT(*)
            FROM event_speakers accepted_scope_speaker
            WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
              AND accepted_scope_speaker.event_id = event_row.id
              AND accepted_scope_speaker.person_id = assignment.person_id
              AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
              AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
       AND (SELECT COUNT(*) FROM plan_assignments current_assignment
            WHERE current_assignment.workspace_id = plan.workspace_id
              AND current_assignment.plan_version_id = plan.id
              AND current_assignment.person_id = assignment.person_id) = 1
       AND event_row.workspace_id = ? AND event_row.id = ?
     GROUP BY assignment.id
     HAVING COUNT(DISTINCT accepted_speaker.id) = 1
        AND COUNT(DISTINCT offer.id) = 1
        AND COUNT(DISTINCT response.id) = 1
     ORDER BY assignment.id LIMIT 2`,
  ).all(personId, workspaceId, eventId) as unknown as readonly { assignmentId: unknown }[];
  if (rows.length !== 1 || typeof rows[0]?.assignmentId !== "string" || rows[0].assignmentId.length === 0) {
    throw new Error("schema v14 artifact migration cannot prove durable authority");
  }
  return rows[0].assignmentId;
}

function transformBoundedReceiptJson(
  value: unknown,
  transform: (parsed: unknown) => string,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    if (Buffer.byteLength(value, "utf8") > RECEIPT_JSON_MAX_BYTES) {
      return null;
    }
    const parsed = JSON.parse(value) as unknown;
    return transform(parsed);
  } catch {
    return null;
  }
}

function canonicalizeZonedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return null;

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond
  ) return null;

  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMilliseconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const canonical = new Date(local.getTime() - offsetMilliseconds).toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical)
    ? canonical
    : null;
}

function isSupportedIanaTimezone(value: unknown): number {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 128
    || value.trim() !== value
  ) return 0;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions();
    return 1;
  } catch {
    return 0;
  }
}

function registerCanonicalReceiptFunctions(db: Db): void {
  db.function("sympose_canonical_timestamp", { deterministic: true }, canonicalizeZonedTimestamp);
  db.function("sympose_is_iana_timezone", { deterministic: true }, isSupportedIanaTimezone);
  db.function("sympose_receipt_canonical_json", { deterministic: true }, (value) =>
    transformBoundedReceiptJson(value, canonicalJson));
  db.function("sympose_receipt_fingerprint", { deterministic: true }, (value) =>
    transformBoundedReceiptJson(value, fingerprintOf));
  db.function("sympose_pd01_canonical_json", { deterministic: true }, (value) =>
    transformBoundedJson(value, canonicalJson));
  db.function("sympose_pd01_fingerprint", { deterministic: true }, (value) =>
    transformBoundedJson(value, fingerprintOf));
}

function transformBoundedJson(
  value: unknown,
  transform: (parsed: unknown) => string,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    if (Buffer.byteLength(value, "utf8") > PD01_JSON_MAX_BYTES) {
      return null;
    }
    return transform(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

type SchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
type SchemaState = "empty" | SchemaVersion;

type ColumnDescriptor = {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly defaultValue: string | null;
  readonly primaryKey: number;
};

type ForeignKeyDescriptor = {
  readonly id: number;
  readonly sequence: number;
  readonly tableName: string;
  readonly from: string;
  readonly to: string;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
};

type IndexColumnDescriptor = {
  readonly sequence: number;
  readonly columnId: number;
  readonly columnName: string | null;
};

type SchemaObject = {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
  readonly columns: readonly ColumnDescriptor[] | null;
  readonly foreignKeys: readonly ForeignKeyDescriptor[] | null;
  readonly indexColumns: readonly IndexColumnDescriptor[] | null;
};

type SchemaManifest = readonly SchemaObject[];

let singleton: Db | null = null;

type UnitDbTemplateState = {
  readonly directory: string;
  readonly templatePath: string;
  readonly schemaDigest: string;
  readonly templateDigest: string;
  readonly clonePaths: Map<Db, UnitDbCloneState>;
  nextCloneId: number;
};

type UnitDbCloneState = {
  readonly clonePath: string;
  readonly markerPath: string;
};

type UnitDbProcess = NodeJS.Process & {
  __symposeUnitDbTemplateState?: UnitDbTemplateState;
  __symposeUnitDbTemplateCleanupRegistered?: boolean;
};

const unitDbProcess = process as UnitDbProcess;
const UNIT_DB_TEMPLATE_RUN_PREFIX = "sympose-unit-db-template-run-";

export function defaultDbPath(): string {
  return configuredDatabasePath();
}

export function openDb(options?: Partial<DbOptions>): Db {
  if (
    process.env.VITEST === "true"
    && process.env.SYMPOSE_UNIT_DB_TEMPLATE === "1"
    && options?.path === ":memory:"
  ) {
    return openDbFromUnitTemplate(options);
  }
  return openDbInternal(options, undefined);
}

/**
 * Migration fault injection is deliberately available only to the Vitest runtime. The normal
 * openDb options have no fault selector, so production callers cannot choose a rollback point.
 */
export function openDbForTest(
  options: Partial<DbOptions>,
  failureAt?: MigrationFailurePoint,
): Db {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("test-only database helper");
  }
  return openDbInternal(options, failureAt);
}

function openDbInternal(
  options: Partial<DbOptions> | undefined,
  migrationFailureAt: MigrationFailurePoint | undefined,
): Db {
  const runtimeMode = requireRuntimeDataMode();
  const configuredPath = defaultDbPath();
  const path = options?.path ?? configuredPath;
  if (
    runtimeMode === "production" &&
    path !== configuredPath &&
    process.env.NODE_ENV !== "test" &&
    process.env.VITEST !== "true"
  ) {
    throw new Error("PRODUCTION_DATABASE_PATH_OVERRIDE_DENIED");
  }
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  try {
    registerCanonicalReceiptFunctions(db);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA recursive_triggers = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");

    const schemaState = inspectSchemaState(db);
    assertDatabaseRuntimeModeCompatibleBeforeMigration(db, runtimeMode, schemaState);
    ensureSchemaVersion(db, schemaState, migrationFailureAt, runtimeMode, path);
    bindDatabaseRuntimeMode(db, runtimeMode, path);
    if (runtimeMode === "production") {
      const preparedBootstrap = prepareProductionBootstrapChallenge(db);
      withTransaction(db, () => installProductionBootstrapChallenge(db, preparedBootstrap));
    }
    db.exec("PRAGMA journal_mode = WAL;");
    if (runtimeMode === "synthetic-evaluator" && options?.seed !== false) {
      ensureSeed(db, path);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function assertDatabaseRuntimeModeCompatibleBeforeMigration(
  db: Db,
  runtimeMode: RuntimeDataMode,
  schemaState: SchemaState,
): void {
  if (schemaState === "empty") return;
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'runtime_mode'").get() as
    | { readonly value: unknown }
    | undefined;
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seed_version'").get();
  if (runtimeMode === "production" && stored === undefined) {
    throw new Error("PRODUCTION_DATABASE_RUNTIME_MODE_UNBOUND");
  }
  if (stored !== undefined && stored.value !== runtimeMode) {
    throw new Error("DATABASE_RUNTIME_MODE_MISMATCH");
  }
  if (runtimeMode === "production" && seeded !== undefined) {
    throw new Error("PRODUCTION_DATABASE_CONTAINS_SYNTHETIC_SEED");
  }
}

function bindDatabaseRuntimeMode(db: Db, runtimeMode: RuntimeDataMode, path: string): void {
  if (
    runtimeMode === "synthetic-evaluator" &&
    path === ":memory:" &&
    (process.env.NODE_ENV === "test" || process.env.VITEST === "true")
  ) {
    return;
  }
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'runtime_mode'").get() as
    | { readonly value: unknown }
    | undefined;
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seed_version'").get() as
    | { readonly value: unknown }
    | undefined;
  if (stored) {
    if (stored.value !== runtimeMode) throw new Error("DATABASE_RUNTIME_MODE_MISMATCH");
  } else {
    if (runtimeMode === "production" && seeded !== undefined) {
      throw new Error("PRODUCTION_DATABASE_CONTAINS_SYNTHETIC_SEED");
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('runtime_mode', ?)").run(runtimeMode);
  }
  if (runtimeMode === "production" && seeded !== undefined) {
    throw new Error("PRODUCTION_DATABASE_CONTAINS_SYNTHETIC_SEED");
  }
}

function removeUnitDbClone(path: string): void {
  for (const suffix of ["", ".open", "-journal", "-shm", "-wal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function unitDbCacheRoot(): string {
  const configuredCache = process.env.XDG_CACHE_HOME;
  if (configuredCache && !isAbsolute(configuredCache)) {
    throw new Error("unit database cache root is invalid");
  }
  const base = resolve(/* turbopackIgnore: true */ configuredCache ?? join(homedir(), ".cache"));
  return join(base, "sympose", "unit-test-gate");
}

function unitDbTemplateRoot(): string {
  const configured = process.env.SYMPOSE_UNIT_DB_TEMPLATE_ROOT;
  if (!configured) {
    throw new Error("unit database template root is required");
  }

  const absolute = resolve(configured);
  const cacheRoot = unitDbCacheRoot();
  const cacheRootReal = realpathSync(cacheRoot);
  if (
    !isAbsolute(configured)
    || configured !== absolute
    || dirname(absolute) !== cacheRootReal
    || !basename(absolute).startsWith(UNIT_DB_TEMPLATE_RUN_PREFIX)
  ) {
    throw new Error("unit database template root is invalid");
  }
  try {
    if (realpathSync(absolute) !== absolute || !statSync(absolute).isDirectory()) {
      throw new Error("unit database template root is invalid");
    }
  } catch {
    throw new Error("unit database template root is invalid");
  }
  return absolute;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cleanupUnitDbTemplateState(state: UnitDbTemplateState): void {
  for (const clone of state.clonePaths.values()) {
    removeUnitDbClone(clone.clonePath);
  }
  state.clonePaths.clear();
}

function registerUnitDbTemplateExitCleanup(state: UnitDbTemplateState): void {
  unitDbProcess.__symposeUnitDbTemplateState = state;
  if (unitDbProcess.__symposeUnitDbTemplateCleanupRegistered) return;
  unitDbProcess.__symposeUnitDbTemplateCleanupRegistered = true;
  process.once("exit", () => {
    const current = unitDbProcess.__symposeUnitDbTemplateState;
    if (current) cleanupUnitDbTemplateState(current);
  });
}

function createUnitDbTemplateState(): UnitDbTemplateState {
  const directory = mkdtempSync(join(unitDbTemplateRoot(), `worker-${process.pid}-`));
  const templatePath = join(directory, "template.sqlite");
  const templateEvidencePath = join(directory, "template-evidence.json");
  let templateDb: Db | null = null;
  try {
    // This deliberately uses the unchanged real opener. The template is therefore produced only
    // after the complete current DDL, manifest, JSON-bound, integrity, and domain validation path.
    templateDb = openDbInternal({ path: ":memory:", seed: false }, undefined);
    const schemaDigest = manifestDigest(readSchemaManifest(templateDb));
    templateDb.prepare("VACUUM INTO ?").run(templatePath);
    templateDb.close();
    templateDb = null;
    const templateDigest = sha256File(templatePath);
    chmodSync(templatePath, 0o444);
    writeFileSync(
      templateEvidencePath,
      JSON.stringify({ closed: true, schemaDigest, schemaVersion: SCHEMA_VERSION, templateDigest }),
      { encoding: "utf8", flag: "wx", mode: 0o444 },
    );
    chmodSync(templateEvidencePath, 0o444);

    const state: UnitDbTemplateState = {
      directory,
      templatePath,
      schemaDigest,
      templateDigest,
      clonePaths: new Map(),
      nextCloneId: 0,
    };
    registerUnitDbTemplateExitCleanup(state);
    return state;
  } catch (error) {
    try {
      templateDb?.close();
    } catch {
      // Preserve the original template construction failure.
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function openDbFromUnitTemplate(options: Partial<DbOptions>): Db {
  const state = unitDbProcess.__symposeUnitDbTemplateState ?? createUnitDbTemplateState();
  state.nextCloneId += 1;
  const clonePath = join(state.directory, `clone-${process.pid}-${state.nextCloneId}.sqlite`);
  copyFileSync(state.templatePath, clonePath, fsConstants.COPYFILE_EXCL);
  if (sha256File(clonePath) !== state.templateDigest) {
    removeUnitDbClone(clonePath);
    throw new Error("unit database template clone digest mismatch");
  }
  chmodSync(clonePath, 0o600);

  const db = new DatabaseSync(clonePath);
  const markerPath = `${clonePath}.open`;
  try {
    // Functions and connection-local pragmas are never inherited by a copied SQLite image.
    registerCanonicalReceiptFunctions(db);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA recursive_triggers = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    // A real :memory: database resolves the requested WAL mode to MEMORY. Keep that logical
    // behavior even though the disposable clone uses a private file as its transport substrate.
    db.exec("PRAGMA journal_mode = MEMORY;");
    if (manifestDigest(readSchemaManifest(db)) !== state.schemaDigest) {
      throw new Error("unit database template schema digest mismatch");
    }
    writeFileSync(
      markerPath,
      JSON.stringify({ schemaDigest: state.schemaDigest, templateDigest: state.templateDigest }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    state.clonePaths.set(db, { clonePath, markerPath });
    if (options.seed !== false) {
      ensureSeed(db, ":memory:");
    }
    return db;
  } catch (error) {
    state.clonePaths.delete(db);
    try {
      db.close();
    } catch {
      // The clone and marker remain covered by the post-lane cleanup proof if close fails.
    }
    removeUnitDbClone(clonePath);
    throw error;
  }
}

export function getDb(): Db {
  if (!singleton) {
    singleton = openDb();
  }
  return singleton;
}

export function closeDb(db: Db): void {
  const state = unitDbProcess.__symposeUnitDbTemplateState;
  const clone = state?.clonePaths.get(db);
  let closeError: unknown = null;
  try {
    db.close();
  } catch (error) {
    closeError = error;
  }
  if (!closeError && state && clone) {
    try {
      removeUnitDbClone(clone.clonePath);
      state.clonePaths.delete(db);
    } catch (error) {
      closeError = error;
    }
  }
  if (singleton === db) {
    singleton = null;
  }
  if (closeError) throw closeError;
}

export class TransactionCleanupError extends Error {
  readonly cleanupFailed = true;

  constructor() {
    super("TRANSACTION_CLEANUP_FAILED");
    this.name = "TransactionCleanupError";
  }
}

export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback makes the boundary outcome indeterminate. Do not return the original
      // domain error as if this connection were known to be clean.
      throw new TransactionCleanupError();
    }
    throw error;
  }
}

function validateSavepointName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) {
    throw new Error("invalid savepoint name");
  }
}

/** A savepoint-aware composition seam for future lifecycle commands. */
export function withSavepoint<T>(db: Db, name: string, fn: () => T): T {
  validateSavepointName(name);
  db.exec(`SAVEPOINT "${name}"`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT "${name}"`);
    return result;
  } catch (error) {
    let cleanupFailed = false;
    try {
      db.exec(`ROLLBACK TO SAVEPOINT "${name}"`);
      db.exec(`RELEASE SAVEPOINT "${name}"`);
    } catch {
      cleanupFailed = true;
      try {
        db.exec(`RELEASE SAVEPOINT "${name}"`);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new TransactionCleanupError();
    }
    throw error;
  }
}

/** Compose a command at either the connection or an existing caller transaction boundary. */
export function withTransactionOrSavepoint<T>(db: Db, name: string, fn: () => T): T {
  validateSavepointName(name);
  return db.isTransaction ? withSavepoint(db, name, fn) : withTransaction(db, fn);
}

function ensureSeed(db: Db, path: string): void {
  const shouldSeedEvaluator = path !== ":memory:" &&
    process.env.NODE_ENV !== "test" &&
    process.env.VITEST !== "true" &&
    process.env.SYMPOSE_EVALUATOR_PROFILE === "local" &&
    (process.env.NODE_ENV !== "production" || process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO === "1");
  // Resolve and initialize the exact configured/derived store before any seed writes. A malformed
  // or unavailable root therefore cannot leave a partially fabricated evaluator journey behind.
  const evaluatorArtifactStore = shouldSeedEvaluator ? getSpeakerArtifactStore(db) : null;
  withTransaction(db, () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'seed_version'").get() as
      | { value: string }
      | undefined;
    if (row) {
      return;
    }
    seedWorkspaces(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('seed_version', '1')").run();
  });

  // Keep existing in-memory and test databases intentionally minimal. The browser evaluator
  // uses a persistent worktree-local install, where the Acme journey is safe to materialize.
  if (shouldSeedEvaluator && evaluatorArtifactStore) {
    seedEvaluatorDemo(db, { store: evaluatorArtifactStore });
  }
}

function inspectSchemaState(db: Db): SchemaState {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: string; name: string }>;
  if (objects.length === 0) {
    return "empty";
  }

  if (!objects.some((object) => object.type === "table" && object.name === "meta")) {
    throw new Error("malformed existing database: schema metadata table is missing");
  }

  const metaColumns = readTableColumns(db, "meta");
  const expectedMetaColumns = [
    { cid: 0, name: "key", type: "TEXT", notnull: 0, defaultValue: null, primaryKey: 1 },
    { cid: 1, name: "value", type: "TEXT", notnull: 1, defaultValue: null, primaryKey: 0 },
  ];
  if (JSON.stringify(metaColumns) !== JSON.stringify(expectedMetaColumns)) {
    throw new Error("malformed existing database: schema metadata table is invalid");
  }

  const metadataRows = db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Array<{
    key: unknown;
    value: unknown;
  }>;
  for (const metadataRow of metadataRows) {
    if (
      (metadataRow.key !== "schema_version" && metadataRow.key !== "seed_version" && metadataRow.key !== "runtime_mode") ||
      typeof metadataRow.value !== "string"
    ) {
      throw new Error("malformed existing database: schema metadata is invalid");
    }
    if (metadataRow.key === "seed_version" && metadataRow.value !== SUPPORTED_SEED_VERSION) {
      throw new Error("malformed existing database: schema seed metadata is invalid");
    }
    if (
      metadataRow.key === "runtime_mode" &&
      metadataRow.value !== "synthetic-evaluator" &&
      metadataRow.value !== "production"
    ) {
      throw new Error("malformed existing database: runtime mode metadata is invalid");
    }
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (!row || typeof row.value !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(row.value)) {
    throw new Error("schema version mismatch: database has an unsupported version");
  }

  const version = Number(row.value) as SchemaVersion;
  const actualManifest = readSchemaManifest(db);
  const actualDigest = manifestDigest(actualManifest);
  if ((version === 1 || version === 2) && manifestDigest(columnsOnlySchemaManifest(db)) !== LEGACY_SCHEMA_MANIFEST_SHA256) {
    throw new Error(`malformed schema v${version}`);
  }
  if (version === 3 && actualDigest !== EXPECTED_V3_MANIFEST_SHA256) {
    throw new Error("malformed schema v3");
  }
  if (version === 4 && actualDigest !== EXPECTED_V4_MANIFEST_SHA256) {
    throw new Error("malformed schema v4");
  }
  if (version === 5 && actualDigest !== EXPECTED_V5_MANIFEST_SHA256) {
    throw new Error("malformed schema v5");
  }
  if (version === 6 && actualDigest !== EXPECTED_V6_MANIFEST_SHA256) {
    throw new Error("malformed schema v6");
  }
  if (version === 7 && actualDigest !== EXPECTED_V7_MANIFEST_SHA256) {
    throw new Error("malformed schema v7");
  }
  if (version === 8 && actualDigest !== EXPECTED_V8_MANIFEST_SHA256) {
    throw new Error("malformed schema v8");
  }
  if (version === 10 && actualDigest !== EXPECTED_V10_MANIFEST_SHA256) {
    throw new Error("malformed schema v10");
  }
  if (version === 11 && actualDigest !== EXPECTED_V11_MANIFEST_SHA256) {
    throw new Error("malformed schema v11");
  }
  if (version === 12 && actualDigest !== EXPECTED_V12_MANIFEST_SHA256) {
    throw new Error("malformed schema v12");
  }
  if (version === 13 && actualDigest !== EXPECTED_V13_MANIFEST_SHA256) {
    throw new Error("malformed schema v13");
  }
  if (version === 14 && actualDigest !== EXPECTED_V14_MANIFEST_SHA256 && actualDigest !== LEGACY_V14_MANIFEST_SHA256 && actualDigest !== PRIOR_HARDENED_V14_MANIFEST_SHA256) {
    throw new Error("malformed schema v14");
  }
  if (version === 14 && actualDigest === EXPECTED_V14_MANIFEST_SHA256) {
    validateArtifactRecordIntegrity(db);
  }
  if (version === 19 && actualDigest !== EXPECTED_V19_MANIFEST_SHA256) {
    throw new Error("malformed schema v19");
  }
  if (version === 20 && actualDigest !== EXPECTED_V20_MANIFEST_SHA256) {
    throw new Error("malformed schema v20");
  }
  if (version === 21 && actualDigest !== EXPECTED_V21_MANIFEST_SHA256) {
    throw new Error("malformed schema v21");
  }
  if (version === 9 && EXPECTED_V9_MANIFEST_SHA256 !== undefined && actualDigest !== EXPECTED_V9_MANIFEST_SHA256) {
    throw new Error("malformed schema v9");
  }
  return version;
}

function ensureSchemaVersion(
  db: Db,
  schemaState: SchemaState,
  migrationFailureAt: MigrationFailurePoint | undefined,
  runtimeMode: RuntimeDataMode,
  path: string,
): void {
  if (schemaState === "empty") {
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      db.exec(DDL);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        String(SCHEMA_VERSION),
      );
      // First publication and runtime ownership are one atomic decision. A process failure can
      // therefore leave either an empty database or a fully bound V21 database, never an
      // unbound V21 database that production correctly refuses to adopt on the next open.
      bindDatabaseRuntimeMode(db, runtimeMode, path);
    });
    return;
  }

  if (schemaState === 1) {
    validateDatabaseIntegrity(db, false, false);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      migrateV1ToV2(db);
      db.exec(V4_DDL);
      db.exec(V5_DDL);
      db.exec(V6_DDL);
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 2) {
    validateDatabaseIntegrity(db, false, false);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      db.exec(V4_DDL);
      db.exec(V5_DDL);
      db.exec(V6_DDL);
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 3) {
    validateDatabaseIntegrity(db, true, false);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      db.exec(V4_DDL);
      db.exec(V5_DDL);
      db.exec(V6_DDL);
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 4) {
    validateStoredJsonBounds(db, false);
    validateStoredJsonDepths(db, false);
    validateDatabaseIntegrity(db, true, true, false);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      db.exec(V5_DDL);
      db.exec(V6_DDL);
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 5) {
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateTrustedReviewDocuments(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      db.exec(V6_DDL);
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 6) {
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateTrustedReviewDocuments(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      migrateVerificationIssuanceSequencesV7(db);
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 7) {
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") {
        throw new Error("injected migration failure");
      }
      migrateV7ToV8(db);
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") {
        throw new Error("injected migration failure");
      }
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") {
        throw new Error("injected migration failure");
      }
      if (migrationFailureAt === "before-version-publication") {
        throw new Error("injected migration failure");
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(SCHEMA_VERSION),
      );
    });
    return;
  }

  if (schemaState === 8) {
    verifySchemaManifest(db, 8);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV8ToV11(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 9) {
    verifySchemaManifest(db, 9);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V9(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV9ToV11(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 10) {
    verifySchemaManifest(db, 10);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV10ToV12(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 11) {
    verifySchemaManifest(db, 11);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV11ToV12(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 12) {
    verifySchemaManifest(db, 12);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV12ToV13(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 13) {
    verifySchemaManifest(db, 13);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV13ToV14(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }

  if (schemaState === 14) {
    const v14Digest = manifestDigest(readSchemaManifest(db));
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      if (v14Digest === LEGACY_V14_MANIFEST_SHA256) {
        migrateLegacyV14ArtifactRecords(db);
      } else if (v14Digest === PRIOR_HARDENED_V14_MANIFEST_SHA256) {
        migratePriorHardenedV14(db);
      }
      migrateV14ToV15(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 15) {
    verifySchemaManifest(db, 15);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV15ToV16(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 16) {
    verifySchemaManifest(db, 16);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV16ToV19(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 17) {
    verifySchemaManifest(db, 17);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV17ToV19(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 18) {
    verifySchemaManifest(db, 18);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      migrateV18ToV19(db);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 19) {
    verifySchemaManifest(db, 19);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      db.exec(V20_CONNECTOR_CONNECTIONS_DDL);
      db.exec(V21_PRODUCTION_CONNECTOR_RUNTIME_DDL);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  if (schemaState === 20) {
    verifySchemaManifest(db, 20);
    validateStoredJsonBounds(db);
    validateStoredJsonDepths(db);
    validateDatabaseIntegrity(db, true, true, true);
    validateVerificationIssuanceIntegrity(db);
    validateTrustedReviewDocuments(db);
    validatePd01Foundation(db);
    validatePd01V10(db);
    withTransaction(db, () => {
      if (migrationFailureAt === "before-ddl") throw new Error("injected migration failure");
      db.exec(V21_PRODUCTION_CONNECTOR_RUNTIME_DDL);
      if (migrationFailureAt === "after-ddl") throw new Error("injected migration failure");
      verifySchemaManifest(db, 21);
      validateStoredJsonBounds(db);
      validateStoredJsonDepths(db);
      validateDatabaseIntegrity(db, true, true, true);
      validateVerificationIssuanceIntegrity(db);
      validateTrustedReviewDocuments(db);
      validatePd01Foundation(db);
      validatePd01V10(db);
      if (migrationFailureAt === "after-integrity-check") throw new Error("injected migration failure");
      if (migrationFailureAt === "before-version-publication") throw new Error("injected migration failure");
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    });
    return;
  }
  verifySchemaManifest(db, 21);
  validateStoredJsonBounds(db);
  validateStoredJsonDepths(db);
  validateDatabaseIntegrity(db, true, true, true);
  validateVerificationIssuanceIntegrity(db);
  validateTrustedReviewDocuments(db);
  validatePd01Foundation(db);
  validatePd01V10(db);
}

function migrateV1ToV2(db: Db): void {
  const releaseCount = (db
    .prepare("SELECT COUNT(*) AS count FROM publication_releases")
    .get() as { count: number }).count;
  if (releaseCount > 0) {
    throw new Error(
      "schema v1 contains sealed publication releases whose displayed identity cannot be reconstructed safely; run pnpm db:reset for this synthetic local MVP",
    );
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("2");
}

type LegacyVerificationIssuanceEvidence = {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly call_id: unknown;
  readonly email: unknown;
  readonly created_at: unknown;
};

function isCanonicalIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
}

function isCanonicalVerificationEmail(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.trim().toLowerCase().normalize("NFC") ||
    /[\s\u0000-\u001F\u007F-\u009F]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > 320
  ) {
    return false;
  }
  const atIndex = value.indexOf("@");
  return (
    atIndex > 0 &&
    atIndex < value.length - 1 &&
    value.indexOf("@", atIndex + 1) === -1
  );
}

/**
 * V6 stored no durable issuance order. A V7 backfill is therefore allowed to use only the
 * canonical created_at evidence, and only when that evidence proves a strict total order inside
 * the exact workspace/call/email scope. Physical row order is deliberately never observed.
 */
function migrateVerificationIssuanceSequencesV7(db: Db): void {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, call_id, email, created_at
       FROM cfp_email_verifications`,
    )
    .all() as LegacyVerificationIssuanceEvidence[];
  const scopes = new Map<string, LegacyVerificationIssuanceEvidence[]>();

  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.workspace_id !== "string" ||
      row.workspace_id.length === 0 ||
      typeof row.call_id !== "string" ||
      row.call_id.length === 0 ||
      typeof row.email !== "string" ||
      !isCanonicalVerificationEmail(row.email) ||
      typeof row.created_at !== "string" ||
      !isCanonicalIsoInstant(row.created_at)
    ) {
      throw new Error(
        "malformed schema v6: verification issuance scope or chronology evidence is invalid",
      );
    }
    const scopeKey = JSON.stringify([
      row.workspace_id,
      row.call_id,
      row.email,
    ]);
    const scope = scopes.get(scopeKey);
    if (scope) {
      scope.push(row);
    } else {
      scopes.set(scopeKey, [row]);
    }
  }

  for (const scope of scopes.values()) {
    if (scope.length < 2) continue;
    const instants = new Set<string>();
    for (const row of scope) {
      const instant = row.created_at as string;
      if (instants.has(instant)) {
        throw new Error(
          "malformed schema v6: verification issuance chronology is ambiguous within an exact workspace/call/email scope",
        );
      }
      instants.add(instant);
    }
  }

  db.exec("DROP TRIGGER trg_cfp_email_verifications_immutable");
  db.exec(
    `ALTER TABLE cfp_email_verifications ADD COLUMN ${V7_VERIFICATION_ISSUANCE_SEQUENCE_COLUMN}`,
  );
  const backfilled = db
    .prepare(
      `UPDATE cfp_email_verifications AS target
       SET issuance_sequence = 1 + (
         SELECT COUNT(*)
         FROM cfp_email_verifications AS prior
         WHERE prior.workspace_id IS target.workspace_id
           AND prior.call_id IS target.call_id
           AND prior.email IS target.email
           AND prior.created_at < target.created_at
       )`,
    )
    .run();
  if (backfilled.changes !== rows.length) {
    throw new Error("database verification issuance migration failed");
  }
  db.exec(V7_DDL);
  validateVerificationIssuanceIntegrity(db);
}

function migrateV7ToV8(db: Db): void {
  // The lineage root must exist before the explicit nullable submission binding is added. No
  // historical submission is assigned: migration has no safe similarity or cross-event basis.
  db.exec(`CREATE TABLE IF NOT EXISTS proposal_lineages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  originating_submission_id TEXT REFERENCES submissions(id),
  originating_submission_revision_id TEXT REFERENCES submission_revisions(id),
  display_projection_json TEXT NOT NULL
    CHECK (typeof(display_projection_json) = 'text'
      AND json_valid(display_projection_json) = 1
      AND length(CAST(display_projection_json AS BLOB)) <= 524288),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (workspace_id, id)
) STRICT`);
  db.exec(
    "ALTER TABLE submissions ADD COLUMN lineage_id TEXT REFERENCES proposal_lineages(id)",
  );
  db.exec(V8_DDL);
}

function migrateV8ToV9(db: Db): void {
  const populated = db.prepare(`
    SELECT 1 FROM recommendation_sets
    UNION ALL SELECT 1 FROM recommendation_set_versions
    LIMIT 1`).get();
  if (populated) {
    throw new Error("schema v9 migration requires authoritative PD-01 P2 binding; populated V8 recommendation data cannot be fabricated");
  }
  db.exec(`
    DROP TRIGGER IF EXISTS trg_recommendation_sets_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_sets_identity_immutable;
    DROP TRIGGER IF EXISTS trg_recommendation_set_versions_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_set_versions_finalize_or_immutable;
    DROP TRIGGER IF EXISTS trg_recommendation_set_versions_no_delete;
    DROP TRIGGER IF EXISTS trg_recommendation_entries_guard;
    DROP TRIGGER IF EXISTS trg_recommendation_entries_immutable;
    DROP TRIGGER IF EXISTS trg_recommendation_entries_no_delete;
    DROP TABLE recommendation_entries;
    DROP TABLE recommendation_set_versions;
    DROP TABLE recommendation_sets;
  `);
  db.exec(V9_DDL);
  validatePd01V9(db);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type SqliteDefinition = {
  readonly name: string;
  readonly sql: string;
};

function migrateV10ToV11(db: Db): void {
  const rebuiltTables = [
    "review_context_versions",
    "recommendation_set_versions",
    "recommendation_entries",
  ] as const;
  const temporaryTables = {
    review_context_versions: "sympose_v11_review_context_versions",
    recommendation_set_versions: "sympose_v11_recommendation_set_versions",
    recommendation_entries: "sympose_v11_recommendation_entries",
  } as const;

  const tableDefinitions = new Map(
    (db
      .prepare(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'table' AND name IN (?, ?, ?)
         ORDER BY name`,
      )
      .all(...rebuiltTables) as SqliteDefinition[])
      .map((definition) => [definition.name, definition] as const),
  );
  for (const table of rebuiltTables) {
    if (!tableDefinitions.get(table)?.sql) {
      throw new Error(`schema v11 migration is missing ${table} definition`);
    }
  }

  const triggerDefinitions = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all() as SqliteDefinition[];
  const indexDefinitions = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name IN (?, ?, ?)
         AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all(...rebuiltTables) as SqliteDefinition[];

  for (const trigger of triggerDefinitions) {
    db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  }
  for (const index of indexDefinitions) {
    db.exec(`DROP INDEX ${quoteIdentifier(index.name)}`);
  }

  db.exec(
    `ALTER TABLE recommendation_entries RENAME TO ${quoteIdentifier(temporaryTables.recommendation_entries)};
     ALTER TABLE recommendation_set_versions RENAME TO ${quoteIdentifier(temporaryTables.recommendation_set_versions)};
     ALTER TABLE review_context_versions RENAME TO ${quoteIdentifier(temporaryTables.review_context_versions)};`,
  );

  db.exec(V11_DDL);
  db.exec(
    `INSERT INTO review_context_versions
     SELECT * FROM ${quoteIdentifier(temporaryTables.review_context_versions)};`,
  );
  db.exec(tableDefinitions.get("recommendation_set_versions")?.sql ?? "");
  db.exec(tableDefinitions.get("recommendation_entries")?.sql ?? "");
  db.exec(
    `INSERT INTO recommendation_set_versions
     SELECT * FROM ${quoteIdentifier(temporaryTables.recommendation_set_versions)};
     INSERT INTO recommendation_entries
     SELECT * FROM ${quoteIdentifier(temporaryTables.recommendation_entries)};`,
  );

  db.exec(
    `DROP TABLE ${quoteIdentifier(temporaryTables.recommendation_entries)};
     DROP TABLE ${quoteIdentifier(temporaryTables.recommendation_set_versions)};
     DROP TABLE ${quoteIdentifier(temporaryTables.review_context_versions)};`,
  );

  for (const index of indexDefinitions) {
    db.exec(index.sql);
  }
  for (const trigger of triggerDefinitions) {
    db.exec(trigger.sql);
  }
}

type V17UncatalogedRelease = {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
  readonly releaseFingerprint: string;
  readonly sealedAt: string;
};

/**
 * V16 had immutable releases but no durable event-local version catalog. The only safe upgrade
 * order is the retained logical evidence (workspace, event, sealed instant, release id); physical
 * row order is never consulted. A V17 catalog that already contains a row is left untouched.
 */
function backfillPublicationReleaseVersionsV17(db: Db): void {
  const nextVersionByScope = new Map<string, number>();
  const existing = db.prepare(
    `SELECT workspace_id AS workspaceId, event_id AS eventId, MAX(version_number) AS maximumVersion
     FROM publication_release_versions
     GROUP BY workspace_id, event_id
     ORDER BY workspace_id, event_id`,
  ).all() as Array<{ workspaceId: string; eventId: string; maximumVersion: number }>;
  for (const scope of existing) {
    nextVersionByScope.set(JSON.stringify([scope.workspaceId, scope.eventId]), scope.maximumVersion + 1);
  }

  const releases = db.prepare(
    `SELECT release_row.workspace_id AS workspaceId,
            release_row.event_id AS eventId,
            release_row.id AS releaseId,
            release_row.fingerprint AS releaseFingerprint,
            release_row.sealed_at AS sealedAt
     FROM publication_releases release_row
     WHERE NOT EXISTS (
       SELECT 1 FROM publication_release_versions catalog
       WHERE catalog.workspace_id = release_row.workspace_id
         AND catalog.event_id = release_row.event_id
         AND catalog.release_id = release_row.id
     )
     ORDER BY release_row.workspace_id, release_row.event_id,
              release_row.sealed_at, release_row.id`,
  ).all() as V17UncatalogedRelease[];

  const insert = db.prepare(
    `INSERT INTO publication_release_versions
       (id, workspace_id, event_id, release_id, version_number, release_fingerprint,
        sealed_at, catalog_source, cataloged_by_account_id, cataloged_at, catalog_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'MIGRATION', NULL, ?, ?)`,
  );
  for (const release of releases) {
    const scopeKey = JSON.stringify([release.workspaceId, release.eventId]);
    const versionNumber = nextVersionByScope.get(scopeKey) ?? 1;
    const catalogedAt = release.sealedAt;
    const catalogFingerprint = fingerprintOf({
      schema: "publication-release-version/v1",
      workspaceId: release.workspaceId,
      eventId: release.eventId,
      releaseId: release.releaseId,
      versionNumber,
      releaseFingerprint: release.releaseFingerprint,
      sealedAt: release.sealedAt,
      catalogSource: "MIGRATION",
      catalogedByAccountId: null,
      catalogedAt,
    });
    insert.run(
      `publication-release-version:${release.releaseId}`,
      release.workspaceId,
      release.eventId,
      release.releaseId,
      versionNumber,
      release.releaseFingerprint,
      release.sealedAt,
      catalogedAt,
      catalogFingerprint,
    );
    nextVersionByScope.set(scopeKey, versionNumber + 1);
  }
}

function migrateV11ToV12(db: Db): void {
  db.exec(V12_DDL);
  db.exec(V13_DDL);
  db.exec(V14_DDL);
  db.exec(V15_DDL);
  db.exec(V16_DDL);
  migrateV16ToV19(db);
}

function migrateV12ToV13(db: Db): void {
  db.exec(V13_DDL);
  db.exec(V14_DDL);
  db.exec(V15_DDL);
  db.exec(V16_DDL);
  migrateV16ToV19(db);
}

function migrateV13ToV14(db: Db): void {
  db.exec(V14_DDL);
  db.exec(V15_DDL);
  db.exec(V16_DDL);
  migrateV16ToV19(db);
}

function migrateV14ToV15(db: Db): void {
  db.exec(V15_DDL);
  db.exec(V16_DDL);
  migrateV16ToV19(db);
}

function migrateV15ToV16(db: Db): void {
  db.exec(V16_DDL);
  migrateV16ToV19(db);
}

function migrateV16ToV19(db: Db): void {
  db.exec(V17_DDL);
  backfillPublicationReleaseVersionsV17(db);
  migrateV17ToV19(db);
}

function migrateV17ToV19(db: Db): void {
  migrateV17ToV18(db);
  migrateV18ToV19(db);
}

function migrateV17ToV18(db: Db): void {
  const reservedSourceCollision = db.prepare(
    `SELECT 1
     FROM observations
     WHERE source IN ('organizer-live-operations', 'organizer-live-operations-correction')
     LIMIT 1`,
  ).get();
  if (reservedSourceCollision) {
    throw new Error("schema v18 reserved observation source collision");
  }
  db.exec(V18_DDL);
}

function migrateV18ToV19(db: Db): void {
  const ambiguousLegacyLineage = db.prepare(
    "SELECT 1 FROM observations WHERE corrected_by IS NOT NULL LIMIT 1",
  ).get();
  if (ambiguousLegacyLineage) {
    throw new Error("malformed observation correction history");
  }
  validateObservationCorrectionIntegrity(db);
  db.exec(
    `ALTER TABLE observations ADD COLUMN ${V19_OBSERVATION_RECORDED_AT_COLUMN}`,
  );
  db.exec("DROP TRIGGER IF EXISTS trg_observations_immutable");
  db.prepare("UPDATE observations SET recorded_at = observed_at").run();
  db.exec(V19_DDL);
  db.exec(V20_CONNECTOR_CONNECTIONS_DDL);
  db.exec(V21_PRODUCTION_CONNECTOR_RUNTIME_DDL);
}

function migratePriorHardenedV14(db: Db): void {
  validateRetainedSpeakerTaskAuthority(db);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_speaker_tasks_scope_guard;
    DROP TRIGGER IF EXISTS trg_speaker_tasks_reopen_authority_guard;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_payload_guard;
    DROP TRIGGER IF EXISTS trg_speaker_portal_tokens_scope_guard;
    DROP TRIGGER IF EXISTS trg_artifact_upload_intents_payload_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_scope_guard;
  `);
  db.exec(V14_DDL);
}

function migrateV10ToV12(db: Db): void {
  migrateV10ToV11(db);
  migrateV11ToV12(db);
}

function migrateV9ToV11(db: Db): void {
  db.exec(V10_DDL);
  migrateV10ToV11(db);
  migrateV11ToV12(db);
}

function migrateV8ToV11(db: Db): void {
  migrateV8ToV9(db);
  migrateV9ToV11(db);
}

interface LegacyV14ArtifactRecordRow {
  readonly id: unknown;
  readonly artifact_schema: unknown;
  readonly workspace_id: unknown;
  readonly event_id: unknown;
  readonly person_id: unknown;
  readonly task_id: unknown;
  readonly kind: unknown;
  readonly version: unknown;
  readonly supersedes_record_id: unknown;
  readonly storage_provider: unknown;
  readonly storage_id: unknown;
  readonly storage_filename: unknown;
  readonly sha256: unknown;
  readonly size_bytes: unknown;
  readonly media_type: unknown;
  readonly display_filename: unknown;
  readonly created_at: unknown;
}

function legacyV14String(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("schema v14 artifact migration cannot prove durable authority");
  }
  return value;
}

function validateRetainedSpeakerTaskAuthority(db: Db): void {
  const speakerTasksTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_tasks'")
    .get();
  if (!speakerTasksTable) return;

  const retainedTasks = db.prepare(
    `SELECT id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
            title, required, gate, owner
     FROM speaker_tasks
     ORDER BY workspace_id, event_id, person_id, id`,
  ).all() as unknown as readonly {
    id: string;
    workspace_id: string;
    event_id: string;
    person_id: string;
    assignment_id: string;
    task_kind: string;
    content_kind: string;
    title: string;
    required: number;
    gate: string;
    owner: string;
  }[];
  for (const task of retainedTasks) {
    if (
      task.owner !== "SPEAKER" ||
      task.task_kind !== task.content_kind ||
      task.title !== (task.task_kind === "HEADSHOT" ? "Headshot PNG" : task.task_kind === "SLIDES" ? "Slides PDF" : "") ||
      task.required !== (task.task_kind === "HEADSHOT" ? 1 : task.task_kind === "SLIDES" ? 0 : -1) ||
      task.gate !== (task.task_kind === "HEADSHOT" ? "PUBLICATION" : task.task_kind === "SLIDES" ? "OPERATOR_RELEASE" : "") ||
      acceptedCurrentPlanAssignmentId(db, task.workspace_id, task.event_id, task.person_id) !== task.assignment_id
    ) {
      throw new Error("schema v14 artifact migration cannot prove durable authority");
    }
  }
}

function migrateLegacyV14ArtifactRecords(db: Db): void {
  validateRetainedSpeakerTaskAuthority(db);
  const rows = db
    .prepare(
      `SELECT id, artifact_schema, workspace_id, event_id, person_id, task_id, kind,
              version, supersedes_record_id, storage_provider, storage_id, storage_filename,
              sha256, size_bytes, media_type, display_filename, created_at
       FROM artifact_records
       ORDER BY workspace_id, event_id, person_id, task_id, kind, version, id`,
    )
    .all() as unknown as readonly LegacyV14ArtifactRecordRow[];

  db.exec(`
    DROP TRIGGER IF EXISTS trg_speaker_tasks_scope_guard;
    DROP TRIGGER IF EXISTS trg_speaker_tasks_reopen_authority_guard;
    DROP TRIGGER IF EXISTS trg_speaker_content_versions_payload_guard;
    DROP TRIGGER IF EXISTS trg_speaker_portal_tokens_scope_guard;
    DROP TRIGGER IF EXISTS trg_artifact_upload_intents_payload_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_scope_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_lineage_guard;
    DROP TRIGGER IF EXISTS trg_artifact_records_immutable;
    DROP TRIGGER IF EXISTS trg_artifact_records_no_delete;
    DROP INDEX IF EXISTS idx_artifact_records_scope;
    DROP TABLE artifact_records;
  `);
  db.exec(V14_DDL);

  const previousContentVersionByScope = new Map<string, string>();
  const taskByScope = new Set<string>();

  for (const row of rows) {
    const id = legacyV14String(row.id);
    const artifactSchema = legacyV14String(row.artifact_schema);
    const workspaceId = legacyV14String(row.workspace_id);
    const eventId = legacyV14String(row.event_id);
    const personId = legacyV14String(row.person_id);
    const taskId = legacyV14String(row.task_id);
    const kind = legacyV14String(row.kind);
    const supersedesRecordId = row.supersedes_record_id === null ? null : legacyV14String(row.supersedes_record_id);
    const storageProvider = legacyV14String(row.storage_provider);
    const storageId = legacyV14String(row.storage_id);
    const storageFilename = legacyV14String(row.storage_filename);
    const sha256 = legacyV14String(row.sha256);
    const version = row.version;
    const sizeBytes = row.size_bytes;
    const mediaType = legacyV14String(row.media_type);
    const displayFilename = legacyV14String(row.display_filename);
    const createdAt = legacyV14String(row.created_at);
    if (
      artifactSchema !== "sympose-artifact-record/v1" ||
      !/^[a-f0-9]{64}$/u.test(id) ||
      !/^[a-f0-9]{64}$/u.test(storageId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(sizeBytes) ||
      !["HEADSHOT", "SLIDES"].includes(kind) ||
      storageProvider !== "local"
    ) {
      throw new Error("schema v14 artifact migration cannot prove durable authority");
    }
    const validatedVersion = version as number;
    const validatedSizeBytes = sizeBytes as number;

    const speaker = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM event_speakers
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND role_key IN ('SPEAKER', 'MODERATOR')
           AND participation_status IN ('CONFIRMED', 'ACCEPTED')`,
      )
      .get(workspaceId, eventId, personId) as { count: number };
    if (speaker.count !== 1) {
      throw new Error("schema v14 artifact migration cannot prove durable authority");
    }
    const scopeKey = JSON.stringify([workspaceId, eventId, personId, taskId, kind]);
    if (!taskByScope.has(scopeKey)) {
      const assignmentId = acceptedCurrentPlanAssignmentId(db, workspaceId, eventId, personId);
      db.prepare(
        `INSERT INTO speaker_tasks
           (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
            title, required, gate, owner, state, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPEAKER', 'SUBMITTED', ?, ?, ?)`,
      ).run(
        taskId,
        workspaceId,
        eventId,
        personId,
        assignmentId,
        kind,
        kind,
        kind === "HEADSHOT" ? "Headshot PNG" : "Slides PDF",
        kind === "HEADSHOT" ? 1 : 0,
        kind === "HEADSHOT" ? "PUBLICATION" : "OPERATOR_RELEASE",
        createdAt,
        createdAt,
        createdAt,
      );
      taskByScope.add(scopeKey);
    }

    const contentVersionId = deterministicUuid(
      `content-version:${workspaceId}:${eventId}:${personId}:${taskId}:${kind}:${validatedVersion}`,
    );
    const priorContentVersionId = previousContentVersionByScope.get(scopeKey) ?? null;
    if ((validatedVersion === 1 && (supersedesRecordId !== null || priorContentVersionId !== null)) || (validatedVersion > 1 && priorContentVersionId === null)) {
      throw new Error("schema v14 artifact migration cannot prove artifact lineage");
    }
    const contentPayload = {
      kind,
      asset: {
        assetId: id,
        fileName: displayFilename,
        mediaType,
        byteSize: validatedSizeBytes,
        checksum: sha256,
        storageRef: `synthetic://artifact/${id}`,
      },
    };
    const contentPayloadJson = canonicalJson(contentPayload);
    const contentHash = fingerprintOf(contentPayload);
    db.prepare(
      `INSERT INTO speaker_content_versions
         (id, workspace_id, event_id, person_id, task_id, kind, version,
          supersedes_version_id, payload_json, content_hash, payload_bytes,
          submitted_at, submitted_by, submitted_by_kind, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'speaker', 'local-artifact-store')`,
    ).run(
      contentVersionId,
      workspaceId,
      eventId,
      personId,
      taskId,
      kind,
      validatedVersion,
      priorContentVersionId,
      contentPayloadJson,
      contentHash,
      Buffer.byteLength(contentPayloadJson, "utf8"),
      createdAt,
      personId,
    );

    const authorityEventId = deterministicUuid(`speaker-artifact-event:${id}`);
    const authorityPayload = {
      schema: "speaker-artifact-submission/v1",
      artifactId: id,
      workspaceId,
      eventId,
      personId,
      taskId,
      kind,
      version,
      storageId,
      storageFilename,
      sha256,
      byteSize: validatedSizeBytes,
      mediaType,
      displayFilename,
      contentVersionId,
      contentVersionHash: contentHash,
    };
    const authorityPayloadJson = canonicalJson(authorityPayload);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'speaker.artifact.submitted', 'speaker_task', ?, ?, ?, ?)`,
    ).run(
      authorityEventId,
      workspaceId,
      taskId,
      authorityPayloadJson,
      fingerprintOf(authorityPayload),
      createdAt,
    );

    db.prepare(
      `INSERT INTO artifact_upload_intents
         (id, workspace_id, event_id, person_id, task_id, kind, artifact_id,
          storage_id, storage_filename, version, supersedes_record_id, sha256,
          size_bytes, media_type, display_filename, created_at, content_version_id,
          content_payload_json, status, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMMITTED', ?)`,
    ).run(
      id,
      workspaceId,
      eventId,
      personId,
      taskId,
      kind,
      id,
      storageId,
      storageFilename,
      validatedVersion,
      supersedesRecordId,
      sha256,
      validatedSizeBytes,
      mediaType,
      displayFilename,
      createdAt,
      contentVersionId,
      contentPayloadJson,
      createdAt,
    );

    db.prepare(
      `INSERT INTO artifact_records
        (id, artifact_schema, workspace_id, event_id, person_id, task_id, kind, version,
         supersedes_record_id, storage_provider, storage_id, storage_filename, sha256,
         size_bytes, media_type, display_filename, created_at, content_version_id,
         authority_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      artifactSchema,
      workspaceId,
      eventId,
      personId,
      taskId,
      kind,
      validatedVersion,
      supersedesRecordId,
      storageProvider,
      storageId,
      storageFilename,
      sha256,
      validatedSizeBytes,
      mediaType,
      displayFilename,
      createdAt,
      contentVersionId,
      authorityEventId,
    );
    previousContentVersionByScope.set(scopeKey, contentVersionId);
  }
}

const OBSERVATION_CORRECTION_ACTOR_ROLES = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);
const OBSERVATION_CORRECTION_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const OBSERVATION_CORRECTION_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

type ObservationCorrectionIntegrityRow = {
  readonly id: unknown;
  readonly workspaceId: unknown;
  readonly originalObservationId: unknown;
  readonly correctionObservationId: unknown;
  readonly reason: unknown;
  readonly actorAccountId: unknown;
  readonly actorRole: unknown;
  readonly correctedAt: unknown;
  readonly idempotencyKey: unknown;
  readonly commandFingerprint: unknown;
  readonly actorWorkspaceId: unknown;
  readonly originalWorkspaceId: unknown;
  readonly originalEventId: unknown;
  readonly originalPersonId: unknown;
  readonly originalProgramUnitId: unknown;
  readonly originalObservationType: unknown;
  readonly originalObservedAt: unknown;
  readonly originalCorrectedBy: unknown;
  readonly originalSource: unknown;
  readonly originalIdempotencyKey: unknown;
  readonly correctionWorkspaceId: unknown;
  readonly correctionEventId: unknown;
  readonly correctionPersonId: unknown;
  readonly correctionProgramUnitId: unknown;
  readonly correctionObservationType: unknown;
  readonly correctionObservedAt: unknown;
  readonly correctionCorrectedBy: unknown;
  readonly correctionSource: unknown;
  readonly correctionIdempotencyKey: unknown;
};

function validateObservationCorrectionIntegrity(db: Db): void {
  const legacyLineage = db.prepare(
    "SELECT 1 FROM observations WHERE corrected_by IS NOT NULL LIMIT 1",
  ).get();
  if (legacyLineage) {
    throw new Error("malformed observation correction history");
  }
  const rows = db.prepare(
    `SELECT relation.id,
            relation.workspace_id AS workspaceId,
            relation.original_observation_id AS originalObservationId,
            relation.correction_observation_id AS correctionObservationId,
            relation.reason,
            relation.actor_account_id AS actorAccountId,
            relation.actor_role AS actorRole,
            relation.corrected_at AS correctedAt,
            relation.idempotency_key AS idempotencyKey,
            relation.command_fingerprint AS commandFingerprint,
            actor.workspace_id AS actorWorkspaceId,
            original.workspace_id AS originalWorkspaceId,
            original.event_id AS originalEventId,
            original.person_id AS originalPersonId,
            original.program_unit_id AS originalProgramUnitId,
            original.observation_type AS originalObservationType,
            original.observed_at AS originalObservedAt,
            original.corrected_by AS originalCorrectedBy,
            original.source AS originalSource,
            original.idempotency_key AS originalIdempotencyKey,
            correction.workspace_id AS correctionWorkspaceId,
            correction.event_id AS correctionEventId,
            correction.person_id AS correctionPersonId,
            correction.program_unit_id AS correctionProgramUnitId,
            correction.observation_type AS correctionObservationType,
            correction.observed_at AS correctionObservedAt,
            correction.corrected_by AS correctionCorrectedBy,
            correction.source AS correctionSource,
            correction.idempotency_key AS correctionIdempotencyKey
     FROM observation_corrections relation
     LEFT JOIN accounts actor ON actor.id = relation.actor_account_id
     LEFT JOIN observations original ON original.id = relation.original_observation_id
     LEFT JOIN observations correction ON correction.id = relation.correction_observation_id
     ORDER BY relation.id`,
  ).all() as ObservationCorrectionIntegrityRow[];

  const invalid = (): never => {
    throw new Error("malformed observation correction history");
  };
  for (const row of rows) {
    if (
      typeof row.id !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.id) ||
      typeof row.workspaceId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.workspaceId) ||
      typeof row.originalObservationId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.originalObservationId) ||
      typeof row.correctionObservationId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.correctionObservationId) ||
      row.originalObservationId === row.correctionObservationId ||
      typeof row.reason !== "string" || Array.from(row.reason).length < 8 || Array.from(row.reason).length > 280 ||
      Buffer.byteLength(row.reason, "utf8") < 8 || Buffer.byteLength(row.reason, "utf8") > 1120 ||
      row.reason.trim() !== row.reason || OBSERVATION_CORRECTION_CONTROL_CHARACTER.test(row.reason) ||
      typeof row.actorAccountId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.actorAccountId) ||
      typeof row.actorRole !== "string" || !OBSERVATION_CORRECTION_ACTOR_ROLES.has(row.actorRole) ||
      row.actorWorkspaceId !== row.workspaceId ||
      typeof row.correctedAt !== "string" || canonicalizeZonedTimestamp(row.correctedAt) !== row.correctedAt ||
      typeof row.idempotencyKey !== "string" || Buffer.byteLength(row.idempotencyKey, "utf8") < 1 ||
      Buffer.byteLength(row.idempotencyKey, "utf8") > 128 ||
      OBSERVATION_CORRECTION_CONTROL_CHARACTER.test(row.idempotencyKey) ||
      typeof row.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.commandFingerprint) ||
      row.originalWorkspaceId !== row.workspaceId || row.correctionWorkspaceId !== row.workspaceId ||
      typeof row.originalEventId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.originalEventId) ||
      typeof row.originalPersonId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.originalPersonId) ||
      typeof row.originalProgramUnitId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(row.originalProgramUnitId) ||
      row.originalEventId !== row.correctionEventId || row.originalPersonId !== row.correctionPersonId ||
      row.originalProgramUnitId !== row.correctionProgramUnitId ||
      row.originalObservationType !== "attendance" || row.originalSource !== "organizer-live-operations" ||
      row.correctionObservationType !== "attendance_not_attended" ||
      row.correctionSource !== "organizer-live-operations-correction" ||
      row.originalCorrectedBy !== null || row.correctionCorrectedBy !== null ||
      row.correctionObservedAt !== row.correctedAt ||
      typeof row.originalObservedAt !== "string" || canonicalizeZonedTimestamp(row.originalObservedAt) !== row.originalObservedAt ||
      row.correctedAt <= row.originalObservedAt ||
      row.correctionIdempotencyKey !== row.idempotencyKey
    ) invalid();
    const workspaceId = row.workspaceId as string;
    const originalEventId = row.originalEventId as string;
    const originalPersonId = row.originalPersonId as string;
    const originalProgramUnitId = row.originalProgramUnitId as string;
    const originalObservationId = row.originalObservationId as string;
    const relationId = row.id as string;

    const originalKey = `attendance-observation:v1:${fingerprintOf({
      schema: "attendance-observation-key/v1",
      workspaceId,
      eventId: originalEventId,
      personId: originalPersonId,
      programUnitId: originalProgramUnitId,
      observedMeaning: "ATTENDED",
    })}`;
    const correctionKey = `attendance-correction:v1:${fingerprintOf({
      schema: "attendance-correction-key/v1",
      workspaceId,
      originalObservationId,
      correctedMeaning: "DID_NOT_ATTEND",
    })}`;
    const commandFingerprint = fingerprintOf({
      schema: "attendance-correction-command/v1",
      workspaceId,
      originalObservationId,
      correctedMeaning: "DID_NOT_ATTEND",
      reason: row.reason,
    });
    if (
      row.originalIdempotencyKey !== originalKey ||
      row.idempotencyKey !== correctionKey ||
      row.commandFingerprint !== commandFingerprint
    ) invalid();

    const auditRows = db.prepare(
      `SELECT actor_kind AS actorKind,
              actor_ref AS actorRef,
              details_json AS detailsJson,
              created_at AS createdAt
       FROM audit_events
       WHERE workspace_id = ?
         AND action = 'outcome.attendance.corrected'
         AND target_type = 'observation_correction'
         AND target_id = ?`,
    ).all(workspaceId, relationId) as Array<{
      actorKind: unknown;
      actorRef: unknown;
      detailsJson: unknown;
      createdAt: unknown;
    }>;
    if (auditRows.length !== 1) invalid();
    const audit = auditRows[0]!;
    const expectedAuditDetails = JSON.stringify({
      eventId: originalEventId,
      originalObservationId,
      correctionObservationId: row.correctionObservationId,
      correctedMeaning: "DID_NOT_ATTEND",
      commandFingerprint,
    });
    if (
      audit.actorKind !== "account" ||
      audit.actorRef !== row.actorAccountId ||
      typeof audit.createdAt !== "string" ||
      canonicalizeZonedTimestamp(audit.createdAt) !== audit.createdAt ||
      audit.detailsJson !== expectedAuditDetails
    ) invalid();

    const competing = db.prepare(
      `SELECT COUNT(*) AS count
       FROM observations candidate
       WHERE candidate.workspace_id = ?
         AND candidate.event_id = ?
         AND candidate.person_id = ?
         AND candidate.program_unit_id = ?
         AND candidate.observation_type = 'attendance'
         AND candidate.id <> ?
         AND NOT EXISTS (
           SELECT 1 FROM observation_corrections supersession
           WHERE supersession.original_observation_id = candidate.id
         )`,
    ).get(
      workspaceId,
      originalEventId,
      originalPersonId,
      originalProgramUnitId,
      originalObservationId,
    ) as { count: number };
    if (competing.count !== 0) invalid();
  }

  const originalRows = db.prepare(
    `SELECT original.id,
            original.workspace_id AS workspaceId,
            original.event_id AS eventId,
            original.person_id AS personId,
            original.program_unit_id AS programUnitId,
            original.observation_type AS observationType,
            original.observed_at AS observedAt,
            original.corrected_by AS correctedBy,
            original.idempotency_key AS idempotencyKey,
            event_row.workspace_id AS eventWorkspaceId,
            person.workspace_id AS personWorkspaceId,
            unit.workspace_id AS unitWorkspaceId,
            unit.event_id AS unitEventId,
            (SELECT COUNT(*) FROM observation_corrections relation
             WHERE relation.workspace_id = original.workspace_id
               AND relation.original_observation_id = original.id) AS relationCount
     FROM observations original
     LEFT JOIN events event_row ON event_row.id = original.event_id
     LEFT JOIN people person ON person.id = original.person_id
     LEFT JOIN program_units unit ON unit.id = original.program_unit_id
     WHERE original.source = 'organizer-live-operations'
     ORDER BY original.id`,
  ).all() as Array<{
    id: unknown;
    workspaceId: unknown;
    eventId: unknown;
    personId: unknown;
    programUnitId: unknown;
    observationType: unknown;
    observedAt: unknown;
    correctedBy: unknown;
    idempotencyKey: unknown;
    eventWorkspaceId: unknown;
    personWorkspaceId: unknown;
    unitWorkspaceId: unknown;
    unitEventId: unknown;
    relationCount: unknown;
  }>;
  for (const original of originalRows) {
    if (
      typeof original.id !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(original.id) ||
      typeof original.workspaceId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(original.workspaceId) ||
      typeof original.eventId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(original.eventId) ||
      typeof original.personId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(original.personId) ||
      typeof original.programUnitId !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(original.programUnitId) ||
      original.observationType !== "attendance" ||
      typeof original.observedAt !== "string" ||
      canonicalizeZonedTimestamp(original.observedAt) !== original.observedAt ||
      original.correctedBy !== null ||
      original.eventWorkspaceId !== original.workspaceId ||
      original.personWorkspaceId !== original.workspaceId ||
      original.unitWorkspaceId !== original.workspaceId ||
      original.unitEventId !== original.eventId ||
      (original.relationCount !== 0 && original.relationCount !== 1)
    ) invalid();
    const originalId = original.id as string;
    const workspaceId = original.workspaceId as string;
    const eventId = original.eventId as string;
    const personId = original.personId as string;
    const programUnitId = original.programUnitId as string;
    const expectedKey = `attendance-observation:v1:${fingerprintOf({
      schema: "attendance-observation-key/v1",
      workspaceId,
      eventId,
      personId,
      programUnitId,
      observedMeaning: "ATTENDED",
    })}`;
    if (original.idempotencyKey !== expectedKey) invalid();

    const auditRows = db.prepare(
      `SELECT audit.actor_kind AS actorKind,
              audit.actor_ref AS actorRef,
              audit.details_json AS detailsJson,
              audit.created_at AS createdAt,
              actor.workspace_id AS actorWorkspaceId
       FROM audit_events audit
       LEFT JOIN accounts actor
         ON actor.id = audit.actor_ref
        AND actor.workspace_id = audit.workspace_id
       WHERE audit.workspace_id = ?
         AND audit.action = 'outcome.attendance.recorded'
         AND audit.target_type = 'observation'
         AND audit.target_id = ?`,
    ).all(workspaceId, originalId) as Array<{
      actorKind: unknown;
      actorRef: unknown;
      detailsJson: unknown;
      createdAt: unknown;
      actorWorkspaceId: unknown;
    }>;
    if (auditRows.length !== 1) invalid();
    const audit = auditRows[0]!;
    const expectedAuditDetails = JSON.stringify({
      eventId,
      personId,
      programUnitId,
      observedMeaning: "ATTENDED",
    });
    if (
      audit.actorKind !== "account" ||
      typeof audit.actorRef !== "string" || !OBSERVATION_CORRECTION_SAFE_ID.test(audit.actorRef) ||
      audit.actorWorkspaceId !== workspaceId ||
      typeof audit.createdAt !== "string" || canonicalizeZonedTimestamp(audit.createdAt) !== audit.createdAt ||
      audit.detailsJson !== expectedAuditDetails
    ) invalid();
  }

  const incompleteCorrection = db.prepare(
    `SELECT 1
     FROM observations correction
     WHERE correction.source = 'organizer-live-operations-correction'
       AND (
         correction.observation_type <> 'attendance_not_attended'
         OR (SELECT COUNT(*) FROM observation_corrections relation
             WHERE relation.correction_observation_id = correction.id) <> 1
       )
     LIMIT 1`,
  ).get();
  if (incompleteCorrection) invalid();
}

function validateObservationRecordingTimeIntegrity(db: Db): void {
  const rows = db.prepare(
    `SELECT observation.id,
            observation.workspace_id AS workspaceId,
            observation.event_id AS eventId,
            observation.program_unit_id AS programUnitId,
            observation.observation_type AS observationType,
            observation.observed_at AS observedAt,
            observation.recorded_at AS recordedAt,
            observation.source,
            observation.corrected_by AS correctedBy,
            event_row.starts_at AS eventStartsAt,
            event_row.ends_at AS eventEndsAt,
            unit.starts_at AS unitStartsAt,
            unit.ends_at AS unitEndsAt,
            (SELECT COUNT(*) FROM observation_corrections relation
             WHERE relation.workspace_id = observation.workspace_id
               AND relation.original_observation_id = observation.id) AS originalRelationCount,
            (SELECT COUNT(*) FROM observation_corrections relation
             WHERE relation.workspace_id = observation.workspace_id
               AND relation.correction_observation_id = observation.id) AS correctionRelationCount,
            (SELECT MIN(audit.created_at) FROM audit_events audit
             WHERE audit.workspace_id = observation.workspace_id
               AND audit.action = 'outcome.attendance.recorded'
               AND audit.target_type = 'observation'
               AND audit.target_id = observation.id) AS recordingAuditCreatedAt,
            (SELECT MIN(audit.created_at)
             FROM observation_corrections relation
             JOIN audit_events audit
               ON audit.workspace_id = relation.workspace_id
              AND audit.action = 'outcome.attendance.corrected'
              AND audit.target_type = 'observation_correction'
              AND audit.target_id = relation.id
             WHERE relation.workspace_id = observation.workspace_id
               AND relation.correction_observation_id = observation.id) AS correctionAuditCreatedAt
            ,(SELECT original.recorded_at
              FROM observation_corrections relation
              JOIN observations original
                ON original.id = relation.original_observation_id
               AND original.workspace_id = relation.workspace_id
              WHERE relation.workspace_id = observation.workspace_id
                AND relation.correction_observation_id = observation.id) AS originalRecordedAt
     FROM observations observation
     LEFT JOIN events event_row
       ON event_row.id = observation.event_id
      AND event_row.workspace_id = observation.workspace_id
     LEFT JOIN program_units unit
       ON unit.id = observation.program_unit_id
      AND unit.workspace_id = observation.workspace_id
      AND unit.event_id = observation.event_id
     ORDER BY observation.id`,
  ).all() as Array<Record<string, unknown>>;
  const invalid = (): never => {
    throw new Error("malformed observation recording history");
  };
  for (const row of rows) {
    if (
      typeof row.observedAt !== "string" ||
      canonicalizeZonedTimestamp(row.observedAt) !== row.observedAt ||
      typeof row.recordedAt !== "string" ||
      canonicalizeZonedTimestamp(row.recordedAt) !== row.recordedAt ||
      row.observedAt > row.recordedAt ||
      row.correctedBy !== null
    ) invalid();
    const observedAt = row.observedAt as string;
    const recordedAt = row.recordedAt as string;
    if (row.source === "organizer-live-operations") {
      if (
        row.observationType !== "attendance" ||
        typeof row.eventStartsAt !== "string" ||
        canonicalizeZonedTimestamp(row.eventStartsAt) !== row.eventStartsAt ||
        typeof row.eventEndsAt !== "string" ||
        canonicalizeZonedTimestamp(row.eventEndsAt) !== row.eventEndsAt ||
        typeof row.unitStartsAt !== "string" ||
        canonicalizeZonedTimestamp(row.unitStartsAt) !== row.unitStartsAt ||
        typeof row.unitEndsAt !== "string" ||
        canonicalizeZonedTimestamp(row.unitEndsAt) !== row.unitEndsAt ||
        row.eventStartsAt >= row.eventEndsAt ||
        row.unitStartsAt < row.eventStartsAt ||
        row.unitEndsAt > row.eventEndsAt ||
        row.unitStartsAt >= row.unitEndsAt ||
        recordedAt < row.eventStartsAt || recordedAt >= row.eventEndsAt ||
        observedAt < row.unitStartsAt || observedAt >= row.unitEndsAt ||
        (row.originalRelationCount !== 0 && row.originalRelationCount !== 1) ||
        typeof row.recordingAuditCreatedAt !== "string" ||
        canonicalizeZonedTimestamp(row.recordingAuditCreatedAt) !== row.recordingAuditCreatedAt ||
        row.recordingAuditCreatedAt < recordedAt
      ) invalid();
    } else if (row.source === "organizer-live-operations-correction") {
      if (
        row.observationType !== "attendance_not_attended" ||
        observedAt !== recordedAt ||
        typeof row.originalRecordedAt !== "string" ||
        canonicalizeZonedTimestamp(row.originalRecordedAt) !== row.originalRecordedAt ||
        recordedAt < row.originalRecordedAt ||
        row.correctionRelationCount !== 1 ||
        typeof row.correctionAuditCreatedAt !== "string" ||
        canonicalizeZonedTimestamp(row.correctionAuditCreatedAt) !== row.correctionAuditCreatedAt ||
        row.correctionAuditCreatedAt < recordedAt
      ) invalid();
    }
  }
}

function verifySchemaManifest(db: Db, version: SchemaVersion): void {
  if (version === 21) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V21_MANIFEST_SHA256) {
      throw new Error("malformed schema v21");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    validateObservationCorrectionIntegrity(db);
    validateObservationRecordingTimeIntegrity(db);
    validateV21ProductionConnectorIntegrity(db);
    return;
  }
  if (version === 20) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V20_MANIFEST_SHA256) {
      throw new Error("malformed schema v20");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    validateObservationCorrectionIntegrity(db);
    validateObservationRecordingTimeIntegrity(db);
    return;
  }
  if (version === 19) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V19_MANIFEST_SHA256) {
      throw new Error("malformed schema v19");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    validateObservationCorrectionIntegrity(db);
    validateObservationRecordingTimeIntegrity(db);
    return;
  }
  if (version === 18) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V18_MANIFEST_SHA256) {
      throw new Error("malformed schema v18");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    validateObservationCorrectionIntegrity(db);
    return;
  }
  if (version === 17) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V17_MANIFEST_SHA256) {
      throw new Error("malformed schema v17");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    return;
  }
  if (version === 16) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V16_MANIFEST_SHA256) {
      throw new Error("malformed schema v16");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    validateReviewerAccessIntegrity(db);
    return;
  }
  if (version === 15) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V15_MANIFEST_SHA256) {
      throw new Error("malformed schema v15");
    }
    validateArtifactRecordIntegrity(db);
    validateReviewRoundScheduleIntegrity(db);
    return;
  }
  if (version === 14) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V14_MANIFEST_SHA256) {
      throw new Error("malformed schema v14");
    }
    validateArtifactRecordIntegrity(db);
    return;
  }
  if (version === 13) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V13_MANIFEST_SHA256) {
      throw new Error("malformed schema v13");
    }
    return;
  }
  if (version === 12) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V12_MANIFEST_SHA256) {
      throw new Error("malformed schema v12");
    }
    return;
  }
  if (version === 11) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V11_MANIFEST_SHA256) {
      throw new Error("malformed schema v11");
    }
    return;
  }
  if (version === 10) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V10_MANIFEST_SHA256) {
      throw new Error("malformed schema v10");
    }
    return;
  }
  if (version === 9) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V9_MANIFEST_SHA256) throw new Error("malformed schema v9");
    return;
  }
  if (version === 8) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V8_MANIFEST_SHA256) {
      throw new Error("malformed schema v8");
    }
    return;
  }
  if (version === 7) {
    if (manifestDigest(readSchemaManifest(db)) !== EXPECTED_V7_MANIFEST_SHA256) {
      throw new Error("malformed schema v7");
    }
    return;
  }
  const actual = readSchemaManifest(db);
  if (version === 6) {
    if (manifestDigest(actual) !== EXPECTED_V6_MANIFEST_SHA256) {
      throw new Error("malformed schema v6");
    }
    return;
  }
  if (version === 5) {
    if (manifestDigest(actual) !== EXPECTED_V5_MANIFEST_SHA256) {
      throw new Error("malformed schema v5");
    }
    return;
  }
  if (version === 4) {
    if (manifestDigest(actual) !== EXPECTED_V4_MANIFEST_SHA256) {
      throw new Error("malformed schema v4");
    }
    return;
  }
  if (version === 3) {
    if (manifestDigest(actual) !== EXPECTED_V3_MANIFEST_SHA256) {
      throw new Error("malformed schema v3");
    }
    return;
  }
  if (manifestDigest(columnsOnlySchemaManifest(db)) !== LEGACY_SCHEMA_MANIFEST_SHA256) {
    throw new Error(`malformed schema v${version}`);
  }
}

function validateV21ProductionConnectorIntegrity(db: Db): void {
  const fail = (): never => {
    throw new Error("database v21 production connector integrity check failed");
  };
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const exactRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    const candidate = record(value);
    if (!candidate) return null;
    const actual = Object.keys(candidate).sort();
    const expected = [...keys].sort();
    return canonicalJson(actual) === canonicalJson(expected) ? candidate : null;
  };
  const parsedCanonical = (json: unknown, fingerprint: unknown): unknown => {
    if (typeof json !== "string" || typeof fingerprint !== "string") fail();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json as string) as unknown;
    } catch {
      fail();
    }
    if (canonicalJson(parsed) !== (json as string) || fingerprintOf(parsed) !== fingerprint) fail();
    return parsed;
  };
  const canonicalInstant = (value: unknown): value is string =>
    typeof value === "string" && canonicalizeZonedTimestamp(value) === value;

  const malformedCredential = db.prepare(
    `SELECT 1 FROM account_credentials credential
     LEFT JOIN accounts account
       ON account.id = credential.account_id AND account.workspace_id = credential.workspace_id
     WHERE account.id IS NULL LIMIT 1`,
  ).get();
  const malformedRun = db.prepare(
    `SELECT 1 FROM connector_runs run
     LEFT JOIN connector_connections connection
       ON connection.id = run.connection_id AND connection.workspace_id = run.workspace_id
          AND connection.provider = run.provider
     LEFT JOIN accounts creator
       ON creator.id = run.created_by_account_id AND creator.workspace_id = run.workspace_id
     LEFT JOIN accounts confirmer
       ON confirmer.id = run.confirmed_by_account_id AND confirmer.workspace_id = run.workspace_id
     WHERE connection.id IS NULL OR creator.id IS NULL
       OR (run.confirmed_by_account_id IS NOT NULL AND confirmer.id IS NULL)
       OR ((run.state IN ('SUCCEEDED', 'FAILED_TERMINAL', 'UNKNOWN')) <> (run.completed_at IS NOT NULL))
       OR (run.operation <> 'IMPORT' AND (run.confirmation_token_hash IS NOT NULL OR run.confirmed_at IS NOT NULL))
     LIMIT 1`,
  ).get();
  const malformedAttempt = db.prepare(
    `SELECT 1 FROM connector_run_attempts attempt
     LEFT JOIN connector_runs run
       ON run.id = attempt.run_id AND run.workspace_id = attempt.workspace_id
     WHERE run.id IS NULL LIMIT 1`,
  ).get();
  const malformedPreview = db.prepare(
    `SELECT 1 FROM connector_import_preview_rows preview
     LEFT JOIN connector_runs run
       ON run.id = preview.run_id AND run.workspace_id = preview.workspace_id
          AND run.provider = preview.provider AND run.operation = 'IMPORT'
     LEFT JOIN people candidate
       ON candidate.id = preview.candidate_person_id AND candidate.workspace_id = preview.workspace_id
     LEFT JOIN source_records source
       ON source.id = preview.applied_source_record_id AND source.workspace_id = preview.workspace_id
     WHERE run.id IS NULL
       OR (preview.candidate_person_id IS NOT NULL AND candidate.id IS NULL)
       OR (preview.disposition IN ('LINK', 'UPDATE') AND
           (preview.candidate_person_id IS NULL OR preview.candidate_person_fingerprint IS NULL))
       OR (preview.disposition IN ('CREATE', 'CONFLICT') AND
           (preview.candidate_person_id IS NOT NULL OR preview.candidate_person_fingerprint IS NOT NULL))
       OR (preview.applied_source_record_id IS NOT NULL AND source.id IS NULL)
     LIMIT 1`,
  ).get();
  const malformedImportCompletion = db.prepare(
    `SELECT 1
     FROM connector_import_preview_rows preview
     JOIN connector_runs run
       ON run.id = preview.run_id AND run.workspace_id = preview.workspace_id
          AND run.provider = preview.provider AND run.operation = 'IMPORT'
     WHERE (
       run.state = 'SUCCEEDED' AND (
         preview.disposition = 'EVALUATING'
         OR (preview.disposition IN ('CREATE', 'UPDATE', 'LINK') AND preview.applied_source_record_id IS NULL)
         OR (preview.disposition = 'CONFLICT' AND preview.applied_source_record_id IS NOT NULL)
         OR (preview.disposition IN ('CREATE', 'UPDATE') AND (
           SELECT COUNT(*) FROM person_projection_decisions decision
           WHERE decision.workspace_id = preview.workspace_id
             AND decision.import_run_id = preview.run_id
             AND decision.preview_row_id = preview.id
             AND decision.source_record_id = preview.applied_source_record_id
             AND decision.confirmed_by_account_id = run.confirmed_by_account_id
         ) != 1)
         OR (preview.disposition IN ('LINK', 'CONFLICT') AND EXISTS (
           SELECT 1 FROM person_projection_decisions decision
           WHERE decision.workspace_id = preview.workspace_id
             AND decision.import_run_id = preview.run_id
             AND decision.preview_row_id = preview.id
         ))
       )
     ) OR (
       run.state != 'SUCCEEDED' AND (
         preview.applied_source_record_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM person_projection_decisions decision
           WHERE decision.workspace_id = preview.workspace_id
             AND decision.import_run_id = preview.run_id
             AND decision.preview_row_id = preview.id
         )
       )
     )
     LIMIT 1`,
  ).get();
  const malformedBootstrap = db.prepare(
    `SELECT 1 FROM production_bootstrap_challenges challenge
     LEFT JOIN accounts account ON account.id = challenge.consumed_by_account_id
     WHERE challenge.consumed_by_account_id IS NOT NULL AND account.id IS NULL LIMIT 1`,
  ).get();
  const malformedExportScope = db.prepare(
    `SELECT 1 FROM connector_export_receipts receipt
     LEFT JOIN connector_runs run
       ON run.id = receipt.run_id AND run.workspace_id = receipt.workspace_id AND run.operation = 'EXPORT'
     LEFT JOIN people person
       ON person.id = receipt.person_id AND person.workspace_id = receipt.workspace_id
     LEFT JOIN connector_export_decisions decision
       ON decision.run_id = receipt.run_id AND decision.workspace_id = receipt.workspace_id
          AND decision.person_id = receipt.person_id AND decision.decision_state = 'READY'
          AND decision.projection_fingerprint = receipt.input_fingerprint
     WHERE run.id IS NULL OR person.id IS NULL OR decision.id IS NULL LIMIT 1`,
  ).get();
  if (
    malformedCredential || malformedRun || malformedAttempt || malformedPreview ||
    malformedImportCompletion || malformedBootstrap || malformedExportScope
  ) fail();

  const authRows = db.prepare(
    `SELECT 'credential' AS kind, created_at AS firstAt, updated_at AS secondAt, NULL AS thirdAt
       FROM account_credentials
     UNION ALL
     SELECT 'identity', last_failed_at, blocked_until, NULL FROM auth_login_guards
     UNION ALL
     SELECT 'global', window_started_at, updated_at, blocked_until FROM auth_global_guards
     UNION ALL
     SELECT 'lease', acquired_at, expires_at, NULL FROM auth_attempt_leases
     UNION ALL
     SELECT 'bootstrap', issued_at, expires_at, COALESCE(consumed_at, invalidated_at)
       FROM production_bootstrap_challenges`,
  ).all() as Array<{
    readonly kind: string;
    readonly firstAt: unknown;
    readonly secondAt: unknown;
    readonly thirdAt: unknown;
  }>;
  for (const row of authRows) {
    if (!canonicalInstant(row.firstAt) || (row.secondAt !== null && !canonicalInstant(row.secondAt))
      || (row.thirdAt !== null && !canonicalInstant(row.thirdAt))) fail();
    const firstAt = row.firstAt as string;
    const secondAt = row.secondAt as string | null;
    const thirdAt = row.thirdAt as string | null;
    if (secondAt !== null && secondAt < firstAt) fail();
    if (thirdAt !== null && row.kind !== "bootstrap" && secondAt !== null && thirdAt <= secondAt) fail();
  }
  const authBounds = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM auth_login_guards) AS loginGuards,
       (SELECT COUNT(*) FROM auth_attempt_leases) AS leases,
       (SELECT COUNT(*) FROM auth_attempt_leases WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active,
       (SELECT COUNT(*) FROM auth_attempt_leases
        WHERE attempt_kind = 'BOOTSTRAP' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS bootstrapActive,
       (SELECT COUNT(*) FROM auth_global_guards) AS globalGuards`,
  ).get() as { loginGuards: number; leases: number; active: number; bootstrapActive: number; globalGuards: number };
  if (authBounds.loginGuards > 256 || authBounds.leases > 64 || authBounds.active > 4
    || authBounds.bootstrapActive > 1 || authBounds.globalGuards > 2) fail();

  const previewEvidenceRows = db.prepare(
    "SELECT evidence_json AS evidenceJson, evidence_fingerprint AS evidenceFingerprint FROM connector_import_preview_rows",
  ).all() as Array<{ readonly evidenceJson: unknown; readonly evidenceFingerprint: unknown }>;
  for (const row of previewEvidenceRows) parsedCanonical(row.evidenceJson, row.evidenceFingerprint);

  const projectionRows = db.prepare(
    `SELECT decision.id, decision.workspace_id AS workspaceId, decision.person_id AS personId,
            decision.decision_kind AS decisionKind,
            decision.previous_projection_json AS previousJson,
            decision.previous_projection_fingerprint AS previousFingerprint,
            decision.next_projection_json AS nextJson,
            decision.next_projection_fingerprint AS nextFingerprint,
            decision.created_at AS decisionCreatedAt,
            preview.disposition, preview.normalized_email AS normalizedEmail,
            preview.full_name AS fullName, preview.organization, preview.title,
            preview.candidate_person_fingerprint AS candidateFingerprint,
            preview.provider_record_id AS providerRecordId,
            run.id AS runId, run.state AS runState, run.connection_id AS connectionId,
            run.provider, run.confirmed_at AS confirmedAt,
            run.confirmed_by_account_id AS confirmedBy,
            source.id AS sourceId, source.provider AS sourceProvider, source.source_ref AS sourceRef,
            source_link.person_id AS linkedPersonId, actor.id AS actorId
       FROM person_projection_decisions decision
       LEFT JOIN connector_runs run
         ON run.id = decision.import_run_id AND run.workspace_id = decision.workspace_id
            AND run.operation = 'IMPORT'
       LEFT JOIN connector_import_preview_rows preview
         ON preview.id = decision.preview_row_id AND preview.workspace_id = decision.workspace_id
            AND preview.run_id = decision.import_run_id
       LEFT JOIN source_records source
         ON source.id = decision.source_record_id AND source.workspace_id = decision.workspace_id
       LEFT JOIN source_links source_link
         ON source_link.workspace_id = decision.workspace_id
            AND source_link.source_record_id = decision.source_record_id
            AND source_link.person_id = decision.person_id
       LEFT JOIN accounts actor
         ON actor.id = decision.confirmed_by_account_id AND actor.workspace_id = decision.workspace_id`,
  ).all() as Array<Record<string, unknown>>;
  for (const row of projectionRows) {
    if (!row.runId || row.runState !== "SUCCEEDED" || !row.sourceId || !row.linkedPersonId || !row.actorId
      || row.confirmedBy !== row.actorId || row.decisionCreatedAt !== row.confirmedAt
      || row.sourceProvider !== `connector.${String(row.provider)}`
      || row.sourceRef !== `${String(row.connectionId)}:${String(row.providerRecordId)}`) fail();
    const next = exactRecord(parsedCanonical(row.nextJson, row.nextFingerprint),
      ["schema", "id", "canonicalEmail", "fullName", "organization", "title"]);
    if (!next || next.schema !== "connector-person-projection/v1" || next.id !== row.personId
      || typeof next.canonicalEmail !== "string" || typeof next.fullName !== "string"
      || !(next.organization === null || typeof next.organization === "string")
      || !(next.title === null || typeof next.title === "string")) fail();
    const nextProjection = next as Record<string, unknown>;
    if (row.decisionKind === "CREATE_FROM_SOURCE") {
      if (row.disposition !== "CREATE" || row.previousJson !== null || row.previousFingerprint !== null
        || nextProjection.canonicalEmail !== row.normalizedEmail || nextProjection.fullName !== row.fullName
        || nextProjection.organization !== row.organization || nextProjection.title !== row.title) fail();
      continue;
    }
    if (row.decisionKind !== "UPDATE_FROM_SOURCE" || row.disposition !== "UPDATE") fail();
    const previous = exactRecord(parsedCanonical(row.previousJson, row.previousFingerprint),
      ["schema", "id", "canonicalEmail", "fullName", "organization", "title"]);
    if (!previous || previous.schema !== "connector-person-projection/v1" || previous.id !== row.personId
      || typeof previous.canonicalEmail !== "string" || typeof previous.fullName !== "string"
      || !(previous.organization === null || typeof previous.organization === "string")
      || !(previous.title === null || typeof previous.title === "string")) fail();
    const previousProjection = previous as Record<string, unknown>;
    const candidateFingerprint = fingerprintOf({
      schema: "connector-person-preview/v1",
      id: previousProjection.id,
      canonicalEmail: previousProjection.canonicalEmail,
      fullName: previousProjection.fullName,
      organization: previousProjection.organization,
      title: previousProjection.title,
    });
    if (candidateFingerprint !== row.candidateFingerprint
      || nextProjection.canonicalEmail !== row.normalizedEmail || nextProjection.fullName !== row.fullName
      || nextProjection.organization !== (row.organization ?? previousProjection.organization)
      || nextProjection.title !== (row.title ?? previousProjection.title)) fail();
  }

  const authorityRows = db.prepare(
    `SELECT authority.id, authority.workspace_id AS workspaceId,
            authority.connection_id AS connectionId, authority.provider,
            authority.person_id AS personId, authority.event_id AS eventId,
            authority.version, authority.purpose_evidence_json AS purposeJson,
            authority.purpose_evidence_fingerprint AS purposeFingerprint,
            authority.retention_evidence_json AS retentionJson,
            authority.retention_evidence_fingerprint AS retentionFingerprint,
            authority.authority_evidence_json AS authorityJson,
            authority.authority_evidence_fingerprint AS authorityFingerprint,
            connection.id AS scopedConnection, person.id AS scopedPerson, event_row.id AS scopedEvent
       FROM connector_export_authority_versions authority
       LEFT JOIN connector_connections connection
         ON connection.id = authority.connection_id AND connection.workspace_id = authority.workspace_id
            AND connection.provider = authority.provider
       LEFT JOIN people person
         ON person.id = authority.person_id AND person.workspace_id = authority.workspace_id
       LEFT JOIN events event_row
         ON event_row.id = authority.event_id AND event_row.workspace_id = authority.workspace_id
       ORDER BY authority.workspace_id, authority.connection_id, authority.person_id, authority.version`,
  ).all() as Array<Record<string, unknown>>;
  const authoritiesById = new Map<string, Record<string, unknown>>();
  const lastAuthorityVersion = new Map<string, number>();
  for (const row of authorityRows) {
    if (!row.scopedConnection || !row.scopedPerson || !row.scopedEvent || typeof row.id !== "string") fail();
    const purpose = record(parsedCanonical(row.purposeJson, row.purposeFingerprint));
    const retention = record(parsedCanonical(row.retentionJson, row.retentionFingerprint));
    const authority = record(parsedCanonical(row.authorityJson, row.authorityFingerprint));
    if (!purpose || !retention || !authority
      || purpose.schema !== "authority-purpose-evidence/v1"
      || retention.schema !== "authority-retention-evidence/v1"
      || authority.schema !== "authority-version-evidence/v1"
      || purpose.workspaceId !== row.workspaceId || retention.workspaceId !== row.workspaceId
      || authority.workspaceId !== row.workspaceId
      || purpose.eventId !== row.eventId || retention.eventId !== row.eventId
      || authority.eventId !== row.eventId
      || record(purpose.subject)?.kind !== "PERSON" || record(purpose.subject)?.id !== row.personId
      || record(retention.subject)?.kind !== "PERSON" || record(retention.subject)?.id !== row.personId) fail();
    try {
      createPurposeAuthorizationEvidence(purpose);
      createRetentionEvidence(retention);
      createAuthorityEvidence(authority);
    } catch {
      fail();
    }
    const key = `${String(row.workspaceId)}\0${String(row.connectionId)}\0${String(row.personId)}`;
    const expectedVersion = (lastAuthorityVersion.get(key) ?? 0) + 1;
    if (row.version !== expectedVersion) fail();
    lastAuthorityVersion.set(key, expectedVersion);
    authoritiesById.set(row.id as string, row);
  }

  const manifestRows = db.prepare(
    `SELECT manifest.run_id AS runId, manifest.workspace_id AS workspaceId,
            manifest.connection_id AS connectionId, manifest.connection_version AS connectionVersion,
            manifest.provider, manifest.total_person_count AS totalCount,
            manifest.candidate_count AS candidateCount, manifest.candidates_json AS candidatesJson,
            manifest.candidates_fingerprint AS candidatesFingerprint,
            run.input_fingerprint AS inputFingerprint
       FROM connector_export_manifests manifest
       LEFT JOIN connector_runs run
         ON run.id = manifest.run_id AND run.workspace_id = manifest.workspace_id
            AND run.connection_id = manifest.connection_id
            AND run.connection_version = manifest.connection_version
            AND run.provider = manifest.provider AND run.operation = 'EXPORT'`,
  ).all() as Array<Record<string, unknown>>;
  const manifestsByRun = new Map<string, { row: Record<string, unknown>; candidates: readonly unknown[] }>();
  for (const row of manifestRows) {
    if (typeof row.runId !== "string" || typeof row.provider !== "string") fail();
    const candidates = parsedCanonical(row.candidatesJson, row.candidatesFingerprint);
    if (!Array.isArray(candidates) || candidates.length !== row.candidateCount) fail();
    const candidateValues = candidates as unknown[];
    const expectedInput = fingerprintOf({
      schema: "connector-export/v1",
      provider: row.provider,
      connectionId: row.connectionId,
      connectionVersion: row.connectionVersion,
      totalCount: row.totalCount,
      candidates: candidateValues,
    });
    if (expectedInput !== row.inputFingerprint) fail();
    let previousPersonId: string | null = null;
    for (const candidateValue of candidateValues) {
      const candidate = exactRecord(candidateValue, ["person", "authority"]);
      const person = exactRecord(candidate?.person, ["personId", "fullName", "email", "organization", "title"]);
      const binding = record(candidate?.authority);
      if (!candidate || !person || !binding || typeof person.personId !== "string"
        || typeof person.fullName !== "string" || typeof person.email !== "string"
        || !(person.organization === null || typeof person.organization === "string")
        || !(person.title === null || typeof person.title === "string")
        || (previousPersonId !== null && previousPersonId >= person.personId)) fail();
      const candidatePerson = person as Record<string, unknown>;
      const authorityBinding = binding as Record<string, unknown>;
      previousPersonId = candidatePerson.personId as string;
      if (authorityBinding.state === "ABSENT") {
        if (!exactRecord(authorityBinding, ["state"])) fail();
      } else if (authorityBinding.state === "PRESENT") {
        if (!exactRecord(authorityBinding, [
          "state", "id", "eventId", "version", "purposeEvidenceFingerprint",
          "retentionEvidenceFingerprint", "authorityEvidenceFingerprint",
        ]) || typeof authorityBinding.id !== "string") fail();
        const authority = authoritiesById.get(authorityBinding.id as string);
        if (!authority || authority.workspaceId !== row.workspaceId
          || authority.connectionId !== row.connectionId || authority.provider !== row.provider
          || authority.personId !== candidatePerson.personId || authority.eventId !== authorityBinding.eventId
          || authority.version !== authorityBinding.version
          || authority.purposeFingerprint !== authorityBinding.purposeEvidenceFingerprint
          || authority.retentionFingerprint !== authorityBinding.retentionEvidenceFingerprint
          || authority.authorityFingerprint !== authorityBinding.authorityEvidenceFingerprint) fail();
      } else fail();
    }
    manifestsByRun.set(row.runId as string, { row, candidates: candidateValues });
  }

  const decisionRows = db.prepare(
    `SELECT decision.*, run.created_at AS runCreatedAt,
            run.created_by_account_id AS runActorId, run.state AS runState,
            authority.purpose_evidence_json AS storedPurposeJson,
            authority.retention_evidence_json AS storedRetentionJson,
            authority.authority_evidence_json AS storedAuthorityJson
       FROM connector_export_decisions decision
       LEFT JOIN connector_runs run
         ON run.id = decision.run_id AND run.workspace_id = decision.workspace_id
            AND run.connection_id = decision.connection_id
            AND run.connection_version = decision.connection_version
            AND run.provider = decision.provider AND run.operation = 'EXPORT'
       LEFT JOIN connector_export_authority_versions authority
         ON authority.id = decision.authority_version_id
            AND authority.workspace_id = decision.workspace_id
            AND authority.connection_id = decision.connection_id
            AND authority.provider = decision.provider
            AND authority.person_id = decision.person_id
       ORDER BY decision.workspace_id, decision.run_id, decision.person_id`,
  ).all() as Array<Record<string, unknown>>;
  const decisionsByRun = new Map<string, number>();
  for (const row of decisionRows) {
    if (typeof row.run_id !== "string" || typeof row.person_id !== "string" || !row.runCreatedAt) fail();
    const runId = row.run_id as string;
    const personId = row.person_id as string;
    const manifest = manifestsByRun.get(runId);
    if (!manifest) fail();
    const boundManifest = manifest as { row: Record<string, unknown>; candidates: readonly unknown[] };
    const projection = exactRecord(parsedCanonical(row.projection_json, row.projection_fingerprint),
      ["personId", "fullName", "email", "organization", "title"]);
    const factFamilies = parsedCanonical(row.fact_families_json, row.fact_families_fingerprint);
    const preflightInput = record(parsedCanonical(row.preflight_input_json, row.preflight_input_fingerprint));
    const preflightResult = record(parsedCanonical(row.preflight_result_json, row.preflight_result_fingerprint));
    if (!projection || !Array.isArray(factFamilies) || !preflightInput || !preflightResult
      || preflightResult.state !== row.decision_state
      || canonicalJson(preflightAuthorityPurpose(preflightInput)) !== row.preflight_result_json) fail();
    const validProjection = projection as Record<string, unknown>;
    const validPreflightInput = preflightInput as Record<string, unknown>;
    const validPreflightResult = preflightResult as Record<string, unknown>;
    const manifestCandidate = boundManifest.candidates.find((value) =>
      record(record(value)?.person)?.personId === personId);
    if (!manifestCandidate || canonicalJson(record(manifestCandidate)?.person) !== row.projection_json) fail();
    const command = record(validPreflightInput.command);
    const actor = record(validPreflightInput.actorEvidence);
    const identity = record(validPreflightInput.idempotencyEvidence);
    const subject = record(command?.subject);
    const expectedAction = `EXTERNAL_PROVIDER_EXPORT:${String(row.provider).toUpperCase()}:${
      createHash("sha256").update(String(row.connection_id)).digest("hex").slice(0, 32).toUpperCase()
    }:V${String(row.connection_version)}`;
    const expectedFacts = row.provider === "airtable"
      ? ["PERSON_EMAIL", "PERSON_FULL_NAME", "PERSON_ID", "PERSON_ORGANIZATION", "PERSON_TITLE"]
      : [
          "PERSON_EMAIL",
          "PERSON_FULL_NAME",
          ...(validProjection.organization === null ? [] : ["PERSON_ORGANIZATION"]),
          ...(validProjection.title === null ? [] : ["PERSON_TITLE"]),
        ].sort();
    const expectedPayload = fingerprintOf({
      schema: "connector-provider-person-projection/v1",
      provider: row.provider,
      connectionId: row.connection_id,
      connectionVersion: row.connection_version,
      person: validProjection,
    });
    if (!command || !actor || !identity || !subject
      || command.workspaceId !== row.workspace_id || command.eventId !== actor.eventId
      || subject.kind !== "PERSON" || subject.id !== row.person_id
      || command.actionFamily !== expectedAction || row.action_family !== expectedAction
      || canonicalJson(command.factFamilies) !== canonicalJson(expectedFacts)
      || canonicalJson(factFamilies) !== canonicalJson(expectedFacts)
      || command.payloadFingerprint !== expectedPayload || command.issuedAt !== row.runCreatedAt
      || actor.actorId !== row.runActorId || identity.actorId !== row.runActorId
      || validPreflightInput.now !== row.created_at || validPreflightResult.checkedAt !== row.created_at) fail();
    if (row.authority_version_id === null) {
      if (row.decision_state === "READY") fail();
    } else {
      if (!row.storedPurposeJson || !row.storedRetentionJson || !row.storedAuthorityJson
        || canonicalJson(validPreflightInput.purposeEvidence) !== row.storedPurposeJson
        || canonicalJson(validPreflightInput.retentionEvidence) !== row.storedRetentionJson
        || canonicalJson(validPreflightInput.authorityEvidence) !== row.storedAuthorityJson) fail();
    }
    decisionsByRun.set(runId, (decisionsByRun.get(runId) ?? 0) + 1);
  }

  const exportRuns = db.prepare(
    `SELECT run.id, run.state, run.error_code AS errorCode, run.item_count AS itemCount,
            manifest.candidate_count AS candidateCount,
            (SELECT COUNT(*) FROM connector_export_receipts receipt
             WHERE receipt.workspace_id = run.workspace_id AND receipt.run_id = run.id) AS receiptCount,
            (SELECT COUNT(*) FROM connector_export_decisions decision
             WHERE decision.workspace_id = run.workspace_id AND decision.run_id = run.id
               AND decision.decision_state != 'READY') AS deniedCount
       FROM connector_runs run
       LEFT JOIN connector_export_manifests manifest
         ON manifest.run_id = run.id AND manifest.workspace_id = run.workspace_id
       WHERE run.operation = 'EXPORT'`,
  ).all() as Array<{
    id: string;
    state: string;
    errorCode: string | null;
    itemCount: number;
    candidateCount: number | null;
    receiptCount: number;
    deniedCount: number;
  }>;
  for (const run of exportRuns) {
    const decisionCount = decisionsByRun.get(run.id) ?? 0;
    if (run.state === "SUCCEEDED" && (run.candidateCount === null
      || decisionCount !== run.candidateCount || run.deniedCount !== 0
      || run.receiptCount !== run.candidateCount || run.itemCount !== run.receiptCount)) fail();
    if (run.errorCode === "EXPORT_PURPOSE_AUTHORIZATION_DENIED" && (
      run.candidateCount === null || decisionCount !== run.candidateCount || run.deniedCount < 1
      || run.receiptCount !== 0 || run.itemCount !== 0
    )) fail();
    if (run.deniedCount > 0 && run.errorCode !== "EXPORT_PURPOSE_AUTHORIZATION_DENIED") fail();
  }
}

function columnsOnlySchemaManifest(db: Db): readonly {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
  readonly columns: readonly ColumnDescriptor[] | null;
}[] {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name, tableName`,
    )
    .all() as Array<{
    type: string;
    name: string;
    tableName: string;
    sql: string | null;
  }>;

  return objects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: object.sql,
    columns: object.type === "table" ? readTableColumns(db, object.name) : null,
  }));
}

function readSchemaManifest(db: Db): SchemaManifest {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name, tableName`,
    )
    .all() as Array<{
    type: string;
    name: string;
    tableName: string;
    sql: string | null;
  }>;

  return objects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: object.sql,
    columns: object.type === "table" ? readTableColumns(db, object.name) : null,
    foreignKeys: object.type === "table" ? readTableForeignKeys(db, object.name) : null,
    indexColumns: object.type === "index" ? readIndexColumns(db, object.name) : null,
  }));
}

function readTableColumns(db: Db, tableName: string): ColumnDescriptor[] {
  const quoted = `"${tableName.replaceAll('"', '""')}"`;
  const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  return columns.map((column) => ({
    cid: column.cid,
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    defaultValue: column.dflt_value,
    primaryKey: column.pk,
  }));
}

function readTableForeignKeys(db: Db, tableName: string): ForeignKeyDescriptor[] {
  const quoted = `"${tableName.replaceAll('"', '""')}"`;
  const fks = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }>;
  return fks.map((fk) => ({
    id: fk.id,
    sequence: fk.seq,
    tableName: fk.table,
    from: fk.from,
    to: fk.to,
    onUpdate: fk.on_update,
    onDelete: fk.on_delete,
    match: fk.match,
  }));
}

function readIndexColumns(db: Db, indexName: string): IndexColumnDescriptor[] {
  const quoted = `"${indexName.replaceAll('"', '""')}"`;
  const cols = db.prepare(`PRAGMA index_info(${quoted})`).all() as Array<{
    seqno: number;
    cid: number;
    name: string | null;
  }>;
  return cols.map((col) => ({
    sequence: col.seqno,
    columnId: col.cid,
    columnName: col.name,
  }));
}

function manifestDigest(manifest: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function validateArtifactRecordIntegrity(db: Db): void {
  const malformed = db.prepare(
    `SELECT 1
     FROM artifact_records record
     WHERE record.artifact_schema <> 'sympose-artifact-record/v1'
        OR record.storage_provider <> 'local'
        OR record.kind NOT IN ('HEADSHOT', 'SLIDES')
        OR length(record.id) <> 64
        OR record.id GLOB '*[^0-9a-f]*'
        OR record.version < 1
        OR length(record.storage_id) <> 64
        OR record.storage_id GLOB '*[^0-9a-f]*'
        OR record.storage_filename <> record.storage_id || '.bin'
        OR record.storage_filename LIKE '%/%'
        OR record.storage_filename LIKE '%\\%'
        OR length(record.sha256) <> 64
        OR record.sha256 GLOB '*[^0-9a-f]*'
        OR ((record.kind = 'HEADSHOT' AND (record.size_bytes NOT BETWEEN 1 AND 8388608 OR record.media_type <> 'image/png' OR lower(record.display_filename) NOT LIKE '%.png'))
         OR (record.kind = 'SLIDES' AND (record.size_bytes NOT BETWEEN 1 AND 26214400 OR record.media_type <> 'application/pdf' OR lower(record.display_filename) NOT LIKE '%.pdf')))
        OR length(CAST(record.display_filename AS BLOB)) NOT BETWEEN 1 AND 180
        OR record.display_filename LIKE '%/%'
        OR record.display_filename LIKE '%\\%'
        OR record.display_filename GLOB '*[' || char(0) || '-' || char(31) || ']*'
        OR length(CAST(record.created_at AS BLOB)) NOT BETWEEN 1 AND 128
        OR NOT EXISTS (SELECT 1 FROM events event_row WHERE event_row.id = record.event_id AND event_row.workspace_id = record.workspace_id)
        OR NOT EXISTS (SELECT 1 FROM people person_row WHERE person_row.id = record.person_id AND person_row.workspace_id = record.workspace_id)
        OR (SELECT COUNT(*) FROM event_speakers accepted_speaker
            WHERE accepted_speaker.workspace_id = record.workspace_id
              AND accepted_speaker.event_id = record.event_id
              AND accepted_speaker.person_id = record.person_id
              AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
              AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) <> 1
        OR NOT EXISTS (
          SELECT 1 FROM speaker_tasks task
          WHERE task.id = record.task_id
            AND task.workspace_id = record.workspace_id
            AND task.event_id = record.event_id
            AND task.person_id = record.person_id
            AND task.task_kind = record.kind
            AND task.content_kind = record.kind
            AND task.owner = 'SPEAKER'
        )
        OR NOT EXISTS (
          SELECT 1 FROM speaker_content_versions version
          WHERE version.id = record.content_version_id
            AND version.workspace_id = record.workspace_id
            AND version.event_id = record.event_id
            AND version.person_id = record.person_id
            AND version.task_id = record.task_id
            AND version.kind = record.kind
            AND version.version = record.version
            AND version.submitted_by = record.person_id
            AND version.submitted_by_kind = 'speaker'
            AND version.source = 'local-artifact-store'
            AND sympose_pd01_canonical_json(version.payload_json) IS version.payload_json
            AND sympose_pd01_fingerprint(version.payload_json) IS version.content_hash
            AND sympose_pd01_canonical_json(json_object(
              'asset', json_object(
                'assetId', json_extract(version.payload_json, '$.asset.assetId'),
                'byteSize', json_extract(version.payload_json, '$.asset.byteSize'),
                'checksum', json_extract(version.payload_json, '$.asset.checksum'),
                'fileName', json_extract(version.payload_json, '$.asset.fileName'),
                'mediaType', json_extract(version.payload_json, '$.asset.mediaType'),
                'storageRef', json_extract(version.payload_json, '$.asset.storageRef')),
              'kind', json_extract(version.payload_json, '$.kind'))) IS version.payload_json
            AND json_extract(version.payload_json, '$.kind') = record.kind
            AND json_extract(version.payload_json, '$.asset.assetId') = record.id
            AND json_extract(version.payload_json, '$.asset.fileName') = record.display_filename
            AND json_extract(version.payload_json, '$.asset.mediaType') = record.media_type
            AND json_extract(version.payload_json, '$.asset.byteSize') = record.size_bytes
            AND json_extract(version.payload_json, '$.asset.checksum') = record.sha256
            AND json_extract(version.payload_json, '$.asset.storageRef') = 'synthetic://artifact/' || record.id
            AND ((record.version = 1 AND version.supersedes_version_id IS NULL)
              OR (record.version > 1 AND version.supersedes_version_id = (
                SELECT prior.content_version_id FROM artifact_records prior WHERE prior.id = record.supersedes_record_id
              )))
        )
        OR NOT EXISTS (
          SELECT 1 FROM domain_events authority
          WHERE authority.id = record.authority_event_id
            AND authority.workspace_id = record.workspace_id
            AND authority.event_type = 'speaker.artifact.submitted'
            AND authority.aggregate_type = 'speaker_task'
            AND authority.aggregate_id = record.task_id
            AND sympose_pd01_canonical_json(authority.payload_json) IS authority.payload_json
            AND sympose_pd01_fingerprint(authority.payload_json) IS authority.payload_fingerprint
            AND json_extract(authority.payload_json, '$.schema') = 'speaker-artifact-submission/v1'
            AND json_extract(authority.payload_json, '$.artifactId') = record.id
            AND json_extract(authority.payload_json, '$.workspaceId') = record.workspace_id
            AND json_extract(authority.payload_json, '$.eventId') = record.event_id
            AND json_extract(authority.payload_json, '$.personId') = record.person_id
            AND json_extract(authority.payload_json, '$.taskId') = record.task_id
            AND json_extract(authority.payload_json, '$.kind') = record.kind
            AND json_extract(authority.payload_json, '$.version') = record.version
            AND json_extract(authority.payload_json, '$.storageId') = record.storage_id
            AND json_extract(authority.payload_json, '$.storageFilename') = record.storage_filename
            AND json_extract(authority.payload_json, '$.sha256') = record.sha256
            AND json_extract(authority.payload_json, '$.byteSize') = record.size_bytes
            AND json_extract(authority.payload_json, '$.mediaType') = record.media_type
            AND json_extract(authority.payload_json, '$.displayFilename') = record.display_filename
            AND json_extract(authority.payload_json, '$.contentVersionId') = record.content_version_id
            AND json_extract(authority.payload_json, '$.contentVersionHash') = (
              SELECT version.content_hash FROM speaker_content_versions version WHERE version.id = record.content_version_id)
        )
        OR NOT EXISTS (
          SELECT 1 FROM artifact_upload_intents intent
          WHERE intent.artifact_id = record.id
            AND intent.workspace_id = record.workspace_id
            AND intent.event_id = record.event_id
            AND intent.person_id = record.person_id
            AND intent.task_id = record.task_id
            AND intent.kind = record.kind
            AND intent.storage_id = record.storage_id
            AND intent.storage_filename = record.storage_filename
            AND intent.content_version_id = record.content_version_id
            AND intent.status = 'COMMITTED'
        )
     LIMIT 1`,
  ).get();
  if (malformed) throw new Error("artifact record integrity check failed");

  const malformedIntents = db.prepare(
    `SELECT 1
     FROM artifact_upload_intents intent
     WHERE intent.intent_schema <> 'sympose-artifact-upload-intent/v1'
        OR intent.kind NOT IN ('HEADSHOT', 'SLIDES')
        OR length(intent.artifact_id) <> 64
        OR intent.artifact_id GLOB '*[^0-9a-f]*'
        OR length(intent.storage_id) <> 64
        OR intent.storage_id GLOB '*[^0-9a-f]*'
        OR intent.storage_filename <> intent.storage_id || '.bin'
        OR intent.storage_filename LIKE '%/%'
        OR intent.storage_filename LIKE '%\\%'
        OR intent.version < 1
        OR length(intent.sha256) <> 64
        OR intent.sha256 GLOB '*[^0-9a-f]*'
        OR ((intent.kind = 'HEADSHOT' AND (intent.size_bytes NOT BETWEEN 1 AND 8388608 OR intent.media_type <> 'image/png' OR lower(intent.display_filename) NOT LIKE '%.png'))
         OR (intent.kind = 'SLIDES' AND (intent.size_bytes NOT BETWEEN 1 AND 26214400 OR intent.media_type <> 'application/pdf' OR lower(intent.display_filename) NOT LIKE '%.pdf')))
        OR length(CAST(intent.display_filename AS BLOB)) NOT BETWEEN 1 AND 180
        OR intent.display_filename LIKE '%/%'
        OR intent.display_filename LIKE '%\\%'
        OR intent.display_filename GLOB '*[' || char(0) || '-' || char(31) || ']*'
        OR intent.status NOT IN ('PREPARED', 'COMMITTED', 'ABORTED')
        OR (intent.status = 'COMMITTED' AND intent.committed_at IS NULL)
        OR (intent.status = 'ABORTED' AND intent.committed_at IS NOT NULL)
        OR (intent.status = 'COMMITTED' AND NOT EXISTS (
          SELECT 1 FROM artifact_records record
          WHERE record.id = intent.artifact_id
            AND record.workspace_id = intent.workspace_id
            AND record.event_id = intent.event_id
            AND record.person_id = intent.person_id
            AND record.task_id = intent.task_id
            AND record.kind = intent.kind
            AND record.storage_id = intent.storage_id
            AND record.storage_filename = intent.storage_filename
            AND record.content_version_id = intent.content_version_id
        ))
        OR sympose_pd01_canonical_json(intent.content_payload_json) IS NOT intent.content_payload_json
        OR sympose_pd01_canonical_json(json_object(
          'asset', json_object(
            'assetId', json_extract(intent.content_payload_json, '$.asset.assetId'),
            'byteSize', json_extract(intent.content_payload_json, '$.asset.byteSize'),
            'checksum', json_extract(intent.content_payload_json, '$.asset.checksum'),
            'fileName', json_extract(intent.content_payload_json, '$.asset.fileName'),
            'mediaType', json_extract(intent.content_payload_json, '$.asset.mediaType'),
            'storageRef', json_extract(intent.content_payload_json, '$.asset.storageRef')),
          'kind', json_extract(intent.content_payload_json, '$.kind'))) IS NOT intent.content_payload_json
        OR json_extract(intent.content_payload_json, '$.kind') IS NOT intent.kind
        OR json_extract(intent.content_payload_json, '$.asset.assetId') IS NOT intent.artifact_id
        OR json_extract(intent.content_payload_json, '$.asset.fileName') IS NOT intent.display_filename
        OR json_extract(intent.content_payload_json, '$.asset.mediaType') IS NOT intent.media_type
        OR json_extract(intent.content_payload_json, '$.asset.byteSize') IS NOT intent.size_bytes
        OR json_extract(intent.content_payload_json, '$.asset.checksum') IS NOT intent.sha256
        OR json_extract(intent.content_payload_json, '$.asset.storageRef') IS NOT ('synthetic://artifact/' || intent.artifact_id)
        OR NOT EXISTS (
          SELECT 1 FROM speaker_tasks task
          WHERE task.id = intent.task_id
            AND task.workspace_id = intent.workspace_id
            AND task.event_id = intent.event_id
            AND task.person_id = intent.person_id
            AND task.content_kind = intent.kind
        )
        OR (SELECT COUNT(*) FROM event_speakers accepted_speaker
            WHERE accepted_speaker.workspace_id = intent.workspace_id
              AND accepted_speaker.event_id = intent.event_id
              AND accepted_speaker.person_id = intent.person_id
              AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
              AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) <> 1
     LIMIT 1`,
  ).get();
  if (malformedIntents) throw new Error("artifact upload intent integrity check failed");

  const brokenLineage = db.prepare(
    `SELECT 1
     FROM artifact_records record
     WHERE (record.version = 1 AND record.supersedes_record_id IS NOT NULL)
        OR (record.version > 1 AND NOT EXISTS (
          SELECT 1
          FROM artifact_records prior
          WHERE prior.id = record.supersedes_record_id
            AND prior.workspace_id = record.workspace_id
            AND prior.event_id = record.event_id
            AND prior.person_id = record.person_id
            AND prior.task_id = record.task_id
            AND prior.kind = record.kind
            AND prior.version = record.version - 1
        ))
     LIMIT 1`,
  ).get();
  if (brokenLineage) throw new Error("artifact record lineage integrity check failed");

  const malformedReviews = db.prepare(
    `SELECT 1
     FROM speaker_content_reviews review
     WHERE review.review_state NOT IN ('APPROVED', 'CHANGES_REQUESTED', 'BLOCKED')
        OR review.gate NOT IN ('CONFIRMATION', 'PUBLICATION', 'OPERATOR_RELEASE')
        OR NOT EXISTS (
          SELECT 1 FROM speaker_content_versions version
          WHERE version.id = review.submission_version_id
            AND version.workspace_id = review.workspace_id
            AND version.event_id = review.event_id
            AND version.person_id = review.person_id
            AND version.task_id = review.task_id
            AND version.content_hash = review.submission_content_hash
        )
     LIMIT 1`,
  ).get();
  if (malformedReviews) throw new Error("artifact content review integrity check failed");

  const malformedBindings = db.prepare(
    `SELECT 1
     FROM speaker_artifact_release_bindings binding
     WHERE length(binding.content_hash) <> 64
        OR binding.content_hash GLOB '*[^0-9a-f]*'
        OR NOT EXISTS (
          SELECT 1 FROM publication_releases release_row
          WHERE release_row.id = binding.release_id
            AND release_row.workspace_id = binding.workspace_id
            AND release_row.event_id = binding.event_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM artifact_records artifact
          WHERE artifact.id = binding.artifact_id
            AND artifact.workspace_id = binding.workspace_id
            AND artifact.event_id = binding.event_id
            AND artifact.person_id = binding.person_id
            AND artifact.kind = 'HEADSHOT'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM artifact_records artifact
          JOIN speaker_content_versions version ON version.id = artifact.content_version_id
          JOIN speaker_content_reviews review
            ON review.submission_version_id = version.id
           AND review.workspace_id = version.workspace_id
           AND review.review_state = 'APPROVED'
           AND review.gate = 'PUBLICATION'
           AND review.submission_content_hash = version.content_hash
          WHERE artifact.id = binding.artifact_id
            AND version.content_hash = binding.content_hash
        )
        OR NOT EXISTS (
          SELECT 1
          FROM publication_releases release_row, json_each(release_row.content_json, '$.accepted') accepted
          WHERE release_row.id = binding.release_id
            AND release_row.workspace_id = binding.workspace_id
            AND release_row.event_id = binding.event_id
            AND json_extract(release_row.content_json, '$.schema') = 'publication-release/v2'
            AND json_extract(accepted.value, '$.personId') = binding.person_id
        )
     LIMIT 1`,
  ).get();
  if (malformedBindings) throw new Error("artifact release binding integrity check failed");
}

function validateReviewRoundScheduleIntegrity(db: Db): void {
  const missing = db.prepare(
    `SELECT 1
     FROM review_rounds round
     WHERE NOT EXISTS (
       SELECT 1
       FROM review_round_schedule_versions schedule
       WHERE schedule.workspace_id = round.workspace_id
         AND schedule.event_id = round.event_id
         AND schedule.round_id = round.id
     )
     LIMIT 1`,
  ).get();
  const malformed = db.prepare(
    `SELECT 1
     FROM review_round_schedule_versions schedule
     LEFT JOIN review_rounds round
       ON round.id = schedule.round_id
      AND round.workspace_id = schedule.workspace_id
      AND round.event_id = schedule.event_id
     LEFT JOIN calls call
       ON call.id = round.call_id
      AND call.workspace_id = round.workspace_id
      AND call.event_id = round.event_id
     LEFT JOIN accounts actor
       ON actor.id = schedule.actor_account_id
      AND actor.workspace_id = schedule.workspace_id
     WHERE round.id IS NULL
        OR call.id IS NULL
        OR actor.id IS NULL
        OR sympose_is_iana_timezone(schedule.timezone) != 1
        OR sympose_canonical_timestamp(schedule.opens_at) IS NOT schedule.opens_at
        OR sympose_canonical_timestamp(schedule.closes_at) IS NOT schedule.closes_at
        OR sympose_canonical_timestamp(schedule.created_at) IS NOT schedule.created_at
        OR schedule.opens_at >= schedule.closes_at
        OR schedule.version_number != schedule.expected_previous_version + 1
        OR schedule.created_at < round.created_at
        OR (schedule.version_number = 1 AND schedule.source != 'CALL_BACKFILL')
        OR (schedule.version_number > 1 AND schedule.source != 'ORGANIZER_INPUT')
        OR (schedule.version_number > 1 AND NOT EXISTS (
          SELECT 1
          FROM review_round_schedule_versions prior
          WHERE prior.workspace_id = schedule.workspace_id
            AND prior.event_id = schedule.event_id
            AND prior.round_id = schedule.round_id
            AND prior.version_number = schedule.version_number - 1
            AND prior.timezone = schedule.timezone
            AND prior.created_at <= schedule.created_at
        ))
     LIMIT 1`,
  ).get();
  if (missing || malformed) {
    throw new Error("malformed review-round schedule history");
  }
  const malformedCreationReceipt = db.prepare(
    `SELECT 1 FROM review_round_creation_receipts receipt
     LEFT JOIN review_rounds round ON round.id = receipt.round_id
       AND round.workspace_id = receipt.workspace_id AND round.event_id = receipt.event_id
       AND round.call_id = receipt.call_id AND round.created_by = receipt.actor_account_id
     LEFT JOIN review_round_schedule_versions schedule ON schedule.round_id = receipt.round_id
       AND schedule.workspace_id = receipt.workspace_id AND schedule.event_id = receipt.event_id
       AND schedule.version_number = receipt.schedule_version
     WHERE round.id IS NULL OR schedule.round_id IS NULL
        OR schedule.timezone IS NOT receipt.timezone
        OR schedule.opens_at IS NOT receipt.opens_at
        OR schedule.closes_at IS NOT receipt.closes_at
        OR sympose_is_iana_timezone(receipt.timezone) != 1
        OR sympose_canonical_timestamp(receipt.opens_at) IS NOT receipt.opens_at
        OR sympose_canonical_timestamp(receipt.closes_at) IS NOT receipt.closes_at
        OR sympose_canonical_timestamp(receipt.created_at) IS NOT receipt.created_at
        OR receipt.request_schema != 'cfp-review-round-create-request/v1'
        OR length(receipt.request_fingerprint) != 64
        OR receipt.request_fingerprint GLOB '*[^0-9a-f]*'
     LIMIT 1`,
  ).get();
  if (malformedCreationReceipt) throw new Error("malformed review-round creation receipt");
}

function validateStoredJsonBounds(db: Db, includeTrustedReview = true): void {
  const oversizedPolicy = db
    .prepare(
      `SELECT 1
       FROM calls
       WHERE typeof(policy_json) <> 'text'
          OR length(CAST(policy_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(POLICY_JSON_MAX_BYTES);
  if (oversizedPolicy) {
    throw new Error("malformed schema v3: stored call policy JSON exceeds its raw bound");
  }

  const oversizedRevision = db
    .prepare(
      `SELECT 1
       FROM submission_revisions
       WHERE typeof(revision_json) <> 'text'
          OR length(CAST(revision_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(JSON_MAX_BYTES);
  if (oversizedRevision) {
    throw new Error("malformed schema v3: stored submission revision JSON exceeds its raw bound");
  }

  const oversizedRubric = db
    .prepare(
      `SELECT 1
       FROM rubric_versions
       WHERE typeof(rubric_json) <> 'text'
          OR length(CAST(rubric_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(JSON_MAX_BYTES);
  if (oversizedRubric) {
    throw new Error("malformed schema v4: stored rubric JSON exceeds its raw bound");
  }

  const oversizedEvaluation = db
    .prepare(
      `SELECT 1
       FROM review_revisions
       WHERE typeof(evaluation_json) <> 'text'
          OR length(CAST(evaluation_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(JSON_MAX_BYTES);
  if (oversizedEvaluation) {
    throw new Error("malformed schema v4: stored evaluation JSON exceeds its raw bound");
  }

  if (!includeTrustedReview) {
    return;
  }

  const oversizedSemantics = db
    .prepare(
      `SELECT 1
       FROM review_rubric_semantics
       WHERE typeof(semantics_json) <> 'text'
          OR length(CAST(semantics_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(POLICY_JSON_MAX_BYTES);
  const oversizedArtifact = db
    .prepare(
      `SELECT 1
       FROM review_blind_artifacts
       WHERE typeof(artifact_json) <> 'text'
          OR length(CAST(artifact_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(JSON_MAX_BYTES);
  const oversizedReceipt = db
    .prepare(
      `SELECT 1
       FROM review_command_receipts
       WHERE typeof(receipt_json) <> 'text'
          OR length(CAST(receipt_json AS BLOB)) > ?
       LIMIT 1`,
    )
    .get(RECEIPT_JSON_MAX_BYTES);
  if (oversizedSemantics || oversizedArtifact || oversizedReceipt) {
    throw new Error("malformed schema v5: stored trusted review JSON exceeds its raw bound");
  }
}

function jsonDepthExceeds(value: unknown, maximum: number): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > maximum) {
      return true;
    }
    if (current.value !== null && typeof current.value === "object") {
      if (Array.isArray(current.value)) {
        for (const child of current.value) {
          pending.push({ value: child, depth: current.depth + 1 });
        }
      } else {
        for (const child of Object.values(current.value)) {
          pending.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
  }
  return false;
}

function validateStoredJsonDepths(db: Db, includeTrustedReview = true): void {
  const policies = db.prepare("SELECT policy_json FROM calls").all() as Array<{ policy_json: unknown }>;
  const revisions = db
    .prepare("SELECT revision_json FROM submission_revisions")
    .all() as Array<{ revision_json: unknown }>;
  const rubrics = db.prepare("SELECT rubric_json FROM rubric_versions").all() as Array<{ rubric_json: unknown }>;
  const evaluations = db
    .prepare("SELECT evaluation_json FROM review_revisions")
    .all() as Array<{ evaluation_json: unknown }>;
  const trustedReviewDocuments = includeTrustedReview
    ? [
        ...(db.prepare("SELECT semantics_json AS document FROM review_rubric_semantics").all() as Array<{
          document: unknown;
        }>),
        ...(db.prepare("SELECT artifact_json AS document FROM review_blind_artifacts").all() as Array<{
          document: unknown;
        }>),
        ...(db.prepare("SELECT receipt_json AS document FROM review_command_receipts").all() as Array<{
          document: unknown;
        }>),
      ]
    : [];
  const jsonValues = [
    ...policies.map((row) => row.policy_json),
    ...revisions.map((row) => row.revision_json),
    ...rubrics.map((row) => row.rubric_json),
    ...evaluations.map((row) => row.evaluation_json),
    ...trustedReviewDocuments.map((row) => row.document),
  ];
  for (const jsonValue of jsonValues) {
    if (typeof jsonValue !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonValue) as unknown;
      if (jsonDepthExceeds(parsed, 32)) {
        throw new Error("malformed schema: stored JSON exceeds its structural depth");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("structural depth")) {
        throw error;
      }
    }
  }
}

function validateTrustedReviewDocuments(db: Db): void {
  const documents = [
    ...(db
      .prepare("SELECT semantics_json AS document, fingerprint FROM review_rubric_semantics")
      .all() as Array<{ document: unknown; fingerprint: unknown }>),
    ...(db
      .prepare("SELECT artifact_json AS document, fingerprint FROM review_blind_artifacts")
      .all() as Array<{ document: unknown; fingerprint: unknown }>),
    ...(db
      .prepare("SELECT receipt_json AS document, receipt_fingerprint AS fingerprint FROM review_command_receipts")
      .all() as Array<{ document: unknown; fingerprint: unknown }>),
  ];

  for (const row of documents) {
    if (typeof row.document !== "string" || typeof row.fingerprint !== "string") {
      throw new Error("database trusted review document integrity check failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.document) as unknown;
    } catch {
      throw new Error("database trusted review document integrity check failed");
    }
    if (canonicalJson(parsed) !== row.document || fingerprintOf(parsed) !== row.fingerprint) {
      throw new Error("database trusted review document integrity check failed");
    }
  }
}

const PD01_JSON_MAX_BYTES = 524288;

function validateV9ContextDocument(db: Db, row: any): any {
  const fail = (): never => { throw new Error("database PD-01 V9 context integrity check failed"); };
  const schemas: Record<string,string> = { ADVOCACY_POLICY:"pd01-advocacy-policy/v1", VISIBILITY:"pd01-visibility-snapshot/v1", BLINDNESS:"pd01-blindness-policy/v1", SELECTION_CONTEXT:"pd01-selection-context/v1" };
  const fields: Record<string,string[]> = { ADVOCACY_POLICY:["schema","maximumEntries","eligibleRevisions"], VISIBILITY:["schema","visibleRevisions"], BLINDNESS:["schema","disclosureStage","organizerAdvocacyAggregationPermitted"], SELECTION_CONTEXT:["schema","decisionBoundary","resolvedRevisions"] };
  let document: any; try { document=JSON.parse(row.context_json); } catch { fail(); }
  if (row.context_schema!==schemas[row.context_kind] || row.fingerprint_algorithm!=="sha256-canonical-json-v1" || !document || Array.isArray(document)
    || Object.keys(document).sort().join("\0")!==fields[row.context_kind]?.slice().sort().join("\0") || document.schema!==row.context_schema
    || canonicalJson(document)!==row.context_json || fingerprintOf(document)!==row.fingerprint) fail();
  const tuples = row.context_kind==="ADVOCACY_POLICY" ? document.eligibleRevisions : row.context_kind==="VISIBILITY" ? document.visibleRevisions : row.context_kind==="SELECTION_CONTEXT" ? document.resolvedRevisions : null;
  if (row.context_kind==="ADVOCACY_POLICY" && (!Number.isSafeInteger(document.maximumEntries) || document.maximumEntries<1)) fail();
  if (row.context_kind==="BLINDNESS" && (document.disclosureStage!=="BLIND_REVIEW" || typeof document.organizerAdvocacyAggregationPermitted!=="boolean")) fail();
  if (row.context_kind==="SELECTION_CONTEXT" && (typeof document.decisionBoundary!=="string" || Buffer.byteLength(document.decisionBoundary,"utf8")<1 || Buffer.byteLength(document.decisionBoundary,"utf8")>256)) fail();
  if (tuples !== null) {
    if (!Array.isArray(tuples)) fail();
    const seen=new Set<string>();
    for (const tuple of tuples) {
      if (!tuple || Array.isArray(tuple) || Object.keys(tuple).sort().join("\0")!==["submissionId","submissionRevisionId","submissionRevisionFingerprint"].sort().join("\0")
        || typeof tuple.submissionId!=="string" || typeof tuple.submissionRevisionId!=="string" || typeof tuple.submissionRevisionFingerprint!=="string" || !/^[0-9a-f]{64}$/u.test(tuple.submissionRevisionFingerprint)) fail();
      const key=JSON.stringify([tuple.submissionId,tuple.submissionRevisionId,tuple.submissionRevisionFingerprint]); if(seen.has(key)) fail(); seen.add(key);
      const match=db.prepare("SELECT s.workspace_id,s.event_id,r.fingerprint FROM submissions s JOIN submission_revisions r ON r.id=? AND r.submission_id=s.id WHERE s.id=?").get(tuple.submissionRevisionId,tuple.submissionId) as any;
      if(!match || match.workspace_id!==row.workspace_id || match.event_id!==row.event_id || match.fingerprint!==tuple.submissionRevisionFingerprint) fail();
    }
  }
  return document;
}

function validatePd01V9(db: Db): void {
  const fail = (): never => { throw new Error("database PD-01 V9 identity/context integrity check failed"); };
  const validId = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 128 && !value.includes("\0");
  const validInstant = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  };
  const rows = <T>(sql: string, ...params: any[]): T[] => db.prepare(sql).all(...params) as T[];
  const bindings = rows<{ id:string; workspace_id:string; account_id:string; person_id:string; bound_by_account_id:string; binding_basis:string; created_at:string; fingerprint_algorithm:string; fingerprint:string }>("SELECT * FROM account_person_bindings");
  for (const b of bindings) {
    const accounts = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id=? AND id=?").get(b.workspace_id,b.account_id) as {n:number};
    const binder = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id=? AND id=?").get(b.workspace_id,b.bound_by_account_id) as {n:number};
    const person = db.prepare("SELECT 1 FROM people WHERE workspace_id=? AND id=?").get(b.workspace_id,b.person_id);
    if (!validId(b.id) || !validInstant(b.created_at) || typeof b.binding_basis !== "string" || Buffer.byteLength(b.binding_basis,"utf8")<1 || Buffer.byteLength(b.binding_basis,"utf8")>256 || accounts.n !== 1 || binder.n !== 1 || !person || b.fingerprint_algorithm !== "sha256-canonical-json-v1" || b.fingerprint !== fingerprintOf({schema:"pd01-account-person-binding/v1",workspaceId:b.workspace_id,accountId:b.account_id,personId:b.person_id,boundByAccountId:b.bound_by_account_id,bindingBasis:b.binding_basis,createdAt:b.created_at})) fail();
  }
  const assignments = rows<any>("SELECT * FROM event_reviewer_assignments");
  for (const a of assignments) {
    const b = db.prepare("SELECT * FROM account_person_bindings WHERE id=?").get(a.account_person_binding_id) as any;
    const event = db.prepare("SELECT 1 FROM events WHERE id=? AND workspace_id=?").get(a.event_id,a.workspace_id);
    const issuer = db.prepare("SELECT workspace_id FROM accounts WHERE id=?").get(a.assigned_by_account_id) as any;
    if (!validId(a.id) || !validInstant(a.created_at) || !b || b.workspace_id!==a.workspace_id || b.account_id!==a.reviewer_account_id || b.person_id!==a.reviewer_person_id || !event || !issuer || issuer.workspace_id!==a.workspace_id || a.fingerprint_algorithm !== "sha256-canonical-json-v1" || a.fingerprint!==fingerprintOf({schema:"pd01-event-reviewer-assignment/v1",workspaceId:a.workspace_id,eventId:a.event_id,reviewerAccountId:a.reviewer_account_id,reviewerPersonId:a.reviewer_person_id,accountPersonBindingId:a.account_person_binding_id,assignedByAccountId:a.assigned_by_account_id,createdAt:a.created_at})) fail();
  }
  const states = rows<any>("SELECT * FROM event_reviewer_assignment_states ORDER BY event_reviewer_assignment_id, sequence_number");
  const stateLast = new Map<string, any>();
  for (const s of states) { const prior=stateLast.get(s.event_reviewer_assignment_id); const assignment=db.prepare("SELECT event_id,workspace_id FROM event_reviewer_assignments WHERE id=?").get(s.event_reviewer_assignment_id) as any; const actor=db.prepare("SELECT workspace_id FROM accounts WHERE id=?").get(s.actor_account_id) as any; if (!validId(s.id) || !validInstant(s.created_at) || (s.reason !== null && (typeof s.reason !== "string" || Buffer.byteLength(s.reason,"utf8")<1 || Buffer.byteLength(s.reason,"utf8")>1024)) || !assignment || assignment.workspace_id!==s.workspace_id || assignment.event_id!==s.event_id || !actor || actor.workspace_id!==s.workspace_id || s.sequence_number !== (prior?.sequence_number ?? 0)+1) fail(); stateLast.set(s.event_reviewer_assignment_id,s); }
  for (const assignment of assignments) if (!stateLast.has(assignment.id)) fail();
  const contexts = rows<any>("SELECT * FROM review_context_versions ORDER BY workspace_id,event_id,context_kind,version_number");
  const contextMap = new Map<string,any>();
  for (const c of contexts) {
    let parsed: unknown; try { parsed=JSON.parse(c.context_json); } catch { fail(); }
    const schema = ({ADVOCACY_POLICY:"pd01-advocacy-policy/v1",VISIBILITY:"pd01-visibility-snapshot/v1",BLINDNESS:"pd01-blindness-policy/v1",SELECTION_CONTEXT:"pd01-selection-context/v1"} as Record<string,string>)[c.context_kind];
    const key=`${c.workspace_id}\0${c.event_id}\0${c.context_kind}`; const prior=contextMap.get(key);
    if (!validId(c.id) || !validInstant(c.issued_at) || c.context_schema!==schema || canonicalJson(parsed)!==c.context_json || fingerprintOf(parsed)!==c.fingerprint || c.version_number!==(prior?.version_number??0)+1) fail();
    validateV9ContextDocument(db, c);
    const issuer=db.prepare("SELECT workspace_id FROM accounts WHERE id=?").get(c.issued_by_account_id) as any; const event=db.prepare("SELECT 1 FROM events WHERE id=? AND workspace_id=?").get(c.event_id,c.workspace_id); if(!issuer||issuer.workspace_id!==c.workspace_id||!event) fail();
    contextMap.set(key,c);
  }
  for (const s of rows<any>("SELECT * FROM recommendation_sets")) {
    const assignment = db.prepare("SELECT * FROM event_reviewer_assignments WHERE id=?").get(s.event_reviewer_assignment_id) as any;
    const binding = db.prepare("SELECT * FROM account_person_bindings WHERE id=?").get(s.account_person_binding_id) as any;
    const event = db.prepare("SELECT 1 FROM events WHERE id=? AND workspace_id=?").get(s.event_id,s.workspace_id);
    if (!validId(s.id) || !validInstant(s.created_at) || (s.archived_at !== null && !validInstant(s.archived_at)) || !event || !assignment || !binding || assignment.workspace_id!==s.workspace_id || assignment.event_id!==s.event_id || assignment.reviewer_account_id!==s.reviewer_account_id || assignment.reviewer_person_id!==s.reviewer_person_id || assignment.account_person_binding_id!==s.account_person_binding_id || s.reviewer_person_id!==binding.person_id || s.reviewer_account_id!==binding.account_id) fail();
  }
  const versions = rows<any>("SELECT * FROM recommendation_set_versions");
  for (const v of versions) {
    const set = db.prepare("SELECT * FROM recommendation_sets WHERE id=?").get(v.recommendation_set_id) as any;
    const contextsById = [v.policy_version_id,v.visibility_version_id,v.blindness_version_id,v.selection_context_version_id].map((id:string)=>db.prepare("SELECT * FROM review_context_versions WHERE id=?").get(id) as any);
    if (!validId(v.id) || !validInstant(v.created_at) || (v.submitted_at !== null && !validInstant(v.submitted_at)) || (v.sealed_at !== null && !validInstant(v.sealed_at)) || typeof v.selection_context_reference !== "string" || Buffer.byteLength(v.selection_context_reference,"utf8")<1 || Buffer.byteLength(v.selection_context_reference,"utf8")>256 || !set || set.workspace_id!==v.workspace_id || set.event_id!==v.event_id || set.reviewer_account_id!==v.reviewer_account_id || set.reviewer_person_id!==v.reviewer_person_id || set.event_reviewer_assignment_id!==v.event_reviewer_assignment_id || set.account_person_binding_id!==v.account_person_binding_id || contextsById.some((c:any,i:number)=>!c || c.workspace_id!==v.workspace_id || c.event_id!==v.event_id || c.context_kind!==["ADVOCACY_POLICY","VISIBILITY","BLINDNESS","SELECTION_CONTEXT"][i]) || v.selection_context_reference !== (JSON.parse(contextsById[3].context_json) as any).decisionBoundary || v.policy_version_fingerprint!==contextsById[0].fingerprint || v.visibility_version_fingerprint!==contextsById[1].fingerprint || v.blindness_version_fingerprint!==contextsById[2].fingerprint || v.selection_context_fingerprint!==contextsById[3].fingerprint || canonicalJson(JSON.parse(v.eligibility_snapshot_json))!==v.eligibility_snapshot_json || fingerprintOf(JSON.parse(v.eligibility_snapshot_json))!==v.eligibility_fingerprint) fail();
    const policyDocument = JSON.parse(contextsById[0].context_json) as any;
    const visibilityDocument = JSON.parse(contextsById[1].context_json) as any;
    const entriesForMembership = rows<any>("SELECT * FROM recommendation_entries WHERE recommendation_set_version_id=?", v.id);
    for (const e of entriesForMembership) if (!validId(e.id) || !validInstant(e.created_at) || (e.rationale !== null && Buffer.byteLength(e.rationale,"utf8")>4096)) fail();
    if (v.maximum_entries !== policyDocument.maximumEntries || canonicalJson(policyDocument.eligibleRevisions) !== v.eligibility_snapshot_json) fail();
    for (const e of entriesForMembership) {
      const revision = db.prepare("SELECT fingerprint FROM submission_revisions WHERE id=?").get(e.submission_revision_id) as {fingerprint:string}|undefined;
      const tuple = (items: any[]) => items?.some((x:any) => x.submissionId===e.submission_id && x.submissionRevisionId===e.submission_revision_id && x.submissionRevisionFingerprint===revision?.fingerprint);
      if (!revision || !tuple(policyDocument.eligibleRevisions) || !tuple(visibilityDocument.visibleRevisions)) fail();
    }
    if (v.sealed_at !== null) {
      const entries=rows<any>("SELECT * FROM recommendation_entries WHERE recommendation_set_version_id=? ORDER BY rank IS NULL,rank,id", v.id).map(e=>({id:e.id,submissionId:e.submission_id,submissionRevisionId:e.submission_revision_id,stance:e.stance,rank:e.rank,strength:e.strength,rationale:e.rationale,followUpWillingness:e.follow_up_willingness,evidence:e.evidence_json===null?null:JSON.parse(e.evidence_json)}));
      const content=fingerprintOf({schema:"pd01-recommendation-ballot/v1",workspaceId:v.workspace_id,eventId:v.event_id,recommendationSetId:v.recommendation_set_id,versionNumber:v.version_number,reviewerAccountId:v.reviewer_account_id,reviewerPersonId:v.reviewer_person_id,accountPersonBindingId:v.account_person_binding_id,eventReviewerAssignmentId:v.event_reviewer_assignment_id,eligibilityFingerprint:v.eligibility_fingerprint,policyVersionId:v.policy_version_id,policyVersionFingerprint:v.policy_version_fingerprint,visibilityVersionId:v.visibility_version_id,visibilityVersionFingerprint:v.visibility_version_fingerprint,blindnessVersionId:v.blindness_version_id,blindnessVersionFingerprint:v.blindness_version_fingerprint,selectionContextVersionId:v.selection_context_version_id,selectionContextFingerprint:v.selection_context_fingerprint,selectionContextReference:v.selection_context_reference,policyContextSchema:(db.prepare("SELECT context_schema FROM review_context_versions WHERE id=?").get(v.policy_version_id) as any).context_schema,visibilityContextSchema:(db.prepare("SELECT context_schema FROM review_context_versions WHERE id=?").get(v.visibility_version_id) as any).context_schema,blindnessContextSchema:(db.prepare("SELECT context_schema FROM review_context_versions WHERE id=?").get(v.blindness_version_id) as any).context_schema,selectionContextSchema:(db.prepare("SELECT context_schema FROM review_context_versions WHERE id=?").get(v.selection_context_version_id) as any).context_schema,maximumEntries:v.maximum_entries,entries});
      if (v.content_fingerprint!==content) fail();
    }
  }
}

function validatePd01V10(db: Db): void {
  const fail = (detail = "integrity"): never => {
    throw new Error(`database PD-01 V10 ${detail} check failed`);
  };
  validatePd01V9(db);
  const validId = (value: unknown): value is string =>
    typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= 1
    && Buffer.byteLength(value, "utf8") <= 128
    && !value.includes("\0");
  const validInstant = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
      return false;
    }
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  };
  const rows = <T>(sql: string, ...params: any[]): T[] => db.prepare(sql).all(...params) as T[];
  const assignments = rows<any>("SELECT * FROM event_reviewer_assignments ORDER BY id");
  for (const assignment of assignments) {
    const binding = db.prepare("SELECT created_at FROM account_person_bindings WHERE id=?")
      .get(assignment.account_person_binding_id) as { created_at: string } | undefined;
    if (!binding || assignment.created_at < binding.created_at) fail("assignment chronology");
  }

  const stateHistory = new Map<string, any[]>();
  const states = rows<any>("SELECT * FROM event_reviewer_assignment_states ORDER BY event_reviewer_assignment_id, sequence_number");
  for (const state of states) {
    const history = stateHistory.get(state.event_reviewer_assignment_id) ?? [];
    const prior = history[history.length - 1];
    const assignment = db.prepare("SELECT workspace_id,event_id,created_at FROM event_reviewer_assignments WHERE id=?")
      .get(state.event_reviewer_assignment_id) as any;
    const actor = db.prepare("SELECT workspace_id FROM accounts WHERE id=?").get(state.actor_account_id) as any;
    if (!validId(state.id)
      || !Number.isSafeInteger(state.sequence_number)
      || state.sequence_number < 1
      || (state.state !== "ACTIVE" && state.state !== "REVOKED")
      || !validInstant(state.created_at)
      || (state.reason !== null && (typeof state.reason !== "string" || Buffer.byteLength(state.reason, "utf8") < 1 || Buffer.byteLength(state.reason, "utf8") > 1024))
      || !assignment
      || state.workspace_id !== assignment.workspace_id
      || state.event_id !== assignment.event_id
      || !actor
      || actor.workspace_id !== state.workspace_id
      || state.sequence_number !== history.length + 1
      || (history.length === 0 && state.state !== "ACTIVE")
      || state.created_at < assignment.created_at
      || (prior !== undefined && (state.state === prior.state || state.created_at < prior.created_at))) {
      fail("assignment-state history");
    }
    history.push(state);
    stateHistory.set(state.event_reviewer_assignment_id, history);
  }
  for (const assignment of assignments) {
    if (!stateHistory.has(assignment.id)) fail("assignment-state history");
  }

  const assignmentIsActiveAt = (assignmentId: string, instant: string): boolean => {
    const history = stateHistory.get(assignmentId) ?? [];
    let state: any;
    for (const candidate of history) {
      if (candidate.created_at > instant) break;
      state = candidate;
    }
    return state?.state === "ACTIVE";
  };

  for (const context of rows<any>("SELECT * FROM review_context_versions")) {
    if (context.context_kind === "ADVOCACY_POLICY") {
      const document = JSON.parse(context.context_json) as { maximumEntries?: unknown };
      if (!Number.isSafeInteger(document.maximumEntries) || (document.maximumEntries as number) > 10000) {
        fail("maximumEntries");
      }
    }
  }

  for (const set of rows<any>("SELECT * FROM recommendation_sets")) {
    const assignment = db.prepare("SELECT created_at FROM event_reviewer_assignments WHERE id=?")
      .get(set.event_reviewer_assignment_id) as { created_at: string } | undefined;
    if (!assignment || set.created_at < assignment.created_at || (set.archived_at !== null && set.archived_at < set.created_at)) {
      fail("recommendation-set chronology");
    }
  }

  for (const version of rows<any>("SELECT * FROM recommendation_set_versions")) {
    const set = db.prepare("SELECT created_at FROM recommendation_sets WHERE id=?")
      .get(version.recommendation_set_id) as { created_at: string } | undefined;
    const assignment = db.prepare("SELECT created_at FROM event_reviewer_assignments WHERE id=?")
      .get(version.event_reviewer_assignment_id) as { created_at: string } | undefined;
    if (!set || !assignment
      || version.created_at < set.created_at
      || version.created_at < assignment.created_at
      || (version.submitted_at === null) !== (version.sealed_at === null)
      || (version.submitted_at !== null && version.submitted_at < version.created_at)
      || (version.sealed_at !== null && (version.submitted_at === null || version.sealed_at < version.submitted_at))
      || (version.sealed_at === null && version.content_fingerprint !== null)
      || (version.sealed_at !== null && (version.content_fingerprint === null || !assignmentIsActiveAt(version.event_reviewer_assignment_id, version.sealed_at)))) {
      fail("recommendation authority");
    }
    for (const entry of rows<any>("SELECT created_at FROM recommendation_entries WHERE recommendation_set_version_id=?", version.id)) {
      if (!validInstant(entry.created_at) || entry.created_at < version.created_at || (version.sealed_at !== null && entry.created_at > version.sealed_at)) {
        fail("recommendation-entry chronology");
      }
    }
  }
}

function validatePd01Foundation(db: Db): void {
  const hasPd01Rows = db.prepare(`
    SELECT 1 FROM submissions WHERE lineage_id IS NOT NULL
    UNION ALL SELECT 1 FROM proposal_lineages
    UNION ALL SELECT 1 FROM submission_derivations
    UNION ALL SELECT 1 FROM resubmission_requests
    UNION ALL SELECT 1 FROM recommendation_sets
    UNION ALL SELECT 1 FROM recommendation_set_versions
    UNION ALL SELECT 1 FROM recommendation_entries
    UNION ALL SELECT 1 FROM program_capacity_pools
    UNION ALL SELECT 1 FROM program_capacity_pool_versions
    UNION ALL SELECT 1 FROM capacity_transfer_decisions
    UNION ALL SELECT 1 FROM capacity_transfer_receipts
    LIMIT 1`).get();
  if (!hasPd01Rows) return;

  const assertClean = (sql: string, message = "database PD-01 foundation integrity check failed"): void => {
    if (db.prepare(sql).get()) throw new Error(message);
  };

  assertClean(`
    SELECT 1 FROM submissions s JOIN proposal_lineages l ON l.id = s.lineage_id
    WHERE l.workspace_id <> s.workspace_id
    UNION ALL
    SELECT 1 FROM proposal_lineages l
    LEFT JOIN submissions s ON s.id = l.originating_submission_id
    LEFT JOIN submission_revisions r ON r.id = l.originating_submission_revision_id
    LEFT JOIN accounts a ON a.id = l.created_by_account_id
    WHERE (l.originating_submission_id IS NULL) <> (l.originating_submission_revision_id IS NULL)
       OR (l.originating_submission_id IS NOT NULL AND (s.id IS NULL OR r.id IS NULL
           OR s.workspace_id <> l.workspace_id OR r.workspace_id <> l.workspace_id
           OR r.submission_id <> s.id))
       OR sympose_pd01_canonical_json(l.display_projection_json) IS NOT l.display_projection_json
       OR a.id IS NULL OR a.workspace_id <> l.workspace_id
    UNION ALL
    SELECT 1 FROM submission_derivations d
    LEFT JOIN submissions source_submission ON source_submission.id = d.source_submission_id
    LEFT JOIN submission_revisions source_revision ON source_revision.id = d.source_submission_revision_id
    LEFT JOIN submissions target_submission ON target_submission.id = d.target_submission_id
    LEFT JOIN submission_revisions target_revision ON target_revision.id = d.target_submission_revision_id
    LEFT JOIN accounts actor ON actor.id = d.actor_account_id
    WHERE source_submission.id IS NULL OR source_revision.id IS NULL
       OR source_submission.workspace_id <> d.workspace_id OR source_revision.workspace_id <> d.workspace_id
       OR source_revision.submission_id <> source_submission.id
       OR (d.target_submission_id IS NULL) <> (d.target_submission_revision_id IS NULL)
       OR (d.target_submission_id IS NOT NULL AND (target_submission.id IS NULL OR target_revision.id IS NULL
           OR target_submission.workspace_id <> d.workspace_id OR target_revision.workspace_id <> d.workspace_id
           OR target_revision.submission_id <> target_submission.id))
       OR (d.guidance_request_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM resubmission_requests q WHERE q.id = d.guidance_request_id
             AND q.workspace_id = d.workspace_id AND q.source_submission_id = d.source_submission_id
             AND q.source_submission_revision_id = d.source_submission_revision_id))
       OR sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-submission-derivation/v1', 'workspaceId', d.workspace_id,
           'relationshipType', d.relationship_type, 'sourceSubmissionId', d.source_submission_id,
           'sourceSubmissionRevisionId', d.source_submission_revision_id,
           'targetSubmissionId', d.target_submission_id, 'targetSubmissionRevisionId', d.target_submission_revision_id,
           'actorAccountId', d.actor_account_id, 'reason', d.reason,
           'guidanceRequestId', d.guidance_request_id, 'guidanceReference', d.guidance_reference,
           'createdAt', d.created_at)) IS NOT d.fingerprint
       OR actor.id IS NULL OR actor.workspace_id <> d.workspace_id
    UNION ALL
    SELECT 1 FROM resubmission_requests q
    LEFT JOIN submissions s ON s.id = q.source_submission_id
    LEFT JOIN submission_revisions r ON r.id = q.source_submission_revision_id
    LEFT JOIN calls c ON c.id = q.target_call_id
    LEFT JOIN accounts a ON a.id = q.created_by_account_id
    WHERE s.id IS NULL OR r.id IS NULL OR s.workspace_id <> q.workspace_id OR r.workspace_id <> q.workspace_id
       OR r.submission_id <> s.id OR (q.target_call_id IS NOT NULL AND (c.id IS NULL OR c.workspace_id <> q.workspace_id))
       OR sympose_pd01_canonical_json(q.guidance_json) IS NOT q.guidance_json
       OR sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-resubmission-request/v1', 'workspaceId', q.workspace_id,
           'sourceSubmissionId', q.source_submission_id, 'sourceSubmissionRevisionId', q.source_submission_revision_id,
           'targetCallId', q.target_call_id, 'guidanceVersion', q.guidance_version,
           'guidance', json(q.guidance_json), 'createdByAccountId', q.created_by_account_id,
           'createdAt', q.created_at, 'expiresAt', q.expires_at)) IS NOT q.fingerprint
       OR a.id IS NULL OR a.workspace_id <> q.workspace_id
    LIMIT 1`);

  assertClean(`
    SELECT 1 FROM recommendation_sets s
    LEFT JOIN events e ON e.id = s.event_id
    LEFT JOIN accounts a ON a.id = s.reviewer_account_id
    WHERE e.id IS NULL OR e.workspace_id <> s.workspace_id OR a.id IS NULL OR a.workspace_id <> s.workspace_id
    UNION ALL
    SELECT 1 FROM recommendation_set_versions v
    LEFT JOIN recommendation_sets s ON s.id = v.recommendation_set_id
    LEFT JOIN accounts a ON a.id = v.reviewer_account_id
    WHERE s.id IS NULL OR s.workspace_id <> v.workspace_id OR s.event_id <> v.event_id
       OR s.reviewer_account_id <> v.reviewer_account_id OR a.id IS NULL OR a.workspace_id <> v.workspace_id
       OR v.eligibility_fingerprint IS NOT sympose_pd01_fingerprint(v.eligibility_snapshot_json)
       OR ((SELECT value FROM meta WHERE key = 'schema_version') = '8'
         AND v.selection_context_fingerprint IS NOT sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-selection-context/v1', 'workspaceId', v.workspace_id, 'eventId', v.event_id,
           'recommendationSetId', v.recommendation_set_id, 'reviewerAccountId', v.reviewer_account_id,
           'reference', v.selection_context_reference)))
       OR (SELECT COUNT(*) FROM recommendation_entries entry
           WHERE entry.recommendation_set_version_id = v.id) > v.maximum_entries
       OR (v.submitted_at IS NULL) <> (v.sealed_at IS NULL)
       OR (v.sealed_at IS NULL AND v.content_fingerprint IS NOT NULL)
       OR (v.sealed_at IS NOT NULL AND (v.submitted_at < v.created_at OR v.sealed_at < v.submitted_at))
       OR ((SELECT value FROM meta WHERE key = 'schema_version') = '8' AND v.sealed_at IS NOT NULL
         AND (v.content_fingerprint IS NULL OR v.content_fingerprint IS NOT sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-recommendation-ballot/v1', 'workspaceId', v.workspace_id,
           'eventId', v.event_id, 'recommendationSetId', v.recommendation_set_id,
           'versionNumber', v.version_number, 'reviewerAccountId', v.reviewer_account_id,
           'eligibilityFingerprint', v.eligibility_fingerprint,
           'selectionContextReference', v.selection_context_reference,
           'selectionContextFingerprint', v.selection_context_fingerprint,
           'maximumEntries', v.maximum_entries, 'policyVersionId', v.policy_version_id,
           'visibilityVersionId', v.visibility_version_id, 'blindnessVersionId', v.blindness_version_id,
           'entries', (SELECT json_group_array(json_object(
             'id', entry.id, 'submissionId', entry.submission_id, 'submissionRevisionId', entry.submission_revision_id,
             'stance', entry.stance, 'rank', entry.rank, 'strength', entry.strength, 'rationale', entry.rationale,
             'followUpWillingness', entry.follow_up_willingness, 'evidence', json(entry.evidence_json)))
             FROM (SELECT * FROM recommendation_entries WHERE recommendation_set_version_id = v.id
                   ORDER BY rank IS NULL, rank, id) entry)))))
    UNION ALL
    SELECT 1 FROM recommendation_set_versions v
    LEFT JOIN recommendation_set_versions prior ON prior.workspace_id = v.workspace_id
      AND prior.recommendation_set_id = v.recommendation_set_id AND prior.version_number = v.version_number - 1
    WHERE v.version_number > 1 AND prior.id IS NULL
    UNION ALL
    SELECT 1 FROM recommendation_entries e
    LEFT JOIN recommendation_set_versions v ON v.id = e.recommendation_set_version_id
    LEFT JOIN submissions s ON s.id = e.submission_id
    LEFT JOIN submission_revisions r ON r.id = e.submission_revision_id
    WHERE v.id IS NULL OR v.workspace_id <> e.workspace_id OR v.event_id <> e.event_id
       OR (e.rank IS NOT NULL AND e.rank > v.maximum_entries)
       OR e.id IS NULL OR typeof(e.id) <> 'text' OR length(CAST(e.id AS BLOB)) = 0
       OR e.stance IS NULL OR typeof(e.stance) <> 'text'
          OR e.stance NOT IN ('PROMOTE', 'STRONGLY_PROMOTE', 'OPPOSE', 'NO_POSITION')
       OR (e.rank IS NOT NULL AND (typeof(e.rank) <> 'integer' OR e.rank < 1 OR e.rank > v.maximum_entries))
       OR (e.strength IS NOT NULL AND (typeof(e.strength) <> 'integer' OR e.strength < 0 OR e.strength > 100))
       OR (e.follow_up_willingness IS NOT NULL
          AND (typeof(e.follow_up_willingness) <> 'integer' OR e.follow_up_willingness NOT IN (0, 1)))
       OR (e.rationale IS NOT NULL
          AND (typeof(e.rationale) <> 'text' OR length(CAST(e.rationale AS BLOB)) > 4096))
       OR e.created_at IS NULL OR typeof(e.created_at) <> 'text' OR length(CAST(e.created_at AS BLOB)) = 0
       OR s.id IS NULL OR s.workspace_id <> e.workspace_id OR s.event_id <> e.event_id
       OR r.id IS NULL OR r.workspace_id <> e.workspace_id OR r.submission_id <> s.id
    LIMIT 1`);

  assertClean(`
    SELECT 1 FROM program_capacity_pools p LEFT JOIN events e ON e.id = p.event_id
    WHERE e.id IS NULL OR e.workspace_id <> p.workspace_id
    UNION ALL
    SELECT 1 FROM program_capacity_pool_versions v LEFT JOIN program_capacity_pools p ON p.id = v.pool_id
    WHERE p.id IS NULL OR p.workspace_id <> v.workspace_id OR p.event_id <> v.event_id OR p.unit_kind <> v.unit_kind
       OR v.fingerprint IS NOT sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-capacity-pool-version/v1', 'workspaceId', v.workspace_id, 'eventId', v.event_id,
           'poolId', v.pool_id, 'versionNumber', v.version_number, 'unitKind', v.unit_kind,
           'capacity', v.capacity, 'scope', json(v.scope_json), 'eligibility', json(v.eligibility_json),
           'reservedFor', json(v.reserved_for_json), 'releasePolicy', json(v.release_policy_json),
           'effectiveFrom', v.effective_from, 'effectiveTo', v.effective_to, 'createdAt', v.created_at))
    UNION ALL
    SELECT 1 FROM capacity_transfer_decisions d
    LEFT JOIN accounts actor ON actor.id = d.actor_account_id
    LEFT JOIN program_capacity_pool_versions source ON source.id = d.source_pool_version_id
    LEFT JOIN program_capacity_pool_versions destination ON destination.id = d.destination_pool_version_id
    WHERE actor.id IS NULL OR actor.workspace_id <> d.workspace_id
       OR source.id IS NULL OR source.workspace_id <> d.workspace_id OR source.event_id <> d.event_id
       OR source.pool_id <> d.source_pool_id OR source.unit_kind <> d.unit_kind
       OR destination.id IS NULL OR destination.workspace_id <> d.workspace_id OR destination.event_id <> d.event_id
       OR destination.pool_id <> d.destination_pool_id OR destination.unit_kind <> d.unit_kind
       OR d.fingerprint IS NOT sympose_pd01_fingerprint(json_object(
           'schema', 'pd01-capacity-transfer-decision/v1', 'workspaceId', d.workspace_id,
           'eventId', d.event_id, 'sequenceNumber', d.sequence_number,
           'sourcePoolId', d.source_pool_id, 'sourcePoolVersionId', d.source_pool_version_id,
           'destinationPoolId', d.destination_pool_id, 'destinationPoolVersionId', d.destination_pool_version_id,
           'unitKind', d.unit_kind, 'quantity', d.quantity, 'sourceBefore', d.source_before,
           'sourceAfter', d.source_after, 'destinationBefore', d.destination_before,
           'destinationAfter', d.destination_after, 'actorAccountId', d.actor_account_id,
           'reason', d.reason, 'approvalReference', d.approval_reference, 'decidedAt', d.decided_at,
           'idempotencyKey', d.idempotency_key))
    UNION ALL
    SELECT 1 FROM program_capacity_pool_versions v
    LEFT JOIN program_capacity_pool_versions prior ON prior.workspace_id = v.workspace_id
      AND prior.event_id = v.event_id AND prior.pool_id = v.pool_id AND prior.version_number = v.version_number - 1
    WHERE v.version_number > 1 AND prior.id IS NULL
    LIMIT 1`);

  const poolVersions = new Map<string, { readonly poolId: string; readonly capacity: number }>();
  const poolRows = db.prepare(`SELECT workspace_id, event_id, id, pool_id, capacity FROM program_capacity_pool_versions`).all() as Array<{
    workspace_id: string; event_id: string; id: string; pool_id: string; capacity: number;
  }>;
  for (const row of poolRows) {
    poolVersions.set(`${row.workspace_id}\u0000${row.event_id}\u0000${row.id}`, {
      poolId: row.pool_id,
      capacity: row.capacity,
    });
  }
  const balances = new Map<string, { readonly versionId: string; readonly balance: number }>();
  const lastSequence = new Map<string, number>();
  const decisions = db.prepare(`
    SELECT d.*, source.pool_id AS source_root, destination.pool_id AS destination_root,
      receipt.id AS receipt_id, receipt.workspace_id AS receipt_workspace_id, receipt.event_id AS receipt_event_id,
      receipt.sequence_number AS receipt_sequence_number, receipt.source_pool_id AS receipt_source_pool_id,
      receipt.source_pool_version_id AS receipt_source_pool_version_id, receipt.destination_pool_id AS receipt_destination_pool_id,
      receipt.destination_pool_version_id AS receipt_destination_pool_version_id, receipt.unit_kind AS receipt_unit_kind,
      receipt.quantity AS receipt_quantity, receipt.source_before AS receipt_source_before, receipt.source_after AS receipt_source_after,
      receipt.destination_before AS receipt_destination_before, receipt.destination_after AS receipt_destination_after,
      receipt.recorded_at AS receipt_recorded_at, receipt.fingerprint AS receipt_fingerprint
    FROM capacity_transfer_decisions d
    LEFT JOIN program_capacity_pool_versions source ON source.id = d.source_pool_version_id
    LEFT JOIN program_capacity_pool_versions destination ON destination.id = d.destination_pool_version_id
    LEFT JOIN capacity_transfer_receipts receipt ON receipt.workspace_id = d.workspace_id AND receipt.decision_id = d.id
    ORDER BY d.workspace_id, d.event_id, d.sequence_number`).all() as Array<Record<string, unknown>>;
  for (const row of decisions) {
    const scope = `${row.workspace_id}\u0000${row.event_id}`;
    const sequence = row.sequence_number as number;
    if (row.source_root === row.destination_root || sequence !== (lastSequence.get(scope) ?? 0) + 1) {
      throw new Error("database PD-01 foundation capacity integrity check failed");
    }
    const sourceVersionId = row.source_pool_version_id as string;
    const destinationVersionId = row.destination_pool_version_id as string;
    const sourcePoolId = row.source_pool_id as string;
    const destinationPoolId = row.destination_pool_id as string;
    const sourceVersion = poolVersions.get(`${scope}\u0000${sourceVersionId}`);
    const destinationVersion = poolVersions.get(`${scope}\u0000${destinationVersionId}`);
    const sourceKey = `${scope}\u0000${sourcePoolId}`;
    const destinationKey = `${scope}\u0000${destinationPoolId}`;
    const sourceState = balances.get(sourceKey);
    const destinationState = balances.get(destinationKey);
    if (!sourceVersion || !destinationVersion
      || sourceVersion.poolId !== sourcePoolId || destinationVersion.poolId !== destinationPoolId
      || (sourceState !== undefined && sourceState.versionId !== sourceVersionId)
      || (destinationState !== undefined && destinationState.versionId !== destinationVersionId)) {
      throw new Error("database PD-01 foundation capacity integrity check failed");
    }
    const sourceBefore = sourceState?.balance ?? sourceVersion.capacity;
    const destinationBefore = destinationState?.balance ?? destinationVersion.capacity;
    if (sourceBefore !== row.source_before || destinationBefore !== row.destination_before
      || (row.source_after as number) !== sourceBefore - (row.quantity as number)
      || (row.destination_after as number) !== destinationBefore + (row.quantity as number)
      || (row.source_after as number) < 0
      || row.receipt_id === null
      || row.receipt_id !== `receipt:${String(row.id)}`
      || row.receipt_workspace_id !== row.workspace_id || row.receipt_event_id !== row.event_id
      || row.receipt_sequence_number !== row.sequence_number
      || row.receipt_source_pool_id !== row.source_pool_id || row.receipt_source_pool_version_id !== row.source_pool_version_id
      || row.receipt_destination_pool_id !== row.destination_pool_id
      || row.receipt_destination_pool_version_id !== row.destination_pool_version_id
      || row.receipt_unit_kind !== row.unit_kind || row.receipt_quantity !== row.quantity
      || row.receipt_source_before !== row.source_before || row.receipt_source_after !== row.source_after
      || row.receipt_destination_before !== row.destination_before || row.receipt_destination_after !== row.destination_after
      || row.receipt_recorded_at !== row.decided_at || row.receipt_fingerprint !== row.fingerprint) {
      throw new Error("database PD-01 foundation capacity integrity check failed");
    }
    balances.set(sourceKey, { versionId: sourceVersionId, balance: row.source_after as number });
    balances.set(destinationKey, { versionId: destinationVersionId, balance: row.destination_after as number });
    lastSequence.set(scope, sequence);
  }

  const documents = [
    ...(db.prepare("SELECT display_projection_json AS document FROM proposal_lineages").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT guidance_json AS document FROM resubmission_requests").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT eligibility_snapshot_json AS document FROM recommendation_set_versions").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT evidence_json AS document FROM recommendation_entries WHERE evidence_json IS NOT NULL").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT scope_json AS document FROM program_capacity_pool_versions").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT eligibility_json AS document FROM program_capacity_pool_versions").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT reserved_for_json AS document FROM program_capacity_pool_versions").all() as Array<{ document: unknown }>),
    ...(db.prepare("SELECT release_policy_json AS document FROM program_capacity_pool_versions").all() as Array<{ document: unknown }>),
  ];
  for (const row of documents) {
    if (typeof row.document !== "string" || Buffer.byteLength(row.document, "utf8") > PD01_JSON_MAX_BYTES) {
      throw new Error("database PD-01 foundation JSON integrity check failed");
    }
    try {
      const parsed = JSON.parse(row.document) as unknown;
      if (canonicalJson(parsed) !== row.document) {
        throw new Error("database PD-01 foundation JSON integrity check failed");
      }
      if (jsonDepthExceeds(parsed, 32)) {
        throw new Error("database PD-01 foundation JSON integrity check failed");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("PD-01")) {
        throw error;
      }
      throw new Error("database PD-01 foundation JSON integrity check failed");
    }
  }
}

const LEGACY_TENANT_INTEGRITY_QUERIES = [
  `SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
   WHERE a.workspace_id <> s.workspace_id LIMIT 1`,
  `SELECT 1 FROM source_links l
   JOIN people p ON p.id = l.person_id
   JOIN source_records r ON r.id = l.source_record_id
   WHERE p.workspace_id <> l.workspace_id OR r.workspace_id <> l.workspace_id LIMIT 1`,
  `SELECT 1 FROM cohort_snapshots s JOIN cohort_definitions d ON d.id = s.cohort_definition_id
   WHERE d.workspace_id <> s.workspace_id OR d.version <> s.definition_version LIMIT 1`,
  `SELECT 1 FROM cohort_snapshot_members m
   JOIN cohort_snapshots s ON s.id = m.snapshot_id
   JOIN people p ON p.id = m.person_id
   WHERE s.workspace_id <> m.workspace_id OR p.workspace_id <> m.workspace_id LIMIT 1`,
  `SELECT 1 FROM program_units u JOIN events e ON e.id = u.event_id
   WHERE e.workspace_id <> u.workspace_id LIMIT 1`,
  `SELECT 1 FROM plan_runs r JOIN events e ON e.id = r.event_id
   WHERE e.workspace_id <> r.workspace_id LIMIT 1`,
  `SELECT 1 FROM plan_versions p
   JOIN events e ON e.id = p.event_id
   JOIN plan_runs r ON r.id = p.run_id
   WHERE e.workspace_id <> p.workspace_id OR r.workspace_id <> p.workspace_id
      OR r.event_id <> p.event_id LIMIT 1`,
  `SELECT 1 FROM plan_states s JOIN plan_versions p ON p.id = s.plan_version_id
   LEFT JOIN accounts a ON a.id = s.actor_account_id
   WHERE p.workspace_id <> s.workspace_id
      OR (s.actor_account_id IS NOT NULL AND (a.workspace_id <> s.workspace_id OR a.id IS NULL)) LIMIT 1`,
  `SELECT 1 FROM plan_assignments a
   JOIN plan_versions p ON p.id = a.plan_version_id
   JOIN people person ON person.id = a.person_id
   JOIN program_units u ON u.id = a.program_unit_id
   WHERE p.workspace_id <> a.workspace_id OR person.workspace_id <> a.workspace_id
      OR u.workspace_id <> a.workspace_id OR u.event_id <> p.event_id LIMIT 1`,
  `SELECT 1 FROM approvals a
   JOIN events e ON e.id = a.event_id
   JOIN plan_versions p ON p.id = a.plan_version_id
   JOIN accounts actor ON actor.id = a.actor_account_id
   WHERE e.workspace_id <> a.workspace_id OR p.workspace_id <> a.workspace_id
      OR actor.workspace_id <> a.workspace_id OR p.event_id <> a.event_id LIMIT 1`,
  `SELECT 1 FROM commitment_offers o
   JOIN events e ON e.id = o.event_id
   JOIN plan_versions p ON p.id = o.plan_version_id
   JOIN people person ON person.id = o.person_id
   WHERE e.workspace_id <> o.workspace_id OR p.workspace_id <> o.workspace_id
      OR person.workspace_id <> o.workspace_id OR p.event_id <> o.event_id LIMIT 1`,
  `SELECT 1 FROM commitment_responses r
   JOIN commitment_offers o ON o.id = r.offer_id
   JOIN people person ON person.id = r.actor_person_id
   WHERE o.workspace_id <> r.workspace_id OR person.workspace_id <> r.workspace_id
      OR person.id <> o.person_id LIMIT 1`,
  `SELECT 1 FROM publication_releases r
   JOIN events e ON e.id = r.event_id
   JOIN plan_versions p ON p.id = r.plan_version_id
   WHERE e.workspace_id <> r.workspace_id OR p.workspace_id <> r.workspace_id
      OR p.event_id <> r.event_id LIMIT 1`,
  `SELECT 1 FROM personal_agendas a
   JOIN publication_releases r ON r.id = a.release_id
   JOIN people p ON p.id = a.person_id
   WHERE r.workspace_id <> a.workspace_id OR p.workspace_id <> a.workspace_id LIMIT 1`,
  `SELECT 1 FROM portal_tokens t
   JOIN publication_releases r ON r.id = t.release_id
   JOIN people p ON p.id = t.person_id
   LEFT JOIN accounts revoked_by ON revoked_by.id = t.revoked_by
   WHERE r.workspace_id <> t.workspace_id OR p.workspace_id <> t.workspace_id
      OR (t.revoked_by IS NOT NULL AND (revoked_by.workspace_id <> t.workspace_id OR revoked_by.id IS NULL)) LIMIT 1`,
  `SELECT 1 FROM observations o
   JOIN events e ON e.id = o.event_id
   JOIN people p ON p.id = o.person_id
   JOIN program_units u ON u.id = o.program_unit_id
   WHERE e.workspace_id <> o.workspace_id OR p.workspace_id <> o.workspace_id
      OR u.workspace_id <> o.workspace_id OR u.event_id <> o.event_id LIMIT 1`,
  `SELECT 1 FROM events e JOIN plan_versions p ON p.id = e.current_plan_version_id
   WHERE p.workspace_id <> e.workspace_id OR p.event_id <> e.id LIMIT 1`,
  `SELECT 1 FROM events e JOIN publication_releases r ON r.id = e.current_release_id
   WHERE r.workspace_id <> e.workspace_id OR r.event_id <> e.id LIMIT 1`,
] as const;

const SPEAKER_TASK_AUTHORITY_INTEGRITY_QUERY = `SELECT 1 FROM speaker_tasks task
 WHERE NOT EXISTS (
   SELECT 1
   FROM events event_row
   JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
     AND plan.workspace_id = event_row.workspace_id AND plan.event_id = event_row.id
   JOIN plan_assignments assignment ON assignment.id = task.assignment_id
     AND assignment.workspace_id = plan.workspace_id AND assignment.plan_version_id = plan.id
     AND assignment.person_id = task.person_id
   JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id
     AND accepted_speaker.event_id = event_row.id AND accepted_speaker.person_id = assignment.person_id
     AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
     AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
   JOIN program_units unit ON unit.id = assignment.program_unit_id
     AND unit.workspace_id = assignment.workspace_id AND unit.event_id = event_row.id
   JOIN approvals approval ON approval.plan_version_id = plan.id
     AND approval.workspace_id = plan.workspace_id AND approval.event_id = event_row.id
     AND approval.decision = 'approved'
   JOIN plan_states current_state ON current_state.plan_version_id = plan.id
     AND current_state.workspace_id = plan.workspace_id
     AND current_state.state = 'approved'
     AND NOT EXISTS (
       SELECT 1 FROM plan_states newer_state
       WHERE newer_state.workspace_id = current_state.workspace_id
         AND newer_state.plan_version_id = current_state.plan_version_id
         AND (newer_state.created_at > current_state.created_at
           OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
     )
     AND NOT EXISTS (
       SELECT 1 FROM plan_states superseded_state
       WHERE superseded_state.workspace_id = plan.workspace_id
         AND superseded_state.plan_version_id = plan.id
         AND superseded_state.state = 'superseded'
     )
   JOIN commitment_offers offer ON offer.plan_version_id = plan.id
     AND offer.workspace_id = plan.workspace_id AND offer.event_id = event_row.id
     AND offer.person_id = assignment.person_id
   JOIN commitment_responses response ON response.offer_id = offer.id
     AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id
     AND response.response = 'accepted'
   WHERE json_extract(offer.terms_json, '$.planVersionId') = plan.id
     AND json_extract(offer.terms_json, '$.eventId') = event_row.id
     AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
     AND CASE accepted_speaker.role_key
           WHEN 'SPEAKER' THEN 'SPEAKER'
           WHEN 'MODERATOR' THEN 'MODERATOR'
         END = CASE assignment.assignment_type
           WHEN 'SPEAKER' THEN 'SPEAKER'
           WHEN 'participant' THEN 'SPEAKER'
           WHEN 'MODERATOR' THEN 'MODERATOR'
           WHEN 'moderator' THEN 'MODERATOR'
         END
     AND CASE assignment.assignment_type
           WHEN 'SPEAKER' THEN 'SPEAKER'
           WHEN 'participant' THEN 'SPEAKER'
           WHEN 'MODERATOR' THEN 'MODERATOR'
           WHEN 'moderator' THEN 'MODERATOR'
         END = CASE json_extract(offer.terms_json, '$.role')
           WHEN 'SPEAKER' THEN 'SPEAKER'
           WHEN 'participant' THEN 'SPEAKER'
           WHEN 'MODERATOR' THEN 'MODERATOR'
           WHEN 'moderator' THEN 'MODERATOR'
         END
     AND (SELECT COUNT(*)
          FROM event_speakers accepted_scope_speaker
          WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
            AND accepted_scope_speaker.event_id = event_row.id
            AND accepted_scope_speaker.person_id = assignment.person_id
            AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
            AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
     AND (SELECT COUNT(*) FROM plan_assignments current_assignment
          WHERE current_assignment.workspace_id = plan.workspace_id
            AND current_assignment.plan_version_id = plan.id
            AND current_assignment.person_id = assignment.person_id) = 1
     AND event_row.workspace_id = task.workspace_id AND event_row.id = task.event_id
   GROUP BY assignment.id
   HAVING COUNT(DISTINCT assignment.id) = 1
      AND COUNT(DISTINCT accepted_speaker.id) = 1
      AND COUNT(DISTINCT offer.id) = 1
      AND COUNT(DISTINCT response.id) = 1
 ) LIMIT 1`;

const CFP_TENANT_INTEGRITY_QUERIES = [
  `SELECT 1 FROM rule_versions r JOIN form_definitions d ON d.id = r.form_definition_id
   JOIN accounts a ON a.id = r.sealed_by
   WHERE d.workspace_id <> r.workspace_id OR a.workspace_id <> r.workspace_id LIMIT 1`,
  `SELECT 1 FROM form_versions f
   JOIN form_definitions d ON d.id = f.form_definition_id
   JOIN rule_versions r ON r.id = f.rule_version_id
   JOIN accounts a ON a.id = f.sealed_by
   WHERE d.workspace_id <> f.workspace_id OR r.workspace_id <> f.workspace_id
      OR a.workspace_id <> f.workspace_id OR r.form_definition_id <> f.form_definition_id LIMIT 1`,
  `SELECT 1 FROM calls c
   JOIN events e ON e.id = c.event_id
   JOIN form_versions f ON f.id = c.form_version_id
   WHERE e.workspace_id <> c.workspace_id OR f.workspace_id <> c.workspace_id LIMIT 1`,
  `SELECT 1 FROM call_extensions x
   JOIN calls c ON c.id = x.call_id
   JOIN people p ON p.id = x.person_id
   JOIN accounts a ON a.id = x.granted_by
   WHERE c.workspace_id <> x.workspace_id OR p.workspace_id <> x.workspace_id
      OR a.workspace_id <> x.workspace_id LIMIT 1`,
  `SELECT 1 FROM cfp_email_verifications v JOIN calls c ON c.id = v.call_id
   WHERE c.workspace_id <> v.workspace_id LIMIT 1`,
  `SELECT 1 FROM cfp_email_verification_consumptions c
   JOIN cfp_email_verifications v ON v.id = c.verification_id
   JOIN people p ON p.id = c.person_id
   WHERE v.workspace_id <> c.workspace_id OR p.workspace_id <> c.workspace_id
      OR lower(v.email) <> lower(p.canonical_email) LIMIT 1`,
  `SELECT 1 FROM cfp_applicant_sessions s
   JOIN calls c ON c.id = s.call_id
   JOIN people p ON p.id = s.person_id
   JOIN cfp_email_verifications v ON v.id = s.verification_id
   LEFT JOIN accounts a ON a.id = s.revoked_by
   WHERE c.workspace_id <> s.workspace_id OR p.workspace_id <> s.workspace_id
      OR v.workspace_id <> s.workspace_id OR v.call_id <> s.call_id
      OR lower(v.email) <> lower(p.canonical_email)
      OR s.expires_at <= s.created_at
      OR (s.revoked_by IS NOT NULL AND (a.workspace_id <> s.workspace_id OR a.id IS NULL))
      OR (s.revoked_at IS NULL AND (s.revoked_by IS NOT NULL OR s.revoked_reason IS NOT NULL))
      OR (s.revoked_at IS NOT NULL AND (
        s.revoked_by IS NULL OR s.revoked_reason IS NULL
        OR length(s.revoked_at) = 0 OR length(s.revoked_reason) = 0
      )) LIMIT 1`,
   `SELECT 1
    FROM cfp_applicant_sessions s
    LEFT JOIN cfp_email_verification_consumptions consumed
      ON consumed.workspace_id = s.workspace_id
     AND consumed.verification_id = s.verification_id
     AND consumed.person_id = s.person_id
    WHERE consumed.id IS NULL LIMIT 1`,
   `SELECT 1 FROM calls
    WHERE updated_at < created_at LIMIT 1`,
  `SELECT 1 FROM submissions s
   JOIN events e ON e.id = s.event_id
   JOIN calls c ON c.id = s.call_id
   JOIN people p ON p.id = s.owner_person_id
   JOIN form_versions f ON f.id = s.pinned_form_version_id
   JOIN rule_versions r ON r.id = s.pinned_rule_version_id
   JOIN form_definitions pinned_definition ON pinned_definition.id = f.form_definition_id
   JOIN form_versions call_form ON call_form.id = c.form_version_id
   JOIN form_definitions call_definition ON call_definition.id = call_form.form_definition_id
   WHERE e.workspace_id <> s.workspace_id OR c.workspace_id <> s.workspace_id
      OR p.workspace_id <> s.workspace_id OR f.workspace_id <> s.workspace_id
      OR r.workspace_id <> s.workspace_id OR c.event_id <> s.event_id
      OR f.rule_version_id <> s.pinned_rule_version_id
      OR f.form_definition_id <> r.form_definition_id
      OR f.version_number <> r.version_number
      OR call_form.workspace_id <> s.workspace_id
      OR call_definition.workspace_id <> s.workspace_id
      OR call_definition.id <> pinned_definition.id LIMIT 1`,
   `SELECT 1 FROM submissions s
    LEFT JOIN submission_revisions current_revision ON current_revision.id = s.current_revision_id
    WHERE s.updated_at < s.created_at
       OR (s.current_revision_id IS NULL AND EXISTS (
         SELECT 1 FROM submission_revisions orphan
         WHERE orphan.workspace_id = s.workspace_id AND orphan.submission_id = s.id
       ))
       OR (s.current_revision_id IS NOT NULL AND (
         current_revision.id IS NULL
         OR current_revision.workspace_id <> s.workspace_id
         OR current_revision.submission_id <> s.id
         OR current_revision.form_version_id <> s.pinned_form_version_id
         OR current_revision.rule_version_id <> s.pinned_rule_version_id
         OR current_revision.revision_number <> (
           SELECT MAX(all_revisions.revision_number)
           FROM submission_revisions all_revisions
           WHERE all_revisions.workspace_id = s.workspace_id
             AND all_revisions.submission_id = s.id
         )
         OR (
           SELECT COUNT(*)
           FROM submission_revisions all_revisions
           WHERE all_revisions.workspace_id = s.workspace_id
             AND all_revisions.submission_id = s.id
         ) <> current_revision.revision_number
       )) LIMIT 1`,
  `SELECT 1 FROM submission_revisions r
   JOIN submissions s ON s.id = r.submission_id
   JOIN form_versions f ON f.id = r.form_version_id
   JOIN rule_versions rule_version ON rule_version.id = r.rule_version_id
   JOIN calls c ON c.id = s.call_id
   JOIN cfp_applicant_sessions session_row ON session_row.id = r.session_id
   JOIN people person ON person.id = r.person_id
   LEFT JOIN cfp_email_verification_consumptions consumed
     ON consumed.workspace_id = r.workspace_id
    AND consumed.verification_id = session_row.verification_id
    AND consumed.person_id = session_row.person_id
   WHERE s.workspace_id <> r.workspace_id OR f.workspace_id <> r.workspace_id
      OR rule_version.workspace_id <> r.workspace_id
      OR session_row.workspace_id <> r.workspace_id OR person.workspace_id <> r.workspace_id
      OR s.pinned_form_version_id <> r.form_version_id
      OR s.pinned_rule_version_id <> r.rule_version_id
      OR f.rule_version_id <> r.rule_version_id
      OR f.version_number <> rule_version.version_number
      OR s.owner_person_id <> r.person_id
       OR session_row.call_id <> s.call_id
       OR session_row.person_id <> r.person_id
       OR r.created_at < session_row.created_at
       OR r.created_at >= session_row.expires_at
       OR consumed.id IS NULL
       OR c.workspace_id <> r.workspace_id LIMIT 1`,
  `SELECT 1 FROM calls c
   WHERE json_valid(c.policy_json) <> 1
      OR (
         json_valid(c.policy_json) = 1
         AND (
            json_type(c.policy_json, '$.choices') IS NOT 'array'
            OR json_type(c.policy_json, '$.disclosure') IS NOT 'object'
           OR json_extract(c.policy_json, '$.schema') IS NOT c.policy_schema
          OR json_extract(c.policy_json, '$.policyVersionId') IS NOT c.policy_version_id
         )
       ) LIMIT 1`,
  `SELECT 1
   FROM calls c
   WHERE json_valid(c.policy_json) = 1
     AND (
       json_type(c.policy_json, '$') IS NOT 'object'
       OR (SELECT COUNT(*) FROM json_each(c.policy_json)) <> 4
       OR EXISTS (
         SELECT 1 FROM json_each(c.policy_json) property
         WHERE property.key NOT IN ('schema', 'policyVersionId', 'disclosure', 'choices')
       )
       OR json_type(c.policy_json, '$.schema') IS NOT 'text'
       OR json_type(c.policy_json, '$.policyVersionId') IS NOT 'text'
       OR json_type(c.policy_json, '$.disclosure') IS NOT 'object'
       OR (SELECT COUNT(*) FROM json_each(c.policy_json, '$.disclosure')) <> 6
       OR EXISTS (
         SELECT 1 FROM json_each(c.policy_json, '$.disclosure') property
         WHERE property.key NOT IN ('privacy', 'retention', 'aiProcessing', 'communication', 'consent', 'publication')
       )
        OR json_type(c.policy_json, '$.disclosure.privacy') IS NULL
        OR json_type(c.policy_json, '$.disclosure.retention') IS NULL
        OR json_type(c.policy_json, '$.disclosure.aiProcessing') IS NULL
        OR json_type(c.policy_json, '$.disclosure.communication') IS NULL
        OR json_type(c.policy_json, '$.disclosure.consent') IS NULL
        OR json_type(c.policy_json, '$.disclosure.publication') IS NULL
       OR json_type(c.policy_json, '$.choices') IS NOT 'array'
       OR EXISTS (
         SELECT 1
          FROM json_each(c.policy_json, '$.choices') choice
          WHERE choice.type IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(choice.value)) <> 3
            OR EXISTS (
              SELECT 1 FROM json_each(choice.value) property
              WHERE property.key NOT IN ('fieldId', 'statement', 'required')
            )
            OR json_type(choice.value, '$.fieldId') IS NOT 'text'
            OR json_type(choice.value, '$.statement') IS NOT 'text'
             OR json_type(choice.value, '$.required') IS NULL
             OR json_type(choice.value, '$.required') NOT IN ('true', 'false')
       )
     )
   LIMIT 1`,
  `SELECT 1 FROM submission_revisions r
   WHERE json_valid(r.revision_json) <> 1
      OR (
        json_valid(r.revision_json) = 1
        AND (
          json_extract(r.revision_json, '$.schema') IS NOT r.revision_schema
          OR json_extract(r.revision_json, '$.submissionId') IS NOT r.submission_id
          OR json_extract(r.revision_json, '$.revisionNumber') IS NOT r.revision_number
          OR json_extract(r.revision_json, '$.fingerprintAlgorithm') IS NOT r.fingerprint_algorithm
          OR json_extract(r.revision_json, '$.fingerprint') IS NOT r.fingerprint
          OR json_extract(r.revision_json, '$.formDocument.schema') IS NOT r.form_document_schema
          OR json_extract(r.revision_json, '$.formDocument.formVersionId') IS NOT r.form_version_id
          OR json_extract(r.revision_json, '$.formDocument.ruleVersionId') IS NOT r.rule_version_id
          OR json_extract(r.revision_json, '$.formDocument.fingerprint') IS NOT r.form_document_fingerprint
          OR json_extract(r.revision_json, '$.callPolicy.schema') IS NOT r.policy_schema
          OR json_extract(r.revision_json, '$.callPolicy.policyVersionId') IS NOT r.policy_version_id
          OR json_extract(r.revision_json, '$.callPolicy.fingerprintAlgorithm') IS NOT r.policy_fingerprint_algorithm
          OR json_extract(r.revision_json, '$.callPolicy.fingerprint') IS NOT r.policy_fingerprint
           OR (
             r.consent_receipt_schema IS NULL
             AND (
               r.consent_receipt_policy_fingerprint IS NOT NULL
               OR json_type(r.revision_json, '$.consentReceipt') IS NOT 'null'
             )
           )
           OR (
             r.consent_receipt_schema IS NOT NULL
             AND (
                r.consent_receipt_policy_fingerprint IS NULL
                OR r.consent_receipt_schema != 'cfp-consent-receipt/v1'
                OR json_type(r.revision_json, '$.consentReceipt') IS NOT 'object'
                OR json_type(r.revision_json, '$.callPolicy.choices') IS NOT 'array'
                OR json_type(r.revision_json, '$.consentReceipt.choices') IS NOT 'array'
                 OR json_array_length(r.revision_json, '$.consentReceipt.choices') !=
                    json_array_length(r.revision_json, '$.callPolicy.choices')
                OR json_extract(r.revision_json, '$.consentReceipt.schema') IS NOT r.consent_receipt_schema
               OR json_extract(r.revision_json, '$.consentReceipt.submissionId') IS NOT r.submission_id
               OR json_extract(r.revision_json, '$.consentReceipt.personId') IS NOT r.person_id
               OR json_extract(r.revision_json, '$.consentReceipt.applicantSessionId') IS NOT r.session_id
               OR json_extract(r.revision_json, '$.consentReceipt.receivedAt') IS NOT r.created_at
                OR json_extract(r.revision_json, '$.consentReceipt.policyFingerprint') IS NOT r.consent_receipt_policy_fingerprint
                OR json_extract(r.revision_json, '$.consentReceipt.policyFingerprint') IS NOT r.policy_fingerprint
                OR EXISTS (
                  SELECT 1
                  FROM json_each(r.revision_json, '$.callPolicy.choices') policy_choice
                  WHERE NOT EXISTS (
                    SELECT 1
                     FROM json_each(r.revision_json, '$.consentReceipt.choices') receipt_choice
                     WHERE receipt_choice.key = policy_choice.key
                       AND policy_choice.type = 'object'
                       AND receipt_choice.type = 'object'
                      AND (SELECT COUNT(*) FROM json_each(receipt_choice.value)) = 2
                      AND NOT EXISTS (
                        SELECT 1 FROM json_each(receipt_choice.value) receipt_key
                        WHERE receipt_key.key NOT IN ('fieldId', 'value')
                      )
                      AND json_type(receipt_choice.value, '$.fieldId') = 'text'
                      AND json_extract(receipt_choice.value, '$.fieldId') =
                          json_extract(policy_choice.value, '$.fieldId')
                      AND json_type(receipt_choice.value, '$.value') IN ('true', 'false')
                  )
                )
              )
           )
   )
       ) LIMIT 1`,
  `SELECT 1
   FROM submission_revisions r
   WHERE json_valid(r.revision_json) = 1
     AND (
       json_type(r.revision_json, '$') IS NOT 'object'
       OR (SELECT COUNT(*) FROM json_each(r.revision_json)) <> 8
       OR EXISTS (
         SELECT 1 FROM json_each(r.revision_json) property
         WHERE property.key NOT IN (
           'schema', 'submissionId', 'revisionNumber', 'formDocument',
           'callPolicy', 'consentReceipt', 'fingerprintAlgorithm', 'fingerprint'
         )
       )
       OR json_type(r.revision_json, '$.callPolicy') IS NOT 'object'
       OR (SELECT COUNT(*) FROM json_each(r.revision_json, '$.callPolicy')) <> 6
       OR EXISTS (
         SELECT 1 FROM json_each(r.revision_json, '$.callPolicy') property
         WHERE property.key NOT IN (
           'schema', 'policyVersionId', 'disclosure', 'choices',
           'fingerprintAlgorithm', 'fingerprint'
         )
       )
       OR json_type(r.revision_json, '$.callPolicy.schema') IS NOT 'text'
       OR json_type(r.revision_json, '$.callPolicy.policyVersionId') IS NOT 'text'
       OR json_type(r.revision_json, '$.callPolicy.disclosure') IS NOT 'object'
       OR (SELECT COUNT(*) FROM json_each(r.revision_json, '$.callPolicy.disclosure')) <> 6
       OR EXISTS (
         SELECT 1 FROM json_each(r.revision_json, '$.callPolicy.disclosure') property
         WHERE property.key NOT IN ('privacy', 'retention', 'aiProcessing', 'communication', 'consent', 'publication')
       )
        OR json_type(r.revision_json, '$.callPolicy.disclosure.privacy') IS NULL
        OR json_type(r.revision_json, '$.callPolicy.disclosure.retention') IS NULL
        OR json_type(r.revision_json, '$.callPolicy.disclosure.aiProcessing') IS NULL
        OR json_type(r.revision_json, '$.callPolicy.disclosure.communication') IS NULL
        OR json_type(r.revision_json, '$.callPolicy.disclosure.consent') IS NULL
        OR json_type(r.revision_json, '$.callPolicy.disclosure.publication') IS NULL
       OR json_type(r.revision_json, '$.callPolicy.choices') IS NOT 'array'
       OR length(CAST(json_extract(r.revision_json, '$.callPolicy') AS BLOB)) > 524288
       OR EXISTS (
         SELECT 1
          FROM json_each(r.revision_json, '$.callPolicy.choices') choice
          WHERE choice.type IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(choice.value)) <> 3
            OR EXISTS (
              SELECT 1 FROM json_each(choice.value) property
              WHERE property.key NOT IN ('fieldId', 'statement', 'required')
            )
            OR json_type(choice.value, '$.fieldId') IS NOT 'text'
            OR json_type(choice.value, '$.statement') IS NOT 'text'
             OR json_type(choice.value, '$.required') IS NULL
             OR json_type(choice.value, '$.required') NOT IN ('true', 'false')
       )
       OR (
         r.consent_receipt_schema IS NULL
         AND (
           r.consent_receipt_policy_fingerprint IS NOT NULL
           OR json_type(r.revision_json, '$.consentReceipt') IS NOT 'null'
         )
       )
       OR (
         r.consent_receipt_schema IS NOT NULL
         AND (
           r.consent_receipt_policy_fingerprint IS NULL
           OR json_type(r.revision_json, '$.consentReceipt') IS NOT 'object'
           OR (SELECT COUNT(*) FROM json_each(r.revision_json, '$.consentReceipt')) <> 7
           OR EXISTS (
             SELECT 1 FROM json_each(r.revision_json, '$.consentReceipt') property
             WHERE property.key NOT IN (
               'schema', 'submissionId', 'personId', 'applicantSessionId',
               'receivedAt', 'policyFingerprint', 'choices'
             )
           )
           OR json_type(r.revision_json, '$.consentReceipt.choices') IS NOT 'array'
           OR length(CAST(json_extract(r.revision_json, '$.consentReceipt') AS BLOB)) > 65536
           OR EXISTS (
             SELECT 1
              FROM json_each(r.revision_json, '$.consentReceipt.choices') choice
              WHERE choice.type IS NOT 'object'
                OR (SELECT COUNT(*) FROM json_each(choice.value)) <> 2
                OR EXISTS (
                  SELECT 1 FROM json_each(choice.value) property
                  WHERE property.key NOT IN ('fieldId', 'value')
                )
                OR json_type(choice.value, '$.fieldId') IS NOT 'text'
                OR json_type(choice.value, '$.value') NOT IN ('true', 'false')
           )
         )
       )
     )
   LIMIT 1`,
  `SELECT 1
   FROM submissions s
   LEFT JOIN submission_revisions r
     ON r.id = s.current_revision_id
    AND r.workspace_id = s.workspace_id
    AND r.submission_id = s.id
   WHERE s.state = 'SUBMITTED'
     AND (
       s.current_revision_id IS NULL
       OR r.id IS NULL
       OR r.consent_receipt_schema IS NULL
       OR r.consent_receipt_policy_fingerprint IS NULL
       OR json_valid(r.revision_json) <> 1
       OR json_type(r.revision_json, '$.consentReceipt') IS NOT 'object'
       OR json_type(r.revision_json, '$.callPolicy.choices') IS NOT 'array'
       OR json_type(r.revision_json, '$.consentReceipt.choices') IS NOT 'array'
        OR json_array_length(r.revision_json, '$.consentReceipt.choices') !=
           json_array_length(r.revision_json, '$.callPolicy.choices')
       OR EXISTS (
         SELECT 1
          FROM json_each(r.revision_json, '$.callPolicy.choices') policy_choice
          WHERE policy_choice.type IS NOT 'object'
             OR json_extract(policy_choice.value, '$.required') = 1
           AND NOT EXISTS (
             SELECT 1
              FROM json_each(r.revision_json, '$.consentReceipt.choices') receipt_choice
              WHERE receipt_choice.key = policy_choice.key
                AND policy_choice.type = 'object'
                AND receipt_choice.type = 'object'
               AND (SELECT COUNT(*) FROM json_each(receipt_choice.value)) = 2
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(receipt_choice.value) receipt_key
                 WHERE receipt_key.key NOT IN ('fieldId', 'value')
               )
               AND json_type(receipt_choice.value, '$.fieldId') = 'text'
               AND json_extract(receipt_choice.value, '$.fieldId') =
                   json_extract(policy_choice.value, '$.fieldId')
               AND json_type(receipt_choice.value, '$.value') = 'true'
               AND json_extract(receipt_choice.value, '$.value') = 1
           )
       )
      ) LIMIT 1`,
] as const;

const REVIEW_TENANT_INTEGRITY_QUERIES = [
  `SELECT 1 FROM review_round_states
   WHERE typeof(sequence_number) <> 'integer' OR sequence_number < 1
   UNION ALL
   SELECT 1 FROM rubric_versions
   WHERE typeof(version_number) <> 'integer' OR version_number < 1
      OR typeof(fingerprint) <> 'text' OR length(fingerprint) <> 64
      OR length(CAST(fingerprint AS BLOB)) <> 64
      OR fingerprint GLOB '*[^0-9a-f]*'
   UNION ALL
   SELECT 1 FROM review_assignment_states
   WHERE typeof(sequence_number) <> 'integer' OR sequence_number < 1
   UNION ALL
   SELECT 1 FROM review_conflict_dispositions
   WHERE typeof(sequence_number) <> 'integer' OR sequence_number < 1
      OR typeof(actor_role_basis) <> 'text'
      OR length(CAST(actor_role_basis AS BLOB)) NOT BETWEEN 1 AND 128
      OR typeof(reason) <> 'text'
      OR length(CAST(reason AS BLOB)) NOT BETWEEN 1 AND 4096
   UNION ALL
   SELECT 1 FROM review_revisions
   WHERE typeof(revision_number) <> 'integer' OR revision_number < 1
      OR typeof(fingerprint) <> 'text' OR length(fingerprint) <> 64
      OR length(CAST(fingerprint AS BLOB)) <> 64
      OR fingerprint GLOB '*[^0-9a-f]*'
   LIMIT 1`,
  `SELECT 1 FROM review_rounds r
   JOIN events e ON e.id = r.event_id
   JOIN calls c ON c.id = r.call_id
   JOIN accounts a ON a.id = r.created_by
   WHERE e.workspace_id <> r.workspace_id OR c.workspace_id <> r.workspace_id
      OR a.workspace_id <> r.workspace_id OR c.event_id <> r.event_id LIMIT 1`,
  `SELECT 1 FROM review_round_states s
   JOIN review_rounds r ON r.id = s.round_id
   JOIN accounts a ON a.id = s.actor_account_id
   WHERE r.workspace_id <> s.workspace_id OR a.workspace_id <> s.workspace_id LIMIT 1`,
  `SELECT 1 FROM review_rounds r
   LEFT JOIN review_round_states s1 ON s1.round_id = r.id AND s1.sequence_number = 1
   WHERE s1.id IS NULL OR s1.state <> 'DRAFT' LIMIT 1`,
  `SELECT 1 FROM review_round_states cur
   LEFT JOIN review_round_states prev ON prev.round_id = cur.round_id AND prev.sequence_number = cur.sequence_number - 1
   WHERE cur.sequence_number > 1 AND (
     prev.id IS NULL
     OR (prev.state = 'DRAFT' AND cur.state NOT IN ('OPEN', 'CANCELLED'))
     OR (prev.state = 'OPEN' AND cur.state NOT IN ('CLOSED', 'CANCELLED'))
     OR (prev.state IN ('CLOSED', 'CANCELLED'))
   ) LIMIT 1`,
  `SELECT 1 FROM rubric_versions v
   JOIN review_rounds r ON r.id = v.round_id
   JOIN accounts a ON a.id = v.sealed_by
   WHERE r.workspace_id <> v.workspace_id OR a.workspace_id <> v.workspace_id
      OR v.rubric_schema <> 'cfp-rubric/v1' OR v.fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(v.version_number) <> 'integer' OR v.version_number < 1
      OR typeof(v.fingerprint) <> 'text'
      OR length(v.fingerprint) <> 64 OR length(CAST(v.fingerprint AS BLOB)) <> 64
      OR v.fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(v.sealed_at) <> 'text' OR length(v.sealed_at) = 0
      OR json_valid(v.rubric_json) <> 1 LIMIT 1`,
  `SELECT 1 FROM review_assignments a
   JOIN review_rounds r ON r.id = a.round_id
   JOIN rubric_versions rub ON rub.id = a.rubric_version_id
   JOIN submissions s ON s.id = a.submission_id
   JOIN submission_revisions rev ON rev.id = a.submission_revision_id
   JOIN accounts reviewer ON reviewer.id = a.reviewer_account_id
   JOIN accounts assigner ON assigner.id = a.assigned_by
   WHERE r.workspace_id <> a.workspace_id OR rub.workspace_id <> a.workspace_id
      OR s.workspace_id <> a.workspace_id OR rev.workspace_id <> a.workspace_id
      OR reviewer.workspace_id <> a.workspace_id OR assigner.workspace_id <> a.workspace_id
      OR rub.round_id <> a.round_id
      OR s.event_id <> r.event_id OR s.call_id <> r.call_id
      OR rev.submission_id <> a.submission_id LIMIT 1`,
  `SELECT 1 FROM review_assignments a
   JOIN review_assignments prior ON prior.id = a.supersedes_assignment_id
   WHERE prior.workspace_id <> a.workspace_id
      OR prior.round_id <> a.round_id
      OR prior.submission_id <> a.submission_id
      OR prior.submission_revision_id <> a.submission_revision_id
      OR prior.id = a.id LIMIT 1`,
  `SELECT supersedes_assignment_id FROM review_assignments
   WHERE supersedes_assignment_id IS NOT NULL
   GROUP BY supersedes_assignment_id HAVING COUNT(*) > 1 LIMIT 1`,
  `WITH RECURSIVE chain(start_id, current_id) AS (
     SELECT id, supersedes_assignment_id
     FROM review_assignments
     WHERE supersedes_assignment_id IS NOT NULL
     UNION
     SELECT chain.start_id, a.supersedes_assignment_id
     FROM chain
     JOIN review_assignments a ON a.id = chain.current_id
     WHERE a.supersedes_assignment_id IS NOT NULL
   )
   SELECT 1 FROM chain WHERE start_id = current_id LIMIT 1`,
  `SELECT 1 FROM review_assignments a
   JOIN review_assignments prior ON prior.id = a.supersedes_assignment_id
   LEFT JOIN review_assignment_states latest_prior_state ON latest_prior_state.assignment_id = prior.id
     AND latest_prior_state.sequence_number = (
       SELECT MAX(s.sequence_number)
       FROM review_assignment_states s
       WHERE s.assignment_id = prior.id
     )
   WHERE latest_prior_state.id IS NULL OR latest_prior_state.state NOT IN ('RECUSED', 'REVOKED') LIMIT 1`,
  `SELECT 1 FROM review_assignment_states s
   JOIN review_assignments a ON a.id = s.assignment_id
   JOIN accounts actor ON actor.id = s.actor_account_id
   WHERE a.workspace_id <> s.workspace_id OR actor.workspace_id <> s.workspace_id LIMIT 1`,
  `SELECT 1 FROM review_assignments a
   LEFT JOIN review_assignment_states s1 ON s1.assignment_id = a.id AND s1.sequence_number = 1
   WHERE s1.id IS NULL OR s1.state <> 'ASSIGNED' LIMIT 1`,
  `SELECT 1 FROM review_assignment_states cur
   LEFT JOIN review_assignment_states prev ON prev.assignment_id = cur.assignment_id AND prev.sequence_number = cur.sequence_number - 1
   WHERE cur.sequence_number > 1 AND (
     prev.id IS NULL
     OR (prev.state = 'ASSIGNED' AND cur.state NOT IN ('IN_PROGRESS', 'SUBMITTED', 'RECUSED', 'REVOKED'))
     OR (prev.state = 'IN_PROGRESS' AND cur.state NOT IN ('SUBMITTED', 'RECUSED', 'REVOKED'))
     OR (prev.state IN ('SUBMITTED', 'RECUSED', 'REVOKED'))
   ) LIMIT 1`,
  `SELECT 1 FROM review_conflict_dispositions d
   JOIN review_assignments a ON a.id = d.assignment_id
   JOIN accounts actor ON actor.id = d.actor_account_id
   WHERE a.workspace_id <> d.workspace_id OR actor.workspace_id <> d.workspace_id
      OR typeof(d.actor_role_basis) <> 'text'
      OR length(CAST(d.actor_role_basis AS BLOB)) NOT BETWEEN 1 AND 128
      OR typeof(d.reason) <> 'text'
      OR length(CAST(d.reason AS BLOB)) NOT BETWEEN 1 AND 4096 LIMIT 1`,
  `SELECT 1 FROM review_conflict_dispositions d
   WHERE d.sequence_number = 1 AND d.action <> 'DECLARE' LIMIT 1`,
  `SELECT 1 FROM review_conflict_dispositions d
   LEFT JOIN review_conflict_dispositions s1 ON s1.assignment_id = d.assignment_id AND s1.sequence_number = 1
   WHERE s1.id IS NULL LIMIT 1`,
  `SELECT 1 FROM review_conflict_dispositions cur
   LEFT JOIN review_conflict_dispositions prev ON prev.assignment_id = cur.assignment_id AND prev.sequence_number = cur.sequence_number - 1
   WHERE cur.sequence_number > 1 AND (
     prev.id IS NULL
     OR (prev.action = 'DECLARE' AND cur.action NOT IN ('CLEAR', 'WAIVE'))
     OR (prev.action = 'CLEAR' AND cur.action <> 'DECLARE')
     OR (prev.action = 'WAIVE')
   ) LIMIT 1`,
  `SELECT 1 FROM review_revisions rev
   JOIN review_assignments a ON a.id = rev.assignment_id
   WHERE a.workspace_id <> rev.workspace_id
      OR a.round_id <> rev.round_id
      OR a.rubric_version_id <> rev.rubric_version_id
      OR a.submission_id <> rev.submission_id
      OR a.submission_revision_id <> rev.submission_revision_id
      OR rev.evaluation_schema <> 'cfp-review-evaluation/v1' OR rev.fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(rev.revision_number) <> 'integer' OR rev.revision_number < 1
      OR typeof(rev.fingerprint) <> 'text'
      OR length(rev.fingerprint) <> 64 OR length(CAST(rev.fingerprint AS BLOB)) <> 64
      OR rev.fingerprint GLOB '*[^0-9a-f]*'
      OR json_valid(rev.evaluation_json) <> 1 LIMIT 1`,
  `SELECT 1 FROM review_revisions cur
   LEFT JOIN review_revisions prev ON prev.assignment_id = cur.assignment_id AND prev.revision_number = cur.revision_number - 1
   WHERE cur.revision_number > 1 AND prev.id IS NULL LIMIT 1`,
] as const;

const TRUSTED_REVIEW_INTEGRITY_QUERIES = [
  `SELECT 1 FROM review_rubric_semantics
   WHERE typeof(rubric_version_number) <> 'integer' OR rubric_version_number < 1
      OR typeof(rubric_version_fingerprint) <> 'text'
      OR length(rubric_version_fingerprint) <> 64
      OR length(CAST(rubric_version_fingerprint AS BLOB)) <> 64
      OR rubric_version_fingerprint GLOB '*[^0-9a-f]*'
      OR semantics_schema <> 'cfp-review-rubric-semantics/v1'
      OR typeof(semantics_version) <> 'integer' OR semantics_version <> 1
      OR typeof(semantics_json) <> 'text' OR json_valid(semantics_json) <> 1
      OR fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(fingerprint) <> 'text' OR length(fingerprint) <> 64
      OR length(CAST(fingerprint AS BLOB)) <> 64 OR fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(issuer_role) <> 'text'
      OR length(CAST(issuer_role AS BLOB)) NOT BETWEEN 1 AND 128
      OR issuer_role NOT IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
      OR issuer_authority <> 'phase0.pipeline.manage'
      OR typeof(idempotency_key) <> 'text'
      OR length(CAST(idempotency_key AS BLOB)) NOT BETWEEN 1 AND 128
      OR request_fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(request_fingerprint) <> 'text' OR length(request_fingerprint) <> 64
      OR length(CAST(request_fingerprint AS BLOB)) <> 64
      OR request_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(issued_at) <> 'text' OR length(issued_at) = 0
   UNION ALL
   SELECT 1 FROM review_blind_artifacts
   WHERE typeof(assignment_created_at) <> 'text' OR length(assignment_created_at) = 0
      OR typeof(rubric_semantics_fingerprint) <> 'text'
      OR length(rubric_semantics_fingerprint) <> 64
      OR length(CAST(rubric_semantics_fingerprint AS BLOB)) <> 64
      OR rubric_semantics_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(submission_revision_number) <> 'integer' OR submission_revision_number < 1
      OR submission_revision_schema <> 'cfp-submission-revision/v1'
      OR submission_revision_fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(submission_revision_fingerprint) <> 'text'
      OR length(submission_revision_fingerprint) <> 64
      OR length(CAST(submission_revision_fingerprint AS BLOB)) <> 64
      OR submission_revision_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(submission_revision_created_at) <> 'text'
      OR length(submission_revision_created_at) = 0
      OR form_document_schema <> 'cfp-form-document/v1'
      OR typeof(form_document_fingerprint) <> 'text'
      OR length(form_document_fingerprint) <> 64
      OR length(CAST(form_document_fingerprint AS BLOB)) <> 64
      OR form_document_fingerprint GLOB '*[^0-9a-f]*'
      OR disclosure_stage <> 'BLIND_REVIEW'
      OR conflict_status_at_issuance NOT IN ('NONE', 'CLEARED', 'WAIVED')
      OR typeof(conflict_sequence_at_issuance) <> 'integer'
      OR conflict_sequence_at_issuance < 0
      OR (conflict_status_at_issuance = 'NONE' AND conflict_sequence_at_issuance <> 0)
      OR (conflict_status_at_issuance IN ('CLEARED', 'WAIVED') AND conflict_sequence_at_issuance < 1)
      OR artifact_schema <> 'cfp-review-blind-artifact/v1'
      OR typeof(artifact_version) <> 'integer' OR artifact_version <> 1
      OR typeof(artifact_json) <> 'text' OR json_valid(artifact_json) <> 1
      OR fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(fingerprint) <> 'text' OR length(fingerprint) <> 64
      OR length(CAST(fingerprint AS BLOB)) <> 64 OR fingerprint GLOB '*[^0-9a-f]*'
      OR blind_safety_attestation <> 'ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION'
      OR typeof(issuer_role) <> 'text'
      OR length(CAST(issuer_role AS BLOB)) NOT BETWEEN 1 AND 128
      OR issuer_role NOT IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
      OR issuer_authority <> 'phase0.pipeline.manage'
      OR typeof(idempotency_key) <> 'text'
      OR length(CAST(idempotency_key AS BLOB)) NOT BETWEEN 1 AND 128
      OR request_fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(request_fingerprint) <> 'text' OR length(request_fingerprint) <> 64
      OR length(CAST(request_fingerprint AS BLOB)) <> 64
      OR request_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(issued_at) <> 'text' OR length(issued_at) = 0
   UNION ALL
   SELECT 1 FROM review_command_receipts
   WHERE command_kind NOT IN ('CONFLICT_DECLARE', 'CONFLICT_CLEAR', 'SAVE_REVIEW', 'SUBMIT_REVIEW')
      OR typeof(idempotency_key) <> 'text'
      OR length(CAST(idempotency_key AS BLOB)) NOT BETWEEN 1 AND 128
      OR request_schema <> 'cfp-review-command-request/v1'
      OR request_fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(request_fingerprint) <> 'text' OR length(request_fingerprint) <> 64
      OR length(CAST(request_fingerprint AS BLOB)) <> 64
      OR request_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(effect_id) <> 'text' OR length(effect_id) = 0
      OR receipt_schema <> 'cfp-review-command-receipt/v1'
      OR typeof(receipt_json) <> 'text' OR json_valid(receipt_json) <> 1
      OR receipt_fingerprint_algorithm <> 'sha256-canonical-json-v1'
      OR typeof(receipt_fingerprint) <> 'text' OR length(receipt_fingerprint) <> 64
      OR length(CAST(receipt_fingerprint AS BLOB)) <> 64
      OR receipt_fingerprint GLOB '*[^0-9a-f]*'
      OR typeof(created_at) <> 'text' OR length(created_at) = 0
   LIMIT 1`,
  `SELECT 1
   FROM review_rubric_semantics semantics
   WHERE NOT EXISTS (
     SELECT 1
     FROM rubric_versions rubric
     JOIN review_rounds round ON round.id = rubric.round_id
     JOIN accounts issuer ON issuer.id = semantics.issued_by_account_id
     WHERE rubric.id = semantics.rubric_version_id
       AND rubric.workspace_id = semantics.workspace_id
       AND rubric.round_id = semantics.round_id
       AND rubric.version_number = semantics.rubric_version_number
       AND rubric.fingerprint = semantics.rubric_version_fingerprint
       AND round.id = semantics.round_id
       AND round.workspace_id = semantics.workspace_id
       AND issuer.workspace_id = semantics.workspace_id
   )
   OR json_type(semantics.semantics_json, '$') IS NOT 'object'
   OR json_extract(semantics.semantics_json, '$.schema') IS NOT semantics.semantics_schema
   OR json_extract(semantics.semantics_json, '$.version') IS NOT semantics.semantics_version
   OR json_extract(semantics.semantics_json, '$.workspaceId') IS NOT semantics.workspace_id
   OR json_extract(semantics.semantics_json, '$.roundId') IS NOT semantics.round_id
   OR json_extract(semantics.semantics_json, '$.rubricVersionId') IS NOT semantics.rubric_version_id
   OR json_extract(semantics.semantics_json, '$.rubricVersionNumber') IS NOT semantics.rubric_version_number
   OR json_extract(semantics.semantics_json, '$.rubricVersionFingerprint') IS NOT semantics.rubric_version_fingerprint
   OR json_extract(semantics.semantics_json, '$.issuer.accountId') IS NOT semantics.issued_by_account_id
   OR json_extract(semantics.semantics_json, '$.issuer.role') IS NOT semantics.issuer_role
   OR json_extract(semantics.semantics_json, '$.issuer.authority') IS NOT semantics.issuer_authority
   OR json_extract(semantics.semantics_json, '$.issuedAt') IS NOT semantics.issued_at
   LIMIT 1`,
  `SELECT 1
   FROM review_blind_artifacts artifact
   WHERE NOT EXISTS (
     SELECT 1
     FROM review_assignments assignment
     JOIN review_rounds round ON round.id = assignment.round_id
     JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
     JOIN review_rubric_semantics semantics ON semantics.id = artifact.rubric_semantics_id
     JOIN submissions submission ON submission.id = assignment.submission_id
     JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
     JOIN form_versions form ON form.id = revision.form_version_id
     JOIN rule_versions rule ON rule.id = revision.rule_version_id
     JOIN accounts issuer ON issuer.id = artifact.issued_by_account_id
     WHERE assignment.id = artifact.assignment_id
       AND assignment.workspace_id = artifact.workspace_id
       AND assignment.created_at = artifact.assignment_created_at
       AND assignment.rubric_version_id = artifact.rubric_version_id
       AND assignment.submission_id = artifact.submission_id
       AND assignment.submission_revision_id = artifact.submission_revision_id
       AND round.workspace_id = artifact.workspace_id
       AND rubric.workspace_id = artifact.workspace_id
       AND rubric.round_id = assignment.round_id
       AND semantics.workspace_id = artifact.workspace_id
       AND semantics.round_id = assignment.round_id
       AND semantics.rubric_version_id = artifact.rubric_version_id
       AND semantics.fingerprint = artifact.rubric_semantics_fingerprint
       AND submission.workspace_id = artifact.workspace_id
       AND submission.state = 'SUBMITTED'
       AND submission.current_revision_id = artifact.submission_revision_id
       AND revision.workspace_id = artifact.workspace_id
       AND revision.submission_id = artifact.submission_id
       AND revision.revision_number = artifact.submission_revision_number
       AND revision.revision_schema = artifact.submission_revision_schema
       AND revision.fingerprint_algorithm = artifact.submission_revision_fingerprint_algorithm
       AND revision.fingerprint = artifact.submission_revision_fingerprint
       AND revision.created_at = artifact.submission_revision_created_at
       AND revision.form_document_schema = artifact.form_document_schema
       AND revision.form_version_id = artifact.form_version_id
       AND revision.rule_version_id = artifact.rule_version_id
       AND revision.form_document_fingerprint = artifact.form_document_fingerprint
       AND form.workspace_id = artifact.workspace_id
       AND form.document_schema = artifact.form_document_schema
       AND form.rule_version_id = artifact.rule_version_id
       AND rule.workspace_id = artifact.workspace_id
       AND rule.id = artifact.rule_version_id
       AND rule.form_definition_id = form.form_definition_id
       AND issuer.workspace_id = artifact.workspace_id
       AND (
         (artifact.conflict_status_at_issuance = 'NONE' AND artifact.conflict_sequence_at_issuance = 0)
         OR EXISTS (
           SELECT 1
           FROM review_conflict_dispositions disposition
           WHERE disposition.workspace_id = artifact.workspace_id
             AND disposition.assignment_id = artifact.assignment_id
             AND disposition.sequence_number = artifact.conflict_sequence_at_issuance
             AND (
               (artifact.conflict_status_at_issuance = 'CLEARED' AND disposition.action = 'CLEAR')
               OR (artifact.conflict_status_at_issuance = 'WAIVED' AND disposition.action = 'WAIVE')
             )
         )
       )
   )
   OR json_type(artifact.artifact_json, '$') IS NOT 'object'
   OR json_extract(artifact.artifact_json, '$.schema') IS NOT artifact.artifact_schema
   OR json_extract(artifact.artifact_json, '$.version') IS NOT artifact.artifact_version
   OR json_extract(artifact.artifact_json, '$.workspaceId') IS NOT artifact.workspace_id
   OR json_extract(artifact.artifact_json, '$.assignmentId') IS NOT artifact.assignment_id
   OR json_extract(artifact.artifact_json, '$.assignmentCreatedAt') IS NOT artifact.assignment_created_at
   OR json_extract(artifact.artifact_json, '$.rubricVersionId') IS NOT artifact.rubric_version_id
   OR json_extract(artifact.artifact_json, '$.rubricSemanticsId') IS NOT artifact.rubric_semantics_id
   OR json_extract(artifact.artifact_json, '$.rubricSemanticsFingerprint') IS NOT artifact.rubric_semantics_fingerprint
   OR json_extract(artifact.artifact_json, '$.submissionId') IS NOT artifact.submission_id
   OR json_extract(artifact.artifact_json, '$.submissionRevision.id') IS NOT artifact.submission_revision_id
   OR json_extract(artifact.artifact_json, '$.submissionRevision.number') IS NOT artifact.submission_revision_number
   OR json_extract(artifact.artifact_json, '$.submissionRevision.schema') IS NOT artifact.submission_revision_schema
   OR json_extract(artifact.artifact_json, '$.submissionRevision.fingerprint') IS NOT artifact.submission_revision_fingerprint
   OR json_extract(artifact.artifact_json, '$.submissionRevision.createdAt') IS NOT artifact.submission_revision_created_at
   OR json_extract(artifact.artifact_json, '$.submissionRevision.formDocumentSchema') IS NOT artifact.form_document_schema
   OR json_extract(artifact.artifact_json, '$.submissionRevision.formVersionId') IS NOT artifact.form_version_id
   OR json_extract(artifact.artifact_json, '$.submissionRevision.ruleVersionId') IS NOT artifact.rule_version_id
   OR json_extract(artifact.artifact_json, '$.submissionRevision.formDocumentFingerprint') IS NOT artifact.form_document_fingerprint
   OR json_extract(artifact.artifact_json, '$.disclosureStage') IS NOT artifact.disclosure_stage
   OR json_extract(artifact.artifact_json, '$.conflictAtIssuance.status') IS NOT artifact.conflict_status_at_issuance
   OR json_extract(artifact.artifact_json, '$.conflictAtIssuance.sequenceNumber') IS NOT artifact.conflict_sequence_at_issuance
   OR json_extract(artifact.artifact_json, '$.attestation') IS NOT artifact.blind_safety_attestation
   OR json_extract(artifact.artifact_json, '$.issuer.accountId') IS NOT artifact.issued_by_account_id
   OR json_extract(artifact.artifact_json, '$.issuer.role') IS NOT artifact.issuer_role
   OR json_extract(artifact.artifact_json, '$.issuer.authority') IS NOT artifact.issuer_authority
   OR json_extract(artifact.artifact_json, '$.issuedAt') IS NOT artifact.issued_at
   LIMIT 1`,
  `SELECT 1
   FROM review_command_receipts receipt
   WHERE NOT EXISTS (
     SELECT 1
     FROM review_assignments assignment
     JOIN review_rounds round ON round.id = assignment.round_id
     JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
     JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
     JOIN accounts actor ON actor.id = receipt.actor_account_id
     WHERE assignment.id = receipt.assignment_id
       AND assignment.workspace_id = receipt.workspace_id
       AND assignment.round_id = receipt.round_id
       AND assignment.rubric_version_id = receipt.rubric_version_id
       AND assignment.submission_revision_id = receipt.submission_revision_id
       AND assignment.reviewer_account_id = receipt.actor_account_id
       AND round.workspace_id = receipt.workspace_id
       AND rubric.workspace_id = receipt.workspace_id
       AND rubric.round_id = receipt.round_id
       AND revision.workspace_id = receipt.workspace_id
       AND revision.submission_id = assignment.submission_id
       AND actor.workspace_id = receipt.workspace_id
   )
   OR EXISTS (
     SELECT 1
     FROM review_command_receipts existing
     WHERE existing.workspace_id = receipt.workspace_id
       AND existing.command_kind = receipt.command_kind
       AND existing.effect_id = receipt.effect_id
       AND existing.id <> receipt.id
   )
   OR NOT (
     (receipt.command_kind = 'CONFLICT_DECLARE' AND EXISTS (
       SELECT 1 FROM review_conflict_dispositions effect
       WHERE effect.id = receipt.effect_id
         AND effect.workspace_id = receipt.workspace_id
         AND effect.assignment_id = receipt.assignment_id
         AND effect.action = 'DECLARE'
         AND effect.actor_account_id = receipt.actor_account_id
         AND effect.created_at = receipt.created_at
     ))
     OR (receipt.command_kind = 'CONFLICT_CLEAR' AND EXISTS (
       SELECT 1 FROM review_conflict_dispositions effect
       WHERE effect.id = receipt.effect_id
         AND effect.workspace_id = receipt.workspace_id
         AND effect.assignment_id = receipt.assignment_id
         AND effect.action = 'CLEAR'
         AND effect.actor_account_id = receipt.actor_account_id
         AND effect.created_at = receipt.created_at
     ))
     OR (receipt.command_kind = 'SAVE_REVIEW' AND EXISTS (
       SELECT 1 FROM review_revisions effect
       WHERE effect.id = receipt.effect_id
         AND effect.workspace_id = receipt.workspace_id
         AND effect.assignment_id = receipt.assignment_id
         AND effect.round_id = receipt.round_id
         AND effect.rubric_version_id = receipt.rubric_version_id
         AND effect.submission_revision_id = receipt.submission_revision_id
         AND effect.created_at = receipt.created_at
     ))
     OR (receipt.command_kind = 'SUBMIT_REVIEW' AND EXISTS (
       SELECT 1 FROM review_assignment_states effect
       WHERE effect.id = receipt.effect_id
         AND effect.workspace_id = receipt.workspace_id
         AND effect.assignment_id = receipt.assignment_id
         AND effect.state = 'SUBMITTED'
         AND effect.actor_account_id = receipt.actor_account_id
         AND effect.created_at = receipt.created_at
     ))
   )
   OR json_type(receipt.receipt_json, '$') IS NOT 'object'
   OR json_extract(receipt.receipt_json, '$.schema') IS NOT receipt.receipt_schema
   OR json_extract(receipt.receipt_json, '$.workspaceId') IS NOT receipt.workspace_id
   OR json_extract(receipt.receipt_json, '$.assignmentId') IS NOT receipt.assignment_id
   OR json_extract(receipt.receipt_json, '$.roundId') IS NOT receipt.round_id
   OR json_extract(receipt.receipt_json, '$.rubricVersionId') IS NOT receipt.rubric_version_id
   OR json_extract(receipt.receipt_json, '$.submissionRevisionId') IS NOT receipt.submission_revision_id
   OR json_extract(receipt.receipt_json, '$.actorAccountId') IS NOT receipt.actor_account_id
   OR json_extract(receipt.receipt_json, '$.commandKind') IS NOT receipt.command_kind
   OR json_extract(receipt.receipt_json, '$.effectId') IS NOT receipt.effect_id
   OR json_extract(receipt.receipt_json, '$.createdAt') IS NOT receipt.created_at
   OR NOT (
     (
       receipt.command_kind = 'SAVE_REVIEW'
       AND json_type(receipt.receipt_json, '$.outcome') IS 'object'
       AND (SELECT COUNT(*) FROM json_each(receipt.receipt_json, '$.outcome')) = 2
       AND NOT EXISTS (
         SELECT 1
         FROM json_each(receipt.receipt_json, '$.outcome') outcome_key
         WHERE outcome_key.key NOT IN ('reviewRevisionId', 'reviewRevisionNumber')
       )
       AND json_type(receipt.receipt_json, '$.outcome.reviewRevisionId') IS 'text'
       AND json_extract(receipt.receipt_json, '$.outcome.reviewRevisionId') IS receipt.effect_id
       AND json_type(receipt.receipt_json, '$.outcome.reviewRevisionNumber') IS 'integer'
       AND EXISTS (
         SELECT 1
         FROM review_revisions effect
         WHERE effect.id = receipt.effect_id
           AND effect.revision_number =
               json_extract(receipt.receipt_json, '$.outcome.reviewRevisionNumber')
       )
     )
     OR
     (
       receipt.command_kind IN ('CONFLICT_DECLARE', 'CONFLICT_CLEAR', 'SUBMIT_REVIEW')
       AND json_type(receipt.receipt_json, '$.outcome') IS 'object'
       AND (SELECT COUNT(*) FROM json_each(receipt.receipt_json, '$.outcome')) = 1
       AND NOT EXISTS (
         SELECT 1
         FROM json_each(receipt.receipt_json, '$.outcome') outcome_key
         WHERE outcome_key.key != 'effectId'
       )
       AND json_type(receipt.receipt_json, '$.outcome.effectId') IS 'text'
       AND json_extract(receipt.receipt_json, '$.outcome.effectId') IS receipt.effect_id
     )
   )
   LIMIT 1`,
] as const;

function validateVerificationIssuanceIntegrity(db: Db): void {
  const malformedSequence = db
    .prepare(
      `SELECT 1
       FROM cfp_email_verifications
       WHERE typeof(issuance_sequence) <> 'integer'
          OR issuance_sequence < 1
          OR issuance_sequence > 9007199254740991
       LIMIT 1`,
    )
    .get();
  const malformedScope = db
    .prepare(
      `SELECT 1
       FROM cfp_email_verifications
       GROUP BY workspace_id, call_id, email
       HAVING MIN(issuance_sequence) <> 1
          OR MAX(issuance_sequence) <> COUNT(*)
          OR COUNT(DISTINCT issuance_sequence) <> COUNT(*)
       LIMIT 1`,
    )
    .get();
  if (malformedSequence || malformedScope) {
    throw new Error("database verification issuance integrity check failed");
  }
}

function validateReviewerAccessIntegrity(db: Db): void {
  const fail = (): never => {
    throw new Error("database reviewer access integrity check failed");
  };
  const validId = (value: unknown): value is string =>
    typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= 128 && !value.includes("\0");
  const validInstant = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
      return false;
    }
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  };
  const validText = (value: unknown, maximumBytes: number): value is string =>
    typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes && !value.includes("\0");
  const stateForIntent = new Map([
    ["PROVISION", "PROVISIONED"],
    ["INVITE", "INVITED"],
    ["ACTIVATE", "ACTIVE"],
  ]);
  const sequenceForState = new Map([
    ["PROVISIONED", 1],
    ["INVITED", 2],
    ["ACTIVE", 3],
  ]);
  type AccessRow = Record<string, any>;
  const receipts = db.prepare(
    `SELECT * FROM reviewer_access_receipts
     ORDER BY workspace_id, assignment_id, created_at, id`,
  ).all() as AccessRow[];
  const states = db.prepare(
    `SELECT * FROM reviewer_access_states
     ORDER BY workspace_id, assignment_id, sequence_number, created_at, id`,
  ).all() as AccessRow[];
  const issuanceAnchors = db.prepare(
    `SELECT id, workspace_id, actor_kind, actor_ref, action, target_type, target_id,
            details_json, created_at
     FROM audit_events
     WHERE action = 'cfp.review.reviewer-access'
       AND target_type = 'reviewer_access_receipt'
     ORDER BY target_id, created_at, id`,
  ).all() as AccessRow[];
  const receiptById = new Map<string, AccessRow>();
  for (const receipt of receipts) {
    if (typeof receipt.id !== "string" || receiptById.has(receipt.id)) fail();
    receiptById.set(receipt.id, receipt);
  }
  const anchorsByReceiptId = new Map<string, AccessRow[]>();
  for (const anchor of issuanceAnchors) {
    if (
      !validId(anchor.id) ||
      !validId(anchor.workspace_id) ||
      anchor.actor_kind !== "account" ||
      !validId(anchor.actor_ref) ||
      anchor.action !== "cfp.review.reviewer-access" ||
      anchor.target_type !== "reviewer_access_receipt" ||
      !validId(anchor.target_id) ||
      !validInstant(anchor.created_at)
    ) {
      fail();
    }
    const anchors = anchorsByReceiptId.get(anchor.target_id) ?? [];
    anchors.push(anchor);
    anchorsByReceiptId.set(anchor.target_id, anchors);
  }
  if (
    anchorsByReceiptId.size !== receipts.length ||
    [...anchorsByReceiptId.keys()].some((receiptId) => !receiptById.has(receiptId))
  ) {
    fail();
  }
  const stateByReceipt = new Map<string, AccessRow>();
  const stateHistory = new Map<string, AccessRow>();

  const assertIssuanceAnchor = (
    receipt: AccessRow,
    expectedSequence: number,
  ): void => {
    const anchors = anchorsByReceiptId.get(receipt.id);
    if (!anchors || anchors.length !== 1) return fail();
    const anchor = anchors[0]!;
    if (
      anchor.workspace_id !== receipt.workspace_id ||
      anchor.actor_ref !== receipt.actor_account_id ||
      anchor.target_id !== receipt.id ||
      typeof anchor.details_json !== "string" ||
      Buffer.byteLength(anchor.details_json, "utf8") > RECEIPT_JSON_MAX_BYTES
    ) {
      fail();
    }
    let details: unknown;
    try {
      details = JSON.parse(anchor.details_json) as unknown;
    } catch {
      fail();
    }
    if (details === null || typeof details !== "object" || Array.isArray(details)) fail();
    const document = details as Record<string, unknown>;
    const expectedKeys = [
      "accountPersonBindingId",
      "assignmentId",
      "credentialIssued",
      "eventId",
      "eventReviewerAssignmentId",
      "intent",
      "providerMutation",
      "receiptId",
      "reviewerAccountId",
      "reviewerPersonId",
      "roundId",
      "schema",
      "sequenceNumber",
      "state",
      "transitioned",
      "workspaceId",
    ];
    const actualKeys = Object.keys(document).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      document.schema !== "cfp-reviewer-provisioning-evidence/v3" ||
      document.workspaceId !== receipt.workspace_id ||
      document.eventId !== receipt.event_id ||
      document.roundId !== receipt.round_id ||
      document.assignmentId !== receipt.assignment_id ||
      document.eventReviewerAssignmentId !== receipt.event_reviewer_assignment_id ||
      document.reviewerAccountId !== receipt.reviewer_account_id ||
      document.reviewerPersonId !== receipt.reviewer_person_id ||
      document.accountPersonBindingId !== receipt.account_person_binding_id ||
      document.intent !== receipt.intent ||
      document.state !== receipt.state ||
      document.sequenceNumber !== expectedSequence ||
      document.receiptId !== receipt.id ||
      document.transitioned !== (receipt.transitioned === 1) ||
      document.providerMutation !== false ||
      document.credentialIssued !== false
    ) {
      fail();
    }
  };

  const assertBoundScope = (row: AccessRow): void => {
    const ids = [
      row.workspace_id,
      row.event_id,
      row.round_id,
      row.assignment_id,
      row.event_reviewer_assignment_id,
      row.reviewer_account_id,
      row.reviewer_person_id,
      row.account_person_binding_id,
      row.actor_account_id,
    ];
    if (ids.some((value) => !validId(value))) fail();
    const context = db.prepare(
      `SELECT event_row.workspace_id AS event_workspace_id,
              round_row.workspace_id AS round_workspace_id,
              round_row.event_id AS round_event_id,
              assignment.workspace_id AS assignment_workspace_id,
              assignment.round_id AS assignment_round_id,
              assignment.reviewer_account_id AS assignment_reviewer_account_id,
              submission.workspace_id AS submission_workspace_id,
              submission.event_id AS submission_event_id,
              event_assignment.workspace_id AS event_assignment_workspace_id,
              event_assignment.event_id AS event_assignment_event_id,
              event_assignment.reviewer_account_id AS event_assignment_reviewer_account_id,
              event_assignment.reviewer_person_id AS event_assignment_reviewer_person_id,
              event_assignment.account_person_binding_id AS event_assignment_binding_id,
              binding.workspace_id AS binding_workspace_id,
              binding.account_id AS binding_account_id,
              binding.person_id AS binding_person_id,
              reviewer.workspace_id AS reviewer_workspace_id,
              actor.workspace_id AS actor_workspace_id
       FROM events event_row
       JOIN review_rounds round_row
         ON round_row.id = ? AND round_row.workspace_id = event_row.workspace_id
        AND round_row.event_id = event_row.id
       JOIN review_assignments assignment
         ON assignment.id = ? AND assignment.workspace_id = event_row.workspace_id
        AND assignment.round_id = round_row.id
        AND assignment.reviewer_account_id = ?
       JOIN submissions submission
         ON submission.id = assignment.submission_id
        AND submission.workspace_id = assignment.workspace_id
        AND submission.event_id = event_row.id
       JOIN event_reviewer_assignments event_assignment
         ON event_assignment.id = ? AND event_assignment.workspace_id = event_row.workspace_id
        AND event_assignment.event_id = event_row.id
        AND event_assignment.reviewer_account_id = assignment.reviewer_account_id
        AND event_assignment.reviewer_person_id = ?
        AND event_assignment.account_person_binding_id = ?
       JOIN account_person_bindings binding
         ON binding.id = ? AND binding.workspace_id = event_row.workspace_id
        AND binding.account_id = assignment.reviewer_account_id
        AND binding.person_id = event_assignment.reviewer_person_id
       JOIN people person
         ON person.id = event_assignment.reviewer_person_id
        AND person.workspace_id = event_row.workspace_id
       JOIN accounts reviewer
         ON reviewer.id = assignment.reviewer_account_id
        AND reviewer.workspace_id = event_row.workspace_id
       JOIN accounts actor
         ON actor.id = ? AND actor.workspace_id = event_row.workspace_id
       WHERE event_row.id = ? AND event_row.workspace_id = ?`,
    ).get(
      row.round_id,
      row.assignment_id,
      row.reviewer_account_id,
      row.event_reviewer_assignment_id,
      row.reviewer_person_id,
      row.account_person_binding_id,
      row.account_person_binding_id,
      row.actor_account_id,
      row.event_id,
      row.workspace_id,
    ) as AccessRow | undefined;
    if (
      !context ||
      context.event_workspace_id !== row.workspace_id ||
      context.round_workspace_id !== row.workspace_id ||
      context.round_event_id !== row.event_id ||
      context.assignment_workspace_id !== row.workspace_id ||
      context.assignment_round_id !== row.round_id ||
      context.assignment_reviewer_account_id !== row.reviewer_account_id ||
      context.submission_workspace_id !== row.workspace_id ||
      context.submission_event_id !== row.event_id ||
      context.event_assignment_workspace_id !== row.workspace_id ||
      context.event_assignment_event_id !== row.event_id ||
      context.event_assignment_reviewer_account_id !== row.reviewer_account_id ||
      context.event_assignment_reviewer_person_id !== row.reviewer_person_id ||
      context.event_assignment_binding_id !== row.account_person_binding_id ||
      context.binding_workspace_id !== row.workspace_id ||
      context.binding_account_id !== row.reviewer_account_id ||
      context.binding_person_id !== row.reviewer_person_id ||
      context.reviewer_workspace_id !== row.workspace_id ||
      context.actor_workspace_id !== row.workspace_id
    ) {
      fail();
    }
  };

  for (const receipt of receipts) {
    if (
      !validId(receipt.id) ||
      !validId(receipt.workspace_id) ||
      !validId(receipt.event_id) ||
      !validId(receipt.round_id) ||
      !validId(receipt.assignment_id) ||
      !validId(receipt.event_reviewer_assignment_id) ||
      !validId(receipt.reviewer_account_id) ||
      !validId(receipt.reviewer_person_id) ||
      !validId(receipt.account_person_binding_id) ||
      !validId(receipt.actor_account_id) ||
      !stateForIntent.has(receipt.intent) ||
      stateForIntent.get(receipt.intent) !== receipt.state ||
      !validText(receipt.idempotency_key, 128) ||
      !validText(receipt.request_schema, 128) ||
      receipt.request_schema !== "cfp-reviewer-access-request/v1" ||
      !/^[a-f0-9]{64}$/u.test(receipt.request_fingerprint) ||
      receipt.receipt_schema !== "cfp-reviewer-access-receipt/v1" ||
      !Number.isInteger(receipt.transitioned) ||
      (receipt.transitioned !== 0 && receipt.transitioned !== 1) ||
      !validInstant(receipt.created_at)
    ) {
      fail();
    }
    assertBoundScope(receipt);
    const expectedFingerprint = fingerprintOf({
      schema: receipt.request_schema,
      actorAccountId: receipt.actor_account_id,
      workspaceId: receipt.workspace_id,
      eventId: receipt.event_id,
      roundId: receipt.round_id,
      assignmentId: receipt.assignment_id,
      eventReviewerAssignmentId: receipt.event_reviewer_assignment_id,
      reviewerAccountId: receipt.reviewer_account_id,
      reviewerPersonId: receipt.reviewer_person_id,
      accountPersonBindingId: receipt.account_person_binding_id,
      intent: receipt.intent,
    });
    if (receipt.request_fingerprint !== expectedFingerprint) fail();
    const state = stateForIntent.get(receipt.intent);
    if (!state || !sequenceForState.has(state)) fail();
    const expectedSequence = sequenceForState.get(state!) as number;
    assertIssuanceAnchor(receipt, expectedSequence);
    if (receipt.transitioned === 1) {
      if (receipt.effect_state_id !== `reviewer-access-state:${receipt.id}`) fail();
      const effect = states.find((candidate) => candidate.receipt_id === receipt.id);
      if (effect === undefined) fail();
      const effectRow = effect as AccessRow;
      if (effectRow.id !== receipt.effect_state_id || effectRow.state !== state || effectRow.sequence_number !== expectedSequence || effectRow.created_at !== receipt.created_at) fail();
      stateByReceipt.set(receipt.id, effectRow);
    } else {
      if (receipt.effect_state_id !== null) fail();
      const latest = states
        .filter((candidate) => candidate.workspace_id === receipt.workspace_id && candidate.assignment_id === receipt.assignment_id)
        .sort((left, right) => Number(right.sequence_number) - Number(left.sequence_number))[0];
      if (!latest || Number(latest.sequence_number) < Number(expectedSequence)) fail();
    }
  }

  for (const state of states) {
    if (
      !validId(state.id) ||
      !validId(state.workspace_id) ||
      !validId(state.event_id) ||
      !validId(state.round_id) ||
      !validId(state.assignment_id) ||
      !validId(state.event_reviewer_assignment_id) ||
      !validId(state.reviewer_account_id) ||
      !validId(state.reviewer_person_id) ||
      !validId(state.account_person_binding_id) ||
      !validId(state.actor_account_id) ||
      !validId(state.receipt_id) ||
      !sequenceForState.has(state.state) ||
      state.sequence_number !== sequenceForState.get(state.state) ||
      !Number.isInteger(state.sequence_number) ||
      !validInstant(state.created_at)
    ) {
      fail();
    }
    const scopeKey = `${state.workspace_id}\0${state.assignment_id}`;
    const prior = stateHistory.get(scopeKey);
    if (
      state.id !== `reviewer-access-state:${state.receipt_id}` ||
      state.sequence_number !== (prior ? Number(prior.sequence_number) + 1 : 1) ||
      (prior && (
        (prior.state !== "PROVISIONED" || state.state !== "INVITED") &&
        (prior.state !== "INVITED" || state.state !== "ACTIVE")
      ))
    ) {
      fail();
    }
    assertBoundScope(state);
    const receipt = receiptById.get(state.receipt_id);
    if (
      !receipt ||
      receipt.transitioned !== 1 ||
      receipt.effect_state_id !== state.id ||
      receipt.state !== state.state ||
      receipt.created_at !== state.created_at ||
      receipt.workspace_id !== state.workspace_id ||
      receipt.event_id !== state.event_id ||
      receipt.round_id !== state.round_id ||
      receipt.assignment_id !== state.assignment_id ||
      receipt.event_reviewer_assignment_id !== state.event_reviewer_assignment_id ||
      receipt.reviewer_account_id !== state.reviewer_account_id ||
      receipt.reviewer_person_id !== state.reviewer_person_id ||
      receipt.account_person_binding_id !== state.account_person_binding_id ||
      receipt.actor_account_id !== state.actor_account_id
    ) {
      fail();
    }
    stateHistory.set(scopeKey, state);
    stateByReceipt.set(state.receipt_id, state);
  }
  if (stateByReceipt.size !== states.filter((state) => state.receipt_id !== undefined).length) fail();
}

function validateDatabaseIntegrity(
  db: Db,
  includeCfp = true,
  includeReview = true,
  includeTrustedReview = false,
): void {
  const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: unknown }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("database tenant integrity check failed");
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("database foreign-key check failed");
  }
  const queries = [
    ...LEGACY_TENANT_INTEGRITY_QUERIES,
    ...(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_tasks'").get() ? [SPEAKER_TASK_AUTHORITY_INTEGRITY_QUERY] : []),
    ...(includeCfp ? CFP_TENANT_INTEGRITY_QUERIES : []),
    ...(includeReview ? REVIEW_TENANT_INTEGRITY_QUERIES : []),
    ...(includeTrustedReview ? TRUSTED_REVIEW_INTEGRITY_QUERIES : []),
  ];
  for (const query of queries) {
    if (db.prepare(query).get()) {
      throw new Error("database tenant integrity check failed");
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviewer_access_states'").get()) {
    validateReviewerAccessIntegrity(db);
  }
}

export const STORED_JSON_MAX_BYTES = JSON_MAX_BYTES;
