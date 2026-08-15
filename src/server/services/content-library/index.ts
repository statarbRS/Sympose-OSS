import { roleHasCapability } from "../../auth";
import { withTransaction, type Db } from "../../db";
import {
  getSpeakerArtifactStore,
  listSpeakerArtifactRecords,
  type ArtifactRecordServiceOptions,
  type SpeakerArtifactKind,
  type SpeakerArtifactRecord,
} from "../artifact-records";
import { type LocalArtifactStore } from "../artifact-store";
import {
  createDurableContentOperationsRepository,
  type ContentApproval,
  type ContentReviewProjection,
  type ContentReviewState,
} from "../content-operations";

export const CONTENT_LIBRARY_SCHEMA = "sympose-content-library/v1" as const;
export const CONTENT_LIBRARY_ARCHIVE_SCHEMA = "sympose-content-library-archive/v1" as const;
export const CONTENT_LIBRARY_ARCHIVE_MAX_FILES = 24;
export const CONTENT_LIBRARY_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const CONTENT_LIBRARY_ARCHIVE_MAX_FORM_BYTES = 16 * 1024;
export const CONTENT_LIBRARY_ARCHIVE_FILENAME = "sympose-content-library.zip";

const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_ARTIFACT_ID = /^[a-f0-9]{64}$/u;
const APPROVAL_GATE_ORDER: readonly ContentApproval["gate"][] = [
  "CONFIRMATION",
  "PUBLICATION",
  "OPERATOR_RELEASE",
];
const UTF8_ZIP_FLAG = 0x0800;
const STORED_COMPRESSION_METHOD = 0;
const DOS_EPOCH_DATE = 0x0021;
const ZIP_VERSION_2 = 20;
const ZIP_VERSION_2_UNIX = 0x0314;
const ZIP_FILE_MODE = (0o100600 << 16) >>> 0;

export type ContentLibraryErrorCode =
  | "CONTENT_LIBRARY_SCOPE_UNAVAILABLE"
  | "CONTENT_LIBRARY_INTEGRITY_FAILURE"
  | "CONTENT_LIBRARY_SELECTION_EMPTY"
  | "CONTENT_LIBRARY_SELECTION_INVALID"
  | "CONTENT_LIBRARY_SELECTION_DUPLICATE"
  | "CONTENT_LIBRARY_SELECTION_NOT_FOUND"
  | "CONTENT_LIBRARY_SELECTION_STALE"
  | "CONTENT_LIBRARY_SELECTION_TOO_LARGE"
  | "CONTENT_LIBRARY_SELECTION_TOO_MANY"
  | "CONTENT_LIBRARY_BYTES_UNAVAILABLE"
  | "CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE";

export class ContentLibraryError extends Error {
  readonly code: ContentLibraryErrorCode;

  constructor(code: ContentLibraryErrorCode, message: string) {
    super(message);
    this.name = "ContentLibraryError";
    this.code = code;
  }
}

export interface OrganizerContentLibraryScope {
  readonly kind: "organizer";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorId: string;
}

export interface ContentLibraryItem {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly speakerName: string;
  readonly programUnitId: string;
  readonly sessionName: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskKind: string;
  readonly contentKind: SpeakerArtifactKind;
  readonly taskState: string;
  readonly contentVersionId: string;
  readonly contentHash: string;
  readonly version: number;
  readonly supersedesArtifactId: string | null;
  readonly current: boolean;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly uploadedAt: string;
  readonly reviewState: ContentReviewState;
  readonly approvalGates: readonly ContentApproval["gate"][];
}

export interface ContentLibraryProjection {
  readonly schema: typeof CONTENT_LIBRARY_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly items: readonly ContentLibraryItem[];
  readonly versionCount: number;
  readonly currentFileCount: number;
  readonly archiveLimits: {
    readonly maxFiles: number;
    readonly maxUncompressedBytes: number;
  };
}

export interface ContentLibraryArchiveEntry {
  readonly artifactId: string;
  readonly archivePath: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ContentLibraryArchive {
  readonly schema: typeof CONTENT_LIBRARY_ARCHIVE_SCHEMA;
  readonly fileName: typeof CONTENT_LIBRARY_ARCHIVE_FILENAME;
  readonly contentType: "application/zip";
  readonly bytes: Buffer;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly entries: readonly ContentLibraryArchiveEntry[];
}

interface ArtifactAuthorityRow {
  readonly artifactId: string;
  readonly personId: string;
  readonly speakerName: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskKind: string;
  readonly contentKind: SpeakerArtifactKind;
  readonly taskState: string;
  readonly programUnitId: string;
  readonly sessionName: string;
  readonly contentVersionId: string;
  readonly contentHash: string;
}

interface MaterializedArchiveEntry {
  readonly item: ContentLibraryItem;
  readonly archivePath: string;
  readonly bytes: Buffer;
}

function fail(code: ContentLibraryErrorCode, message: string): never {
  throw new ContentLibraryError(code, message);
}

function exactScopeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_SCOPE_ID.test(value)) {
    fail("CONTENT_LIBRARY_SCOPE_UNAVAILABLE", "Content Library scope is unavailable.");
  }
  return value;
}

function exactOrganizerScope(db: Db, scope: OrganizerContentLibraryScope): OrganizerContentLibraryScope {
  if (scope === null || typeof scope !== "object" || scope.kind !== "organizer") {
    fail("CONTENT_LIBRARY_SCOPE_UNAVAILABLE", "Content Library scope is unavailable.");
  }
  const normalized = Object.freeze({
    kind: "organizer" as const,
    workspaceId: exactScopeId(scope.workspaceId),
    eventId: exactScopeId(scope.eventId),
    actorId: exactScopeId(scope.actorId),
  });
  const actor = db.prepare(
    "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
  ).get(normalized.workspaceId, normalized.actorId) as { readonly role: string } | undefined;
  if (!actor || !roleHasCapability(actor.role, "phase0.pipeline.manage")) {
    fail("CONTENT_LIBRARY_SCOPE_UNAVAILABLE", "Content Library scope is unavailable.");
  }
  const event = db.prepare(
    "SELECT id FROM events WHERE workspace_id = ? AND id = ?",
  ).get(normalized.workspaceId, normalized.eventId) as { readonly id: string } | undefined;
  if (!event) {
    fail("CONTENT_LIBRARY_SCOPE_UNAVAILABLE", "Content Library scope is unavailable.");
  }
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function authorityRows(db: Db, scope: OrganizerContentLibraryScope): readonly ArtifactAuthorityRow[] {
  return db.prepare(
    `SELECT artifact.id AS artifactId,
            person.id AS personId,
            person.full_name AS speakerName,
            task.id AS taskId,
            task.title AS taskTitle,
            task.task_kind AS taskKind,
            task.content_kind AS contentKind,
            task.state AS taskState,
            unit.id AS programUnitId,
            unit.name AS sessionName,
            version.id AS contentVersionId,
            version.content_hash AS contentHash
       FROM artifact_records artifact
       JOIN artifact_upload_intents intent
         ON intent.artifact_id = artifact.id
        AND intent.workspace_id = artifact.workspace_id
        AND intent.event_id = artifact.event_id
        AND intent.person_id = artifact.person_id
        AND intent.task_id = artifact.task_id
        AND intent.kind = artifact.kind
        AND intent.storage_id = artifact.storage_id
        AND intent.storage_filename = artifact.storage_filename
        AND intent.version = artifact.version
        AND COALESCE(intent.supersedes_record_id, '') = COALESCE(artifact.supersedes_record_id, '')
        AND intent.sha256 = artifact.sha256
        AND intent.size_bytes = artifact.size_bytes
        AND intent.media_type = artifact.media_type
        AND intent.display_filename = artifact.display_filename
        AND intent.content_version_id = artifact.content_version_id
        AND intent.status = 'COMMITTED'
        AND intent.committed_at IS NOT NULL
       JOIN people person
         ON person.id = artifact.person_id
        AND person.workspace_id = artifact.workspace_id
       JOIN speaker_tasks task
         ON task.id = artifact.task_id
        AND task.workspace_id = artifact.workspace_id
        AND task.event_id = artifact.event_id
        AND task.person_id = artifact.person_id
        AND task.content_kind = artifact.kind
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id
        AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id
        AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id
        AND version.kind = artifact.kind
        AND version.version = artifact.version
       JOIN plan_assignments assignment
         ON assignment.id = task.assignment_id
        AND assignment.workspace_id = task.workspace_id
        AND assignment.person_id = task.person_id
       JOIN plan_versions plan
         ON plan.id = assignment.plan_version_id
        AND plan.workspace_id = assignment.workspace_id
        AND plan.event_id = task.event_id
       JOIN program_units unit
         ON unit.id = assignment.program_unit_id
        AND unit.workspace_id = assignment.workspace_id
        AND unit.event_id = task.event_id
      WHERE artifact.workspace_id = ? AND artifact.event_id = ?
      ORDER BY artifact.person_id, artifact.task_id, artifact.kind, artifact.version, artifact.id`,
  ).all(scope.workspaceId, scope.eventId) as unknown as readonly ArtifactAuthorityRow[];
}

function projectionKey(record: Pick<SpeakerArtifactRecord, "personId" | "taskId" | "kind">): string {
  return JSON.stringify([record.personId, record.taskId, record.kind]);
}

function approvalGatesFor(
  projection: ContentReviewProjection,
  versionId: string,
  contentHash: string,
): readonly ContentApproval["gate"][] {
  const gates = new Set(
    projection.approvals
      .filter((approval) =>
        approval.submissionVersionId === versionId && approval.submissionContentHash === contentHash,
      )
      .map((approval) => approval.gate),
  );
  return Object.freeze(APPROVAL_GATE_ORDER.filter((gate) => gates.has(gate)));
}

function itemFromAuthority(
  record: SpeakerArtifactRecord,
  authority: ArtifactAuthorityRow,
  projection: ContentReviewProjection,
): ContentLibraryItem {
  const version = projection.versions.find((candidate) => candidate.version === record.version);
  const asset = version?.payload.kind === "HEADSHOT" || version?.payload.kind === "SLIDES"
    ? version.payload.asset
    : null;
  if (
    authority.artifactId !== record.artifactId ||
    authority.personId !== record.personId ||
    authority.taskId !== record.taskId ||
    authority.contentKind !== record.kind ||
    !version ||
    version.id !== authority.contentVersionId ||
    version.contentHash !== authority.contentHash ||
    version.personId !== record.personId ||
    version.taskId !== record.taskId ||
    version.kind !== record.kind ||
    version.version !== record.version ||
    !asset ||
    asset.assetId !== record.artifactId ||
    asset.fileName !== record.displayFilename ||
    asset.mediaType !== record.mediaType ||
    asset.byteSize !== record.byteSize ||
    asset.checksum !== record.sha256
  ) {
    fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library authority is inconsistent.");
  }
  return deepFreeze({
    artifactId: record.artifactId,
    workspaceId: record.workspaceId,
    eventId: record.eventId,
    personId: record.personId,
    speakerName: authority.speakerName,
    programUnitId: authority.programUnitId,
    sessionName: authority.sessionName,
    taskId: record.taskId,
    taskTitle: authority.taskTitle,
    taskKind: authority.taskKind,
    contentKind: record.kind,
    taskState: authority.taskState,
    contentVersionId: version.id,
    contentHash: version.contentHash,
    version: record.version,
    supersedesArtifactId: record.supersedesRecordId,
    current: record.current,
    originalFilename: record.displayFilename,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    uploadedAt: record.createdAt,
    reviewState: version.reviewState,
    approvalGates: approvalGatesFor(projection, version.id, version.contentHash),
  });
}

export function listContentLibrary(
  db: Db,
  scope: OrganizerContentLibraryScope,
  options: ArtifactRecordServiceOptions = {},
): ContentLibraryProjection {
  const normalized = exactOrganizerScope(db, scope);
  const records = listSpeakerArtifactRecords(db, {
    workspaceId: normalized.workspaceId,
    eventId: normalized.eventId,
  }, options);
  const rows = authorityRows(db, normalized);
  if (rows.length !== records.length) {
    fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library authority is incomplete.");
  }
  const authorityByArtifactId = new Map<string, ArtifactAuthorityRow>();
  for (const row of rows) {
    if (authorityByArtifactId.has(row.artifactId)) {
      fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library authority is ambiguous.");
    }
    authorityByArtifactId.set(row.artifactId, row);
  }
  const content = createDurableContentOperationsRepository(db);
  const projections = new Map<string, ContentReviewProjection>();
  const items = records.map((record) => {
    const authority = authorityByArtifactId.get(record.artifactId);
    if (!authority) fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library authority is incomplete.");
    const key = projectionKey(record);
    let projection = projections.get(key);
    if (!projection) {
      projection = content.getReviewProjection({
        workspaceId: normalized.workspaceId,
        eventId: normalized.eventId,
        actorId: normalized.actorId,
        actorKind: "organizer",
      }, {
        personId: record.personId,
        taskId: record.taskId,
        kind: record.kind,
      });
      projections.set(key, projection);
    }
    return itemFromAuthority(record, authority, projection);
  });
  return deepFreeze({
    schema: CONTENT_LIBRARY_SCHEMA,
    workspaceId: normalized.workspaceId,
    eventId: normalized.eventId,
    items,
    versionCount: items.length,
    currentFileCount: items.filter((item) => item.current).length,
    archiveLimits: {
      maxFiles: CONTENT_LIBRARY_ARCHIVE_MAX_FILES,
      maxUncompressedBytes: CONTENT_LIBRARY_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
    },
  });
}

function selectedArtifactIds(values: readonly unknown[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    fail("CONTENT_LIBRARY_SELECTION_EMPTY", "Select at least one current file.");
  }
  if (values.length > CONTENT_LIBRARY_ARCHIVE_MAX_FILES) {
    fail("CONTENT_LIBRARY_SELECTION_TOO_MANY", "The selected file count exceeds the archive limit.");
  }
  const ids = values.map((value) => {
    if (typeof value !== "string" || !OPAQUE_ARTIFACT_ID.test(value)) {
      fail("CONTENT_LIBRARY_SELECTION_INVALID", "The file selection is invalid.");
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    fail("CONTENT_LIBRARY_SELECTION_DUPLICATE", "The same file cannot be selected more than once.");
  }
  return Object.freeze([...ids].sort(compareText));
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function safeArchiveSegment(value: string, fallback: string, maxBytes: number): string {
  let segment = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:]+/gu, "_")
    .replace(/[^\p{L}\p{N}._ ()-]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  if (segment.length === 0 || segment === "." || segment === "..") segment = fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(segment)) segment = `_${segment}`;
  segment = truncateUtf8(segment, maxBytes).replace(/[. ]+$/u, "");
  return segment.length > 0 ? segment : fallback;
}

function safeArchiveFilename(item: ContentLibraryItem): string {
  const extension = item.mediaType === "image/png" ? ".png" : ".pdf";
  const safe = safeArchiveSegment(item.originalFilename, `artifact${extension}`, 96);
  if (safe.toLocaleLowerCase("en-US").endsWith(extension)) return safe;
  const stem = truncateUtf8(safe.replace(/\.[^.]*$/u, ""), 96 - Buffer.byteLength(extension, "utf8"));
  return `${stem || "artifact"}${extension}`;
}

function archiveBasePath(item: ContentLibraryItem): string {
  const speaker = safeArchiveSegment(item.speakerName, `speaker-${item.artifactId.slice(0, 12)}`, 64);
  const task = safeArchiveSegment(
    `${item.contentKind.toLocaleLowerCase("en-US")}-${item.taskTitle}`,
    `${item.contentKind.toLocaleLowerCase("en-US")}-task`,
    80,
  );
  return `${speaker}/${task}/${safeArchiveFilename(item)}`;
}

function collisionPath(path: string, ordinal: number): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  return `${directory}${stem} (${ordinal})${extension}`;
}

function archivePaths(items: readonly ContentLibraryItem[]): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const item of [...items].sort((left, right) => compareText(left.artifactId, right.artifactId))) {
    const base = archiveBasePath(item);
    let path = base;
    let collisionOrdinal = 2;
    while (used.has(path.toLocaleLowerCase("en-US")) && collisionOrdinal <= items.length) {
      path = collisionPath(base, collisionOrdinal);
      collisionOrdinal += 1;
    }
    if (
      used.has(path.toLocaleLowerCase("en-US")) ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "A safe archive path could not be generated.");
    }
    used.add(path.toLocaleLowerCase("en-US"));
    paths.set(item.artifactId, path);
  }
  return paths;
}

export function selectContentLibraryArchiveItems(
  library: ContentLibraryProjection,
  selectedValues: readonly unknown[],
): readonly ContentLibraryItem[] {
  const artifactIds = selectedArtifactIds(selectedValues);
  const itemByArtifactId = new Map<string, ContentLibraryItem>();
  for (const item of library.items) {
    if (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0) {
      fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library file size authority is invalid.");
    }
    if (itemByArtifactId.has(item.artifactId)) {
      fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Content Library authority is ambiguous.");
    }
    itemByArtifactId.set(item.artifactId, item);
  }
  const selected = artifactIds.map((artifactId) => {
    const item = itemByArtifactId.get(artifactId);
    if (!item) fail("CONTENT_LIBRARY_SELECTION_NOT_FOUND", "A selected file is not available.");
    if (!item.current) fail("CONTENT_LIBRARY_SELECTION_STALE", "Only exact current file versions may be archived.");
    return item;
  });
  const total = selected.reduce((sum, item) => sum + item.byteSize, 0);
  if (!Number.isSafeInteger(total) || total > CONTENT_LIBRARY_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
    fail("CONTENT_LIBRARY_SELECTION_TOO_LARGE", "The selected bytes exceed the archive limit.");
  }
  return Object.freeze([...selected].sort((left, right) => compareText(left.artifactId, right.artifactId)));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: readonly MaterializedArchiveEntry[]): Buffer {
  if (entries.length < 1 || entries.length > CONTENT_LIBRARY_ARCHIVE_MAX_FILES) {
    fail("CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE", "The archive entry set is invalid.");
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.archivePath, "utf8");
    if (name.byteLength < 1 || name.byteLength > 0xffff || entry.bytes.byteLength > 0xffffffff) {
      fail("CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE", "An archive entry exceeds ZIP32 limits.");
    }
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION_2, 4);
    local.writeUInt16LE(UTF8_ZIP_FLAG, 6);
    local.writeUInt16LE(STORED_COMPRESSION_METHOD, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION_2_UNIX, 4);
    central.writeUInt16LE(ZIP_VERSION_2, 6);
    central.writeUInt16LE(UTF8_ZIP_FLAG, 8);
    central.writeUInt16LE(STORED_COMPRESSION_METHOD, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(ZIP_FILE_MODE, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.byteLength + name.byteLength + entry.bytes.byteLength;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  if (localOffset > 0xffffffff || centralSize > 0xffffffff || localOffset + centralSize > 0xffffffff) {
    fail("CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE", "The archive exceeds ZIP32 limits.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function currentArtifactIds(
  db: Db,
  scope: OrganizerContentLibraryScope,
  artifactIds: readonly string[],
): ReadonlySet<string> {
  const placeholders = artifactIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT artifact.id
       FROM artifact_records artifact
      WHERE artifact.workspace_id = ? AND artifact.event_id = ?
        AND artifact.id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1
            FROM artifact_records later
           WHERE later.workspace_id = artifact.workspace_id
             AND later.event_id = artifact.event_id
             AND later.person_id = artifact.person_id
             AND later.task_id = artifact.task_id
             AND later.kind = artifact.kind
             AND later.version > artifact.version
        )`,
  ).all(scope.workspaceId, scope.eventId, ...artifactIds) as unknown as readonly { readonly id: string }[];
  return new Set(rows.map((row) => row.id));
}

function materializeArchive(
  db: Db,
  scope: OrganizerContentLibraryScope,
  items: readonly ContentLibraryItem[],
  store: LocalArtifactStore,
): readonly MaterializedArchiveEntry[] {
  const paths = archivePaths(items);
  return withTransaction(db, () => {
    exactOrganizerScope(db, scope);
    const currentIds = currentArtifactIds(db, scope, items.map((item) => item.artifactId));
    if (currentIds.size !== items.length || items.some((item) => !currentIds.has(item.artifactId))) {
      fail("CONTENT_LIBRARY_SELECTION_STALE", "Only exact current file versions may be archived.");
    }
    const materialized = items.map((item) => {
      const read = store.read({
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: item.personId,
        taskId: item.taskId,
        kind: item.contentKind,
      }, item.artifactId);
      if (
        read.artifactId !== item.artifactId ||
        read.version !== item.version ||
        read.sha256 !== item.sha256 ||
        read.byteSize !== item.byteSize ||
        read.mediaType !== item.mediaType ||
        read.displayFilename !== item.originalFilename ||
        read.bytes.byteLength !== item.byteSize
      ) {
        fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "Selected file bytes do not match durable authority.");
      }
      const archivePath = paths.get(item.artifactId);
      if (!archivePath) fail("CONTENT_LIBRARY_INTEGRITY_FAILURE", "A selected archive path is missing.");
      return Object.freeze({ item, archivePath, bytes: Buffer.from(read.bytes) });
    });
    return Object.freeze(materialized);
  });
}

export function createContentLibraryArchive(
  db: Db,
  scope: OrganizerContentLibraryScope,
  selectedValues: readonly unknown[],
  options: ArtifactRecordServiceOptions = {},
): ContentLibraryArchive {
  if (db.isTransaction) {
    fail("CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE", "The archive requires its own read snapshot.");
  }
  const normalized = exactOrganizerScope(db, scope);
  const library = listContentLibrary(db, normalized, options);
  const selected = selectContentLibraryArchiveItems(library, selectedValues);
  const total = selected.reduce((sum, item) => sum + item.byteSize, 0);
  const store = options.store ?? getSpeakerArtifactStore(db);
  let materialized: readonly MaterializedArchiveEntry[];
  try {
    materialized = materializeArchive(db, normalized, selected, store);
  } catch (error) {
    if (error instanceof ContentLibraryError) throw error;
    fail("CONTENT_LIBRARY_BYTES_UNAVAILABLE", "The selected files could not be read; no archive was created.");
  }
  const ordered = [...materialized].sort((left, right) =>
    compareText(left.archivePath, right.archivePath) || compareText(left.item.artifactId, right.item.artifactId),
  );
  const bytes = buildStoredZip(ordered);
  const entries = ordered.map((entry) => Object.freeze({
    artifactId: entry.item.artifactId,
    archivePath: entry.archivePath,
    byteSize: entry.item.byteSize,
    sha256: entry.item.sha256,
  }));
  return deepFreeze({
    schema: CONTENT_LIBRARY_ARCHIVE_SCHEMA,
    fileName: CONTENT_LIBRARY_ARCHIVE_FILENAME,
    contentType: "application/zip" as const,
    bytes,
    fileCount: entries.length,
    uncompressedBytes: total,
    entries,
  });
}
