import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReturnerLens } from "@/components/institutional-memory/returner-lens";
import type { SessionInfo } from "@/server/auth";
import { deterministicUuid } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_DRAFT_PERSON_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  EVALUATOR_WORKSPACE_SLUG,
  seedEvaluatorArtifactFixtures,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import {
  projectInstitutionalMemoryForReturnerLens,
  queryReturnerLens,
  ReturnerLensError,
} from "@/server/services/returner-lens";
import { LocalArtifactStore } from "@/server/services/artifact-store";
import type { InstitutionalMemoryResult } from "@/server/services/institutional-memory";

function organizerSession(db: Db): SessionInfo {
  const account = db.prepare(`SELECT account.email, account.display_name, account.role,
      workspace.name
    FROM accounts account JOIN workspaces workspace ON workspace.id = account.workspace_id
    WHERE account.workspace_id = ? AND account.id = ?`)
    .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_ORGANIZER_ACCOUNT_ID) as {
      email: string;
      display_name: string;
      role: string;
      name: string;
    };
  const session: SessionInfo = {
    id: "returner-lens-session",
    tokenHash: "returner-lens-token-hash",
    accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: account.email,
    displayName: account.display_name,
    role: account.role,
    workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
    workspaceName: account.name,
  };
  db.prepare(`INSERT INTO sessions
      (id, token_hash, account_id, workspace_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(session.id, session.tokenHash, session.accountId, session.workspaceId,
      "2026-08-13T00:00:00.000Z", session.expiresAt);
  return session;
}

function fixture(): { readonly db: Db; readonly session: SessionInfo } {
  const db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  seedEvaluatorSpeakerTaskFixtures(db);
  return { db, session: organizerSession(db) };
}

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ReturnerLensError ? error.code : null;
  }
}

describe("Returner Lens", () => {
  it("renders persisted structured guidance as historical evidence only", () => {
    const memory: InstitutionalMemoryResult = {
      schema: "pd01-institutional-memory/v1",
      workspaceId: EVALUATOR_WORKSPACE_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      lineageId: "lineage-guidance",
      eventId: null,
      authorityCarryover: false,
      unavailableFamilies: [],
      sources: [{
        family: "lineage",
        eventId: EVALUATOR_EVENT_ID,
        ids: { requestId: "guidance-request", sourceSubmissionId: "submission-guidance", sourceSubmissionRevisionId: "revision-guidance" },
        fingerprint: "a".repeat(64),
        fingerprintOrigin: "stored",
        recordedAt: "2026-08-12T10:00:00.000Z",
        currentUse: "historical",
        authority: "evidence-only",
        carriesAuthorityForward: false,
        data: {
          guidanceVersion: "guidance-v2",
          guidance: { focus: "Clarify the evidence boundary", avoid: "Do not carry forward acceptance" },
          targetCallId: "call-next",
          expiresAt: null,
        },
      }],
    };
    const projected = projectInstitutionalMemoryForReturnerLens(memory);
    expect(projected).toEqual([expect.objectContaining({
      family: "prior-guidance",
      truthLayer: "evidence",
      title: "Prior proposal guidance · guidance-v2",
      carriesAuthorityForward: false,
    })]);
    expect(projected[0]?.detail).toContain("Clarify the evidence boundary");
    expect(projected[0]?.detail).toContain("Do not carry forward acceptance");
  });

  it("projects real canonical history without writes or authority carryover", () => {
    const { db, session } = fixture();
    try {
      db.prepare(`INSERT INTO events
          (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
        VALUES (?, ?, 'Unrelated empty event', 'UTC', ?, ?, 'planning', ?)`)
        .run(deterministicUuid("returner-lens:empty-event"), EVALUATOR_WORKSPACE_ID,
          "2027-05-10T09:00:00.000Z", "2027-05-10T17:00:00.000Z", "2026-08-13T09:00:00.000Z");
      const before = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      const result = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const after = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;

      expect(after).toBe(before);
      expect(result.readOnly).toBe(true);
      expect(result.authorityCarryover).toBe(false);
      expect(result.currentAuthorization).toMatchObject({ state: "NOT_EVALUATED", carriesFromHistory: false });
      expect(result.selectedPerson?.id).toBe(EVALUATOR_SPEAKER_PERSON_ID);
      const entries = [...result.eventHistory.flatMap((history) => history.entries), ...result.workspaceEvidence];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((item) => item.carriesAuthorityForward === false)).toBe(true);
      expect(entries.some((item) => item.family === "application")).toBe(true);
      expect(entries.some((item) => item.family === "candidate-assignment" && item.truthLayer === "candidate")).toBe(true);
      expect(entries.some((item) => item.family === "plan-decision" && item.truthLayer === "decision")).toBe(true);
      expect(entries.some((item) => item.family === "commitment" && item.truthLayer === "commitment")).toBe(true);
      expect(entries.some((item) => item.family === "session-role")).toBe(true);
      expect(entries.some((item) => item.family === "readiness-task")).toBe(true);
      expect(entries.some((item) => item.family === "editorial-version")).toBe(true);
      expect(entries.some((item) => item.family === "editorial-review" && item.title.includes("approval"))).toBe(true);
      expect(result.coverage.find((item) => item.key === "attendee-feedback")?.state).toBe("UNAVAILABLE");
      expect(result.coverage.find((item) => item.key === "reliability")?.state).toBe("UNAVAILABLE");
      expect(result.coverage.find((item) => item.key === "current-authorization")?.state).toBe("NOT_EVALUATED");

      const html = renderToStaticMarkup(createElement(ReturnerLens, { result }));
      expect(html).toContain("Returner Lens");
      expect(html).toContain("Nothing is carried forward");
      expect(html).toContain("Attendee feedback");
      expect(html).toContain("Speaker reliability");
      expect(html).toContain("No event-linked evidence for this person");
      expect(html).not.toContain("Reliability score");
      expect(html).not.toContain("type=\"email\"");
    } finally {
      closeDb(db);
    }
  });

  it("projects the default draft applicant as candidate evidence without a CFP decision read", () => {
    const { db, session } = fixture();
    try {
      const result = queryReturnerLens(db, session, { workspaceSlug: EVALUATOR_WORKSPACE_SLUG });
      expect(result.selectedPerson?.id).toBe(EVALUATOR_DRAFT_PERSON_ID);
      const entries = result.eventHistory.flatMap((history) => history.entries);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: "application",
          truthLayer: "candidate",
          title: "Draft application · revision 1",
          detail: expect.stringContaining("No organizer decision is recorded"),
          currentUse: "current-record",
        }),
      ]));
      expect(result.counts.decisions).toBe(0);
      expect(result.coverage.find((item) => item.key === "decisions")).toMatchObject({ state: "EMPTY" });
      expect(renderToStaticMarkup(createElement(ReturnerLens, { result }))).toContain("Draft application · revision 1");
    } finally {
      closeDb(db);
    }
  });

  it.each(["WITHDRAWN", "INVALIDATED"] as const)(
    "projects a current %s CFP revision as terminal candidate evidence without a submitted-only decision read",
    (state) => {
      const { db, session } = fixture();
      try {
        const submission = db.prepare(`SELECT submission.id, revision.id AS revisionId,
            revision.revision_number AS revisionNumber
          FROM submissions submission
          JOIN submission_revisions revision
            ON revision.workspace_id = submission.workspace_id
            AND revision.id = submission.current_revision_id
            AND revision.submission_id = submission.id
          WHERE submission.workspace_id = ? AND submission.owner_person_id = ?`)
          .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_DRAFT_PERSON_ID) as {
            id: string;
            revisionId: string;
            revisionNumber: number;
          };
        db.prepare("UPDATE submissions SET state = ? WHERE workspace_id = ? AND id = ?")
          .run(state, EVALUATOR_WORKSPACE_ID, submission.id);

        const result = queryReturnerLens(db, session, {
          workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
          personId: EVALUATOR_DRAFT_PERSON_ID,
        });
        const entries = result.eventHistory.flatMap((history) => history.entries);
        const application = entries.find((item) => item.family === "application" && item.references.some((reference) =>
          reference.label === "submissionRevisionId" && reference.value === submission.revisionId));
        const stateLabel = state === "WITHDRAWN" ? "Withdrawn" : "Invalidated";
        expect(application).toMatchObject({
          truthLayer: "candidate",
          title: `${stateLabel} application · revision ${submission.revisionNumber}`,
          currentUse: "current-record",
          carriesAuthorityForward: false,
        });
        expect(application?.detail).toContain(`Current stored ${state} submission revision`);
        expect(application?.detail).toContain("no organizer decision, commitment, or current authorization is inferred");
        expect(entries.some((item) => item.family === "proposal-decision")).toBe(false);
        expect(result.currentAuthorization).toMatchObject({ state: "NOT_EVALUATED", carriesFromHistory: false });
      } finally {
        closeDb(db);
      }
    },
  );

  it("renders event timestamps in persisted event time with an explicit invalid-timezone fallback", () => {
    const { db, session } = fixture();
    try {
      db.prepare("UPDATE events SET timezone = ? WHERE id = ?").run("America/Los_Angeles", EVALUATOR_EVENT_ID);
      const eventLocal = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const event = eventLocal.eventHistory.find((history) => history.event.id === EVALUATOR_EVENT_ID)?.event;
      expect(event).toBeDefined();
      const localLabel = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Los_Angeles",
      }).format(new Date(event!.startsAt));
      const localHtml = renderToStaticMarkup(createElement(ReturnerLens, { result: eventLocal }));
      expect(localHtml).toContain(localLabel);
      expect(localHtml).toContain(" · America/Los_Angeles");
      const localDueLabel = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Los_Angeles",
      }).format(new Date("2026-09-10T17:00:00.000Z"));
      expect(localHtml).toContain(localDueLabel);
      expect(localHtml).toContain("due time is shown below in the event timezone");

      db.prepare("UPDATE events SET timezone = ? WHERE id = ?").run("Not/AZone", EVALUATOR_EVENT_ID);
      const invalidTimezone = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const fallbackHtml = renderToStaticMarkup(createElement(ReturnerLens, { result: invalidTimezone }));
      const utcLabel = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(event!.startsAt));
      expect(fallbackHtml).toContain(utcLabel);
      expect(fallbackHtml).toContain(" · UTC");
      expect(fallbackHtml).toContain("Event timezone unavailable; shown in UTC.");
      const utcDueLabel = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-09-10T17:00:00.000Z"));
      expect(fallbackHtml).toContain(utcDueLabel);

      db.prepare("UPDATE events SET timezone = '' WHERE id = ?").run(EVALUATOR_EVENT_ID);
      const missingTimezone = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const missingHtml = renderToStaticMarkup(createElement(ReturnerLens, { result: missingTimezone }));
      expect(missingHtml).toContain(" · UTC");
      expect(missingHtml).toContain("Event timezone unavailable; shown in UTC.");
    } finally {
      closeDb(db);
    }
  });

  it("keeps candidate-only evidence out of the session-role count", () => {
    const { db, session } = fixture();
    try {
      const candidatePersonId = deterministicUuid("returner-lens:candidate-only-person");
      const assignmentId = deterministicUuid("returner-lens:candidate-only-assignment");
      const plan = db.prepare(`SELECT plan.id AS planVersionId, unit.id AS programUnitId
        FROM plan_versions plan JOIN program_units unit
          ON unit.workspace_id = plan.workspace_id AND unit.event_id = plan.event_id
        WHERE plan.workspace_id = ? AND plan.event_id = ?
        ORDER BY plan.created_at, plan.id LIMIT 1`).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
          planVersionId: string;
          programUnitId: string;
        };
      db.prepare(`INSERT INTO people
          (id, workspace_id, canonical_email, full_name, organization, title, created_at)
        VALUES (?, ?, ?, 'Candidate Only Person', 'Synthetic Candidate Org', 'Proposalist', ?)`).run(
        candidatePersonId,
        EVALUATOR_WORKSPACE_ID,
        "candidate-only@synthetic.example",
        "2026-08-13T11:00:00.000Z",
      );
      db.prepare(`INSERT INTO plan_assignments
          (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation, is_pinned)
        VALUES (?, ?, ?, ?, ?, 'SPEAKER', 'Candidate-only regression assignment', 0)`).run(
        assignmentId,
        EVALUATOR_WORKSPACE_ID,
        plan.planVersionId,
        candidatePersonId,
        plan.programUnitId,
      );

      const result = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: candidatePersonId,
      });
      const entries = result.eventHistory.flatMap((history) => history.entries);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: "candidate-assignment", truthLayer: "candidate" }),
      ]));
      expect(entries.some((item) => item.family === "session-role")).toBe(false);
      expect(result.counts.sessionRoles).toBe(0);
      expect(result.coverage.find((item) => item.key === "session-roles")).toMatchObject({ state: "EMPTY" });
    } finally {
      closeDb(db);
    }
  });

  it("keeps one canonical person linked to distinct histories across two events", () => {
    const { db, session } = fixture();
    try {
      const secondEventId = deterministicUuid("returner-lens:second-event");
      db.prepare(`INSERT INTO events
          (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
        VALUES (?, ?, 'Returner Forum', 'UTC', ?, ?, 'planning', ?)`)
        .run(secondEventId, EVALUATOR_WORKSPACE_ID, "2027-02-10T09:00:00.000Z",
          "2027-02-10T17:00:00.000Z", "2026-08-13T10:00:00.000Z");
      db.prepare(`INSERT INTO event_speakers
          (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'MODERATOR', 'INVITED', ?, ?)`)
        .run(deterministicUuid("returner-lens:second-role"), EVALUATOR_WORKSPACE_ID,
          secondEventId, EVALUATOR_SPEAKER_PERSON_ID,
          "2026-08-13T10:01:00.000Z", "2026-08-13T10:01:00.000Z");

      const result = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      expect(result.selectedPerson?.returnerState).toBe("MULTI_EVENT");
      expect(result.selectedPerson?.eventCount).toBe(2);
      expect(result.counts.eventsWithEvidence).toBe(2);
      expect(result.eventHistory.find((history) => history.event.id === EVALUATOR_EVENT_ID)?.entries.length).toBeGreaterThan(1);
      expect(result.eventHistory.find((history) => history.event.id === secondEventId)?.entries)
        .toEqual(expect.arrayContaining([expect.objectContaining({ family: "session-role", carriesAuthorityForward: false })]));
      const invitedRole = result.eventHistory.find((history) => history.event.id === secondEventId)?.entries.find((item) => item.family === "session-role");
      expect(invitedRole).toMatchObject({ truthLayer: "commitment", title: "Moderator relationship · Invited" });
      expect(invitedRole?.detail).toContain("does not prove session attendance, role fulfillment");
    } finally {
      closeDb(db);
    }
  });

  it("keeps operational truth exclusive to observations while preserving readiness task states", () => {
    const { db, session } = fixture();
    try {
      const programUnit = db.prepare(`SELECT id FROM program_units
        WHERE workspace_id = ? AND event_id = ? ORDER BY id LIMIT 1`).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { id: string };
      const observationId = deterministicUuid("returner-lens:observed-attendance");
      db.prepare(`INSERT INTO observations
          (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
           observed_at, source, idempotency_key, corrected_by, recorded_at)
        VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'returner-lens-test', ?, NULL, ?)`).run(
        observationId,
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        EVALUATOR_SPEAKER_PERSON_ID,
        programUnit.id,
        "2026-09-18T10:00:00.000Z",
        "returner-lens-observed-attendance",
        "2026-09-18T10:01:00.000Z",
      );

      const result = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const entries = result.eventHistory.flatMap((history) => history.entries);
      const role = entries.find((item) => item.family === "session-role");
      const observation = entries.find((item) => item.family === "operational-observation");
      expect(role).toMatchObject({ truthLayer: "commitment" });
      expect(role?.detail).toContain("does not prove session attendance, role fulfillment");
      expect(observation).toMatchObject({
        family: "operational-observation",
        truthLayer: "operational",
      });
      expect(observation?.title).toContain("Operational observation");
      const operationalEntries = entries.filter((item) => item.truthLayer === "operational");
      expect(operationalEntries).toHaveLength(1);
      expect(operationalEntries.every((item) => item.family === "operational-observation")).toBe(true);
      const readinessTasks = entries.filter((item) => item.family === "readiness-task");
      expect(readinessTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: "readiness-task", truthLayer: "evidence", title: "Headshot PNG · Not started" }),
        expect.objectContaining({ family: "readiness-task", truthLayer: "evidence", title: "Slides or supporting PDF · Not started" }),
      ]));
      expect(result.counts.sessionRoles).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("projects exact immutable artifact versions and authority receipts without loading bytes", () => {
    const { db, session } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "sympose-returner-lens-artifacts-"));
    const priorProfile = process.env.SYMPOSE_EVALUATOR_PROFILE;
    try {
      process.env.SYMPOSE_EVALUATOR_PROFILE = "local";
      seedEvaluatorArtifactFixtures(db, {
        store: new LocalArtifactStore({ rootDir: directory, clock: () => "2026-08-13T10:00:00.000Z" }),
      });
      const before = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      const result = queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: EVALUATOR_SPEAKER_PERSON_ID,
      });
      const after = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      const entries = result.eventHistory.flatMap((history) => history.entries);
      expect(after).toBe(before);
      expect(entries.filter((item) => item.family === "artifact")).toHaveLength(2);
      expect(entries.filter((item) => item.family === "editorial-version" && item.title.includes("artifact version"))).toHaveLength(2);
      expect(entries.filter((item) => item.family === "artifact").every((item) =>
        item.references.some((reference) => reference.label === "authorityEventId") &&
        item.carriesAuthorityForward === false)).toBe(true);
    } finally {
      if (priorProfile === undefined) delete process.env.SYMPOSE_EVALUATOR_PROFILE;
      else process.env.SYMPOSE_EVALUATOR_PROFILE = priorProfile;
      closeDb(db);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a truthful empty state when a workspace has no canonical people", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedWorkspaces(db);
      const workspace = db.prepare("SELECT id, name FROM workspaces WHERE slug = 'northstar'").get() as { id: string; name: string };
      const account = db.prepare("SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1")
        .get(workspace.id) as { id: string; email: string; display_name: string; role: string };
      const session: SessionInfo = {
        id: "empty-returner-session", tokenHash: "empty-returner-token", accountId: account.id,
        workspaceId: workspace.id, expiresAt: "2099-01-01T00:00:00.000Z", email: account.email,
        displayName: account.display_name, role: account.role, workspaceSlug: "northstar", workspaceName: workspace.name,
      };
      db.prepare("INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(session.id, session.tokenHash, session.accountId, session.workspaceId, "2026-08-13T00:00:00.000Z", session.expiresAt);

      const result = queryReturnerLens(db, session, { workspaceSlug: "northstar" });
      expect(result.people).toEqual([]);
      expect(result.selectedPerson).toBeNull();
      expect(result.counts.historicalRecords).toBe(0);
      expect(result.currentAuthorization.state).toBe("NOT_EVALUATED");
      expect(renderToStaticMarkup(createElement(ReturnerLens, { result }))).toContain("No canonical person is available");
    } finally {
      closeDb(db);
    }
  });

  it("denies cross-workspace, foreign-person, and revoked-session reads without denial writes", () => {
    const { db, session } = fixture();
    try {
      const foreignPerson = db.prepare(`SELECT person.id
        FROM people person WHERE person.workspace_id <> ? LIMIT 1`).get(EVALUATOR_WORKSPACE_ID) as { id: string } | undefined;
      const before = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      expect(errorCode(() => queryReturnerLens(db, session, { workspaceSlug: "devflow" }))).toBe("AUTHORIZATION_DENIED");
      expect(errorCode(() => queryReturnerLens(db, session, {
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        personId: foreignPerson?.id ?? "foreign-person",
      }))).toBe("TARGET_UNAVAILABLE");
      const afterDenied = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      expect(afterDenied).toBe(before);

      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      const afterRevocation = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
      expect(errorCode(() => queryReturnerLens(db, session, { workspaceSlug: EVALUATOR_WORKSPACE_SLUG }))).toBe("AUTHORIZATION_DENIED");
      expect((db.prepare("SELECT total_changes() AS count").get() as { count: number }).count).toBe(afterRevocation);
    } finally {
      closeDb(db);
    }
  });
});
