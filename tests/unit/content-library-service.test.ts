import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createSpeakerArtifactRecord,
  readSpeakerArtifact,
  type SpeakerArtifactRecord,
  type SpeakerArtifactScope,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import {
  CONTENT_LIBRARY_ARCHIVE_MAX_FILES,
  CONTENT_LIBRARY_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  ContentLibraryError,
  createContentLibraryArchive,
  listContentLibrary,
  selectContentLibraryArchiveItems,
  type ContentLibraryErrorCode,
  type ContentLibraryProjection,
  type OrganizerContentLibraryScope,
} from "../../src/server/services/content-library";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";

const AT = "2026-08-13T00:00:00.000Z";
const WORKSPACE_A = "content-library-workspace-a";
const WORKSPACE_B = "content-library-workspace-b";
const EVENT_A = "content-library-event-a";
const EVENT_A_OTHER = "content-library-event-a-other";
const EVENT_B = "content-library-event-b";
const PERSON_A = "content-library-person-a";
const PERSON_B = "content-library-person-b";
const ACTOR_A = "content-library-organizer-a";
const ACTOR_B = "content-library-organizer-b";
const ZIP_PROOF_PATH = join(tmpdir(), "sympose-content-library-zip-proof.zip");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function validPdfFixture(label: string): Buffer {
  const prefix = Buffer.from(`%PDF-1.7\n% ${label}\n`, "utf8");
  const objectOffset = prefix.byteLength;
  const object = Buffer.from("1 0 obj\n<< /Type /Catalog >>\nendobj\n", "ascii");
  const beforeXref = Buffer.concat([prefix, object]);
  const xrefOffset = beforeXref.byteLength;
  return Buffer.concat([
    beforeXref,
    Buffer.from("xref\n0 2\n0000000000 65535 f \n", "ascii"),
    Buffer.from(`${String(objectOffset).padStart(10, "0")} 00000 n \n`, "ascii"),
    Buffer.from("trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n", "ascii"),
    Buffer.from(`${xrefOffset}\n%%EOF\n`, "ascii"),
  ]);
}

const PDF_OLD = validPdfFixture("old exact bytes");
const PDF_LATEST = validPdfFixture("latest exact bytes");
const PDF_SECOND = validPdfFixture("second exact bytes");
const PDF_B = validPdfFixture("tenant B exact bytes");

const roots = new Set<string>();
const databases = new Set<Db>();

function trackedOpen(path: string): Db {
  const db = openDb({ path, seed: false });
  databases.add(db);
  return db;
}

function trackedClose(db: Db): void {
  if (!databases.delete(db)) return;
  closeDb(db);
}

afterEach(() => {
  for (const db of databases) closeDb(db);
  databases.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function seedAcceptedCurrentPlan(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
  actorId: string,
  slug: string,
): void {
  const assignmentId = `${slug}-assignment`;
  const runId = `${slug}-run`;
  const planId = `${slug}-plan`;
  const unitId = `${slug}-unit`;
  const offerId = `${slug}-offer`;
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)")
    .run(actorId, workspaceId, `${slug}@example.test`, `${slug} Organizer`, AT);
  db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, 'SESSION', ?, ?, 4, ?)")
    .run(unitId, workspaceId, eventId, `${slug} Main Session`, AT, "2026-08-13T01:00:00.000Z", AT);
  db.prepare("INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at) VALUES (?, ?, ?, 'completed', ?, '{}', 'test', '1', ?)")
    .run(runId, workspaceId, eventId, `${slug}-input`, AT);
  db.prepare("INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at) VALUES (?, ?, ?, ?, 1, ?, '{}', ?)")
    .run(
      planId,
      workspaceId,
      eventId,
      runId,
      fingerprintOf({ schema: "content-library-plan/v1", slug }),
      AT,
    );
  db.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?")
    .run(planId, workspaceId, eventId);
  db.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation) VALUES (?, ?, ?, ?, ?, 'SPEAKER', ?)")
    .run(assignmentId, workspaceId, planId, personId, unitId, "Accepted Content Library fixture authority");
  db.prepare("INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, created_at) VALUES (?, ?, ?, 'approved', ?, ?)")
    .run(`${slug}-state`, workspaceId, planId, actorId, AT);
  db.prepare("INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?)")
    .run(`${slug}-approval`, workspaceId, eventId, planId, actorId, AT);
  const terms = JSON.stringify({
    schema: "commitment-offer-terms/v1",
    planVersionId: planId,
    eventId,
    programUnitId: unitId,
    role: "SPEAKER",
    startsAt: AT,
    endsAt: "2026-08-13T01:00:00.000Z",
    location: "Room A",
  });
  db.prepare("INSERT INTO commitment_offers (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(offerId, workspaceId, eventId, planId, personId, terms, fingerprintOf(JSON.parse(terms)), AT);
  db.prepare("INSERT INTO commitment_responses (id, workspace_id, offer_id, response, responded_at, actor_person_id) VALUES (?, ?, ?, 'accepted', ?, ?)")
    .run(`${slug}-response`, workspaceId, offerId, AT, personId);
}

interface Fixture {
  readonly db: Db;
  readonly dbPath: string;
  readonly root: string;
  readonly store: LocalArtifactStore;
  readonly scopeA: OrganizerContentLibraryScope;
  readonly scopeB: OrganizerContentLibraryScope;
  readonly mainScope: SpeakerArtifactScope;
  readonly old: SpeakerArtifactRecord;
  readonly latest: SpeakerArtifactRecord;
  readonly second: SpeakerArtifactRecord;
  readonly headshot: SpeakerArtifactRecord;
  readonly tenantB: SpeakerArtifactRecord;
}

function approveArtifact(
  db: Db,
  scope: OrganizerContentLibraryScope,
  artifactScope: SpeakerArtifactScope,
  version: number,
): void {
  const durable = db.prepare(
    "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ? AND version = ?",
  ).get(
    artifactScope.workspaceId,
    artifactScope.eventId,
    artifactScope.personId,
    artifactScope.taskId,
    artifactScope.kind,
    version,
  ) as { readonly id: string; readonly contentHash: string } | undefined;
  if (!durable) throw new Error("Artifact content version fixture was not persisted.");
  createSyntheticSpeakerOperationsRepository({ db, clock: () => AT }).approveContent(scope, {
    personId: artifactScope.personId,
    taskId: artifactScope.taskId,
    submissionVersionId: durable.id,
    submissionContentHash: durable.contentHash,
    gate: "OPERATOR_RELEASE",
  });
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sympose-content-library-"));
  roots.add(root);
  const dbPath = join(root, "content-library.sqlite");
  const db = trackedOpen(dbPath);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_A, "content-library-a", "Content Library A", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_B, "content-library-b", "Content Library B", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)")
    .run(EVENT_A, WORKSPACE_A, "Content Library Event A", AT, "2026-08-13T01:00:00.000Z", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)")
    .run(EVENT_A_OTHER, WORKSPACE_A, "Other Event A", AT, "2026-08-13T01:00:00.000Z", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)")
    .run(EVENT_B, WORKSPACE_B, "Content Library Event B", AT, "2026-08-13T01:00:00.000Z", AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(PERSON_A, WORKSPACE_A, "speaker-a@example.test", "Mína / ..\\ Speaker\r\nA", AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(PERSON_B, WORKSPACE_B, "speaker-b@example.test", "Speaker B", AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)")
    .run("content-library-speaker-a", WORKSPACE_A, EVENT_A, PERSON_A, AT, AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)")
    .run("content-library-speaker-b", WORKSPACE_B, EVENT_B, PERSON_B, AT, AT);
  seedAcceptedCurrentPlan(db, WORKSPACE_A, EVENT_A, PERSON_A, ACTOR_A, "content-library-a");
  seedAcceptedCurrentPlan(db, WORKSPACE_B, EVENT_B, PERSON_B, ACTOR_B, "content-library-b");

  const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
  const scopeA = { kind: "organizer" as const, workspaceId: WORKSPACE_A, eventId: EVENT_A, actorId: ACTOR_A };
  const scopeB = { kind: "organizer" as const, workspaceId: WORKSPACE_B, eventId: EVENT_B, actorId: ACTOR_B };
  const mainScope: SpeakerArtifactScope = {
    workspaceId: WORKSPACE_A,
    eventId: EVENT_A,
    personId: PERSON_A,
    taskId: "content-library-task-main-slides",
    kind: "SLIDES",
  };
  const secondScope: SpeakerArtifactScope = {
    ...mainScope,
    taskId: "content-library-task-second-slides",
  };
  const headshotScope: SpeakerArtifactScope = {
    ...mainScope,
    taskId: "content-library-task-headshot",
    kind: "HEADSHOT",
  };
  const tenantBScope: SpeakerArtifactScope = {
    workspaceId: WORKSPACE_B,
    eventId: EVENT_B,
    personId: PERSON_B,
    taskId: "content-library-task-tenant-b",
    kind: "SLIDES",
  };

  const old = createSpeakerArtifactRecord(db, mainScope, {
    bytes: PDF_OLD,
    mediaType: "application/pdf",
    originalFilename: "../../shared\r\nname.pdf",
  }, { store });
  approveArtifact(db, scopeA, mainScope, 1);
  const latest = createSpeakerArtifactRecord(db, mainScope, {
    bytes: PDF_LATEST,
    mediaType: "application/pdf",
    originalFilename: "..\\..\\shared\r\nname.pdf",
  }, { store });
  approveArtifact(db, scopeA, mainScope, 2);
  const second = createSpeakerArtifactRecord(db, secondScope, {
    bytes: PDF_SECOND,
    mediaType: "application/pdf",
    originalFilename: "/absolute/shared\r\nname.pdf",
  }, { store });
  const headshot = createSpeakerArtifactRecord(db, headshotScope, {
    bytes: PNG,
    mediaType: "image/png",
    originalFilename: "C:\\..\\Mína\r\nheadshot.png",
  }, { store });
  const tenantB = createSpeakerArtifactRecord(db, tenantBScope, {
    bytes: PDF_B,
    mediaType: "application/pdf",
    originalFilename: "tenant-b-private-slides.pdf",
  }, { store });
  return { db, dbPath, root, store, scopeA, scopeB, mainScope, old, latest, second, headshot, tenantB };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzipStoredEntries(zip: Buffer): ReadonlyMap<string, Buffer> {
  const endOffset = zip.byteLength - 22;
  expect(endOffset).toBeGreaterThanOrEqual(0);
  expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
  expect(zip.readUInt16LE(endOffset + 4)).toBe(0);
  expect(zip.readUInt16LE(endOffset + 6)).toBe(0);
  const count = zip.readUInt16LE(endOffset + 8);
  expect(zip.readUInt16LE(endOffset + 10)).toBe(count);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  expect(zip.readUInt16LE(endOffset + 20)).toBe(0);
  expect(centralOffset + centralSize).toBe(endOffset);

  const extracted = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 8)).toBe(0x0800);
    expect(zip.readUInt16LE(cursor + 10)).toBe(0);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    expect(compressed).toBe(uncompressed);
    expect(extraLength).toBe(0);
    expect(commentLength).toBe(0);
    expect(zip.readUInt16LE(cursor + 34)).toBe(0);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt16LE(localOffset + 6)).toBe(0x0800);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(0);
    expect(zip.readUInt32LE(localOffset + 14)).toBe(expectedCrc);
    expect(zip.readUInt32LE(localOffset + 18)).toBe(compressed);
    expect(zip.readUInt32LE(localOffset + 22)).toBe(uncompressed);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    expect(localExtraLength).toBe(0);
    expect(zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8")).toBe(name);
    const dataOffset = localOffset + 30 + localNameLength;
    const bytes = Buffer.from(zip.subarray(dataOffset, dataOffset + compressed));
    expect(bytes.byteLength).toBe(uncompressed);
    expect(crc32(bytes)).toBe(expectedCrc);
    expect(extracted.has(name)).toBe(false);
    extracted.set(name, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(centralOffset + centralSize);
  return extracted;
}

function expectLibraryError(action: () => unknown, code: ContentLibraryErrorCode): void {
  try {
    action();
    throw new Error("Expected ContentLibraryError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ContentLibraryError);
    expect((error as ContentLibraryError).code).toBe(code);
  }
}

describe("durable organizer Content Library", () => {
  it("lists every exact-event version with durable identity, file metadata, latest status, and canonical review evidence", () => {
    const fixture = setup();
    const projection = listContentLibrary(fixture.db, fixture.scopeA, { store: fixture.store });

    expect(projection.workspaceId).toBe(WORKSPACE_A);
    expect(projection.eventId).toBe(EVENT_A);
    expect(projection.versionCount).toBe(4);
    expect(projection.currentFileCount).toBe(3);
    expect(projection.items).toHaveLength(4);
    expect(projection.items.some((item) => item.artifactId === fixture.tenantB.artifactId)).toBe(false);

    const old = projection.items.find((item) => item.artifactId === fixture.old.artifactId);
    const latest = projection.items.find((item) => item.artifactId === fixture.latest.artifactId);
    const second = projection.items.find((item) => item.artifactId === fixture.second.artifactId);
    const headshot = projection.items.find((item) => item.artifactId === fixture.headshot.artifactId);
    expect(old).toMatchObject({
      personId: PERSON_A,
      speakerName: "Mína / ..\\ Speaker\r\nA",
      sessionName: "content-library-a Main Session",
      taskId: fixture.mainScope.taskId,
      taskKind: "SLIDES",
      contentKind: "SLIDES",
      version: 1,
      current: false,
      originalFilename: fixture.old.displayFilename,
      mediaType: "application/pdf",
      byteSize: PDF_OLD.byteLength,
      sha256: sha256(PDF_OLD),
      uploadedAt: AT,
      reviewState: "APPROVED",
      approvalGates: ["OPERATOR_RELEASE"],
    });
    expect(latest).toMatchObject({
      version: 2,
      supersedesArtifactId: fixture.old.artifactId,
      current: true,
      originalFilename: fixture.latest.displayFilename,
      byteSize: PDF_LATEST.byteLength,
      sha256: sha256(PDF_LATEST),
      reviewState: "APPROVED",
      approvalGates: ["OPERATOR_RELEASE"],
    });
    expect(second).toMatchObject({ version: 1, current: true, reviewState: "IN_REVIEW", approvalGates: [] });
    expect(headshot).toMatchObject({ contentKind: "HEADSHOT", mediaType: "image/png", byteSize: PNG.byteLength, current: true });
  });

  it("survives a cold database and artifact-store reload with the same projection and exact bytes", () => {
    const fixture = setup();
    const before = listContentLibrary(fixture.db, fixture.scopeA, { store: fixture.store });
    const beforeArchive = createContentLibraryArchive(
      fixture.db,
      fixture.scopeA,
      [fixture.latest.artifactId, fixture.second.artifactId],
      { store: fixture.store },
    );
    trackedClose(fixture.db);

    const reopened = trackedOpen(fixture.dbPath);
    const reopenedStore = new LocalArtifactStore({ rootDir: fixture.root });
    const after = listContentLibrary(reopened, fixture.scopeA, { store: reopenedStore });
    const afterArchive = createContentLibraryArchive(
      reopened,
      fixture.scopeA,
      [fixture.second.artifactId, fixture.latest.artifactId],
      { store: reopenedStore },
    );

    expect(after).toEqual(before);
    expect(afterArchive.bytes).toEqual(beforeArchive.bytes);
    expect(readSpeakerArtifact(reopened, fixture.mainScope, fixture.latest.artifactId, { store: reopenedStore })?.bytes)
      .toEqual(PDF_LATEST);
  });

  it("creates a deterministic standards-compliant ZIP containing only the exact selected latest bytes", () => {
    const fixture = setup();
    const first = createContentLibraryArchive(
      fixture.db,
      fixture.scopeA,
      [fixture.second.artifactId, fixture.latest.artifactId],
      { store: fixture.store },
    );
    const reversed = createContentLibraryArchive(
      fixture.db,
      fixture.scopeA,
      [fixture.latest.artifactId, fixture.second.artifactId],
      { store: fixture.store },
    );

    expect(first.bytes).toEqual(reversed.bytes);
    expect(first.fileCount).toBe(2);
    expect(first.uncompressedBytes).toBe(PDF_LATEST.byteLength + PDF_SECOND.byteLength);
    expect(first.entries.map((entry) => entry.archivePath)).toHaveLength(2);
    expect(new Set(first.entries.map((entry) => entry.archivePath)).size).toBe(2);
    expect(first.entries.some((entry) => /\(2\)\.pdf$/u.test(entry.archivePath))).toBe(true);
    for (const entry of first.entries) {
      expect(entry.archivePath).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|[\\\r\n\u0000]/u);
      expect(entry.archivePath.startsWith("/")).toBe(false);
    }

    if (process.env.SYMPOSE_WRITE_CONTENT_LIBRARY_ZIP_PROOF === "1") {
      writeFileSync(ZIP_PROOF_PATH, first.bytes);
    }
    const extracted = unzipStoredEntries(first.bytes);
    expect([...extracted.keys()]).toEqual(first.entries.map((entry) => entry.archivePath));
    const expected = new Map([
      [fixture.latest.artifactId, PDF_LATEST],
      [fixture.second.artifactId, PDF_SECOND],
    ]);
    for (const entry of first.entries) {
      expect(extracted.get(entry.archivePath)).toEqual(expected.get(entry.artifactId));
    }
    expect(first.entries.some((entry) => entry.artifactId === fixture.old.artifactId)).toBe(false);
    expect(first.bytes.includes(PDF_OLD)).toBe(false);
  });

  it("fails closed for stale, cross-tenant, wrong-event, wrong-person, wrong-task, and wrong-kind identifiers", () => {
    const fixture = setup();
    expectLibraryError(
      () => createContentLibraryArchive(fixture.db, fixture.scopeA, [fixture.old.artifactId], { store: fixture.store }),
      "CONTENT_LIBRARY_SELECTION_STALE",
    );
    expectLibraryError(
      () => createContentLibraryArchive(fixture.db, fixture.scopeA, [fixture.tenantB.artifactId], { store: fixture.store }),
      "CONTENT_LIBRARY_SELECTION_NOT_FOUND",
    );
    expectLibraryError(
      () => listContentLibrary(fixture.db, { ...fixture.scopeA, actorId: ACTOR_B }, { store: fixture.store }),
      "CONTENT_LIBRARY_SCOPE_UNAVAILABLE",
    );
    expectLibraryError(
      () => createContentLibraryArchive(fixture.db, { ...fixture.scopeA, eventId: EVENT_A_OTHER }, [fixture.latest.artifactId], { store: fixture.store }),
      "CONTENT_LIBRARY_SELECTION_NOT_FOUND",
    );
    expect(listContentLibrary(fixture.db, fixture.scopeB, { store: fixture.store }).items.map((item) => item.artifactId))
      .toEqual([fixture.tenantB.artifactId]);
    expect(readSpeakerArtifact(fixture.db, { ...fixture.mainScope, personId: PERSON_B }, fixture.latest.artifactId, { store: fixture.store })).toBeNull();
    expect(readSpeakerArtifact(fixture.db, { ...fixture.mainScope, taskId: "wrong-task" }, fixture.latest.artifactId, { store: fixture.store })).toBeNull();
    expect(readSpeakerArtifact(fixture.db, { ...fixture.mainScope, kind: "HEADSHOT" }, fixture.latest.artifactId, { store: fixture.store })).toBeNull();
  });

  it("rejects malformed, empty, duplicate, excessive-count, and excessive-byte selections", () => {
    const fixture = setup();
    const projection = listContentLibrary(fixture.db, fixture.scopeA, { store: fixture.store });
    expectLibraryError(() => selectContentLibraryArchiveItems(projection, []), "CONTENT_LIBRARY_SELECTION_EMPTY");
    expectLibraryError(() => selectContentLibraryArchiveItems(projection, ["../artifact"]), "CONTENT_LIBRARY_SELECTION_INVALID");
    expectLibraryError(
      () => selectContentLibraryArchiveItems(projection, [fixture.latest.artifactId, fixture.latest.artifactId]),
      "CONTENT_LIBRARY_SELECTION_DUPLICATE",
    );
    expectLibraryError(
      () => selectContentLibraryArchiveItems(
        projection,
        Array.from({ length: CONTENT_LIBRARY_ARCHIVE_MAX_FILES + 1 }, (_, index) => index.toString(16).padStart(64, "0")),
      ),
      "CONTENT_LIBRARY_SELECTION_TOO_MANY",
    );
    const base = projection.items[0]!;
    const oversized: ContentLibraryProjection = {
      ...projection,
      items: [
        { ...base, artifactId: "d".repeat(64), current: true, byteSize: CONTENT_LIBRARY_ARCHIVE_MAX_UNCOMPRESSED_BYTES },
        { ...base, artifactId: "e".repeat(64), current: true, byteSize: 1 },
      ],
    };
    expectLibraryError(
      () => selectContentLibraryArchiveItems(oversized, ["d".repeat(64), "e".repeat(64)]),
      "CONTENT_LIBRARY_SELECTION_TOO_LARGE",
    );
  });

  it("fails the whole archive before returning bytes when any selected stored file is missing", () => {
    const fixture = setup();
    rmSync(join(fixture.root, `${fixture.second.storageId}.bin`));

    expectLibraryError(
      () => createContentLibraryArchive(
        fixture.db,
        fixture.scopeA,
        [fixture.latest.artifactId, fixture.second.artifactId],
        { store: fixture.store },
      ),
      "CONTENT_LIBRARY_BYTES_UNAVAILABLE",
    );
  });

  it("fails atomically when stored bytes retain their size but no longer match the durable SHA-256", () => {
    const fixture = setup();
    writeFileSync(join(fixture.root, `${fixture.second.storageId}.bin`), Buffer.alloc(fixture.second.byteSize, 0x78));

    expectLibraryError(
      () => createContentLibraryArchive(
        fixture.db,
        fixture.scopeA,
        [fixture.latest.artifactId, fixture.second.artifactId],
        { store: fixture.store },
      ),
      "CONTENT_LIBRARY_BYTES_UNAVAILABLE",
    );
  });
});
