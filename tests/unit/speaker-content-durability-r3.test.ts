import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, deterministicUuid, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { createSpeakerArtifactRecord } from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import {
  ContentOperationsConflictError,
  createDurableContentOperationsRepository,
  type ContentSubmissionVersion,
} from "../../src/server/services/content-operations";
import {
  acceptedCurrentPlanAssignmentId,
} from "../../src/server/services/evaluator-speaker-identity";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import {
  runPersistentRaceActor,
  startPersistentRaceActors,
  stopPersistentRaceActors,
} from "./helpers/persistent-race-actor";

const AT = "2026-08-12T12:00:00.000Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REVIEW_EVENT_TYPES = [
  "speaker.content.comment.added",
  "speaker.content.finding.added",
  "speaker.content.revision.requested",
  "speaker.content.approved",
] as const;
const scope = {
  kind: "organizer" as const,
  workspaceId: EVALUATOR_WORKSPACE_ID,
  eventId: EVALUATOR_EVENT_ID,
  actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
};
const contentScope = {
  workspaceId: EVALUATOR_WORKSPACE_ID,
  eventId: EVALUATOR_EVENT_ID,
  actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  actorKind: "organizer" as const,
};

type Fixture = {
  readonly db: Db;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly version: ContentSubmissionVersion;
};

function fixture(path = ":memory:"): Fixture {
  const db = openDb({ path, seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  seedEvaluatorSpeakerTaskFixtures(db);
  const assignmentId = acceptedCurrentPlanAssignmentId(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    personId: EVALUATOR_SPEAKER_PERSON_ID,
  });
  const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
  const task = speaker.createTask(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    kind: "SESSION_TITLE",
    contentKind: "SESSION_TITLE",
    title: "Durable R3 title",
    description: "Exact current task authority fixture.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-09-12T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "r3-durable-title-task",
  });
  const version = speaker.submitOrganizerContent(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId: task.id,
    payload: { kind: "SESSION_TITLE", title: "Exact current durable title" },
    idempotencyKey: "r3-durable-title-version",
  });
  return { db, taskId: task.id, assignmentId, version };
}

function reviewCounts(db: Db): Record<string, number> {
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM domain_events) AS domainEvents,
       (SELECT COUNT(*) FROM outbox_messages) AS outbox,
       (SELECT COUNT(*) FROM audit_events) AS audit,
       (SELECT COUNT(*) FROM speaker_content_reviews) AS contentReviews,
       (SELECT COUNT(*) FROM speaker_artifact_release_bindings) AS bindings`,
  ).get() as Record<string, number>;
  return row;
}

function addAmbiguousAssignment(db: Db): void {
  const plan = db.prepare(
    "SELECT current_plan_version_id AS planId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { planId: string };
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES ('r3-ambiguous-unit', ?, ?, 'R3 ambiguity', 'SESSION', ?, ?, 1, ?)`,
  ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, AT, "2026-08-12T13:00:00.000Z", AT);
  db.prepare(
    `INSERT INTO plan_assignments
       (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
     VALUES ('r3-ambiguous-assignment', ?, ?, ?, 'r3-ambiguous-unit', 'SPEAKER', 'R3 stale authority')`,
  ).run(EVALUATOR_WORKSPACE_ID, plan.planId, EVALUATOR_SPEAKER_PERSON_ID);
}

describe("R3 durable speaker content authority", () => {
  it("binds all four review envelopes to the exact accepted assignment", () => {
    const data = fixture();
    try {
      const speaker = createSyntheticSpeakerOperationsRepository({ db: data.db, clock: () => AT });
      const exact = {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: data.taskId,
        submissionVersionId: data.version.id,
        submissionContentHash: data.version.contentHash,
      };
      const comment = speaker.addComment(scope, { ...exact, body: "Exact assignment comment", idempotencyKey: "r3-bind-comment" });
      const finding = speaker.addFinding(scope, { ...exact, severity: "INFO", message: "Exact assignment finding", blocksReadiness: false, idempotencyKey: "r3-bind-finding" });
      const revision = speaker.requestRevision(scope, { ...exact, reason: "Exact assignment revision", idempotencyKey: "r3-bind-revision" });
      const approval = speaker.approveContent(scope, { ...exact, gate: "PUBLICATION", idempotencyKey: "r3-bind-approval" });
      expect([comment, finding, revision, approval].every((record) => record.taskId === data.taskId)).toBe(true);

      const payloads = data.db.prepare(
        `SELECT event_type AS eventType, payload_json AS payloadJson
         FROM domain_events
         WHERE workspace_id = ? AND aggregate_id = ?
           AND event_type IN (${REVIEW_EVENT_TYPES.map(() => "?").join(", ")})
         ORDER BY created_at, rowid`,
      ).all(EVALUATOR_WORKSPACE_ID, data.taskId, ...REVIEW_EVENT_TYPES) as Array<{ eventType: string; payloadJson: string }>;
      expect(payloads.map(({ eventType, payloadJson }) => {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        return { eventType, schema: payload.schema, assignmentId: payload.assignmentId };
      })).toEqual(REVIEW_EVENT_TYPES.map((eventType) => ({
        eventType,
        schema: "sympose-content-operation/v2",
        assignmentId: data.assignmentId,
      })));

      expect(speaker.approveContent(scope, { ...exact, gate: "PUBLICATION", idempotencyKey: "r3-bind-approval" })).toEqual(approval);
      expect(data.db.prepare(
        "SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'speaker.content.approved'",
      ).get(EVALUATOR_WORKSPACE_ID, data.taskId)).toEqual({ count: 1 });
    } finally {
      closeDb(data.db);
    }
  });

  it("denies stale assignment and stale version commands with no business side effects", () => {
    const data = fixture();
    try {
      const repository = createDurableContentOperationsRepository(data.db, { clock: () => AT });
      const exact = {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: data.taskId,
        submissionVersionId: data.version.id,
        submissionContentHash: data.version.contentHash,
      };
      repository.addComment(contentScope, { ...exact, body: "Companion removed before denial", idempotencyKey: "r3-missing-outbox" });
      const commentEvent = data.db.prepare(
        "SELECT id FROM domain_events WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'speaker.content.comment.added' AND json_extract(payload_json, '$.idempotencyKey') = 'r3-missing-outbox'",
      ).get(EVALUATOR_WORKSPACE_ID, data.taskId) as { id: string };
      data.db.prepare("DELETE FROM outbox_messages WHERE domain_event_id = ?").run(commentEvent.id);

      const staleVersionBefore = reviewCounts(data.db);
      expect(() => repository.addFinding(contentScope, {
        ...exact,
        submissionVersionId: "missing-version",
        severity: "INFO",
        message: "Must not repair an outbox before stale-version denial",
        idempotencyKey: "r3-stale-version",
      })).toThrow(/version|authorized/iu);
      expect(reviewCounts(data.db)).toEqual(staleVersionBefore);
      expect(data.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE domain_event_id = ?").get(commentEvent.id)).toEqual({ count: 0 });

      addAmbiguousAssignment(data.db);
      const staleAssignmentBefore = reviewCounts(data.db);
      const attempts = [
        () => repository.addComment(contentScope, { ...exact, body: "Denied stale comment", idempotencyKey: "r3-stale-comment" }),
        () => repository.addFinding(contentScope, { ...exact, severity: "INFO", message: "Denied stale finding", blocksReadiness: false, idempotencyKey: "r3-stale-finding" }),
        () => repository.requestRevision(contentScope, { ...exact, reason: "Denied stale revision", idempotencyKey: "r3-stale-revision" }),
        () => repository.approveVersion(contentScope, { ...exact, gate: "PUBLICATION", idempotencyKey: "r3-stale-approval" }),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrow(/authority|current|available/iu);
        expect(reviewCounts(data.db)).toEqual(staleAssignmentBefore);
        expect(data.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE domain_event_id = ?").get(commentEvent.id)).toEqual({ count: 0 });
      }
    } finally {
      closeDb(data.db);
    }
  });

  it("denies stale artifact-task review commands with no business side effects", () => {
    const data = fixture();
    const directory = mkdtempSync(join(tmpdir(), "sympose-r3-artifact-review-"));
    try {
      const task = data.db.prepare(
        "SELECT id FROM speaker_tasks WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_kind = 'HEADSHOT'",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID) as { id: string };
      createSpeakerArtifactRecord(data.db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: task.id,
        kind: "HEADSHOT",
      }, {
        bytes: PNG,
        mediaType: "image/png",
        originalFilename: "r3-headshot.png",
      }, {
        store: new LocalArtifactStore({ rootDir: directory, clock: () => AT }),
      });
      const repository = createDurableContentOperationsRepository(data.db, { clock: () => AT });
      const version = repository.getReviewProjection(contentScope, {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: task.id,
        kind: "HEADSHOT",
      }).versions.at(-1);
      if (!version) throw new Error("R3 artifact content version was not persisted.");
      const exact = {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: task.id,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
      };
      data.db.exec("DROP TRIGGER trg_speaker_tasks_immutable_definition");
      data.db.prepare("UPDATE speaker_tasks SET title = 'Divergent artifact task' WHERE id = ?").run(task.id);
      const divergentBefore = reviewCounts(data.db);
      expect(() => repository.addComment(contentScope, {
        ...exact,
        body: "Denied divergent artifact definition",
        idempotencyKey: "r3-divergent-artifact-definition",
      })).toThrow(/task|available|authority/iu);
      expect(reviewCounts(data.db)).toEqual(divergentBefore);
      data.db.prepare("UPDATE speaker_tasks SET title = 'Headshot PNG' WHERE id = ?").run(task.id);

      addAmbiguousAssignment(data.db);
      const before = reviewCounts(data.db);
      const attempts = [
        () => repository.addComment(contentScope, { ...exact, body: "Denied artifact comment", idempotencyKey: "r3-stale-artifact-comment" }),
        () => repository.addFinding(contentScope, { ...exact, severity: "INFO", message: "Denied artifact finding", blocksReadiness: false, idempotencyKey: "r3-stale-artifact-finding" }),
        () => repository.requestRevision(contentScope, { ...exact, reason: "Denied artifact revision", idempotencyKey: "r3-stale-artifact-revision" }),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrow(/authority|current|available/iu);
        expect(reviewCounts(data.db)).toEqual(before);
      }
    } finally {
      closeDb(data.db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads and replays a historical v1 review envelope without claiming an assignment binding", () => {
    const data = fixture();
    try {
      const repository = createDurableContentOperationsRepository(data.db, { clock: () => AT });
      const input = {
        personId: EVALUATOR_SPEAKER_PERSON_ID,
        taskId: data.taskId,
        submissionVersionId: data.version.id,
        submissionContentHash: data.version.contentHash,
        body: "Historical v1 comment",
        idempotencyKey: "r3-legacy-v1-comment",
      };
      const comment = repository.addComment(contentScope, input);
      const stored = data.db.prepare(
        `SELECT id, payload_json AS payloadJson, created_at AS createdAt
         FROM domain_events
         WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'speaker.content.comment.added'
           AND json_extract(payload_json, '$.idempotencyKey') = ?`,
      ).get(EVALUATOR_WORKSPACE_ID, data.taskId, input.idempotencyKey) as { id: string; payloadJson: string; createdAt: string };
      const legacy = JSON.parse(stored.payloadJson) as Record<string, unknown>;
      legacy.schema = "sympose-content-operation/v1";
      delete legacy.assignmentId;
      const payloadJson = canonicalJson(legacy);
      const payloadFingerprint = fingerprintOf(legacy);
      const eventId = deterministicUuid(`speaker-content-event:speaker.content.comment.added:${EVALUATOR_WORKSPACE_ID}:${payloadFingerprint}`);
      data.db.prepare("DELETE FROM outbox_messages WHERE domain_event_id = ?").run(stored.id);
      data.db.exec("DROP TRIGGER trg_v12_domain_events_immutable");
      data.db.prepare(
        "UPDATE domain_events SET id = ?, payload_json = ?, payload_fingerprint = ? WHERE id = ?",
      ).run(eventId, payloadJson, payloadFingerprint, stored.id);

      expect(repository.addComment(contentScope, input)).toEqual(comment);
      expect(data.db.prepare(
        "SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'speaker.content.comment.added'",
      ).get(EVALUATOR_WORKSPACE_ID, data.taskId)).toEqual({ count: 1 });
      expect(data.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE domain_event_id = ?").get(eventId)).toEqual({ count: 1 });
      const replayed = data.db.prepare("SELECT payload_json AS payloadJson FROM domain_events WHERE id = ?").get(eventId) as { payloadJson: string };
      expect(JSON.parse(replayed.payloadJson)).toMatchObject({ schema: "sympose-content-operation/v1" });
      expect(JSON.parse(replayed.payloadJson)).not.toHaveProperty("assignmentId");
    } finally {
      closeDb(data.db);
    }
  });
});

type RaceMode = "same" | "different" | "distinct";
type RaceOutcome = { readonly ok: boolean; readonly pid: number; readonly id?: string; readonly code?: string };

function waitForMarker(path: string, timeoutMs = 20_000): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("R3 race coordination marker was not created.");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

async function waitForMarkers(paths: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error("R3 race coordination markers were not created.");
    await new Promise<void>((settle) => setTimeout(settle, 20));
  }
}

function proveBusy(db: Db, ownerMarker: string, busyMarker: string, releaseMarker: string): void {
  waitForMarker(ownerMarker);
  db.exec("PRAGMA busy_timeout = 0");
  let error: unknown;
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (caught) {
    error = caught;
  }
  const sqliteError = error as Error & { readonly code?: unknown; readonly errcode?: unknown };
  if (!(error instanceof Error) || sqliteError.code !== "ERR_SQLITE_ERROR" || sqliteError.errcode !== 5 || db.isTransaction) {
    throw error ?? new Error("R3 contender unexpectedly acquired the append transaction.");
  }
  writeFileSync(busyMarker, JSON.stringify({ pid: process.pid, code: sqliteError.code, errcode: sqliteError.errcode }), "utf8");
  db.exec("PRAGMA busy_timeout = 5000");
  waitForMarker(releaseMarker);
}

describe("R3 content review two-connection serialization", () => {
  it("serializes concurrent replay, conflict, and distinct-key ordering", async () => {
    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR === "1") {
      return runPersistentRaceActor(() => {
        const db = openDb({ path: process.env.SYMPOSE_CONTENT_R3_RACE_DB!, seed: false });
        let outcome: RaceOutcome;
        try {
        const contender = process.env.SYMPOSE_CONTENT_R3_RACE_CONTENDER!;
        let publicDb = db;
        if (contender === "a") {
          publicDb = new Proxy(db, {
            get(target, property) {
              if (property === "exec") return (sql: string): void => {
                target.exec(sql);
                if (sql.trim() === "BEGIN IMMEDIATE") {
                  writeFileSync(process.env.SYMPOSE_CONTENT_R3_RACE_OWNER!, String(process.pid), "utf8");
                  waitForMarker(process.env.SYMPOSE_CONTENT_R3_RACE_RELEASE!);
                }
              };
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as Db;
        } else {
          proveBusy(db, process.env.SYMPOSE_CONTENT_R3_RACE_OWNER!, process.env.SYMPOSE_CONTENT_R3_RACE_BUSY!, process.env.SYMPOSE_CONTENT_R3_RACE_RELEASE!);
        }
        const mode = process.env.SYMPOSE_CONTENT_R3_RACE_MODE! as RaceMode;
        const actorId = process.env.SYMPOSE_CONTENT_R3_RACE_ACTOR!;
        const taskId = process.env.SYMPOSE_CONTENT_R3_RACE_TASK!;
        const versionId = process.env.SYMPOSE_CONTENT_R3_RACE_VERSION!;
        const contentHash = process.env.SYMPOSE_CONTENT_R3_RACE_HASH!;
        const repository = createDurableContentOperationsRepository(publicDb, { clock: () => AT });
        const result = repository.addComment({ ...contentScope, actorId }, {
          personId: EVALUATOR_SPEAKER_PERSON_ID,
          taskId,
          submissionVersionId: versionId,
          submissionContentHash: contentHash,
          body: mode === "different" && contender === "b" ? "Different concurrent intent" : `Concurrent ${mode} intent`,
          idempotencyKey: mode === "distinct" ? `r3-race-distinct-${contender}` : `r3-race-${mode}`,
        });
        outcome = { ok: true, pid: process.pid, id: result.id };
      } catch (error) {
        outcome = {
          ok: false,
          pid: process.pid,
          code: error instanceof ContentOperationsConflictError ? error.code : "UNEXPECTED_ERROR",
        };
      } finally {
        closeDb(db);
      }
        writeFileSync(process.env.SYMPOSE_CONTENT_R3_RACE_RESULT!, JSON.stringify(outcome), "utf8");
      });
    }

    const actors = await startPersistentRaceActors({
      testFile: "tests/unit/speaker-content-durability-r3.test.ts",
      testName: "serializes concurrent replay, conflict, and distinct-key ordering$",
    });
    const runRace = async (mode: RaceMode): Promise<{ readonly db: Db; readonly outcomes: readonly RaceOutcome[]; readonly paths: readonly string[] }> => {
      mkdirSync(".tmp/unit", { recursive: true });
      const prefix = resolve(".tmp/unit", `speaker-content-r3-${mode}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      const databasePath = `${prefix}.db`;
      const ownerMarker = `${prefix}.owner`;
      const busyMarker = `${prefix}.busy`;
      const releaseMarker = `${prefix}.release`;
      const resultPaths = [`${prefix}.a.json`, `${prefix}.b.json`];
      const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`, ownerMarker, busyMarker, releaseMarker, ...resultPaths];
      for (const path of paths) rmSync(path, { force: true });
      const setup = fixture(databasePath);
      const environment = {
        SYMPOSE_CONTENT_R3_RACE_WORKER: "1",
        SYMPOSE_CONTENT_R3_RACE_MODE: mode,
        SYMPOSE_CONTENT_R3_RACE_DB: databasePath,
        SYMPOSE_CONTENT_R3_RACE_ACTOR: scope.actorId,
        SYMPOSE_CONTENT_R3_RACE_TASK: setup.taskId,
        SYMPOSE_CONTENT_R3_RACE_VERSION: setup.version.id,
        SYMPOSE_CONTENT_R3_RACE_HASH: setup.version.contentHash,
        SYMPOSE_CONTENT_R3_RACE_OWNER: ownerMarker,
        SYMPOSE_CONTENT_R3_RACE_BUSY: busyMarker,
        SYMPOSE_CONTENT_R3_RACE_RELEASE: releaseMarker,
      };
      closeDb(setup.db);
      const run = (contender: "a" | "b", resultPath: string): Promise<number> =>
        actors[contender === "a" ? 0 : 1]!.request({
          ...environment,
          SYMPOSE_CONTENT_R3_RACE_CONTENDER: contender,
          SYMPOSE_CONTENT_R3_RACE_RESULT: resultPath,
        });
      const owner = run("a", resultPaths[0]!);
      await waitForMarkers([ownerMarker]);
      const contender = run("b", resultPaths[1]!);
      await waitForMarkers([ownerMarker, busyMarker]);
      writeFileSync(releaseMarker, "release", "utf8");
      expect(await Promise.all([owner, contender])).toEqual([0, 0]);
      const outcomes = resultPaths.map((path) => JSON.parse(readFileSync(path, "utf8")) as RaceOutcome);
      const db = openDb({ path: databasePath, seed: false });
      return { db, outcomes, paths };
    };

    try {
      for (const mode of ["same", "different", "distinct"] as const) {
        const raced = await runRace(mode);
        try {
        const events = raced.db.prepare(
          `SELECT rowid, created_at AS createdAt, payload_json AS payloadJson
           FROM domain_events WHERE workspace_id = ? AND event_type = 'speaker.content.comment.added'
           ORDER BY created_at, rowid`,
        ).all(EVALUATOR_WORKSPACE_ID) as Array<{ rowid: number; createdAt: string; payloadJson: string }>;
        expect(events).toHaveLength(mode === "distinct" ? 2 : 1);
        expect(raced.db.prepare(
          "SELECT COUNT(*) AS count FROM outbox_messages WHERE destination_key = 'speaker-content:speaker.content.comment.added'",
        ).get()).toEqual({ count: events.length });
        if (mode === "same") {
          expect(raced.outcomes.every((outcome) => outcome.ok)).toBe(true);
          expect(new Set(raced.outcomes.map((outcome) => outcome.id)).size).toBe(1);
        } else if (mode === "different") {
          expect(raced.outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
          expect(raced.outcomes.filter((outcome) => outcome.code === "CONTENT_OPERATION_CONFLICT")).toHaveLength(1);
        } else {
          expect(raced.outcomes.every((outcome) => outcome.ok)).toBe(true);
          expect(new Set(raced.outcomes.map((outcome) => outcome.id)).size).toBe(2);
          expect(events[1]!.createdAt).toBe(new Date(Date.parse(events[0]!.createdAt) + 1).toISOString());
          expect(events[1]!.rowid).toBeGreaterThan(events[0]!.rowid);
          expect(events.map((event) => (JSON.parse(event.payloadJson) as Record<string, unknown>).idempotencyKey)).toEqual([
            "r3-race-distinct-a",
            "r3-race-distinct-b",
          ]);
        }
        } finally {
          closeDb(raced.db);
          for (const path of raced.paths) rmSync(path, { force: true });
        }
      }
    } finally {
      await stopPersistentRaceActors(actors);
    }
  }, 120_000);
});
