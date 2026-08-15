import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import {
  formatOperatorTimestamp,
  OperatorProofExperience,
  ReleaseTwinProof,
} from "@/components/operator-proof/operator-proof-experience";
import { createSession } from "@/server/auth";
import { deterministicUuid, fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import {
  consumeEmailVerification,
  issueEmailVerification,
} from "@/server/services/cfp/applicant-access";
import {
  createApplicantSubmissionDraft,
  saveApplicantSubmissionDraft,
  submitApplicantSubmission,
} from "@/server/services/cfp/applicant-portal";
import { decideCfpSubmission } from "@/server/services/cfp/decisions";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "@/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "@/server/services/cfp/form-evaluator";
import { getOperatorProofExperience } from "@/server/services/operator-proof";
import { sealRelease } from "@/server/services/publication";
import {
  executeScheduleDraftCommand,
  readScheduleDraft,
} from "@/server/services/scheduling/persistence";
import { createSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";

function seededDb(): Db {
  const db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  return db;
}

function totalChanges(db: Db): number {
  return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function currentSealedReleaseSnapshot(db: Db): {
  readonly id: string;
  readonly contentJson: string;
  readonly fingerprint: string;
} {
  const row = db.prepare(
    `SELECT release.id, release.content_json AS contentJson, release.fingerprint
       FROM events event_row
       JOIN publication_releases release
         ON release.id = event_row.current_release_id
        AND release.workspace_id = event_row.workspace_id
        AND release.event_id = event_row.id
      WHERE event_row.workspace_id = ? AND event_row.id = ?
      LIMIT 1`,
  ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
    id: string;
    contentJson: string;
    fingerprint: string;
  } | undefined;
  if (!row) throw new Error("sealed evaluator release unavailable");
  return row;
}

function acceptNewCfpSession(db: Db): string {
  const organizer = createSession(
    db,
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_WORKSPACE_ID,
  ).session;
  const definition = createFormDefinition(db, organizer, {
    name: "Operator proof hostile session form",
  });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
      {
        id: "abstract",
        type: "longText",
        label: "Proposal abstract",
        required: true,
        defaultVisibility: "visible",
        config: { maxLength: 4_000 },
      },
      {
        id: "format",
        type: "shortText",
        label: "Session format",
        required: true,
        defaultVisibility: "visible",
        config: { durationMinutes: 30 },
      },
      { id: "track", type: "shortText", label: "Track", required: true, defaultVisibility: "visible" },
      { id: "durationMinutes", type: "shortText", label: "Session duration", required: true, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Accept terms", required: true, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId: EVALUATOR_EVENT_ID,
    name: "Operator proof hostile additions",
    slug: "operator-proof-hostile-additions",
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "Synthetic test proposal only.",
        retention: "Synthetic evidence is retained for the test.",
        aiProcessing: "No AI processing.",
        communication: "Local simulation only.",
        consent: "Required test consent is recorded.",
        publication: "Accepted proposals may enter the synthetic schedule.",
      },
      choices: [{ fieldId: "consent", statement: "Accept test terms", required: true }],
    },
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: "2026-08-01T00:00:00.000Z",
    closesAt: "2099-01-01T00:00:00.000Z",
  });
  const verificationTokenHash = fingerprintOf({
    schema: "operator-proof-hostile-verification/v1",
    eventId: EVALUATOR_EVENT_ID,
  });
  const verification = issueEmailVerification(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
  }, {
    callId: call.id,
    email: "new-cfp-session@sympose.example",
    tokenHash: verificationTokenHash,
  });
  const applicantSessionTokenHash = fingerprintOf({
    schema: "operator-proof-hostile-applicant-session/v1",
    eventId: EVALUATOR_EVENT_ID,
  });
  consumeEmailVerification(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
  }, {
    callId: call.id,
    verificationId: verification.verificationId,
    verificationTokenHash,
    applicantSessionTokenHash,
    fullName: "Hostile New CFP Speaker",
  });
  const draft = createApplicantSubmissionDraft(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    callId: call.id,
    sessionTokenHash: applicantSessionTokenHash,
  });
  const answers = [
    { fieldId: "title", value: "Hostile newly accepted CFP session" },
    { fieldId: "abstract", value: "A post-seal session that must invalidate readiness." },
    { fieldId: "format", value: "Talk" },
    { fieldId: "track", value: "Hostile additions" },
    { fieldId: "durationMinutes", value: "30" },
    { fieldId: "consent", value: true },
  ] as const;
  const saved = saveApplicantSubmissionDraft(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    callId: call.id,
    sessionTokenHash: applicantSessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: null,
  });
  const submitted = submitApplicantSubmission(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    callId: call.id,
    sessionTokenHash: applicantSessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: saved.revisionId,
  });
  const decision = decideCfpSubmission(db, organizer, {
    workspaceSlug: organizer.workspaceSlug,
    eventId: EVALUATOR_EVENT_ID,
    callId: call.id,
    submissionId: draft.submissionId,
    expectedRevisionId: submitted.revisionId,
    decision: "ACCEPTED",
  });
  const programUnitId = decision.handoff?.linkedSession.programUnitId;
  if (!programUnitId) throw new Error("accepted CFP session handoff unavailable");
  return programUnitId;
}

function requiredProjection(db: Db, eventId = EVALUATOR_EVENT_ID) {
  const projection = getOperatorProofExperience(db, EVALUATOR_WORKSPACE_ID, eventId);
  if (!projection) throw new Error("operator proof projection unavailable");
  return projection;
}

function expectSchedulingAndPublicationBlocked(db: Db): void {
  const projection = requiredProjection(db);
  expect(projection.releaseTwin.drift.status).toBe("STALE");
  expect(projection.releaseTwin.drift.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: "schedule-placement", family: "LOCATION" }),
  ]));
  expect(projection.readiness.outcomes.find((outcome) => outcome.outcome === "SCHEDULING")?.status).toBe("BLOCKED");
  expect(projection.readiness.outcomes.find((outcome) => outcome.outcome === "PUBLICATION")?.status).toBe("BLOCKED");
}

describe("operator-proof-experience", () => {
  it("keeps an approved sealed schedule exact after a view-only active-day persistence event", () => {
    const db = seededDb();
    try {
      expect(requiredProjection(db).releaseTwin.drift.status).toBe("EXACT_MATCH");
      const scope = { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID };
      const current = readScheduleDraft(db, scope);
      executeScheduleDraftCommand(db, scope, {
        expectedRevision: current.schedule.revision,
        planVersionId: current.schedule.planVersionId,
        planFingerprint: current.schedule.planFingerprint,
        acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
        command: { kind: "AUTO_PLACE", reason: "Persist a view-only active day" },
        activeDayId: current.schedule.days.at(-1)!.id,
        idempotencyKey: "operator-proof-view-only-active-day",
        requestId: "operator-proof-view-only-active-day-request",
        actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      expect(requiredProjection(db).releaseTwin.drift.status).toBe("EXACT_MATCH");
    } finally {
      closeDb(db);
    }
  });

  it("does not leak release or activity evidence through a hostile cross-event pointer and keeps missing evidence unavailable", () => {
    const db = seededDb();
    try {
      const foreignRelease = db.prepare(
        "SELECT current_release_id AS id FROM events WHERE workspace_id = ? AND id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { id: string };
      const otherEventId = deterministicUuid("operator-proof:hostile-other-event");
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle,
            current_plan_version_id, current_release_id, created_at)
         VALUES (?, ?, 'Hostile pointer event', 'UTC', ?, ?, 'planning', NULL, ?, ?)`,
      ).run(
        otherEventId,
        EVALUATOR_WORKSPACE_ID,
        "2026-10-01T09:00:00.000Z",
        "2026-10-01T17:00:00.000Z",
        foreignRelease.id,
        "2026-08-13T12:00:00.000Z",
      );

      const projection = requiredProjection(db, otherEventId);
      expect(projection.releaseTwin.currentPointer).toEqual({
        releaseId: foreignRelease.id,
        validated: false,
      });
      expect(projection.releaseTwin.publicPackage).toBeNull();
      expect(projection.releaseTwin.history.items).toEqual([]);
      expect(projection.releaseTwin.history.status).toBe("UNAVAILABLE");
      expect(projection.releaseTwin.drift.status).toBe("UNAVAILABLE");
      expect(projection.activitySpine.stages.every((stage) => stage.status === "UNAVAILABLE")).toBe(true);
      expect(projection.readiness.outcomes.find((outcome) => outcome.outcome === "PUBLICATION")?.status).toBe("BLOCKED");

      const source = requiredProjection(db);
      expect(source.releaseTwin.publicPackage?.releaseId).toBe(foreignRelease.id);
      expect(source.activitySpine.stages.find((stage) => stage.stage === "RELEASE_SEALED")?.status).toBe("PROVEN");
    } finally {
      closeDb(db);
    }
  });

  it("reports source drift without mutating the sealed release, then proves explicit supersession", () => {
    const db = seededDb();
    try {
      const initial = requiredProjection(db);
      expect(initial.releaseTwin.drift.status).toBe("EXACT_MATCH");
      const firstReleaseId = initial.releaseTwin.publicPackage?.releaseId;
      expect(firstReleaseId).toBeTruthy();

      const tasks = db.prepare(
        `SELECT aggregate_id AS id,
                json_extract(payload_json, '$.task.contentKind') AS contentKind
           FROM domain_events
          WHERE workspace_id = ?
            AND event_type = 'speaker.task.created'
            AND aggregate_type = 'speaker_task'
            AND json_extract(payload_json, '$.eventId') = ?
            AND json_extract(payload_json, '$.task.contentKind') IN ('SESSION_TITLE', 'SESSION_DESCRIPTION')
          ORDER BY contentKind, id`,
      ).all(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as Array<{ id: string; contentKind: string }>;
      const titleTask = tasks.find((task) => task.contentKind === "SESSION_TITLE");
      if (!titleTask) throw new Error("title task unavailable");
      const speaker = createSyntheticSpeakerOperationsRepository({
        db,
        clock: () => "2026-08-14T00:00:00.000Z",
      });
      const scope = {
        kind: "organizer" as const,
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: EVALUATOR_EVENT_ID,
        actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      };
      const titleV2 = speaker.submitOrganizerContent(scope, {
        personId: db.prepare(
          "SELECT person_id AS personId FROM event_speakers WHERE workspace_id = ? AND event_id = ? ORDER BY id LIMIT 1",
        ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)!.personId as string,
        taskId: titleTask.id,
        payload: { kind: "SESSION_TITLE", title: "Operator proof drift title" },
        idempotencyKey: "operator-proof-title-v2",
      });
      speaker.approveContent(scope, {
        personId: titleV2.personId,
        taskId: titleTask.id,
        submissionVersionId: titleV2.id,
        submissionContentHash: titleV2.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "operator-proof-title-v2-approval",
      });

      const stale = requiredProjection(db);
      expect(stale.releaseTwin.publicPackage?.releaseId).toBe(firstReleaseId);
      expect(stale.releaseTwin.drift.status).toBe("STALE");
      expect(stale.releaseTwin.drift.families).toContain("CONTENT");
      expect(stale.readiness.outcomes.find((outcome) => outcome.outcome === "SCHEDULING")?.status).toBe("BLOCKED");

      const secondRelease = sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
        kind: "account",
        ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      });
      const superseded = requiredProjection(db);
      expect(secondRelease.releaseId).not.toBe(firstReleaseId);
      expect(superseded.releaseTwin.publicPackage?.releaseId).toBe(secondRelease.releaseId);
      expect(superseded.releaseTwin.drift.status).toBe("EXACT_MATCH");
      expect(superseded.releaseTwin.history.status).toBe("PROVEN");
      expect(superseded.releaseTwin.history.items).toHaveLength(2);
      expect(superseded.releaseTwin.history.items[0]).toMatchObject({
        releaseId: firstReleaseId,
        supersededByReleaseId: secondRelease.releaseId,
        current: false,
      });
      expect(superseded.releaseTwin.history.items[1]).toMatchObject({
        releaseId: secondRelease.releaseId,
        supersedesReleaseId: firstReleaseId,
        current: true,
      });
    } finally {
      closeDb(db);
    }
  });

  it("marks a newly accepted CFP session stale without rewriting the sealed audience release", () => {
    const db = seededDb();
    try {
      expect(requiredProjection(db).releaseTwin.drift.status).toBe("EXACT_MATCH");
      const sealedBefore = currentSealedReleaseSnapshot(db);
      const programUnitId = acceptNewCfpSession(db);
      expect(db.prepare(
        `SELECT id
           FROM program_units
          WHERE id = ? AND workspace_id = ? AND event_id = ?`,
      ).get(programUnitId, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID)).toEqual({ id: programUnitId });

      expectSchedulingAndPublicationBlocked(db);
      expect(currentSealedReleaseSnapshot(db)).toEqual(sealedBefore);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    {
      resource: "room",
      rename: (db: Db) => db.prepare(
        `UPDATE event_rooms
            SET name = 'Renamed hostile room'
          WHERE workspace_id = ? AND event_id = ?`,
      ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID).changes,
    },
    {
      resource: "track",
      rename: (db: Db) => db.prepare(
        `UPDATE event_tracks
            SET name = 'Renamed hostile track'
          WHERE workspace_id = ? AND event_id = ?`,
      ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID).changes,
    },
  ])("marks a $resource rename stale without rewriting the sealed audience release", ({ rename }) => {
    const db = seededDb();
    try {
      expect(requiredProjection(db).releaseTwin.drift.status).toBe("EXACT_MATCH");
      const sealedBefore = currentSealedReleaseSnapshot(db);
      expect(rename(db)).toBe(1);

      expectSchedulingAndPublicationBlocked(db);
      expect(currentSealedReleaseSnapshot(db)).toEqual(sealedBefore);
    } finally {
      closeDb(db);
    }
  });

  it("returns a deeply frozen read-only projection with missing proof kept unavailable", () => {
    const db = seededDb();
    try {
      const before = totalChanges(db);
      const first = requiredProjection(db);
      const after = totalChanges(db);
      const second = requiredProjection(db);

      expect(after).toBe(before);
      expect(totalChanges(db)).toBe(before);
      expect(second).toEqual(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.releaseTwin.history.items)).toBe(true);
      expect(first.releaseTwin.operatorPackage.status).toBe("UNAVAILABLE");
      expect(first.boundedEvidence.decisionReplay.status).toBe("UNAVAILABLE");
      expect(first.boundedEvidence.nearMiss.status).toBe("UNAVAILABLE");
      expect(first.activitySpine.stages.map((stage) => stage.stage)).toEqual([
        "PROPOSAL_ACCEPTED",
        "SPEAKER_CREATED",
        "ARTIFACT_SUBMITTED",
        "ARTIFACT_APPROVED",
        "SCHEDULED",
        "RELEASE_SEALED",
      ]);

      const markup = renderToStaticMarkup(createElement(ReleaseTwinProof, { projection: first }));
      const sealedAt = first.releaseTwin.publicPackage?.sealedAt;
      if (!sealedAt) throw new Error("seeded release timestamp unavailable");
      const humanUtc = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(sealedAt));
      expect(markup.indexOf("Included agendas")).toBeGreaterThanOrEqual(0);
      expect(markup.indexOf("Included agendas")).toBeLessThan(markup.indexOf("Sealed fingerprint"));
      expect(markup).toContain("Inspect technical release lineage");
      expect(markup).toContain(`dateTime="${sealedAt}"`);
      expect(markup).toContain(`>${humanUtc} · UTC</time>`);
      expect(markup).not.toContain(`>${sealedAt}</time>`);
      expect(formatOperatorTimestamp("not-an-instant")).toBe(
        "Unformatted UTC timestamp · not-an-instant",
      );
      const experienceMarkup = renderToStaticMarkup(createElement(OperatorProofExperience, { projection: first }));
      expect(experienceMarkup).toContain('aria-label="Operator proof sections"');
      expect(experienceMarkup).toContain('data-role-instrument="operator"');
      expect(experienceMarkup).toContain("Read-only readiness instrument");
      expect(experienceMarkup).toContain("What needs you");
    } finally {
      closeDb(db);
    }
  });

  it("reconstructs the identical read-only proof after a database reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-operator-proof-"));
    const path = join(directory, "proof.sqlite");
    let db = openDb({ path, seed: false });
    try {
      seedWorkspaces(db);
      seedEvaluatorDemo(db);
      const before = requiredProjection(db);
      closeDb(db);
      db = openDb({ path, seed: false });
      const changesBeforeRead = totalChanges(db);
      const after = requiredProjection(db);
      expect(after).toEqual(before);
      expect(totalChanges(db)).toBe(changesBeforeRead);
    } finally {
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
