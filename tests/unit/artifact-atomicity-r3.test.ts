import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  ArtifactRecordCrashInjectedError,
  createSpeakerArtifactRecord,
  listSpeakerArtifactRecords,
  recoverSpeakerArtifactUploads,
  readSpeakerArtifact,
  type SpeakerArtifactScope,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const AT = "2026-08-12T12:00:00.000Z";
const A = { workspaceId: "atomic-workspace-a", eventId: "atomic-event-a", personId: "atomic-person-a", taskId: "atomic-task-a", kind: "HEADSHOT" } as const;
const B = { workspaceId: "atomic-workspace-b", eventId: "atomic-event-b", personId: "atomic-person-b", taskId: "atomic-task-b", kind: "HEADSHOT" } as const;

const roots: string[] = [];
const databases: Db[] = [];

function setup(): { readonly db: Db; readonly root: string; readonly store: LocalArtifactStore } {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(A.workspaceId, "atomic-a", "Atomic A", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(B.workspaceId, "atomic-b", "Atomic B", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(A.eventId, A.workspaceId, "Atomic A", "UTC", AT, AT, AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(B.eventId, B.workspaceId, "Atomic B", "UTC", AT, AT, AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(A.personId, A.workspaceId, "atomic-a@example.test", "Atomic A", AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(B.personId, B.workspaceId, "atomic-b@example.test", "Atomic B", AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)").run("atomic-speaker-a", A.workspaceId, A.eventId, A.personId, AT, AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)").run("atomic-speaker-b", B.workspaceId, B.eventId, B.personId, AT, AT);
  seedAcceptedCurrentPlan(db, A, "atomic-a");
  seedAcceptedCurrentPlan(db, B, "atomic-b");
  const root = mkdtempSync(join(tmpdir(), "sympose-artifact-atomicity-"));
  roots.push(root);
  return { db, root, store: new LocalArtifactStore({ rootDir: root, clock: () => AT }) };
}

function seedAcceptedCurrentPlan(db: Db, scope: SpeakerArtifactScope, slug: string): void {
  const accountId = `${slug}-organizer`;
  const planId = `${slug}-plan`;
  const runId = `${slug}-run`;
  const unitId = `${slug}-unit`;
  const offerId = `${slug}-offer`;
  const assignmentId = `${slug}-assignment`;
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)").run(accountId, scope.workspaceId, `${slug}@example.test`, slug, AT);
  db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(unitId, scope.workspaceId, scope.eventId, slug, "SESSION", AT, "2026-08-12T13:00:00.000Z", 1, AT);
  db.prepare("INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at) VALUES (?, ?, ?, 'completed', ?, '{}', 'test', '1', ?)").run(runId, scope.workspaceId, scope.eventId, `${slug}-input`, AT);
  db.prepare("INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at) VALUES (?, ?, ?, ?, 1, ?, '{}', ?)").run(planId, scope.workspaceId, scope.eventId, runId, `${slug}-fingerprint`, AT);
  db.prepare("UPDATE events SET current_plan_version_id = ? WHERE id = ? AND workspace_id = ?").run(planId, scope.eventId, scope.workspaceId);
  db.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation) VALUES (?, ?, ?, ?, ?, 'SPEAKER', 'accepted current authority')").run(assignmentId, scope.workspaceId, planId, scope.personId, unitId);
  db.prepare("INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, created_at) VALUES (?, ?, ?, 'approved', ?, ?)").run(`${slug}-state`, scope.workspaceId, planId, accountId, AT);
  db.prepare("INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?)").run(`${slug}-approval`, scope.workspaceId, scope.eventId, planId, accountId, AT);
  db.prepare("INSERT INTO commitment_offers (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(offerId, scope.workspaceId, scope.eventId, planId, scope.personId, JSON.stringify({ schema: "commitment-offer-terms/v1", planVersionId: planId, eventId: scope.eventId, programUnitId: unitId, role: "SPEAKER" }), `${slug}-terms`, AT);
  db.prepare("INSERT INTO commitment_responses (id, workspace_id, offer_id, response, responded_at, actor_person_id) VALUES (?, ?, ?, 'accepted', ?, ?)").run(`${slug}-response`, scope.workspaceId, offerId, AT, scope.personId);
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("artifact crash/recovery atomicity", () => {
  it("releases an aborted after-intent reservation so retry commits version one", () => {
    const { db, root, store } = setup();
    expect(() => createSpeakerArtifactRecord(db, A, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "a.png",
    }, { store, fault: (point) => {
      if (point === "after-intent") throw new ArtifactRecordCrashInjectedError(point);
    } })).toThrow(ArtifactRecordCrashInjectedError);

    expect(recoverSpeakerArtifactUploads(db, { workspaceId: A.workspaceId, eventId: A.eventId }, { store: new LocalArtifactStore({ rootDir: root }) })).toEqual({ recovered: 0, aborted: 1 });
    const retry = createSpeakerArtifactRecord(db, A, { bytes: PNG, mediaType: "image/png", originalFilename: "a.png" }, { store });
    expect(retry.version).toBe(1);
    expect(db.prepare("SELECT status, version FROM artifact_upload_intents").all()).toEqual([{ status: "COMMITTED", version: 1 }]);
  });

  it("recovers only the explicitly requested workspace and event", () => {
    const { db, root, store } = setup();
    expect(() => createSpeakerArtifactRecord(db, B, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "b.png",
    }, { store, fault: (point) => {
      if (point === "after-stage") throw new ArtifactRecordCrashInjectedError(point);
    } })).toThrow(ArtifactRecordCrashInjectedError);

    expect(listSpeakerArtifactRecords(db, { workspaceId: A.workspaceId, eventId: A.eventId }, { store: new LocalArtifactStore({ rootDir: root }) })).toEqual([]);
    expect(db.prepare("SELECT status FROM artifact_upload_intents WHERE workspace_id = ?").get(B.workspaceId)).toEqual({ status: "PREPARED" });
    expect(recoverSpeakerArtifactUploads(db, { workspaceId: B.workspaceId, eventId: B.eventId }, { store: new LocalArtifactStore({ rootDir: root }) })).toEqual({ recovered: 1, aborted: 0 });
  });

  it("keeps committed metadata and bytes after a post-finalize fault, then advances once", () => {
    const { db, store } = setup();
    expect(() => createSpeakerArtifactRecord(db, A, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "a.png",
    }, { store, fault: (point) => {
      if (point === "after-finalize") throw new ArtifactRecordCrashInjectedError(point);
    } })).toThrow(ArtifactRecordCrashInjectedError);

    const committed = listSpeakerArtifactRecords(db, { workspaceId: A.workspaceId, eventId: A.eventId }, { store });
    expect(committed).toHaveLength(1);
    expect(readSpeakerArtifact(db, A, committed[0]!.artifactId, { store })?.bytes).toEqual(PNG);
    expect(createSpeakerArtifactRecord(db, A, { bytes: PNG, mediaType: "image/png", originalFilename: "a-v2.png" }, { store }).version).toBe(2);
  });

  it("fails closed before staging when an outer transaction cannot guarantee byte atomicity", () => {
    const { db, root, store } = setup();
    db.exec("BEGIN IMMEDIATE");
    expect(() => createSpeakerArtifactRecord(db, A, { bytes: PNG, mediaType: "image/png", originalFilename: "a.png" }, { store })).toThrow("SPEAKER_ARTIFACT_TRANSACTION_BOUNDARY_UNSAFE");
    db.exec("ROLLBACK");
    expect(readdirSync(root)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_upload_intents").get()).toEqual({ count: 0 });
  });

  it("requires explicit recovery scope and never deletes bytes committed by recovery", () => {
    const { db, root, store } = setup();
    const unscopedRecovery = recoverSpeakerArtifactUploads as unknown as (database: Db, options: { readonly store: LocalArtifactStore }) => unknown;
    expect(() => unscopedRecovery(db, { store })).toThrow();

    expect(() => createSpeakerArtifactRecord(db, A, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "race.png",
      onPrepared: () => {
        expect(recoverSpeakerArtifactUploads(db, { workspaceId: A.workspaceId, eventId: A.eventId }, { store })).toEqual({ recovered: 1, aborted: 0 });
        throw new Error("creator failed after recovery committed");
      },
    }, { store })).toThrow("creator failed after recovery committed");
    const record = db.prepare("SELECT id, status FROM artifact_upload_intents").get() as { id: string; status: string };
    expect(record.status).toBe("COMMITTED");
    expect(readSpeakerArtifact(db, A, record.id, { store })?.bytes).toEqual(PNG);
  });
});
