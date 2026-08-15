import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, deterministicUuid, fingerprintOf, nowIso } from "../../canonical";
import { withTransaction, withTransactionOrSavepoint, type Db } from "../../db";
import {
  ARTIFACT_KINDS,
  createArtifactReservation,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactPreparation,
  type ArtifactProjection,
  LocalArtifactStore,
} from "../artifact-store";
import { validatePublicReleaseForRead, type SealedSpeakerHeadshot } from "../publication";
import { configuredArtifactRoot } from "../../runtime-mode";
import {
  isAudienceReference,
  publicArtifactReference,
  publicPersonReference,
  publicReleaseReference,
  type AudienceReferenceScope,
} from "../public-reference";
import {
  acceptedCurrentPlanAssignmentId,
  ensureEvaluatorArtifactSpeakerProvenance,
  EVALUATOR_ARTIFACT_ASSIGNMENT_ID,
  isEvaluatorArtifactScope,
} from "../evaluator-speaker-identity";

export const ARTIFACT_RECORD_SCHEMA = "sympose-artifact-record/v1" as const;
export type SpeakerArtifactKind = (typeof ARTIFACT_KINDS)[number];

const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_ID = /^[a-f0-9]{64}$/u;

export interface SpeakerArtifactScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: SpeakerArtifactKind;
}

export interface SpeakerArtifactListScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId?: string;
  readonly taskId?: string;
  readonly kind?: SpeakerArtifactKind;
}

export interface SpeakerArtifactRecord {
  readonly schema: typeof ARTIFACT_RECORD_SCHEMA;
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: SpeakerArtifactKind;
  readonly version: number;
  readonly supersedesRecordId: string | null;
  readonly storageProvider: "local";
  readonly storageId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: ArtifactMediaType;
  readonly displayFilename: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface CreateSpeakerArtifactInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly originalFilename: string;
  /** Runs after bytes are durably staged but before metadata is published. */
  readonly onPrepared?: (
    projection: ArtifactProjection,
    registerRollback: (rollback: () => void) => void,
  ) => void | (() => void);
}

export interface ArtifactRecordServiceOptions {
  readonly store?: LocalArtifactStore;
  readonly fault?: (point: ArtifactRecordFaultPoint) => void;
}

export interface SpeakerArtifactRecoveryScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

export type ArtifactRecordFaultPoint = "after-intent" | "after-stage" | "before-finalize" | "after-finalize";

export class ArtifactRecordCrashInjectedError extends Error {
  constructor(point: ArtifactRecordFaultPoint) {
    super(`ARTIFACT_RECOVERY_FAULT_${point}`);
    this.name = "ArtifactRecordCrashInjectedError";
  }
}

export interface SpeakerArtifactRead {
  readonly record: SpeakerArtifactRecord;
  readonly bytes: Buffer;
}

interface ArtifactRecordRow {
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
  readonly content_version_id: unknown;
  readonly authority_event_id: unknown;
}

interface ArtifactUploadIntentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_id: string;
  readonly person_id: string;
  readonly task_id: string;
  readonly kind: SpeakerArtifactKind;
  readonly artifact_id: string;
  readonly storage_id: string;
  readonly storage_filename: string;
  readonly version: number;
  readonly supersedes_record_id: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: ArtifactMediaType;
  readonly display_filename: string;
  readonly created_at: string;
  readonly content_version_id: string;
  readonly content_payload_json: string;
  readonly status: "PREPARED" | "COMMITTED" | "ABORTED";
}

function invalidInput(): never {
  throw new Error("INVALID_SPEAKER_ARTIFACT_INPUT");
}

function invalidScope(): never {
  throw new Error("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
}

function scopeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_SCOPE_ID.test(value)) invalidScope();
  return value;
}

function exactKind(value: unknown): SpeakerArtifactKind {
  if (typeof value !== "string" || !ARTIFACT_KINDS.includes(value as SpeakerArtifactKind)) {
    invalidScope();
  }
  return value as SpeakerArtifactKind;
}

function exactScope(value: SpeakerArtifactScope): SpeakerArtifactScope {
  if (value === null || typeof value !== "object") invalidScope();
  return Object.freeze({
    workspaceId: scopeId(value.workspaceId),
    eventId: scopeId(value.eventId),
    personId: scopeId(value.personId),
    taskId: scopeId(value.taskId),
    kind: exactKind(value.kind),
  });
}

function listScope(value: SpeakerArtifactListScope): SpeakerArtifactListScope {
  if (value === null || typeof value !== "object") invalidScope();
  return Object.freeze({
    workspaceId: scopeId(value.workspaceId),
    eventId: scopeId(value.eventId),
    ...(value.personId === undefined ? {} : { personId: scopeId(value.personId) }),
    ...(value.taskId === undefined ? {} : { taskId: scopeId(value.taskId) }),
    ...(value.kind === undefined ? {} : { kind: exactKind(value.kind) }),
  });
}

function artifactId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) invalidInput();
  return value;
}

let derivedStores = new Map<string, LocalArtifactStore>();
let memoryDatabaseRoots = new WeakMap<object, string>();
let databaseStores = new WeakMap<object, LocalArtifactStore>();
let memoryDatabaseSequence = 0;

function configuredStoreRoot(): string | null {
  return configuredArtifactRoot();
}

function databaseStoreRoot(db: Db): string {
  const configured = configuredStoreRoot();
  if (configured !== null) return configured;
  let file = "";
  try {
    const main = (db.prepare("PRAGMA database_list").all() as Array<{
      readonly name: unknown;
      readonly file: unknown;
    }>).find((entry) => entry.name === "main");
    if (typeof main?.file === "string") file = main.file;
  } catch {
    throw new Error("SPEAKER_ARTIFACT_DATABASE_ROOT_UNAVAILABLE");
  }
  if (file.length > 0) {
    const absoluteDatabasePath = resolve(/* turbopackIgnore: true */ file);
    const digest = createHash("sha256").update(absoluteDatabasePath, "utf8").digest("hex").slice(0, 24);
    return join(dirname(absoluteDatabasePath), `.sympose-artifacts-${digest}`);
  }
  const connection = db as unknown as object;
  const existing = memoryDatabaseRoots.get(connection);
  if (existing) return existing;
  memoryDatabaseSequence += 1;
  const root = join(
    process.cwd(),
    "data",
    `.sympose-artifacts-memory-${String(memoryDatabaseSequence).padStart(8, "0")}`,
  );
  memoryDatabaseRoots.set(connection, root);
  return root;
}

export function getSpeakerArtifactStore(db: Db): LocalArtifactStore {
  const registered = databaseStores.get(db as unknown as object);
  if (registered) return registered;
  const root = databaseStoreRoot(db);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("SPEAKER_ARTIFACT_ROOT_UNAVAILABLE");
  }
  const existing = derivedStores.get(root);
  if (existing) {
    databaseStores.set(db as unknown as object, existing);
    return existing;
  }
  const store = new LocalArtifactStore({ rootDir: root });
  derivedStores.set(root, store);
  databaseStores.set(db as unknown as object, store);
  return store;
}

function serviceStore(db: Db, options?: ArtifactRecordServiceOptions): LocalArtifactStore {
  if (options?.store) {
    databaseStores.set(db as unknown as object, options.store);
    return options.store;
  }
  return getSpeakerArtifactStore(db);
}

function selectRows(db: Db, scope: SpeakerArtifactListScope): ArtifactRecordRow[] {
  const normalized = listScope(scope);
  const clauses = ["workspace_id = ?", "event_id = ?"];
  const params: string[] = [normalized.workspaceId, normalized.eventId];
  if (normalized.personId !== undefined) {
    clauses.push("person_id = ?");
    params.push(normalized.personId);
  }
  if (normalized.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(normalized.taskId);
  }
  if (normalized.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(normalized.kind);
  }
  return db
    .prepare(
      `SELECT id, artifact_schema, workspace_id, event_id, person_id, task_id, kind,
              version, supersedes_record_id, storage_provider, storage_id, storage_filename,
              sha256, size_bytes, media_type, display_filename, created_at,
              content_version_id, authority_event_id
       FROM artifact_records
       WHERE ${clauses.join(" AND ")}
       ORDER BY person_id, task_id, kind, version, id`,
    )
    .all(...params) as unknown as ArtifactRecordRow[];
}

function rowText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("SPEAKER_ARTIFACT_METADATA_INVALID");
  }
  return value;
}

function rowProjection(row: ArtifactRecordRow): ArtifactProjection {
  const supersedes = row.supersedes_record_id === null ? null : rowText(row.supersedes_record_id);
  const kind = exactKind(row.kind);
  const projection: ArtifactProjection = {
    schema: "local-artifact-store/v1",
    artifactId: rowText(row.id),
    storageId: rowText(row.storage_id),
    storageFilename: rowText(row.storage_filename),
    workspaceId: rowText(row.workspace_id),
    eventId: rowText(row.event_id),
    personId: rowText(row.person_id),
    taskId: rowText(row.task_id),
    kind,
    version: row.version as number,
    supersedesArtifactId: supersedes,
    mediaType: row.media_type as ArtifactMediaType,
    byteSize: row.size_bytes as number,
    sha256: rowText(row.sha256),
    displayFilename: rowText(row.display_filename),
    createdAt: rowText(row.created_at),
  };
  if (row.artifact_schema !== ARTIFACT_RECORD_SCHEMA || row.storage_provider !== "local") {
    throw new Error("SPEAKER_ARTIFACT_METADATA_INVALID");
  }
  rowText(row.content_version_id);
  rowText(row.authority_event_id);
  return Object.freeze(projection);
}

function publicRecord(projection: ArtifactProjection, current: boolean): SpeakerArtifactRecord {
  return Object.freeze({
    schema: ARTIFACT_RECORD_SCHEMA,
    artifactId: projection.artifactId,
    workspaceId: projection.workspaceId,
    eventId: projection.eventId,
    personId: projection.personId,
    taskId: projection.taskId,
    kind: projection.kind as SpeakerArtifactKind,
    version: projection.version,
    supersedesRecordId: projection.supersedesArtifactId,
    storageProvider: "local",
    storageId: projection.storageId,
    sha256: projection.sha256,
    byteSize: projection.byteSize,
    mediaType: projection.mediaType,
    displayFilename: projection.displayFilename,
    createdAt: projection.createdAt,
    current,
  });
}

function hydrateRows(store: LocalArtifactStore, rows: readonly ArtifactRecordRow[]): void {
  for (const row of rows) store.hydrate(rowProjection(row));
}

function predecessorHistory(db: Db, target: ArtifactRecordRow): ArtifactProjection[] | null {
  try {
    const first = rowProjection(target);
    if (!Number.isSafeInteger(first.version) || first.version < 1) return null;
    const chain: ArtifactProjection[] = [];
    const seen = new Set<string>();
    let current: ArtifactRecordRow | undefined = target;
    let expectedVersion = first.version;
    while (current) {
      const projection = rowProjection(current);
      if (projection.version !== expectedVersion || seen.has(projection.artifactId)) return null;
      seen.add(projection.artifactId);
      chain.unshift(projection);
      if (expectedVersion === 1) {
        return projection.supersedesArtifactId === null ? chain : null;
      }
      if (projection.supersedesArtifactId === null) return null;
      current = db.prepare(
        `SELECT id, artifact_schema, workspace_id, event_id, person_id, task_id, kind,
                version, supersedes_record_id, storage_provider, storage_id, storage_filename,
                sha256, size_bytes, media_type, display_filename, created_at,
                content_version_id, authority_event_id
           FROM artifact_records
          WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ?
          LIMIT 1`,
      ).get(
        projection.supersedesArtifactId,
        projection.workspaceId,
        projection.eventId,
        projection.personId,
        projection.taskId,
        projection.kind,
      ) as ArtifactRecordRow | undefined;
      expectedVersion -= 1;
    }
    return null;
  } catch {
    return null;
  }
}

function currentRecordId(rows: readonly ArtifactRecordRow[]): string | null {
  const latest = rows.at(-1);
  return latest ? rowText(latest.id) : null;
}

function assertPersistedSpeakerScope(db: Db, scope: SpeakerArtifactScope): void {
  if (ensureEvaluatorArtifactSpeakerProvenance(db, scope)) return;

  try {
    const event = db
      .prepare("SELECT id, workspace_id FROM events WHERE id = ? AND workspace_id = ?")
      .get(scope.eventId, scope.workspaceId) as { id: string; workspace_id: string } | undefined;
    const person = db
      .prepare("SELECT id, workspace_id FROM people WHERE id = ? AND workspace_id = ?")
      .get(scope.personId, scope.workspaceId) as { id: string; workspace_id: string } | undefined;
    if (
      !event ||
      event.id !== scope.eventId ||
      event.workspace_id !== scope.workspaceId ||
      !person ||
      person.id !== scope.personId ||
      person.workspace_id !== scope.workspaceId
    ) {
      invalidScope();
    }

    const speakers = db
      .prepare(
        `SELECT id, workspace_id, event_id, person_id, role_key, participation_status
         FROM event_speakers
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND role_key IN ('SPEAKER', 'MODERATOR')`,
      )
      .all(scope.workspaceId, scope.eventId, scope.personId) as unknown as readonly {
      id: string;
      workspace_id: string;
      event_id: string;
      person_id: string;
      role_key: string;
      participation_status: string;
    }[];
    if (
      speakers.length !== 1 ||
      speakers[0]?.workspace_id !== scope.workspaceId ||
      speakers[0]?.event_id !== scope.eventId ||
      speakers[0]?.person_id !== scope.personId ||
      !["SPEAKER", "MODERATOR"].includes(speakers[0]?.role_key ?? "") ||
      !["CONFIRMED", "ACCEPTED"].includes(speakers[0]?.participation_status ?? "")
    ) {
      invalidScope();
    }
  } catch {
    invalidScope();
  }
}

function ensureDurableArtifactTask(db: Db, scope: SpeakerArtifactScope, createdAt: string): void {
  const existing = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
              title, required, gate, owner, state, due_at, created_at, updated_at
       FROM speaker_tasks WHERE id = ?`,
    )
    .get(scope.taskId) as
    | {
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
        state: string;
        due_at: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  const expected = {
    assignmentId: acceptedCurrentPlanAssignmentId(db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: scope.personId,
    }),
    title: scope.kind === "HEADSHOT" ? "Headshot PNG" : "Slides or supporting PDF",
    required: scope.kind === "HEADSHOT" ? 1 : 0,
    gate: scope.kind === "HEADSHOT" ? "PUBLICATION" : "OPERATOR_RELEASE",
  } as const;
  if (existing) {
    if (
      existing.workspace_id !== scope.workspaceId ||
      existing.event_id !== scope.eventId ||
      existing.person_id !== scope.personId ||
      existing.assignment_id !== expected.assignmentId ||
      existing.task_kind !== scope.kind ||
      existing.content_kind !== scope.kind ||
      existing.owner !== "SPEAKER"
    ) invalidScope();
    return;
  }
  db.prepare(
    `INSERT INTO speaker_tasks
       (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
        title, required, gate, owner, state, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPEAKER', 'NOT_STARTED', ?, ?, ?)`,
  ).run(
    scope.taskId,
    scope.workspaceId,
    scope.eventId,
    scope.personId,
    expected.assignmentId,
    scope.kind,
    scope.kind,
    expected.title,
    expected.required,
    expected.gate,
    createdAt,
    createdAt,
    createdAt,
  );
}

function assertDurableArtifactTaskAuthority(db: Db, scope: SpeakerArtifactScope): void {
  assertPersistedSpeakerScope(db, scope);
  const assignmentId = acceptedCurrentPlanAssignmentId(db, {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: scope.personId,
  });
  const task = db.prepare(
    `SELECT assignment_id, task_kind, content_kind, owner
     FROM speaker_tasks
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ?`,
  ).get(scope.taskId, scope.workspaceId, scope.eventId, scope.personId) as {
    assignment_id: string;
    task_kind: string;
    content_kind: string;
    owner: string;
  } | undefined;
  if (
    !task ||
    task.assignment_id !== assignmentId ||
    task.task_kind !== scope.kind ||
    task.content_kind !== scope.kind ||
    task.owner !== "SPEAKER"
  ) invalidScope();
}

function artifactContentPayload(projection: ArtifactProjection): Record<string, unknown> {
  return {
    kind: projection.kind,
    asset: {
      assetId: projection.artifactId,
      fileName: projection.displayFilename,
      mediaType: projection.mediaType,
      byteSize: projection.byteSize,
      checksum: projection.sha256,
      storageRef: `synthetic://artifact/${projection.artifactId}`,
    },
  };
}

function intentProjection(intent: ArtifactUploadIntentRow): ArtifactProjection {
  return Object.freeze({
    schema: "local-artifact-store/v1",
    artifactId: intent.artifact_id,
    storageId: intent.storage_id,
    storageFilename: intent.storage_filename,
    workspaceId: intent.workspace_id,
    eventId: intent.event_id,
    personId: intent.person_id,
    taskId: intent.task_id,
    kind: intent.kind,
    version: intent.version,
    supersedesArtifactId: intent.supersedes_record_id,
    mediaType: intent.media_type,
    byteSize: intent.size_bytes,
    sha256: intent.sha256,
    displayFilename: intent.display_filename,
    createdAt: intent.created_at,
  });
}

function readIntent(db: Db, id: string): ArtifactUploadIntentRow | null {
  const row = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, kind, artifact_id, storage_id,
              storage_filename, version, supersedes_record_id, sha256, size_bytes, media_type,
              display_filename, created_at, content_version_id, content_payload_json, status
       FROM artifact_upload_intents WHERE id = ?`,
    )
    .get(id) as unknown as ArtifactUploadIntentRow | undefined;
  return row ?? null;
}

function readPreparedIntents(
  db: Db,
  scope: SpeakerArtifactRecoveryScope,
): readonly ArtifactUploadIntentRow[] {
  const normalized = {
    workspaceId: scopeId(scope.workspaceId),
    eventId: scopeId(scope.eventId),
  };
  return db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, kind, artifact_id, storage_id,
              storage_filename, version, supersedes_record_id, sha256, size_bytes, media_type,
              display_filename, created_at, content_version_id, content_payload_json, status
       FROM artifact_upload_intents
       WHERE workspace_id = ? AND event_id = ? AND status = 'PREPARED'
       ORDER BY created_at, id`,
    )
    .all(normalized.workspaceId, normalized.eventId) as unknown as readonly ArtifactUploadIntentRow[];
}

function contentVersionIdFor(projection: ArtifactProjection): string {
  return deterministicUuid(
    `content-version:${projection.workspaceId}:${projection.eventId}:${projection.personId}:${projection.taskId}:${projection.kind}:${projection.version}`,
  );
}

function authorityEventIdFor(projection: ArtifactProjection): string {
  return deterministicUuid(`speaker-artifact-event:${projection.artifactId}`);
}

function assertSameRow(actual: unknown, expected: Record<string, unknown>, code: string): void {
  if (actual === null || typeof actual !== "object") throw new Error(code);
  for (const [key, value] of Object.entries(expected)) {
    if ((actual as Record<string, unknown>)[key] !== value) throw new Error(code);
  }
}

function finalizeIntentInTransaction(db: Db, intent: ArtifactUploadIntentRow): SpeakerArtifactRecord {
  if (intent.status === "ABORTED") throw new Error("SPEAKER_ARTIFACT_INTENT_ABORTED");
  const projection = intentProjection(intent);
  const payload = JSON.parse(intent.content_payload_json) as Record<string, unknown>;
  const payloadHash = fingerprintOf(payload);
  const priorArtifact = intent.supersedes_record_id
    ? db.prepare("SELECT content_version_id FROM artifact_records WHERE id = ?").get(intent.supersedes_record_id) as { content_version_id: string } | undefined
    : undefined;
  const contentVersion = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, kind, version,
              supersedes_version_id, payload_json, content_hash, payload_bytes,
              submitted_at, submitted_by, submitted_by_kind, source
       FROM speaker_content_versions WHERE id = ?`,
    )
    .get(intent.content_version_id) as Record<string, unknown> | undefined;
  if (contentVersion) {
    assertSameRow(contentVersion, {
      id: intent.content_version_id,
      workspace_id: intent.workspace_id,
      event_id: intent.event_id,
      person_id: intent.person_id,
      task_id: intent.task_id,
      kind: intent.kind,
      version: intent.version,
      supersedes_version_id: priorArtifact?.content_version_id ?? null,
      payload_json: intent.content_payload_json,
      content_hash: payloadHash,
      payload_bytes: Buffer.byteLength(intent.content_payload_json, "utf8"),
      submitted_by: intent.person_id,
      submitted_by_kind: "speaker",
      source: "local-artifact-store",
    }, "SPEAKER_ARTIFACT_CONTENT_CONFLICT");
  } else {
    db.prepare(
      `INSERT INTO speaker_content_versions
         (id, workspace_id, event_id, person_id, task_id, kind, version,
          supersedes_version_id, payload_json, content_hash, payload_bytes,
          submitted_at, submitted_by, submitted_by_kind, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'speaker', 'local-artifact-store')`,
    ).run(
      intent.content_version_id,
      intent.workspace_id,
      intent.event_id,
      intent.person_id,
      intent.task_id,
      intent.kind,
      intent.version,
      priorArtifact?.content_version_id ?? null,
      intent.content_payload_json,
      payloadHash,
      Buffer.byteLength(intent.content_payload_json, "utf8"),
      intent.created_at,
      intent.person_id,
    );
  }

  const authorityEventId = authorityEventIdFor(projection);
  const authorityPayload = {
    schema: "speaker-artifact-submission/v1",
    artifactId: projection.artifactId,
    workspaceId: projection.workspaceId,
    eventId: projection.eventId,
    personId: projection.personId,
    taskId: projection.taskId,
    kind: projection.kind,
    version: projection.version,
    storageId: projection.storageId,
    storageFilename: projection.storageFilename,
    sha256: projection.sha256,
    byteSize: projection.byteSize,
    mediaType: projection.mediaType,
    displayFilename: projection.displayFilename,
    contentVersionId: intent.content_version_id,
    contentVersionHash: payloadHash,
  };
  const authorityPayloadJson = canonicalJson(authorityPayload);
  const authorityEvent = db
    .prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint
       FROM domain_events WHERE id = ?`,
    )
    .get(authorityEventId) as Record<string, unknown> | undefined;
  if (authorityEvent) {
    assertSameRow(authorityEvent, {
      id: authorityEventId,
      workspace_id: projection.workspaceId,
      event_type: "speaker.artifact.submitted",
      aggregate_type: "speaker_task",
      aggregate_id: projection.taskId,
      payload_json: authorityPayloadJson,
      payload_fingerprint: fingerprintOf(authorityPayload),
    }, "SPEAKER_ARTIFACT_AUTHORITY_CONFLICT");
  } else {
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'speaker.artifact.submitted', 'speaker_task', ?, ?, ?, ?)`,
    ).run(
      authorityEventId,
      projection.workspaceId,
      projection.taskId,
      authorityPayloadJson,
      fingerprintOf(authorityPayload),
      projection.createdAt,
    );
  }

  const artifact = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, task_id, kind, version,
              supersedes_record_id, storage_provider, storage_id, storage_filename,
              sha256, size_bytes, media_type, display_filename, created_at,
              content_version_id, authority_event_id
       FROM artifact_records WHERE id = ?`,
    )
    .get(projection.artifactId) as Record<string, unknown> | undefined;
  if (artifact) {
    assertSameRow(artifact, {
      id: projection.artifactId,
      workspace_id: projection.workspaceId,
      event_id: projection.eventId,
      person_id: projection.personId,
      task_id: projection.taskId,
      kind: projection.kind,
      version: projection.version,
      supersedes_record_id: projection.supersedesArtifactId,
      storage_provider: "local",
      storage_id: projection.storageId,
      storage_filename: projection.storageFilename,
      sha256: projection.sha256,
      size_bytes: projection.byteSize,
      media_type: projection.mediaType,
      display_filename: projection.displayFilename,
      created_at: projection.createdAt,
      content_version_id: intent.content_version_id,
      authority_event_id: authorityEventId,
    }, "SPEAKER_ARTIFACT_METADATA_CONFLICT");
  } else {
    db.prepare(
      `INSERT INTO artifact_records
        (id, artifact_schema, workspace_id, event_id, person_id, task_id, kind, version,
         supersedes_record_id, storage_provider, storage_id, storage_filename, sha256,
         size_bytes, media_type, display_filename, created_at, content_version_id,
         authority_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projection.artifactId,
      ARTIFACT_RECORD_SCHEMA,
      projection.workspaceId,
      projection.eventId,
      projection.personId,
      projection.taskId,
      projection.kind,
      projection.version,
      projection.supersedesArtifactId,
      projection.storageId,
      projection.storageFilename,
      projection.sha256,
      projection.byteSize,
      projection.mediaType,
      projection.displayFilename,
      projection.createdAt,
      intent.content_version_id,
      authorityEventId,
    );
  }
  db.prepare(
    `UPDATE speaker_tasks SET state = CASE WHEN state = 'COMPLETED' THEN state ELSE 'SUBMITTED' END,
                                updated_at = ?
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ?`,
  ).run(projection.createdAt, projection.taskId, projection.workspaceId, projection.eventId, projection.personId);
  db.prepare(
    `UPDATE artifact_upload_intents SET status = 'COMMITTED', committed_at = ?
     WHERE id = ? AND status = 'PREPARED'`,
  ).run(nowIso(), intent.id);
  return publicRecord(projection, true);
}

function abortIntent(db: Db, intentId: string): void {
  withTransaction(db, () => {
    db.prepare(
      `UPDATE artifact_upload_intents SET status = 'ABORTED'
       WHERE id = ? AND status = 'PREPARED'`,
    ).run(intentId);
  });
}

function cleanupArtifactFailure(
  db: Db,
  intentId: string | null,
  store: LocalArtifactStore,
  staged: ArtifactProjection | null,
  rollbacks: Array<() => void>,
  original: unknown,
): never {
  const cleanupErrors: unknown[] = [];
  let mayDiscard = staged !== null;
  if (intentId !== null) {
    try {
      abortIntent(db, intentId);
      const intent = readIntent(db, intentId);
      const committed = db.prepare("SELECT 1 FROM artifact_records WHERE id = ?").get(intentId);
      mayDiscard = intent?.status === "ABORTED" && committed === undefined;
    } catch (error) {
      cleanupErrors.push(error);
      mayDiscard = false;
    }
  }
  for (const rollback of rollbacks.reverse()) {
    try {
      rollback();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (staged && mayDiscard) {
    try {
      store.discardUnpublished(staged);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([original, ...cleanupErrors], "SPEAKER_ARTIFACT_ROLLBACK_FAILED");
  }
  throw original;
}

export function recoverSpeakerArtifactUploads(
  db: Db,
  scope: SpeakerArtifactRecoveryScope,
  maybeOptions?: ArtifactRecordServiceOptions,
): { readonly recovered: number; readonly aborted: number } {
  if (scope === null || typeof scope !== "object") invalidScope();
  const normalizedScope = {
    workspaceId: scopeId(scope.workspaceId),
    eventId: scopeId(scope.eventId),
  };
  if (db.isTransaction) throw new Error("SPEAKER_ARTIFACT_RECOVERY_TRANSACTION_UNSAFE");
  const store = serviceStore(db, maybeOptions);
  let recovered = 0;
  let aborted = 0;
  const intents = readPreparedIntents(db, normalizedScope);
  for (const intent of intents) {
    const projection = intentProjection(intent);
    try {
      store.hydrate(projection);
      store.read(projection, projection.artifactId);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : null;
      if (code !== "ARTIFACT_NOT_FOUND" && code !== "ARTIFACT_INTEGRITY_FAILURE") {
        throw new Error("SPEAKER_ARTIFACT_RECOVERY_FAILED");
      }
      abortIntent(db, intent.id);
      const afterAbort = readIntent(db, intent.id);
      if (afterAbort?.status === "ABORTED" && db.prepare("SELECT 1 FROM artifact_records WHERE id = ?").get(intent.id) === undefined) {
        try {
          store.discardUnpublished(projection);
        } catch (discardError) {
          throw new AggregateError([error, discardError], "SPEAKER_ARTIFACT_RECOVERY_CLEANUP_FAILED");
        }
      }
      aborted += 1;
      continue;
    }
    withTransaction(db, () => {
      assertDurableArtifactTaskAuthority(db, {
        workspaceId: intent.workspace_id,
        eventId: intent.event_id,
        personId: intent.person_id,
        taskId: intent.task_id,
        kind: intent.kind,
      });
      finalizeIntentInTransaction(db, intent);
    });
    recovered += 1;
  }
  return { recovered, aborted };
}

export function createSpeakerArtifactRecord(
  db: Db,
  scope: SpeakerArtifactScope,
  input: CreateSpeakerArtifactInput,
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRecord {
  const normalizedScope = exactScope(scope);
  if (
    input === null ||
    typeof input !== "object" ||
    !(input.bytes instanceof Uint8Array) ||
    typeof input.mediaType !== "string" ||
    typeof input.originalFilename !== "string" ||
    (input.onPrepared !== undefined && typeof input.onPrepared !== "function")
  ) {
    invalidInput();
  }

  const store = serviceStore(db, options);
  if (db.isTransaction) throw new Error("SPEAKER_ARTIFACT_TRANSACTION_BOUNDARY_UNSAFE");
  recoverSpeakerArtifactUploads(db, {
    workspaceId: normalizedScope.workspaceId,
    eventId: normalizedScope.eventId,
  }, options);
  let intentId: string | null = null;
  let staged: ArtifactProjection | null = null;
  const rollbacks: Array<() => void> = [];
  const registerRollback = (rollback: () => void): void => {
    if (typeof rollback !== "function") invalidInput();
    rollbacks.push(rollback);
  };
  try {
    const prepared = withTransactionOrSavepoint(db, "speaker_artifact_intent", () => {
      assertPersistedSpeakerScope(db, normalizedScope);
      const existingRows = selectRows(db, normalizedScope);
      hydrateRows(store, existingRows);
      const previous = existingRows.at(-1);
      // An aborted pre-stage intent is a cleanup tombstone. It cannot be retried in place because
      // its terminal state is immutable, but it must not reserve the next committed version.
      db.prepare(
        `DELETE FROM artifact_upload_intents
         WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ?
           AND kind = ? AND version = ? AND status = 'ABORTED'`,
      ).run(
        normalizedScope.workspaceId,
        normalizedScope.eventId,
        normalizedScope.personId,
        normalizedScope.taskId,
        normalizedScope.kind,
        existingRows.length + 1,
      );
      const reservation = createArtifactReservation();
      const preparation = store.prepare({
        ...normalizedScope,
        bytes: input.bytes,
        mediaType: input.mediaType,
        originalFilename: input.originalFilename,
      }, existingRows.length + 1, previous ? rowText(previous.id) : null, reservation);
      ensureDurableArtifactTask(db, normalizedScope, preparation.projection.createdAt);
      const contentVersionId = contentVersionIdFor(preparation.projection);
      const payloadJson = canonicalJson(artifactContentPayload(preparation.projection));
      intentId = reservation.artifactId;
      db.prepare(
        `INSERT INTO artifact_upload_intents
          (id, workspace_id, event_id, person_id, task_id, kind, artifact_id,
           storage_id, storage_filename, version, supersedes_record_id, sha256,
           size_bytes, media_type, display_filename, created_at, content_version_id,
           content_payload_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED')`,
      ).run(
        reservation.artifactId,
        preparation.projection.workspaceId,
        preparation.projection.eventId,
        preparation.projection.personId,
        preparation.projection.taskId,
        preparation.projection.kind,
        preparation.projection.artifactId,
        preparation.projection.storageId,
        preparation.projection.storageFilename,
        preparation.projection.version,
        preparation.projection.supersedesArtifactId,
        preparation.projection.sha256,
        preparation.projection.byteSize,
        preparation.projection.mediaType,
        preparation.projection.displayFilename,
        preparation.projection.createdAt,
        contentVersionId,
        payloadJson,
      );
      return { intentId: reservation.artifactId, preparation };
    });
    options?.fault?.("after-intent");

    staged = store.stage(prepared.preparation, {
      ...normalizedScope,
      bytes: input.bytes,
      mediaType: input.mediaType,
      originalFilename: input.originalFilename,
    });
    options?.fault?.("after-stage");

    const returnedRollback = input.onPrepared?.(staged, registerRollback);
    if (returnedRollback !== undefined) registerRollback(returnedRollback);
    options?.fault?.("before-finalize");

    const result = withTransactionOrSavepoint(db, "speaker_artifact_finalize", () => {
      const intent = readIntent(db, prepared.intentId);
      if (!intent || intent.status !== "PREPARED") {
        throw new Error("SPEAKER_ARTIFACT_INTENT_UNAVAILABLE");
      }
      return finalizeIntentInTransaction(db, intent);
    });
    options?.fault?.("after-finalize");
    return result;
  } catch (error) {
    if (error instanceof ArtifactRecordCrashInjectedError) throw error;
    return cleanupArtifactFailure(db, intentId, store, staged, rollbacks, error);
  }
}

export function listSpeakerArtifactRecords(
  db: Db,
  scope: SpeakerArtifactListScope,
  options?: ArtifactRecordServiceOptions,
): readonly SpeakerArtifactRecord[] {
  const normalized = listScope(scope);
  recoverSpeakerArtifactUploads(db, {
    workspaceId: normalized.workspaceId,
    eventId: normalized.eventId,
  }, options);
  const rows = selectRows(db, normalized);
  const store = serviceStore(db, options);
  hydrateRows(store, rows);
  const latestByScope = new Map<string, string>();
  for (const row of rows) {
    const projection = rowProjection(row);
    latestByScope.set(
      JSON.stringify([projection.workspaceId, projection.eventId, projection.personId, projection.taskId, projection.kind]),
      projection.artifactId,
    );
  }
  return Object.freeze(rows.map((row) => {
    const projection = rowProjection(row);
    const key = JSON.stringify([projection.workspaceId, projection.eventId, projection.personId, projection.taskId, projection.kind]);
    return publicRecord(projection, latestByScope.get(key) === projection.artifactId);
  }));
}

export function getSpeakerArtifactRecord(
  db: Db,
  scope: SpeakerArtifactScope,
  requestedArtifactId: string,
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRecord | null {
  const normalized = exactScope(scope);
  const id = artifactId(requestedArtifactId);
  recoverSpeakerArtifactUploads(db, {
    workspaceId: normalized.workspaceId,
    eventId: normalized.eventId,
  }, options);
  const rows = selectRows(db, normalized);
  const target = rows.find((row) => row.id === id);
  if (!target) return null;
  hydrateRows(serviceStore(db, options), rows);
  return publicRecord(rowProjection(target), currentRecordId(rows) === id);
}

export function readSpeakerArtifact(
  db: Db,
  scope: SpeakerArtifactScope,
  requestedArtifactId: string,
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRead | null {
  const normalized = exactScope(scope);
  const id = artifactId(requestedArtifactId);
  recoverSpeakerArtifactUploads(db, {
    workspaceId: normalized.workspaceId,
    eventId: normalized.eventId,
  }, options);
  const rows = selectRows(db, normalized);
  const target = rows.find((row) => row.id === id);
  if (!target) return null;
  const store = serviceStore(db, options);
  hydrateRows(store, rows);
  const projection = rowProjection(target);
  return Object.freeze({
    record: publicRecord(projection, currentRecordId(rows) === id),
    bytes: store.read(normalized, id).bytes,
  });
}

/**
 * Verify one exact current committed record while a publication transaction owns the database
 * lock. This read-only path deliberately performs no upload recovery or state transition.
 */
export function readCommittedSpeakerArtifactForSeal(
  db: Db,
  scope: SpeakerArtifactScope,
  requestedArtifactId: string,
): SpeakerArtifactRead | null {
  const normalized = exactScope(scope);
  const id = artifactId(requestedArtifactId);
  const rows = selectRows(db, normalized);
  const target = rows.find((row) => row.id === id);
  if (!target || currentRecordId(rows) !== id) return null;
  const history = predecessorHistory(db, target);
  if (!history) return null;
  const store = serviceStore(db);
  for (const predecessor of history) store.hydrate(predecessor);
  const projection = rowProjection(target);
  const read = store.read(normalized, id);
  return Object.freeze({
    record: publicRecord(projection, true),
    bytes: read.bytes,
  });
}

export interface PublishedSpeakerHeadshot {
  readonly releaseId: string;
  readonly personId: string;
  readonly artifactId: string;
  readonly mediaType: "image/png";
  readonly displayFilename: string;
  readonly byteSize: number;
  readonly publicPath: string;
}

export function listPublishedSpeakerHeadshots(
  db: Db,
  input: { readonly workspaceId: string; readonly eventId: string; readonly releaseId: string; readonly mode?: "HISTORICAL" | "CURRENT" },
): readonly PublishedSpeakerHeadshot[] {
  scopeId(input.workspaceId);
  scopeId(input.eventId);
  scopeId(input.releaseId);
  const mode = input.mode ?? "CURRENT";
  const validated = validatePublicReleaseForRead(db, {
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    releaseId: input.releaseId,
    mode,
  });
  if (!validated) return Object.freeze([]);
  const referenceScope: AudienceReferenceScope = {
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
  };
  const releaseReference = publicReleaseReference(referenceScope);
  return Object.freeze((validated.content.speakerHeadshots ?? []).map((headshot) => Object.freeze({
    releaseId: validated.releaseId,
    personId: headshot.personId,
    artifactId: headshot.artifactId,
    mediaType: headshot.mediaType,
    displayFilename: headshot.displayFilename,
    byteSize: headshot.byteSize,
    publicPath: `/public/releases/${encodeURIComponent(releaseReference)}/speaker-artifacts/${encodeURIComponent(publicArtifactReference(referenceScope, headshot.artifactId))}`,
  })));
}

export interface PublicSpeakerHeadshot {
  readonly personReference: string;
  readonly artifactReference: string;
  readonly mediaType: "image/png";
  readonly displayFilename: string;
  readonly byteSize: number;
  readonly publicPath: string;
}

/**
 * Build the anonymous photo projection from an already validated release. Internal release,
 * person, and artifact identifiers stay inside this server-side adapter.
 */
export function listPublicSpeakerHeadshots(
  db: Db,
  input: { readonly workspaceId: string; readonly eventId: string; readonly releaseId: string; readonly mode?: "HISTORICAL" | "CURRENT" },
): readonly PublicSpeakerHeadshot[] {
  const headshots = listPublishedSpeakerHeadshots(db, input);
  const referenceScope: AudienceReferenceScope = {
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    releaseId: input.releaseId,
  };
  const releaseReference = publicReleaseReference(referenceScope);
  return Object.freeze(headshots.map((headshot) => {
    const artifactReference = publicArtifactReference(referenceScope, headshot.artifactId);
    return Object.freeze({
      personReference: publicPersonReference(referenceScope, headshot.personId),
      artifactReference,
      mediaType: headshot.mediaType,
      displayFilename: headshot.displayFilename,
      byteSize: headshot.byteSize,
      publicPath: `/public/releases/${encodeURIComponent(releaseReference)}/speaker-artifacts/${encodeURIComponent(artifactReference)}`,
    });
  }));
}

export function readPublishedSpeakerHeadshot(
  db: Db,
  input: { readonly workspaceId: string; readonly eventId: string; readonly releaseId: string; readonly artifactId: string },
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRead | null {
  const workspaceId = scopeId(input.workspaceId);
  const eventId = scopeId(input.eventId);
  const releaseId = scopeId(input.releaseId);
  const id = artifactId(input.artifactId);
  const validated = validatePublicReleaseForRead(db, {
    workspaceId,
    eventId,
    releaseId,
    mode: "HISTORICAL",
  });
  if (!validated) return null;
  const headshot = validated.content.speakerHeadshots?.find((entry) => entry.artifactId === id);
  if (!headshot) return null;
  return readFinalizedPublishedHeadshot(db, {
    workspaceId,
    eventId,
    releaseId,
    headshot,
  }, options);
}

/**
 * Read one already-finalized release binding. This path is deliberately immutable: it does not
 * recover prepared uploads, inspect other scopes, or call any helper that can transition upload
 * intents. The exact artifact row and its sealed approval/binding evidence must all be present.
 */
function readFinalizedPublishedHeadshot(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly releaseId: string;
    readonly headshot: SealedSpeakerHeadshot;
  },
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRead | null {
  const row = db.prepare(
    `SELECT artifact.id, artifact.artifact_schema, artifact.workspace_id, artifact.event_id,
            artifact.person_id, artifact.task_id, artifact.kind, artifact.version,
            artifact.supersedes_record_id, artifact.storage_provider, artifact.storage_id,
            artifact.storage_filename, artifact.sha256, artifact.size_bytes, artifact.media_type,
            artifact.display_filename, artifact.created_at, artifact.content_version_id,
            artifact.authority_event_id
       FROM speaker_artifact_release_bindings binding
       JOIN artifact_records artifact
         ON artifact.id = binding.artifact_id
        AND artifact.workspace_id = binding.workspace_id
        AND artifact.event_id = binding.event_id
       JOIN publication_releases release_row
         ON release_row.id = binding.release_id
        AND release_row.workspace_id = binding.workspace_id
        AND release_row.event_id = binding.event_id
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id
        AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id
        AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id
       WHERE binding.workspace_id = ? AND binding.event_id = ? AND binding.release_id = ?
         AND binding.person_id = ? AND binding.artifact_id = ?
         AND binding.content_hash = ? AND binding.content_hash = version.content_hash
         AND release_row.sealed_at IS NOT NULL
         AND artifact.workspace_id = ? AND artifact.event_id = ? AND artifact.person_id = ?
         AND artifact.task_id = ? AND artifact.kind = 'HEADSHOT'
         AND artifact.content_version_id = ? AND artifact.version = ?
         AND artifact.sha256 = ? AND artifact.media_type = ?
         AND artifact.size_bytes = ? AND artifact.display_filename = ?
         AND version.content_hash = ?
       LIMIT 1`,
  ).get(
    input.workspaceId,
    input.eventId,
    input.releaseId,
    input.headshot.personId,
    input.headshot.artifactId,
    input.headshot.contentHash,
    input.workspaceId,
    input.eventId,
    input.headshot.personId,
    input.headshot.taskId,
    input.headshot.contentVersionId,
    input.headshot.version,
    input.headshot.sha256,
    input.headshot.mediaType,
    input.headshot.byteSize,
    input.headshot.displayFilename,
    input.headshot.contentHash,
  ) as ArtifactRecordRow | undefined;
  if (!row) return null;

  const projection = rowProjection(row);
  const store = serviceStore(db, options);
  const history = predecessorHistory(db, row);
  if (!history) return null;
  // Rehydrate the exact immutable predecessor chain only. This is process-local indexing; it
  // does not recover, commit, abort, or touch any prepared upload or filesystem entry.
  for (const predecessor of history) store.hydrate(predecessor);
  const read = store.read(projection, input.headshot.artifactId);
  return Object.freeze({
    record: publicRecord(projection, true),
    bytes: read.bytes,
  });
}

/** Public route lookup: release authority supplies the tenant/event scope; no caller-owned scope is trusted. */
export function readPublishedSpeakerHeadshotByRelease(
  db: Db,
  input: { readonly releaseId: string; readonly artifactId: string },
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRead | null {
  const releaseId = scopeId(input.releaseId);
  const id = artifactId(input.artifactId);
  const releaseScope = db.prepare(
    `SELECT workspace_id AS workspaceId, event_id AS eventId
       FROM publication_releases
      WHERE id = ? AND sealed_at IS NOT NULL
      LIMIT 1`,
  ).get(releaseId) as { workspaceId: string; eventId: string } | undefined;
  if (!releaseScope) return null;
  const validated = validatePublicReleaseForRead(db, {
    workspaceId: releaseScope.workspaceId,
    eventId: releaseScope.eventId,
    releaseId,
    mode: "HISTORICAL",
  });
  if (!validated) return null;
  const headshot = validated.content.speakerHeadshots?.find((entry) => entry.artifactId === id);
  if (!headshot) return null;
  return readFinalizedPublishedHeadshot(db, {
    workspaceId: releaseScope.workspaceId,
    eventId: releaseScope.eventId,
    releaseId,
    headshot,
  }, options);
}

/**
 * Anonymous photo lookup. The route supplies only audience references; this resolver first proves
 * that the release reference is the event's unique current sealed release, then proves the artifact
 * reference is the exact approved headshot bound into that same release. Historical bytes and
 * bindings remain available to organizer-authorized readers through the internal historical seams.
 */
export function readPublishedSpeakerHeadshotByAudienceReference(
  db: Db,
  input: { readonly releaseReference: string; readonly artifactReference: string },
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRead | null {
  if (!isAudienceReference(input.releaseReference) || !isAudienceReference(input.artifactReference)) return null;
  const rows = db.prepare(
    `SELECT r.workspace_id AS workspaceId, r.event_id AS eventId, r.id AS releaseId
       FROM events e
       JOIN publication_releases r
         ON r.workspace_id = e.workspace_id
        AND r.event_id = e.id
        AND r.id = e.current_release_id
      WHERE r.sealed_at IS NOT NULL`,
  ).all() as Array<{
    readonly workspaceId: string;
    readonly eventId: string;
    readonly releaseId: string;
  }>;
  const matches = rows.filter((row) => {
    try {
      return publicReleaseReference(row) === input.releaseReference;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  const validated = validatePublicReleaseForRead(db, {
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    releaseId: row.releaseId,
    mode: "CURRENT",
  });
  if (!validated) return null;
  const referenceScope: AudienceReferenceScope = {
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
  };
  if (publicReleaseReference(referenceScope) !== input.releaseReference) return null;
  const headshot = validated.content.speakerHeadshots?.find((entry) => publicArtifactReference(referenceScope, entry.artifactId) === input.artifactReference);
  if (!headshot) return null;
  return readFinalizedPublishedHeadshot(db, {
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
    headshot,
  }, options);
}

export function resetSpeakerArtifactStoreForTest(): void {
  derivedStores = new Map<string, LocalArtifactStore>();
  memoryDatabaseRoots = new WeakMap<object, string>();
  databaseStores = new WeakMap<object, LocalArtifactStore>();
  memoryDatabaseSequence = 0;
}
