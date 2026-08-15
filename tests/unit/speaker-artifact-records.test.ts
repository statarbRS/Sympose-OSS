import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { fingerprintOf } from "../../src/server/canonical";
import {
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_REVIEWER_ACCOUNT_ID,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { DDL } from "../../src/server/schema";
import { seedWorkspaces } from "../../src/server/seed";
import {
  ArtifactRecordCrashInjectedError,
  createSpeakerArtifactRecord,
  getSpeakerArtifactRecord,
  listSpeakerArtifactRecords,
  listPublishedSpeakerHeadshots,
  readPublishedSpeakerHeadshot,
  readPublishedSpeakerHeadshotByRelease,
  recoverSpeakerArtifactUploads,
  readSpeakerArtifact,
  type SpeakerArtifactScope,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import { sealRelease } from "../../src/server/services/publication";
import { createSyntheticSpeakerOperationsRepository, syntheticSpeakerPortalToken } from "../../src/server/services/speaker-operations";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../../src/server/services/evaluator-speaker-identity";

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function validPdfFixture(): Buffer {
  const header = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "ascii");
  const objectOffset = 9;
  const xrefOffset = header.length;
  return Buffer.concat([
    header,
    Buffer.from("xref\n0 2\n0000000000 65535 f \n", "ascii"),
    Buffer.from(`${String(objectOffset).padStart(10, "0")} 00000 n \n`, "ascii"),
    Buffer.from("trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n", "ascii"),
    Buffer.from(`${xrefOffset}\n%%EOF\n`, "ascii"),
  ]);
}
const PDF_FIXTURE = validPdfFixture();
const AT = "2026-08-12T12:00:00.000Z";
const WORKSPACE_A = "artifact-workspace-a";
const WORKSPACE_B = "artifact-workspace-b";
const EVENT_A = "artifact-event-a";
const EVENT_B = "artifact-event-b";
const PERSON_A = "artifact-person-a";
const PERSON_B = "artifact-person-b";
const ASSIGNMENT_A = "artifact-assignment-a";
const ASSIGNMENT_B = "artifact-assignment-b";

const HEADSHOT_SCOPE: SpeakerArtifactScope = {
  workspaceId: WORKSPACE_A,
  eventId: EVENT_A,
  personId: PERSON_A,
  taskId: "artifact-task-headshot",
  kind: "HEADSHOT",
};

const SLIDES_SCOPE: SpeakerArtifactScope = {
  workspaceId: WORKSPACE_A,
  eventId: EVENT_A,
  personId: PERSON_A,
  taskId: "artifact-task-slides",
  kind: "SLIDES",
};

const roots: string[] = [];
const databases: Db[] = [];

function setup(): { readonly db: Db; readonly root: string; readonly store: LocalArtifactStore } {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_A, "artifact-a", "Artifact A", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_B, "artifact-b", "Artifact B", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(EVENT_A, WORKSPACE_A, "Artifact Event A", "UTC", AT, "2026-08-12T13:00:00.000Z", AT);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(EVENT_B, WORKSPACE_B, "Artifact Event B", "UTC", AT, "2026-08-12T13:00:00.000Z", AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(PERSON_A, WORKSPACE_A, "a@example.test", "Artifact A", AT);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(PERSON_B, WORKSPACE_B, "b@example.test", "Artifact B", AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("artifact-speaker-a", WORKSPACE_A, EVENT_A, PERSON_A, "SPEAKER", "CONFIRMED", AT, AT);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("artifact-speaker-b", WORKSPACE_B, EVENT_B, PERSON_B, "SPEAKER", "CONFIRMED", AT, AT);
  seedAcceptedCurrentPlan(db, WORKSPACE_A, EVENT_A, PERSON_A, ASSIGNMENT_A, "artifact-a");
  seedAcceptedCurrentPlan(db, WORKSPACE_B, EVENT_B, PERSON_B, ASSIGNMENT_B, "artifact-b");
  const root = mkdtempSync(join(tmpdir(), "sympose-speaker-artifacts-"));
  roots.push(root);
  const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
  return { db, root, store };
}

function seedAcceptedCurrentPlan(db: Db, workspaceId: string, eventId: string, personId: string, assignmentId: string, slug: string): void {
  const accountId = `${slug}-organizer`;
  const runId = `${slug}-run`;
  const planId = `${slug}-plan`;
  const unitId = `${slug}-unit`;
  const offerId = `${slug}-offer`;
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)").run(accountId, workspaceId, `${slug}@example.test`, "Artifact Organizer", AT);
  db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(unitId, workspaceId, eventId, `${slug} unit`, "SESSION", AT, "2026-08-12T13:00:00.000Z", 1, AT);
  db.prepare("INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, workspaceId, eventId, "completed", `${slug}-input`, "{}", "test", "1", AT);
  db.prepare("INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(planId, workspaceId, eventId, runId, 1, `${slug}-fingerprint`, "{}", AT);
  db.prepare("UPDATE events SET current_plan_version_id = ? WHERE id = ? AND workspace_id = ?").run(planId, eventId, workspaceId);
  db.prepare("INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)").run(assignmentId, workspaceId, planId, personId, unitId, "SPEAKER", "accepted artifact test authority");
  db.prepare("INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, created_at) VALUES (?, ?, ?, 'approved', ?, ?)").run(`${slug}-state`, workspaceId, planId, accountId, AT);
  db.prepare("INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(`${slug}-approval`, workspaceId, eventId, planId, accountId, "approved", AT);
  db.prepare("INSERT INTO commitment_offers (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(offerId, workspaceId, eventId, planId, personId, JSON.stringify({ schema: "commitment-offer-terms/v1", planVersionId: planId, eventId, programUnitId: unitId, role: "SPEAKER" }), `${slug}-terms`, AT);
  db.prepare("INSERT INTO commitment_responses (id, workspace_id, offer_id, response, responded_at, actor_person_id) VALUES (?, ?, ?, ?, ?, ?)").run(`${slug}-response`, workspaceId, offerId, "accepted", AT, personId);
}

function requiredEvaluatorHeadshotTaskId(db: Db): string {
  const task = db.prepare(
    `SELECT id
     FROM speaker_tasks
     WHERE workspace_id = ? AND event_id = ? AND person_id = ?
       AND task_kind = 'HEADSHOT' AND required = 1 AND gate = 'PUBLICATION'`,
  ).get(
    EVALUATOR_ARTIFACT_WORKSPACE_ID,
    EVALUATOR_ARTIFACT_EVENT_ID,
    EVALUATOR_ARTIFACT_PERSON_ID,
  ) as { id: string } | undefined;
  if (!task) throw new Error("required evaluator publication headshot task was not created");
  return task.id;
}

function publishedHeadshotFixture(options: { readonly versions?: number } = {}): {
  readonly db: Db;
  readonly root: string;
  readonly store: LocalArtifactStore;
  readonly scope: SpeakerArtifactScope;
  readonly artifact: ReturnType<typeof createSpeakerArtifactRecord>;
  readonly releaseId: string;
} {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  seedEvaluatorSpeakerTaskFixtures(db);
  const root = mkdtempSync(join(tmpdir(), "sympose-public-artifact-adversarial-"));
  roots.push(root);
  const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
  const scope: SpeakerArtifactScope = {
    workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
    eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    taskId: requiredEvaluatorHeadshotTaskId(db),
    kind: "HEADSHOT",
  };
  let artifact = createSpeakerArtifactRecord(db, scope, {
    bytes: PNG_FIXTURE,
    mediaType: "image/png",
    originalFilename: "mina-adversarial.png",
  }, { store });
  for (let version = 1; version < (options.versions ?? 1); version += 1) {
    artifact = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: `mina-adversarial-v${version + 1}.png`,
    }, { store });
  }
  const durableVersion = db.prepare(
    "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1",
  ).get(scope.taskId) as { id: string; contentHash: string } | undefined;
  if (!durableVersion) throw new Error("durable artifact content version was not created");
  const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
  repository.approveContent(
    { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
    {
      personId: scope.personId,
      taskId: scope.taskId,
      submissionVersionId: durableVersion.id,
      submissionContentHash: durableVersion.contentHash,
      gate: "PUBLICATION",
    },
  );
  const sealed = sealRelease(db, scope.workspaceId, scope.eventId, {
    kind: "account",
    ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  });
  return { db, root, store, scope, artifact, releaseId: sealed.releaseId };
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable scoped speaker artifact records", () => {
  it("publishes PNG and PDF metadata with immutable versions and current markers", () => {
    const { db, store } = setup();
    const first = createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "../../Dana headshot.png",
    }, { store });
    const second = createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "Dana headshot v2.png",
    }, { store });
    const slides = createSpeakerArtifactRecord(db, SLIDES_SCOPE, {
      bytes: PDF_FIXTURE,
      mediaType: "application/pdf",
      originalFilename: "slides.pdf",
    }, { store });

    expect(first.version).toBe(1);
    expect(first.current).toBe(true);
    expect(first.displayFilename).toBe("Dana headshot.png");
    expect(second.version).toBe(2);
    expect(second.supersedesRecordId).toBe(first.artifactId);
    expect(second.current).toBe(true);
    expect(slides.mediaType).toBe("application/pdf");
    expect(Object.keys(second)).not.toContain("storageFilename");
    expect(JSON.stringify(second)).not.toContain(roots[0]);

    const records = listSpeakerArtifactRecords(db, { workspaceId: WORKSPACE_A, eventId: EVENT_A }, { store });
    expect(records.map((record) => [record.kind, record.version, record.current])).toEqual([
      ["HEADSHOT", 1, false],
      ["HEADSHOT", 2, true],
      ["SLIDES", 1, true],
    ]);
    expect(readSpeakerArtifact(db, HEADSHOT_SCOPE, first.artifactId, { store })?.bytes).toEqual(PNG_FIXTURE);
    expect(readSpeakerArtifact(db, HEADSHOT_SCOPE, second.artifactId, { store })?.bytes).toEqual(PNG_FIXTURE);
  });

  it("rehydrates metadata and bytes after a process-local store is replaced", () => {
    const { db, root, store } = setup();
    const created = createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
    }, { store });
    const reopenedStore = new LocalArtifactStore({ rootDir: root });
    const reopened = getSpeakerArtifactRecord(db, HEADSHOT_SCOPE, created.artifactId, { store: reopenedStore });
    expect(reopened?.current).toBe(true);
    expect(readSpeakerArtifact(db, HEADSHOT_SCOPE, created.artifactId, { store: reopenedStore })?.bytes).toEqual(PNG_FIXTURE);
  });

  it("recovers a staged upload after an injected process crash without split truth", () => {
    const { db, root, store } = setup();
    expect(() => createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
    }, {
      store,
      fault: (point) => {
        if (point === "after-stage") throw new ArtifactRecordCrashInjectedError(point);
      },
    })).toThrow(ArtifactRecordCrashInjectedError);

    expect(db.prepare("SELECT status FROM artifact_upload_intents").all()).toEqual([{ status: "PREPARED" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records").get()).toEqual({ count: 0 });
    expect(readdirSync(root)).toHaveLength(1);

    const restartedStore = new LocalArtifactStore({ rootDir: root });
    expect(recoverSpeakerArtifactUploads(db, { workspaceId: WORKSPACE_A, eventId: EVENT_A }, { store: restartedStore })).toEqual({ recovered: 1, aborted: 0 });
    const recovered = listSpeakerArtifactRecords(db, { workspaceId: WORKSPACE_A, eventId: EVENT_A }, { store: restartedStore });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.artifactId).toMatch(/^[a-f0-9]{64}$/u);
    expect(db.prepare("SELECT status FROM artifact_upload_intents").all()).toEqual([{ status: "COMMITTED" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_content_versions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.artifact.submitted'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT state FROM speaker_tasks WHERE id = ?").get(HEADSHOT_SCOPE.taskId)).toEqual({ state: "SUBMITTED" });
    expect(readSpeakerArtifact(db, HEADSHOT_SCOPE, recovered[0]!.artifactId, { store: restartedStore })?.bytes).toEqual(PNG_FIXTURE);
  });

  it("aborts an intent that crashed before file staging and leaves no accepted orphan", () => {
    const { db, root, store } = setup();
    expect(() => createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
    }, {
      store,
      fault: (point) => {
        if (point === "after-intent") throw new ArtifactRecordCrashInjectedError(point);
      },
    })).toThrow(ArtifactRecordCrashInjectedError);

    expect(recoverSpeakerArtifactUploads(db, { workspaceId: WORKSPACE_A, eventId: EVENT_A }, { store: new LocalArtifactStore({ rootDir: root }) })).toEqual({ recovered: 0, aborted: 1 });
    expect(db.prepare("SELECT status FROM artifact_upload_intents").all()).toEqual([{ status: "ABORTED" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_content_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.artifact.submitted'").get()).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  it("returns no record for every scope mismatch and does not publish failed writes", () => {
    const { db, root, store } = setup();
    const created = createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
    }, { store });
    const mismatches: readonly SpeakerArtifactScope[] = [
      { ...HEADSHOT_SCOPE, workspaceId: WORKSPACE_B, eventId: EVENT_B, personId: PERSON_B },
      { ...HEADSHOT_SCOPE, eventId: EVENT_B },
      { ...HEADSHOT_SCOPE, personId: PERSON_B },
      { ...HEADSHOT_SCOPE, taskId: "other-task" },
      { ...HEADSHOT_SCOPE, kind: "SLIDES" },
    ];
    for (const scope of mismatches) {
      expect(getSpeakerArtifactRecord(db, scope, created.artifactId, { store })).toBeNull();
      expect(readSpeakerArtifact(db, scope, created.artifactId, { store })).toBeNull();
    }

    const unrelatedSlidesScope: SpeakerArtifactScope = {
      ...SLIDES_SCOPE,
      taskId: "unrelated-prepared-slides-task",
    };
    expect(() => createSpeakerArtifactRecord(db, unrelatedSlidesScope, {
      bytes: PDF_FIXTURE,
      mediaType: "application/pdf",
      originalFilename: "failed.pdf",
      onPrepared: () => { throw new Error("synthetic publish failure"); },
    }, { store })).toThrow("synthetic publish failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records WHERE task_id = ?").get("artifact-task-slides")).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([created.storageId + ".bin"]);
    expect(existsSync(join(root, created.storageId + ".bin"))).toBe(true);
  });

  it("removes staged bytes when the metadata insert fails", () => {
    const { db, root, store } = setup();
    db.exec(`
      CREATE TRIGGER test_artifact_records_insert_failure
      BEFORE INSERT ON artifact_records
      BEGIN SELECT RAISE(ABORT, 'synthetic metadata failure'); END;
    `);
    expect(() => createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
    }, { store })).toThrow("synthetic metadata failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records").get()).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  it("establishes the canonical evaluator person and event-speaker provenance before metadata", () => {
    const { db, store } = setup();
    seedWorkspaces(db);
    seedEvaluatorDemo(db);

    const record = createSpeakerArtifactRecord(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: "artifact-task-evaluator-headshot",
      kind: "HEADSHOT",
    }, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina.png",
    }, { store });

    expect(record.current).toBe(true);
    expect(db.prepare("SELECT id, workspace_id, full_name FROM people WHERE id = ?").get(EVALUATOR_ARTIFACT_PERSON_ID)).toEqual({ id: EVALUATOR_ARTIFACT_PERSON_ID, workspace_id: EVALUATOR_ARTIFACT_WORKSPACE_ID, full_name: "Mina Park" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_links WHERE workspace_id = ? AND person_id = ?").get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_PERSON_ID)).toEqual({ count: 1 });
    expect(db.prepare("SELECT event_id, person_id, role_key FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_PERSON_ID)).toEqual({ event_id: EVALUATOR_ARTIFACT_EVENT_ID, person_id: EVALUATOR_ARTIFACT_PERSON_ID, role_key: "MODERATOR" });
  });

  it("rejects an unsupported persisted role before staging bytes or creating durable task rows", () => {
    const { db, root, store } = setup();
    const assignmentId = ASSIGNMENT_A;
    db.exec("DROP TRIGGER trg_plan_assignments_immutable");
    db.prepare("UPDATE plan_assignments SET assignment_type = 'ATTENDEE' WHERE id = ?").run(assignmentId);
    db.exec("DROP TRIGGER trg_offers_immutable");
    const offer = db.prepare("SELECT id, terms_json FROM commitment_offers WHERE person_id = ?").get(PERSON_A) as { id: string; terms_json: string };
    db.prepare("UPDATE commitment_offers SET terms_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(offer.terms_json), role: "ATTENDEE" }), offer.id);

    expect(() => createSpeakerArtifactRecord(db, HEADSHOT_SCOPE, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "rejected.png",
    }, { store })).toThrow("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_tasks").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_upload_intents").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records").get()).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  it("binds only an approved canonical headshot into the sealed release projection", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);
    const root = mkdtempSync(join(tmpdir(), "sympose-public-artifacts-"));
    roots.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const scope: SpeakerArtifactScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: requiredEvaluatorHeadshotTaskId(db),
      kind: "HEADSHOT",
    };
    const first = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-approved.png",
    }, { store });
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    const durableVersion = db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(scope.taskId) as { id: string; contentHash: string } | undefined;
    if (!durableVersion) throw new Error("durable artifact content version was not created");
    const approval = repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: durableVersion.id,
        submissionContentHash: durableVersion.contentHash,
        gate: "PUBLICATION",
      },
    );
    expect(approval.gate).toBe("PUBLICATION");
    const sealed = sealRelease(db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    expect(listPublishedSpeakerHeadshots(db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: sealed.releaseId,
    })).toEqual([expect.objectContaining({ artifactId: first.artifactId, personId: EVALUATOR_ARTIFACT_PERSON_ID })]);
    expect(readPublishedSpeakerHeadshot(db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: sealed.releaseId,
      artifactId: first.artifactId,
    }, { store })?.bytes).toEqual(PNG_FIXTURE);

    expect(readPublishedSpeakerHeadshotByRelease(db, {
      releaseId: sealed.releaseId,
      artifactId: first.artifactId,
    }, { store })?.bytes).toEqual(PNG_FIXTURE);

    const unrelatedPreparedScope: SpeakerArtifactScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: "unrelated-prepared-slides-task",
      kind: "SLIDES",
    };
    expect(() => createSpeakerArtifactRecord(db, unrelatedPreparedScope, {
      bytes: PDF_FIXTURE,
      mediaType: "application/pdf",
      originalFilename: "unrelated-prepared-slides.pdf",
    }, {
      store,
      fault: (point) => {
        if (point === "after-stage") throw new ArtifactRecordCrashInjectedError(point);
      },
    })).toThrow(ArtifactRecordCrashInjectedError);
    const preparedStatus = db.prepare(
      "SELECT status FROM artifact_upload_intents WHERE task_id = ?",
    ).get(unrelatedPreparedScope.taskId);
    const filesystemBeforePublicRead = readdirSync(roots[0]!);
    expect(preparedStatus).toEqual({ status: "PREPARED" });
    expect(readPublishedSpeakerHeadshotByRelease(db, {
      releaseId: sealed.releaseId,
      artifactId: first.artifactId,
    }, { store })?.bytes).toEqual(PNG_FIXTURE);
    expect(db.prepare(
      "SELECT status FROM artifact_upload_intents WHERE task_id = ?",
    ).get(unrelatedPreparedScope.taskId)).toEqual(preparedStatus);
    expect(readdirSync(roots[0]!)).toEqual(filesystemBeforePublicRead);

    const unpublished = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-unpublished.png",
    }, { store });
    expect(readPublishedSpeakerHeadshot(db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: sealed.releaseId,
      artifactId: unpublished.artifactId,
    }, { store })).toBeNull();
  });

  it("fails closed for release fingerprint, coordinated content, and materialization tampering", () => {
    const fingerprintCase = publishedHeadshotFixture();
    fingerprintCase.db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
    fingerprintCase.db.prepare("UPDATE publication_releases SET fingerprint = ? WHERE id = ?")
      .run("0".repeat(64), fingerprintCase.releaseId);
    expect(readPublishedSpeakerHeadshotByRelease(fingerprintCase.db, {
      releaseId: fingerprintCase.releaseId,
      artifactId: fingerprintCase.artifact.artifactId,
    }, { store: fingerprintCase.store })).toBeNull();

    const contentCase = publishedHeadshotFixture();
    const contentRow = contentCase.db.prepare(
      "SELECT content_json AS content FROM publication_releases WHERE id = ?",
    ).get(contentCase.releaseId) as { content: string };
    const content = JSON.parse(contentRow.content) as { agendas: { personName: string }[] } & Record<string, unknown>;
    content.agendas[0]!.personName = "Forged identity";
    contentCase.db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
    contentCase.db.prepare("UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ?")
      .run(JSON.stringify(content), fingerprintOf(content), contentCase.releaseId);
    expect(readPublishedSpeakerHeadshotByRelease(contentCase.db, {
      releaseId: contentCase.releaseId,
      artifactId: contentCase.artifact.artifactId,
    }, { store: contentCase.store })).toBeNull();

    const materializationCase = publishedHeadshotFixture();
    materializationCase.db.exec("DROP TRIGGER IF EXISTS trg_agendas_no_delete");
    materializationCase.db.prepare("DELETE FROM personal_agendas WHERE release_id = ?").run(materializationCase.releaseId);
    expect(readPublishedSpeakerHeadshotByRelease(materializationCase.db, {
      releaseId: materializationCase.releaseId,
      artifactId: materializationCase.artifact.artifactId,
    }, { store: materializationCase.store })).toBeNull();
  });

  it("requires a committed upload intent and persisted approval actor before serving bytes", () => {
    const intentCase = publishedHeadshotFixture();
    intentCase.db.exec("DROP TRIGGER IF EXISTS trg_artifact_upload_intents_immutable");
    intentCase.db.prepare(
      "UPDATE artifact_upload_intents SET status = 'PREPARED', committed_at = NULL WHERE artifact_id = ?",
    ).run(intentCase.artifact.artifactId);
    expect(readPublishedSpeakerHeadshotByRelease(intentCase.db, {
      releaseId: intentCase.releaseId,
      artifactId: intentCase.artifact.artifactId,
    }, { store: intentCase.store })).toBeNull();
    expect(listPublishedSpeakerHeadshots(intentCase.db, {
      workspaceId: intentCase.scope.workspaceId,
      eventId: intentCase.scope.eventId,
      releaseId: intentCase.releaseId,
      mode: "HISTORICAL",
    })).toEqual([]);

    const existingViewerCase = publishedHeadshotFixture();
    existingViewerCase.db.exec("DROP TRIGGER IF EXISTS trg_speaker_content_reviews_immutable");
    existingViewerCase.db.prepare("UPDATE speaker_content_reviews SET reviewed_by = ? WHERE task_id = ?")
      .run(EVALUATOR_REVIEWER_ACCOUNT_ID, existingViewerCase.scope.taskId);
    expect(readPublishedSpeakerHeadshotByRelease(existingViewerCase.db, {
      releaseId: existingViewerCase.releaseId,
      artifactId: existingViewerCase.artifact.artifactId,
    }, { store: existingViewerCase.store })).toBeNull();

    const reviewCase = publishedHeadshotFixture();
    reviewCase.db.exec("DROP TRIGGER IF EXISTS trg_speaker_content_reviews_immutable");
    reviewCase.db.prepare("UPDATE speaker_content_reviews SET reviewed_by = ? WHERE task_id = ?")
      .run("nonexistent-review-actor", reviewCase.scope.taskId);
    expect(readPublishedSpeakerHeadshotByRelease(reviewCase.db, {
      releaseId: reviewCase.releaseId,
      artifactId: reviewCase.artifact.artifactId,
    }, { store: reviewCase.store })).toBeNull();
  });

  it("preserves a valid historical artifact after a later role change", () => {
    const fixture = publishedHeadshotFixture();
    fixture.db.prepare("UPDATE accounts SET role = 'viewer' WHERE workspace_id = ? AND id = ?")
      .run(fixture.scope.workspaceId, EVALUATOR_ORGANIZER_ACCOUNT_ID);
    const read = readPublishedSpeakerHeadshotByRelease(fixture.db, {
      releaseId: fixture.releaseId,
      artifactId: fixture.artifact.artifactId,
    }, { store: fixture.store });
    expect(read?.bytes).toEqual(PNG_FIXTURE);
  });

  it("rejects approval by a nonexistent organizer and reloads a version-two headshot from its chain", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);
    const root = mkdtempSync(join(tmpdir(), "sympose-public-artifact-approval-"));
    roots.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const scope: SpeakerArtifactScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: requiredEvaluatorHeadshotTaskId(db),
      kind: "HEADSHOT",
    };
    const first = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-v1.png",
    }, { store });
    const second = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-v2.png",
    }, { store });
    const version = db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1",
    ).get(scope.taskId) as { id: string; contentHash: string };
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    expect(() => repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: "nonexistent-organizer" },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
      },
    )).toThrow(/persisted organizer capability/);
    const approval = repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
      },
    );
    expect(approval.approvedBy).toBe(EVALUATOR_ORGANIZER_ACCOUNT_ID);
    const sealed = sealRelease(db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    const third = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-v3.png",
    }, { store });
    db.exec("DROP TRIGGER IF EXISTS trg_artifact_records_immutable");
    db.prepare("UPDATE artifact_records SET supersedes_record_id = ? WHERE id = ?")
      .run(first.artifactId, third.artifactId);
    db.exec(DDL);
    const reloadedStore = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const read = readPublishedSpeakerHeadshotByRelease(db, {
      releaseId: sealed.releaseId,
      artifactId: second.artifactId,
    }, { store: reloadedStore });
    expect(read?.record.version).toBe(2);
    expect(read?.record.supersedesRecordId).toBe(first.artifactId);
    expect(read?.bytes).toEqual(PNG_FIXTURE);
  });

  it("rolls back a real speaker content and task mutation registered by onPrepared", () => {
    const { db, root, store } = setup();
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    const repository = createSyntheticSpeakerOperationsRepository({
      clock: () => AT,
      defaultEventInitialization: { kind: "evaluator-demo" },
    });
    const event = {
      id: EVALUATOR_ARTIFACT_EVENT_ID,
      name: "Artifact Evaluator Event",
      timezone: "UTC",
      startsAt: AT,
      endsAt: "2026-08-12T13:00:00.000Z",
    };
    repository.initializeEvent(EVALUATOR_ARTIFACT_WORKSPACE_ID, event, { kind: "evaluator-demo" });
    const personId = EVALUATOR_ARTIFACT_PERSON_ID;
    const token = syntheticSpeakerPortalToken(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, personId);
    const portal = repository.getPortalProjection(token);
    const task = portal?.tasks.find((candidate) => candidate.contentKind === "HEADSHOT");
    if (!portal || !task) throw new Error("synthetic speaker artifact task was not initialized");
    db.exec(`
      CREATE TRIGGER test_artifact_records_insert_failure_after_content
      BEFORE INSERT ON artifact_records
      BEGIN SELECT RAISE(ABORT, 'synthetic metadata failure after content mutation'); END;
    `);

    expect(() => createSpeakerArtifactRecord(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId,
      taskId: task.id,
      kind: "HEADSHOT",
    }, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina.png",
      onPrepared: (artifact, registerRollback) => {
        const mutation = repository.submitContentWithRollback(token, task.id, {
          kind: "HEADSHOT",
          asset: {
            assetId: artifact.artifactId,
            fileName: artifact.displayFilename,
            mediaType: artifact.mediaType,
            byteSize: artifact.byteSize,
            checksum: artifact.sha256,
            storageRef: `synthetic://artifact/${artifact.artifactId}`,
          },
        }, "atomic-failure");
        registerRollback(mutation.rollback);
      },
    }, { store })).toThrow("synthetic metadata failure after content mutation");

    const after = repository.getPortalProjection(token);
    expect(after?.tasks.find((candidate) => candidate.id === task.id)?.review?.versions).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_records WHERE person_id = ?").get(personId)).toEqual({ count: 0 });
    expect(readdirSync(root)).toEqual([]);
  });

  it("rebuilds durable general tasks and exact content review evidence across repository recreation", () => {
    const { db } = setup();
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    const event = {
      id: EVALUATOR_ARTIFACT_EVENT_ID,
      name: "Artifact Evaluator Event",
      timezone: "UTC",
      startsAt: AT,
      endsAt: "2026-08-12T13:00:00.000Z",
    };
    const scope = {
      kind: "organizer" as const,
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    };
    const first = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    const mina = first.listSpeakerRoster(scope, event).find((record) => record.person.personId === EVALUATOR_ARTIFACT_PERSON_ID);
    if (!mina) throw new Error("durable evaluator speaker was not projected");
    const titleTask = first.createTask(scope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      kind: "SESSION_TITLE",
      contentKind: "SESSION_TITLE",
      title: "Session title",
      description: "Canonical durable title evidence.",
      required: true,
      gate: "PUBLICATION",
      dueAt: "2026-09-12T17:00:00.000Z",
      owner: "SPEAKER",
      idempotencyKey: "durable-title-task-v1",
    });
    const version = first.submitOrganizerContent(scope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: titleTask.id,
      payload: { kind: "SESSION_TITLE", title: "Exact durable title" },
      idempotencyKey: "durable-title-v1",
    });
    const comment = first.addComment(scope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: titleTask.id,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      body: "Author and timestamp must remain attached to this exact version.",
      idempotencyKey: "durable-comment-v1",
    });
    const task = first.createTask(scope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      kind: "BRIEFING",
      contentKind: null,
      title: "Durable briefing task",
      description: "A restart-persistent general speaker task.",
      required: false,
      gate: null,
      dueAt: "2026-09-12T17:00:00.000Z",
      owner: "SPEAKER",
      idempotencyKey: "durable-briefing-v1",
    });

    const second = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    const rebuilt = second.getOrganizerProjection(scope, event).roster.find((record) => record.person.personId === EVALUATOR_ARTIFACT_PERSON_ID);
    const rebuiltTask = rebuilt?.tasks.find((candidate) => candidate.id === task.id);
    expect(rebuiltTask).toMatchObject({ id: task.id, title: "Durable briefing task", contentKind: null, state: "NOT_STARTED" });
    const speakerReview = second.content.getReviewProjection(
      { workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ARTIFACT_PERSON_ID, actorKind: "speaker", personId: EVALUATOR_ARTIFACT_PERSON_ID },
      { personId: EVALUATOR_ARTIFACT_PERSON_ID, taskId: titleTask.id, kind: "SESSION_TITLE" },
    );
    expect(speakerReview.versions.map((candidate) => candidate.id)).toEqual([version.id]);
    expect(speakerReview.comments).toEqual([comment]);
    expect(speakerReview.comments[0]).toMatchObject({ authorId: scope.actorId, submissionVersionId: version.id, submissionContentHash: version.contentHash });
    expect(db.prepare(
      `SELECT COUNT(*) AS count
         FROM outbox_messages
        WHERE workspace_id = ?
          AND destination_key = ?
          AND json_extract(payload_json, '$.payload.eventId') = ?
          AND json_extract(payload_json, '$.payload.taskId') = ?`,
    ).get(
      scope.workspaceId,
      "speaker-content:speaker.content.version.submitted",
      scope.eventId,
      titleTask.id,
    )).toEqual({ count: 1 });

    const otherEventReview = second.content.getReviewProjection(
      { workspaceId: WORKSPACE_A, eventId: EVENT_A, actorId: "other-organizer", actorKind: "organizer" },
      { personId: PERSON_A, taskId: titleTask.id, kind: "SESSION_TITLE" },
    );
    const otherWorkspaceReview = second.content.getReviewProjection(
      { workspaceId: WORKSPACE_B, eventId: EVENT_B, actorId: "other-organizer", actorKind: "organizer" },
      { personId: PERSON_B, taskId: titleTask.id, kind: "SESSION_TITLE" },
    );
    expect(otherEventReview.versions).toEqual([]);
    expect(otherWorkspaceReview.versions).toEqual([]);
  });
});
