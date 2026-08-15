import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEVFLOW_EVALUATOR_PROFILE,
  EVALUATOR_ASSIGNMENT_ID,
  EVALUATOR_CALL_ID,
  EVALUATOR_COMPATIBILITY_CALL_ID,
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_ARTIFACT_FIXTURE_MANIFEST,
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_REVIEWER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorArtifactFixtures,
  seedEvaluatorCompatibility,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { seedWorkspaces } from "../../src/server/seed";
import { deterministicUuid, fingerprintOf } from "../../src/server/canonical";
import {
  listSpeakerArtifactRecords,
  readSpeakerArtifact,
  resetSpeakerArtifactStoreForTest,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import { issueSpeakerPortalToken } from "../../src/server/services/speaker-portal-access";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import { sealRelease } from "../../src/server/services/publication";
import {
  readCurrentScheduleApproval,
  SCHEDULE_APPROVAL_EVENT_TYPE,
} from "../../src/server/services/scheduling/approval";
import {
  executeScheduleDraftCommand,
  readScheduleDraft,
} from "../../src/server/services/scheduling/persistence";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

const TASK_UPLOAD_AT = "2026-08-13T10:00:00.000Z";

function derivedArtifactRoot(databasePath: string): string {
  const absoluteDatabasePath = resolve(databasePath);
  const digest = createHash("sha256")
    .update(absoluteDatabasePath, "utf8")
    .digest("hex")
    .slice(0, 24);
  return join(dirname(absoluteDatabasePath), `.sympose-artifacts-${digest}`);
}

let databases: Db[] = [];
let temporaryDirectories: string[] = [];
const initialEvaluatorProfile = process.env.SYMPOSE_EVALUATOR_PROFILE;
const initialPublicSyntheticDemo = process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO;
const initialArtifactStoreRoot = process.env.SYMPOSE_ARTIFACT_STORE_ROOT;
const initialNodeEnvironment = process.env.NODE_ENV;
const initialVitestEnvironment = process.env.VITEST;

function setEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    Reflect.set(process.env, name, value);
  }
}

beforeEach(() => {
  process.env.SYMPOSE_EVALUATOR_PROFILE = "local";
});

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (initialEvaluatorProfile === undefined) {
    delete process.env.SYMPOSE_EVALUATOR_PROFILE;
  } else {
    process.env.SYMPOSE_EVALUATOR_PROFILE = initialEvaluatorProfile;
  }
  setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", initialArtifactStoreRoot);
  setEnvironmentVariable("SYMPOSE_PUBLIC_SYNTHETIC_DEMO", initialPublicSyntheticDemo);
  setEnvironmentVariable("NODE_ENV", initialNodeEnvironment);
  setEnvironmentVariable("VITEST", initialVitestEnvironment);
});
describe("evaluator demo bootstrap", () => {
  it("materializes the fixed synthetic journey in the explicit production evaluator profile", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "sympose-production-evaluator-profile-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "evaluator.sqlite");
    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", join(directory, "artifacts"));
    setEnvironmentVariable("NODE_ENV", "production");
    setEnvironmentVariable("VITEST", undefined);
    setEnvironmentVariable("SYMPOSE_PUBLIC_SYNTHETIC_DEMO", "1");

    const db = openDb({ path });
    databases.push(db);

    expect(db.prepare("SELECT id FROM accounts WHERE id = ? AND role = 'reviewer'").get(EVALUATOR_REVIEWER_ACCOUNT_ID)).toEqual({
      id: EVALUATOR_REVIEWER_ACCOUNT_ID,
    });
    expect(db.prepare("SELECT id FROM events WHERE workspace_id = ? AND id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({
      id: EVALUATOR_EVENT_ID,
    });
    expect(db.prepare("SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toMatchObject({
      currentReleaseId: expect.any(String),
    });
  });

  it("creates one idempotent, browser-reachable Acme journey from S0 records", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);

    seedEvaluatorDemo(db);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT event_id, person_id, role_key, participation_status FROM event_speakers WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID),
    ).toEqual({ event_id: EVALUATOR_EVENT_ID, person_id: EVALUATOR_SPEAKER_PERSON_ID, role_key: "MODERATOR", participation_status: "CONFIRMED" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 3 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM portal_tokens WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 1 });

    const call = db
      .prepare("SELECT id, state, access_mode AS accessMode FROM calls WHERE workspace_id = ?")
      .get(EVALUATOR_WORKSPACE_ID) as { id: string; state: string; accessMode: string };
    expect(call).toEqual({ id: EVALUATOR_CALL_ID, state: "OPEN", accessMode: "PUBLIC" });

    const rule = db
      .prepare("SELECT rules_json AS rulesJson FROM rule_versions WHERE workspace_id = ?")
      .get(EVALUATOR_WORKSPACE_ID) as { rulesJson: string };
    expect(JSON.parse(rule.rulesJson)).toMatchObject({
      schema: "cfp-form-rules/v1",
      rules: [{ id: "show-workshop-plan" }],
    });

    const assignment = db
      .prepare(
        `SELECT a.id, s.state AS assignmentState, r.state AS roundState
         FROM review_assignments a
         JOIN review_assignment_states s ON s.assignment_id = a.id AND s.sequence_number = 1
         JOIN review_round_states r ON r.round_id = a.round_id
           AND r.sequence_number = (SELECT MAX(sequence_number) FROM review_round_states WHERE round_id = a.round_id)
         WHERE a.workspace_id = ?`,
      )
      .get(EVALUATOR_WORKSPACE_ID) as {
      id: string;
      assignmentState: string;
      roundState: string;
    };
    expect(assignment).toEqual({
      id: EVALUATOR_ASSIGNMENT_ID,
      assignmentState: "ASSIGNED",
      roundState: "OPEN",
    });
    expect(
      db.prepare("SELECT id FROM accounts WHERE id = ? AND role = 'reviewer'").get(EVALUATOR_REVIEWER_ACCOUNT_ID),
    ).toEqual({ id: EVALUATOR_REVIEWER_ACCOUNT_ID });

    const countsBefore = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM calls WHERE workspace_id = ?) AS calls,
           (SELECT COUNT(*) FROM submissions WHERE workspace_id = ?) AS submissions,
           (SELECT COUNT(*) FROM review_assignments WHERE workspace_id = ?) AS assignments,
           (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ?) AS releases`,
      )
      .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID);
    seedEvaluatorDemo(db);
    expect(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM calls WHERE workspace_id = ?) AS calls,
             (SELECT COUNT(*) FROM submissions WHERE workspace_id = ?) AS submissions,
             (SELECT COUNT(*) FROM review_assignments WHERE workspace_id = ?) AS assignments,
             (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ?) AS releases`,
        )
        .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_WORKSPACE_ID),
    ).toEqual(countsBefore);

    expect(db.prepare("SELECT current_plan_version_id, current_release_id FROM events WHERE id = ?").get(EVALUATOR_EVENT_ID)).toMatchObject({
      current_plan_version_id: expect.any(String),
      current_release_id: expect.any(String),
    });
  });

  it("starts with exact approved artifact evidence and preserves it across an agenda-only reseal", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-publication-startup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "evaluator.sqlite");
    const artifactRoot = join(directory, "artifacts");
    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", artifactRoot);
    setEnvironmentVariable("NODE_ENV", "development");
    setEnvironmentVariable("VITEST", undefined);

    let db = openDb({ path });
    databases.push(db);
    const initialRelease = db.prepare(
      `SELECT release_row.id, release_row.content_json AS contentJson,
              release_row.fingerprint, event_row.current_plan_version_id AS planVersionId
         FROM events event_row
         JOIN publication_releases release_row
           ON release_row.id = event_row.current_release_id
          AND release_row.workspace_id = event_row.workspace_id
          AND release_row.event_id = event_row.id
        WHERE event_row.workspace_id = ? AND event_row.id = ?`,
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
      id: string;
      contentJson: string;
      fingerprint: string;
      planVersionId: string;
    } | undefined;
    expect(initialRelease).toBeDefined();
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ count: 1 });

    const evidenceRows = db.prepare(
      `SELECT task.id AS taskId, task.assignment_id AS assignmentId,
              artifact.id AS artifactId, artifact.content_version_id AS contentVersionId,
              artifact.version AS artifactVersion, artifact.sha256,
              artifact.size_bytes AS byteSize, artifact.media_type AS mediaType,
              artifact.display_filename AS displayFilename,
              version.content_hash AS contentHash, review.id AS reviewId,
              review.review_state AS reviewState, review.gate AS reviewGate,
              review.reviewed_by AS reviewedBy, intent.status AS intentStatus,
              binding.release_id AS boundReleaseId,
              approval_authority.details_json AS approvalDetailsJson
         FROM speaker_tasks task
         JOIN artifact_records artifact
           ON artifact.workspace_id = task.workspace_id AND artifact.event_id = task.event_id
          AND artifact.person_id = task.person_id AND artifact.task_id = task.id
          AND artifact.kind = task.task_kind
         JOIN speaker_content_versions version
           ON version.id = artifact.content_version_id AND version.workspace_id = artifact.workspace_id
          AND version.event_id = artifact.event_id AND version.person_id = artifact.person_id
          AND version.task_id = artifact.task_id AND version.kind = artifact.kind
          AND version.version = artifact.version
         JOIN speaker_content_reviews review
           ON review.workspace_id = version.workspace_id AND review.event_id = version.event_id
          AND review.person_id = version.person_id AND review.task_id = version.task_id
          AND review.submission_version_id = version.id
          AND review.submission_content_hash = version.content_hash
         JOIN audit_events approval_authority
           ON approval_authority.workspace_id = review.workspace_id
          AND approval_authority.actor_kind = 'account'
          AND approval_authority.actor_ref = review.reviewed_by
          AND approval_authority.action = 'speaker.content.approved'
          AND approval_authority.target_type = 'speaker_content_review'
          AND approval_authority.target_id = review.id
         JOIN artifact_upload_intents intent
           ON intent.artifact_id = artifact.id AND intent.content_version_id = artifact.content_version_id
          AND intent.workspace_id = artifact.workspace_id AND intent.event_id = artifact.event_id
          AND intent.person_id = artifact.person_id AND intent.task_id = artifact.task_id
          AND intent.kind = artifact.kind
         JOIN speaker_artifact_release_bindings binding
           ON binding.workspace_id = artifact.workspace_id AND binding.event_id = artifact.event_id
          AND binding.person_id = artifact.person_id AND binding.artifact_id = artifact.id
        WHERE task.workspace_id = ? AND task.event_id = ? AND task.person_id = ?
          AND task.task_kind = 'HEADSHOT' AND task.required = 1
          AND task.gate = 'PUBLICATION' AND task.owner = 'SPEAKER'`,
    ).all(
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
      EVALUATOR_SPEAKER_PERSON_ID,
    ) as unknown as Array<{
      taskId: string;
      assignmentId: string;
      artifactId: string;
      contentVersionId: string;
      artifactVersion: number;
      sha256: string;
      byteSize: number;
      mediaType: string;
      displayFilename: string;
      contentHash: string;
      reviewId: string;
      reviewState: string;
      reviewGate: string;
      reviewedBy: string;
      intentStatus: string;
      boundReleaseId: string;
      approvalDetailsJson: string;
    }>;
    expect(evidenceRows).toHaveLength(1);
    const evidence = evidenceRows[0]!;
    const expectedHeadshot = EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.find((fixture) => fixture.kind === "HEADSHOT")!;
    expect(evidence).toMatchObject({
      artifactVersion: 1,
      sha256: expectedHeadshot.sha256,
      byteSize: expectedHeadshot.byteSize,
      mediaType: expectedHeadshot.mediaType,
      displayFilename: expectedHeadshot.displayFilename,
      reviewState: "APPROVED",
      reviewGate: "PUBLICATION",
      reviewedBy: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      intentStatus: "COMMITTED",
      boundReleaseId: initialRelease!.id,
    });
    expect(JSON.parse(evidence.approvalDetailsJson)).toEqual({
      schema: "speaker-content-approval-authority/v1",
      assignmentId: evidence.assignmentId,
      reviewState: "APPROVED",
      gate: "PUBLICATION",
      submissionVersionId: evidence.contentVersionId,
      submissionContentHash: evidence.contentHash,
      capability: "phase0.pipeline.manage",
    });
    const approvalReceipt = db.prepare(
      `SELECT payload_json AS payloadJson
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'speaker.content.approved'
          AND aggregate_type = 'speaker_task' AND aggregate_id = ?
          AND json_extract(payload_json, '$.idempotencyKey') = ?`,
    ).get(
      EVALUATOR_WORKSPACE_ID,
      evidence.taskId,
      "evaluator-demo-headshot-v1-publication-approval",
    ) as { payloadJson: string } | undefined;
    expect(JSON.parse(approvalReceipt?.payloadJson ?? "null")).toMatchObject({
      schema: "speaker-content-approval-receipt/v2",
      eventId: EVALUATOR_EVENT_ID,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      assignmentId: evidence.assignmentId,
      kind: "HEADSHOT",
      outcome: {
        id: evidence.reviewId,
        taskId: evidence.taskId,
        submissionVersionId: evidence.contentVersionId,
        submissionContentHash: evidence.contentHash,
        gate: "PUBLICATION",
      },
    });
    const exactBytes = readSpeakerArtifact(db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      taskId: evidence.taskId,
      kind: "HEADSHOT",
    }, evidence.artifactId);
    expect(exactBytes?.bytes.byteLength).toBe(expectedHeadshot.byteSize);
    expect(createHash("sha256").update(exactBytes?.bytes ?? Buffer.alloc(0)).digest("hex")).toBe(expectedHeadshot.sha256);

    const initialContent = JSON.parse(initialRelease!.contentJson) as {
      plan: { id: string };
      commitmentWatermark: number;
      artifactBindings: Array<Record<string, unknown>>;
      speakerHeadshots: Array<Record<string, unknown>>;
      schedule: { revision: number };
    };
    expect(initialContent.artifactBindings).toEqual([expect.objectContaining({
      assignmentId: evidence.assignmentId,
      taskId: evidence.taskId,
      artifactId: evidence.artifactId,
      contentVersionId: evidence.contentVersionId,
      version: 1,
      contentHash: evidence.contentHash,
      sha256: expectedHeadshot.sha256,
    })]);

    closeDb(db);
    databases.splice(databases.indexOf(db), 1);
    db = openDb({ path });
    databases.push(db);
    expect(db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ releaseId: initialRelease!.id });

    const draft = readScheduleDraft(db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
    });
    executeScheduleDraftCommand(db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
    }, {
      expectedRevision: draft.schedule.revision,
      planVersionId: draft.schedule.planVersionId,
      planFingerprint: draft.schedule.planFingerprint,
      acceptedInventoryFingerprint: draft.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: draft.schedule.cfpSessionInventoryFingerprint,
      command: {
        kind: "CONFIGURE",
        rooms: [{ id: "room-default", name: "Agenda reseal room", venue: "Evaluator venue", capacity: 100 }],
        tracks: [{ id: "track-default", name: "Agenda reseal track", ordinal: 1 }],
      },
      idempotencyKey: "evaluator-startup-agenda-reseal-configure",
      requestId: "evaluator-startup-agenda-reseal-request",
      actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    persistAndApproveCurrentSchedule(db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
    }, EVALUATOR_ORGANIZER_ACCOUNT_ID, "evaluator-startup-agenda-reseal");
    const resealed = sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    expect(resealed.created).toBe(true);
    expect(resealed.releaseId).not.toBe(initialRelease!.id);
    const resealedContentJson = (db.prepare(
      "SELECT content_json AS contentJson FROM publication_releases WHERE id = ? AND workspace_id = ?",
    ).get(resealed.releaseId, EVALUATOR_WORKSPACE_ID) as { contentJson: string }).contentJson;
    const resealedContent = JSON.parse(resealedContentJson) as typeof initialContent;
    expect(resealedContent.plan).toEqual(initialContent.plan);
    expect(resealedContent.commitmentWatermark).toBe(initialContent.commitmentWatermark);
    expect(resealedContent.artifactBindings).toEqual(initialContent.artifactBindings);
    expect(resealedContent.speakerHeadshots).toEqual(initialContent.speakerHeadshots);
    expect(resealedContent.schedule.revision).toBeGreaterThan(initialContent.schedule.revision);
    expect(db.prepare(
      "SELECT content_json AS contentJson FROM publication_releases WHERE id = ? AND workspace_id = ?",
    ).get(initialRelease!.id, EVALUATOR_WORKSPACE_ID)).toEqual({ contentJson: initialRelease!.contentJson });
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releases,
         (SELECT COUNT(*) FROM speaker_content_reviews WHERE workspace_id = ?
           AND task_id = ? AND review_state = 'APPROVED' AND gate = 'PUBLICATION') AS approvals,
         (SELECT COUNT(*) FROM speaker_artifact_release_bindings WHERE workspace_id = ?
           AND event_id = ? AND artifact_id = ?) AS bindings`,
    ).get(
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
      EVALUATOR_WORKSPACE_ID,
      evidence.taskId,
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
      evidence.artifactId,
    )).toEqual({ releases: 2, approvals: 1, bindings: 2 });
  });

  it("reopens truthful evaluator artifact bytes and organizer/speaker projections", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-speaker-tasks-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "evaluator.sqlite");
    const db = openDb({ path, seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);

    const selectTasks = (database: Db): Array<Record<string, unknown>> => database.prepare(
      `SELECT id, workspace_id, event_id, person_id, assignment_id, task_kind,
              content_kind, title, required, gate, owner, state, due_at, created_at, updated_at
       FROM speaker_tasks
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?
       ORDER BY task_kind`,
    ).all(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID) as Array<Record<string, unknown>>;
    const immutableDefinition = ({ state: _state, updated_at: _updatedAt, ...definition }: Record<string, unknown>): Record<string, unknown> => definition;
    const initial = selectTasks(db);
    expect(initial.map((row) => row.task_kind)).toEqual(["HEADSHOT", "SLIDES"]);
    const store = new LocalArtifactStore({ rootDir: join(directory, "artifacts"), clock: () => TASK_UPLOAD_AT });
    const seeded = seedEvaluatorArtifactFixtures(db, { store });
    expect(seeded.map((record) => ({
      kind: record.kind,
      version: record.version,
      workspaceId: record.workspaceId,
      eventId: record.eventId,
      personId: record.personId,
      taskId: record.taskId,
      mediaType: record.mediaType,
      byteSize: record.byteSize,
      sha256: record.sha256,
      displayFilename: record.displayFilename,
    }))).toEqual(EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.map((fixture) => ({
      ...fixture,
      version: 1,
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      taskId: initial.find((task) => task.task_kind === fixture.kind)?.id,
    })));
    expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE id = ? AND workspace_id = ?").get(EVALUATOR_SPEAKER_PERSON_ID, EVALUATOR_WORKSPACE_ID)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_tasks WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID)).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_content_reviews WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ count: 0 });
    const portalClock = new Date().toISOString();
    const organizerActor = db.prepare(
      `SELECT session_row.id AS sessionId, account.id AS accountId
         FROM sessions session_row
         JOIN accounts account
           ON account.id = session_row.account_id
          AND account.workspace_id = session_row.workspace_id
        WHERE session_row.workspace_id = ? AND account.id = ?
        ORDER BY session_row.created_at DESC, session_row.rowid DESC
        LIMIT 1`,
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_ORGANIZER_ACCOUNT_ID) as {
      sessionId: string;
      accountId: string;
    } | undefined;
    if (!organizerActor) throw new Error("evaluator organizer session unavailable");
    const issued = issueSpeakerPortalToken(db, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
    }, organizerActor, { now: portalClock });
    closeDb(db);
    databases.splice(databases.indexOf(db), 1);

    const reopened = openDb({ path, seed: false });
    databases.push(reopened);
    expect(() => seedEvaluatorDemo(reopened)).not.toThrow();
    const reopenedStore = new LocalArtifactStore({ rootDir: join(directory, "artifacts") });
    expect(seedEvaluatorArtifactFixtures(reopened, { store: reopenedStore }).map((record) => record.artifactId)).toEqual(
      seeded.map((record) => record.artifactId),
    );
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM speaker_content_reviews WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ count: 0 });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ count: 0 });
    const records = listSpeakerArtifactRecords(reopened, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
    }, { store: reopenedStore });
    expect(records).toHaveLength(2);
    for (const record of records) {
      const fixture = EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.find((candidate) => candidate.kind === record.kind);
      const read = readSpeakerArtifact(reopened, {
        workspaceId: record.workspaceId,
        eventId: record.eventId,
        personId: record.personId,
        taskId: record.taskId,
        kind: record.kind,
      }, record.artifactId, { store: reopenedStore });
      expect(fixture).toBeDefined();
      expect(read?.bytes.byteLength).toBe(fixture?.byteSize);
      expect(createHash("sha256").update(read?.bytes ?? Buffer.alloc(0)).digest("hex")).toBe(fixture?.sha256);
    }
    const persisted = selectTasks(reopened);
    expect(persisted.map((row) => ({ kind: row.task_kind, state: row.state, updatedAt: row.updated_at }))).toEqual(EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.map((fixture) => ({
      kind: fixture.kind,
      state: "SUBMITTED",
      updatedAt: TASK_UPLOAD_AT,
    })));
    expect(persisted.map(immutableDefinition)).toEqual(initial.map(immutableDefinition));
    const event = reopened.prepare(
      "SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE workspace_id = ? AND id = ?",
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
      id: string;
      name: string;
      timezone: string;
      startsAt: string;
      endsAt: string;
    };
    const repository = createSyntheticSpeakerOperationsRepository({ db: reopened, clock: () => portalClock });
    const organizer = repository.getOrganizerProjection({
      kind: "organizer",
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    }, event).roster.find((row) => row.person.personId === EVALUATOR_SPEAKER_PERSON_ID);
    const speaker = repository.getPortalProjection(issued.token, "speaker-content:resolve:evaluator-fixture-reload");
    expect(organizer?.tasks.filter((task) => task.kind === "HEADSHOT" || task.kind === "SLIDES").map((task) => ({ kind: task.kind, version: task.review?.versions[0]?.version })).sort((left, right) => left.kind.localeCompare(right.kind))).toEqual([
      { kind: "HEADSHOT", version: 1 },
      { kind: "SLIDES", version: 1 },
    ]);
    expect(speaker?.person.personId).toBe(EVALUATOR_SPEAKER_PERSON_ID);
    expect(speaker?.tasks.filter((task) => task.kind === "HEADSHOT" || task.kind === "SLIDES").map((task) => ({ kind: task.kind, version: task.review?.versions[0]?.version })).sort((left, right) => left.kind.localeCompare(right.kind))).toEqual([
      { kind: "HEADSHOT", version: 1 },
      { kind: "SLIDES", version: 1 },
    ]);
  });

  it("isolates derived artifact roots across two database opens and preserves explicit configuration", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const sharedDirectory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-artifact-roots-"));
    const configuredDirectory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-artifact-root-configured-"));
    temporaryDirectories.push(sharedDirectory, configuredDirectory);

    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", undefined);
    setEnvironmentVariable("NODE_ENV", "development");
    setEnvironmentVariable("VITEST", undefined);

    const firstPath = join(sharedDirectory, "first.sqlite");
    const secondPath = join(sharedDirectory, "second.sqlite");
    const assertDefaultFixtureReads = (database: Db): readonly string[] => {
      const records = listSpeakerArtifactRecords(database, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      expect(records).toHaveLength(EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.length);
      for (const record of records) {
        const fixture = EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.find((candidate) => candidate.kind === record.kind);
        const read = readSpeakerArtifact(database, {
          workspaceId: record.workspaceId,
          eventId: record.eventId,
          personId: record.personId,
          taskId: record.taskId,
          kind: record.kind,
        }, record.artifactId);
        expect(fixture).toBeDefined();
        expect(read?.record.mediaType).toBe(fixture?.mediaType);
        expect(read?.bytes.byteLength).toBe(fixture?.byteSize);
        expect(createHash("sha256").update(read?.bytes ?? Buffer.alloc(0)).digest("hex")).toBe(fixture?.sha256);
      }
      return records.map((record) => record.artifactId);
    };
    const first = openDb({ path: firstPath });
    databases.push(first);
    const firstArtifactRoot = derivedArtifactRoot(firstPath);
    const firstFiles = readdirSync(firstArtifactRoot).filter((entry) => entry.endsWith(".bin")).sort();
    expect(firstFiles).toHaveLength(2);
    expect(process.env.SYMPOSE_ARTIFACT_STORE_ROOT).toBeUndefined();

    const second = openDb({ path: secondPath });
    databases.push(second);
    const secondArtifactRoot = derivedArtifactRoot(secondPath);
    const secondFiles = readdirSync(secondArtifactRoot).filter((entry) => entry.endsWith(".bin")).sort();
    expect(secondFiles).toHaveLength(2);
    expect(process.env.SYMPOSE_ARTIFACT_STORE_ROOT).toBeUndefined();
    expect(firstArtifactRoot).not.toBe(secondArtifactRoot);
    expect(firstFiles).not.toEqual(secondFiles);

    const storedFilenames = (db: Db): string[] => (db
      .prepare("SELECT storage_filename AS storageFilename FROM artifact_records ORDER BY storage_filename")
      .all() as Array<{ storageFilename: string }>).map((row) => row.storageFilename);
    expect(storedFilenames(first)).toEqual(firstFiles);
    expect(storedFilenames(second)).toEqual(secondFiles);
    expect(firstFiles.every((filename) => existsSync(join(firstArtifactRoot, filename)))).toBe(true);
    expect(secondFiles.every((filename) => existsSync(join(secondArtifactRoot, filename)))).toBe(true);
    const firstArtifactIds = assertDefaultFixtureReads(first);
    expect(assertDefaultFixtureReads(second)).not.toEqual(firstArtifactIds);

    closeDb(first);
    databases.splice(databases.indexOf(first), 1);
    resetSpeakerArtifactStoreForTest();
    const reopenedFirst = openDb({ path: firstPath });
    databases.push(reopenedFirst);
    expect(assertDefaultFixtureReads(reopenedFirst)).toEqual(firstArtifactIds);
    expect(process.env.SYMPOSE_ARTIFACT_STORE_ROOT).toBeUndefined();

    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", configuredDirectory);
    const configured = openDb({ path: join(configuredDirectory, "evaluator.sqlite") });
    databases.push(configured);
    expect(process.env.SYMPOSE_ARTIFACT_STORE_ROOT).toBe(configuredDirectory);
    expect(readdirSync(configuredDirectory).filter((entry) => entry.endsWith(".bin"))).toHaveLength(2);
    expect(existsSync(join(configuredDirectory, "artifacts"))).toBe(false);
    expect(assertDefaultFixtureReads(configured)).toHaveLength(EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.length);
  });

  it("rejects a profile mismatch before creating artifact records, approvals, or bytes", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-profile-denial-"));
    temporaryDirectories.push(directory);
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    const before = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM artifact_records) AS artifacts,
         (SELECT COUNT(*) FROM artifact_upload_intents) AS intents,
         (SELECT COUNT(*) FROM speaker_content_versions) AS versions,
         (SELECT COUNT(*) FROM speaker_content_reviews) AS reviews`,
    ).get();
    setEnvironmentVariable("SYMPOSE_EVALUATOR_PROFILE", "remote");
    const deniedRoot = join(directory, "denied-artifacts");
    expect(() => seedEvaluatorArtifactFixtures(db, {
      store: new LocalArtifactStore({ rootDir: deniedRoot }),
    })).toThrow("EVALUATOR_ARTIFACT_FIXTURE_PROFILE_DENIED");
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM artifact_records) AS artifacts,
         (SELECT COUNT(*) FROM artifact_upload_intents) AS intents,
         (SELECT COUNT(*) FROM speaker_content_versions) AS versions,
         (SELECT COUNT(*) FROM speaker_content_reviews) AS reviews`,
    ).get()).toEqual(before);
    expect(existsSync(deniedRoot)).toBe(false);
  });

  it("rejects an unavailable configured root before any evaluator seed authority is written", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "sympose-evaluator-root-denial-"));
    temporaryDirectories.push(directory);
    const blockedRoot = join(directory, "blocked-root");
    writeFileSync(blockedRoot, "not a directory", { encoding: "utf8", mode: 0o600 });
    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", blockedRoot);
    setEnvironmentVariable("NODE_ENV", "development");
    setEnvironmentVariable("VITEST", undefined);
    const path = join(directory, "evaluator.sqlite");
    expect(() => openDb({ path })).toThrow("SPEAKER_ARTIFACT_ROOT_UNAVAILABLE");

    setEnvironmentVariable("SYMPOSE_ARTIFACT_STORE_ROOT", undefined);
    const inspect = openDb({ path, seed: false });
    databases.push(inspect);
    expect(inspect.prepare("SELECT value FROM meta WHERE key = 'seed_version'").get()).toBeUndefined();
    expect(inspect.prepare(
      `SELECT
         (SELECT COUNT(*) FROM workspaces) AS workspaces,
         (SELECT COUNT(*) FROM artifact_records) AS artifacts,
         (SELECT COUNT(*) FROM speaker_content_reviews) AS reviews,
         (SELECT COUNT(*) FROM publication_releases) AS releases`,
    ).get()).toEqual({ workspaces: 0, artifacts: 0, reviews: 0, releases: 0 });
  });

  it("fails closed when a persisted evaluator artifact task definition diverges", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);

    db.exec("DROP TRIGGER trg_speaker_tasks_immutable_definition");
    db.prepare("UPDATE speaker_tasks SET title = ? WHERE task_kind = 'HEADSHOT' AND workspace_id = ? AND event_id = ?")
      .run("Divergent headshot definition", EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
    expect(() => seedEvaluatorSpeakerTaskFixtures(db)).toThrow("EVALUATOR_DEMO_SPEAKER_TASK_INVALID");
  });

  it("adds an isolated DevFlow compatibility profile without relabeling Acme", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);

    seedEvaluatorDemo(db);

    expect(
      db.prepare("SELECT id, slug, name FROM workspaces WHERE id = ?").get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID),
    ).toEqual({
      id: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      slug: DEVFLOW_EVALUATOR_PROFILE.workspaceSlug,
      name: DEVFLOW_EVALUATOR_PROFILE.workspaceName,
    });
    expect(
      db.prepare("SELECT display_name AS displayName, role FROM accounts WHERE id = ?").get(EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID),
    ).toEqual({ displayName: "Sam Whitfield", role: "reviewer" });
    expect(
      db
        .prepare("SELECT full_name AS fullName FROM people WHERE workspace_id = ? ORDER BY full_name")
        .all(EVALUATOR_COMPATIBILITY_WORKSPACE_ID),
    ).toEqual([
      { fullName: "Marcus Okafor" },
      { fullName: "Priya Raman" },
      { fullName: "Sam Whitfield" },
    ]);
    expect(
      db.prepare("SELECT id, slug, name FROM calls WHERE workspace_id = ?").get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID),
    ).toMatchObject({ id: EVALUATOR_COMPATIBILITY_CALL_ID, slug: "devflow-conf-2027" });
    expect(
      db.prepare("SELECT id, name FROM events WHERE workspace_id = ?").get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID),
    ).toEqual({ id: EVALUATOR_COMPATIBILITY_EVENT_ID, name: "DevFlow Conf 2027" });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM review_assignments WHERE workspace_id = ?")
        .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID),
    ).toEqual({ count: 1 });

    const acmeNames = db
      .prepare("SELECT full_name AS fullName FROM people WHERE workspace_id = ? ORDER BY full_name")
      .all(EVALUATOR_WORKSPACE_ID);
    expect(acmeNames).not.toEqual(expect.arrayContaining([{ fullName: "Priya Raman" }, { fullName: "Marcus Okafor" }]));

    const countsBefore = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM people WHERE workspace_id = ?) AS people,
           (SELECT COUNT(*) FROM calls WHERE workspace_id = ?) AS calls,
           (SELECT COUNT(*) FROM submissions WHERE workspace_id = ?) AS submissions,
           (SELECT COUNT(*) FROM review_assignments WHERE workspace_id = ?) AS assignments,
           (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ?) AS releases`,
      )
      .get(
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      );
    seedEvaluatorDemo(db);
    expect(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM people WHERE workspace_id = ?) AS people,
             (SELECT COUNT(*) FROM calls WHERE workspace_id = ?) AS calls,
             (SELECT COUNT(*) FROM submissions WHERE workspace_id = ?) AS submissions,
             (SELECT COUNT(*) FROM review_assignments WHERE workspace_id = ?) AS assignments,
             (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ?) AS releases`,
        )
        .get(
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
          EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        ),
    ).toEqual(countsBefore);
  });

  it("reopens append-only evaluator state after another sealed release is recorded", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);

    const current = db
      .prepare(
        `SELECT plan_version_id AS planVersionId, content_json AS contentJson
         FROM publication_releases
         WHERE id = (SELECT current_release_id FROM events WHERE id = ?)`,
      )
      .get(EVALUATOR_EVENT_ID) as { planVersionId: string; contentJson: string };
    const laterContent = JSON.parse(current.contentJson) as { event: { name: string } };
    laterContent.event.name = `${laterContent.event.name} · revised release`;
    db.prepare(
      `INSERT INTO publication_releases
         (id, workspace_id, event_id, plan_version_id, audience_policy_version,
          commitment_watermark, fingerprint, content_json, sealed_at)
       SELECT ?, workspace_id, event_id, plan_version_id, audience_policy_version,
              commitment_watermark, ?, ?, '2026-08-12T14:00:00.000Z'
       FROM publication_releases
       WHERE id = (SELECT current_release_id FROM events WHERE id = ?)`,
    ).run(
      deterministicUuid("evaluator-demo:later-release"),
      fingerprintOf(laterContent),
      JSON.stringify(laterContent),
      EVALUATOR_EVENT_ID,
    );

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 2 });
    expect(current.planVersionId).toEqual(expect.any(String));

    expect(() => seedEvaluatorDemo(db)).not.toThrow();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ?").get(EVALUATOR_WORKSPACE_ID),
    ).toEqual({ count: 2 });
  });

  it("never silently reapproves a materially revised evaluator schedule on seed replay", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);

    for (const fixture of [
      {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
        replay: () => seedEvaluatorDemo(db),
        key: "acme",
      },
      {
        workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
        eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
        actorAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
        replay: () => seedEvaluatorCompatibility(db),
        key: "devflow",
      },
    ] as const) {
      const scope = { workspaceId: fixture.workspaceId, eventId: fixture.eventId };
      const draft = readScheduleDraft(db, scope);
      expect(readCurrentScheduleApproval(db, scope)).not.toBeNull();
      const countsBefore = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM domain_events
             WHERE workspace_id = ? AND aggregate_id = ? AND event_type = ?) AS events,
           (SELECT COUNT(*) FROM audit_events
             WHERE workspace_id = ? AND target_id = ? AND action = 'schedule.approved') AS audits`,
      ).get(
        fixture.workspaceId,
        fixture.eventId,
        SCHEDULE_APPROVAL_EVENT_TYPE,
        fixture.workspaceId,
        fixture.eventId,
      );

      executeScheduleDraftCommand(db, scope, {
        expectedRevision: draft.schedule.revision,
        planVersionId: draft.schedule.planVersionId,
        planFingerprint: draft.schedule.planFingerprint,
        acceptedInventoryFingerprint: draft.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: draft.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "CONFIGURE",
          rooms: draft.schedule.rooms.map((room) => ({
            ...room,
            name: `${room.name} · organizer revision`,
          })),
          tracks: draft.schedule.tracks.map((track) => ({ ...track })),
        },
        idempotencyKey: `evaluator-replay-no-reapproval-${fixture.key}`,
        requestId: `evaluator-replay-no-reapproval-request-${fixture.key}`,
        actorAccountId: fixture.actorAccountId,
      });
      expect(readCurrentScheduleApproval(db, scope)).toBeNull();

      expect(() => fixture.replay()).not.toThrow();
      expect(readCurrentScheduleApproval(db, scope)).toBeNull();
      expect(db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM domain_events
             WHERE workspace_id = ? AND aggregate_id = ? AND event_type = ?) AS events,
           (SELECT COUNT(*) FROM audit_events
             WHERE workspace_id = ? AND target_id = ? AND action = 'schedule.approved') AS audits`,
      ).get(
        fixture.workspaceId,
        fixture.eventId,
        SCHEDULE_APPROVAL_EVENT_TYPE,
        fixture.workspaceId,
        fixture.eventId,
      )).toEqual(countsBefore);
    }
  });
});
