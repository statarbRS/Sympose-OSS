import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  OrganizerReviewBlindControlError,
  ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE,
  ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION,
  readOrganizerReviewBlindControl,
  setOrganizerReviewBlindControl,
  type OrganizerReviewBlindControlErrorCode,
} from "../../src/server/services/cfp-review/review-blind-control";
import {
  createOrganizerReviewRound,
  readOrganizerReviewSurface,
  type OrganizerReviewSurface,
} from "../../src/server/services/cfp-review/organizer";
import { OrganizerReviewConsole } from "../../src/components/cfp-review/organizer-review-console";
import type { ReviewerBlindProposalProjection } from "../../src/server/services/cfp-review/reviewer-types";

const EVENT_ID = "abs07-blind-event";
const OPEN_AT = "2026-09-01T09:00:00.000Z";
const CLOSE_AT = "2026-09-15T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  session: SessionInfo;
  workspaceId: string;
  eventId: string;
  roundId: string;
}>;

function expectCode(action: () => unknown, code: OrganizerReviewBlindControlErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OrganizerReviewBlindControlError);
  expect((thrown as OrganizerReviewBlindControlError).code).toBe(code);
}

function setup(): Fixture {
  const db = openDb({ path: ":memory:" });
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string };
  const organizer = db
    .prepare(
      `SELECT id FROM accounts
       WHERE workspace_id = ? AND role = 'organizer'
       ORDER BY id LIMIT 1`,
    )
    .get(workspace.id) as { id: string };
  const session = createSession(db, organizer.id, workspace.id).session;

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'planning', ?)`,
  ).run(
    EVENT_ID,
    workspace.id,
    "ABS-07 blind review event",
    "America/New_York",
    OPEN_AT,
    CLOSE_AT,
    "2026-08-01T00:00:00.000Z",
  );

  const context = { workspaceId: workspace.id, accountId: organizer.id };
  const definition = createFormDefinition(db, context, { name: "ABS-07 form" });
  const form = sealFormVersion(db, context, {
    formDefinitionId: definition.id,
    fields: [
      {
        id: "proposal",
        type: "longText",
        label: "Proposal",
        required: true,
        defaultVisibility: "visible",
      },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, context, {
    eventId: EVENT_ID,
    name: "ABS-07 call",
    slug: "abs-07-call",
    formVersionId: form.id,
    state: "OPEN",
    timezone: "America/New_York",
    opensAt: OPEN_AT,
    closesAt: CLOSE_AT,
    policy: {
      disclosure: {
        privacy: "synthetic",
        retention: "synthetic",
        aiProcessing: "synthetic",
        communication: "synthetic",
        consent: "synthetic",
        publication: "synthetic",
      },
      choices: [],
    },
  });
  const round = createOrganizerReviewRound(db, session, {
    workspaceSlug: "northstar",
    eventId: EVENT_ID,
    callId: call.id,
    name: "ABS-07 first pass",
    idempotencyKey: "abs07-round",
  });

  return Object.freeze({
    db,
    session,
    workspaceId: workspace.id,
    eventId: EVENT_ID,
    roundId: round.roundId,
  });
}

function read(fixture: Fixture) {
  return readOrganizerReviewBlindControl(fixture.db, fixture.session, {
    workspaceSlug: "northstar",
    eventId: fixture.eventId,
    roundId: fixture.roundId,
  });
}

function set(fixture: Fixture, idempotencyKey = "abs07-blind-setting-v1") {
  return setOrganizerReviewBlindControl(fixture.db, fixture.session, {
    workspaceSlug: "northstar",
    eventId: fixture.eventId,
    roundId: fixture.roundId,
    enabled: true,
    idempotencyKey,
  });
}

describe("ABS-07 per-round blind-review control", () => {
  it("defaults blinded, records one immutable idempotent event, and reloads it", () => {
    const fixture = setup();
    try {
      expect(read(fixture)).toMatchObject({
        enabled: true,
        source: "DEFAULT_FAIL_CLOSED",
        organizerSeesIdentity: true,
        reviewerSeesIdentity: false,
        anonymizedFields: ["author", "coauthor", "organization"],
        disableSupported: false,
      });

      const first = set(fixture);
      const replay = set(fixture);
      expect(first).toMatchObject({
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        enabled: true,
        replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(
        fixture.db
          .prepare(
            `SELECT COUNT(*) AS count FROM domain_events
             WHERE workspace_id = ? AND event_type = ? AND aggregate_id = ?`,
          )
          .get(fixture.workspaceId, ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE, fixture.roundId),
      ).toEqual({ count: 1 });
      expect(
        fixture.db
          .prepare(
            `SELECT workspace_id, actor_kind, actor_ref, action, target_type, target_id
             FROM audit_events
             WHERE action = 'cfp.review.round.blind-control.enabled' AND target_id = ?`,
          )
          .get(fixture.roundId),
      ).toMatchObject({
        workspace_id: fixture.workspaceId,
        actor_kind: "account",
        actor_ref: fixture.session.accountId,
        action: "cfp.review.round.blind-control.enabled",
        target_type: "review_round",
        target_id: fixture.roundId,
      });

      const reloaded = read(fixture);
      expect(reloaded).toMatchObject({
        source: "IMMUTABLE_EVENT",
        settingEventId: first.settingEventId,
        recordedAt: first.recordedAt,
        explanation: ORGANIZER_REVIEW_BLIND_CONTROL_EXPLANATION,
      });
      expect(
        readOrganizerReviewSurface(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
        }).rounds[0]?.blindReview,
      ).toEqual(reloaded);

      expect(() =>
        fixture.db
          .prepare("UPDATE domain_events SET payload_json = ? WHERE id = ?")
          .run("{}", first.settingEventId),
      ).toThrow(/immutable evidence/u);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("enforces workspace and organizer role boundaries for reads and writes", () => {
    const fixture = setup();
    try {
      expectCode(
        () => readOrganizerReviewBlindControl(fixture.db, fixture.session, {
          workspaceSlug: "acme",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
        }),
        "ACCESS_DENIED",
      );

      const acmeWorkspace = fixture.db
        .prepare("SELECT id FROM workspaces WHERE slug = 'acme'")
        .get() as { id: string };
      const acmeOrganizer = fixture.db
        .prepare(
          `SELECT id FROM accounts
           WHERE workspace_id = ? AND role = 'organizer'
           ORDER BY id LIMIT 1`,
        )
        .get(acmeWorkspace.id) as { id: string };
      const acmeSession = createSession(
        fixture.db,
        acmeOrganizer.id,
        acmeWorkspace.id,
      ).session;
      expectCode(
        () => readOrganizerReviewBlindControl(fixture.db, acmeSession, {
          workspaceSlug: "acme",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
        }),
        "ROUND_NOT_AVAILABLE",
      );
      expectCode(
        () => setOrganizerReviewBlindControl(fixture.db, acmeSession, {
          workspaceSlug: "acme",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          enabled: true,
        }),
        "ROUND_NOT_AVAILABLE",
      );

      fixture.db
        .prepare(
          `INSERT INTO accounts
             (id, workspace_id, email, display_name, role, created_at)
           VALUES ('abs07-reviewer', ?, ?, ?, 'reviewer', ?)`,
        )
        .run(
          fixture.workspaceId,
          "abs07-reviewer@synthetic.example",
          "ABS-07 reviewer",
          "2026-08-01T00:00:00.000Z",
        );
      const reviewerSession = createSession(
        fixture.db,
        "abs07-reviewer",
        fixture.workspaceId,
      ).session;
      expectCode(
        () => readOrganizerReviewBlindControl(fixture.db, reviewerSession, {
          workspaceSlug: "northstar",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
        }),
        "ACCESS_DENIED",
      );
      expectCode(
        () => setOrganizerReviewBlindControl(fixture.db, reviewerSession, {
          workspaceSlug: "northstar",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          enabled: true,
        }),
        "ACCESS_DENIED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });

  it("ignores a malformed setting event and fails closed without identity", () => {
    const fixture = setup();
    try {
      const changedAt = "2026-08-12T00:00:00.000Z";
      const malformedPayload = {
        schema: "cfp-review-round-blind-control/v1",
        version: 1,
        workspaceId: fixture.workspaceId,
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        mode: "UNBLINDED",
        enabled: false,
        authorVisibility: "PUBLIC",
        reviewerVisibility: "VISIBLE",
        disableSupported: true,
        changedAt,
        idempotencyKey: "abs07-malformed",
      } as const;
      fixture.db
        .prepare(
          `INSERT INTO domain_events
             (id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at)
           VALUES (?, ?, ?, 'review_round', ?, ?, ?, ?)`,
        )
        .run(
          "abs07-malformed-setting",
          fixture.workspaceId,
          ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE,
          fixture.roundId,
          canonicalJson(malformedPayload),
          fingerprintOf(malformedPayload),
          changedAt,
        );

      const control = read(fixture);
      expect(control).toMatchObject({
        enabled: true,
        source: "DEFAULT_FAIL_CLOSED",
        malformedEvent: true,
        organizerSeesIdentity: true,
        reviewerSeesIdentity: false,
        disableSupported: false,
      });
      expect(JSON.stringify(control)).not.toContain("UNBLINDED");
      expect(read(fixture)).toEqual(control);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("keeps enabled as the only supported production state", () => {
    const fixture = setup();
    try {
      expectCode(
        () => setOrganizerReviewBlindControl(fixture.db, fixture.session, {
          workspaceSlug: "northstar",
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          enabled: false as never,
          idempotencyKey: "abs07-disable-attempt",
        }),
        "INPUT_INVALID",
      );
      expect(read(fixture)).toMatchObject({ enabled: true, disableSupported: false });
      expect(
        fixture.db
          .prepare(
            `SELECT COUNT(*) AS count FROM domain_events
             WHERE workspace_id = ? AND event_type = ? AND aggregate_id = ?`,
          )
          .get(fixture.workspaceId, ORGANIZER_REVIEW_BLIND_CONTROL_EVENT_TYPE, fixture.roundId),
      ).toEqual({ count: 0 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("keeps organizer identity visible while the reviewer contract remains blind", () => {
    const fixture = setup();
    try {
      set(fixture);
      const surface = readOrganizerReviewSurface(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        roundId: fixture.roundId,
      });
      const round = surface.rounds[0]!;
      const organizerSurface: OrganizerReviewSurface = {
        ...surface,
        rounds: [
          {
            ...round,
            rankings: [
              {
                submissionId: "abs07-submission",
                submissionRevisionId: "abs07-submission-revision",
                applicant: {
                  personId: "abs07-person",
                  displayName: "Ari Applicant",
                  organization: "Field Notes",
                },
                assignedReviewCount: 1,
                submittedReviewCount: 0,
                eligibleReviewCount: 1,
                completionPercent: 0,
                conflictCount: 0,
                blindPendingCount: 1,
                score: null,
                scoreBasis: "no-submitted-evidence",
                recommendationCounts: { advance: 0, hold: 0, doNotAdvance: 0 },
                evidenceRank: null,
              },
            ],
          },
        ],
      };
      const html = renderToStaticMarkup(createElement(OrganizerReviewConsole, {
        workspace: "northstar",
        surface: organizerSurface,
      }));
      const reviewerProjection: ReviewerBlindProposalProjection = {
        revisionSequence: 1,
        disclosureStage: "BLIND_REVIEW",
        answers: [
          {
            answerKey: "proposal",
            label: "Proposal",
            type: "longText",
            value: "A proposal without identity fields",
          },
        ],
      };

      expect(html).toContain("Blind review / anonymize authors");
      expect(html).toContain("Ari Applicant");
      expect(html).toContain("Field Notes");
      expect(html).toContain("Organizer projection");
      expect(html).toContain("Reviewer projection");
      expect(JSON.stringify(reviewerProjection)).not.toContain("Ari Applicant");
      expect(JSON.stringify(reviewerProjection)).not.toContain("Field Notes");
      expect(round.blindReview).toMatchObject({
        organizerSeesIdentity: true,
        reviewerSeesIdentity: false,
        anonymizedFields: ["author", "coauthor", "organization"],
      });
    } finally {
      closeDb(fixture.db);
    }
  });
});
