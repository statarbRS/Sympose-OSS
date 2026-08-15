import { describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  OrganizerReviewServiceError,
  createOrganizerReviewRound,
  organizerReviewRoundFingerprint,
  organizerReviewScheduleSummary,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundSchedule,
} from "../../src/server/services/cfp-review/organizer";

const EVENT_ID = "organizer-console-event";
const CALL_ID = "organizer-console-call";
const OPEN_AT = "2026-09-01T09:00:00.000Z";
const CLOSE_AT = "2026-09-15T09:00:00.000Z";
const ROUND_ONE_OPEN = "2026-09-02T09:00:00.000Z";
const ROUND_ONE_CLOSE = "2026-09-08T09:00:00.000Z";
const ROUND_TWO_OPEN = "2026-09-09T09:00:00.000Z";
const ROUND_TWO_CLOSE = "2026-09-14T09:00:00.000Z";

type Fixture = Readonly<{
  db: Db;
  session: SessionInfo;
  workspaceId: string;
  eventId: string;
  callId: string;
}>;

function expectCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OrganizerReviewServiceError);
  expect((thrown as OrganizerReviewServiceError).code).toBe(code);
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
    "Organizer review event",
    "America/New_York",
    OPEN_AT,
    CLOSE_AT,
    "2026-08-01T00:00:00.000Z",
  );

  const context = { workspaceId: workspace.id, accountId: organizer.id };
  const definition = createFormDefinition(db, context, {
    name: "Organizer review form",
  });
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
    name: "Organizer review call",
    slug: "organizer-review-call",
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

  expect(call.id).toBeTruthy();
  return Object.freeze({
    db,
    session,
    workspaceId: workspace.id,
    eventId: EVENT_ID,
    callId: call.id,
  });
}

describe("organizer review round configuration and query", () => {
  it("creates an idempotent draft round and projects call-owned dates", () => {
    const fixture = setup();
    try {
      const input = {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        callId: fixture.callId,
        name: "Initial screening",
        idempotencyKey: "initial-screening",
      } as const;
      const first = createOrganizerReviewRound(fixture.db, fixture.session, input);
      const replay = createOrganizerReviewRound(fixture.db, fixture.session, input);

      expect(first).toMatchObject({
        eventId: fixture.eventId,
        callId: fixture.callId,
        state: "DRAFT",
        stateSequenceNumber: 1,
        scheduleSource: "call",
        timezone: "America/New_York",
        opensAt: OPEN_AT,
        closesAt: CLOSE_AT,
        replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expectCode(
        () => createOrganizerReviewRound(fixture.db, fixture.session, {
          ...input,
          name: "Changed request",
        }),
        "ROUND_CREATE_IDEMPOTENCY_CONFLICT",
      );
      expectCode(
        () => createOrganizerReviewRound(fixture.db, fixture.session, {
          ...input,
          idempotencyKey: "another-key-for-the-same-round",
        }),
        "ROUND_CREATE_IDEMPOTENCY_CONFLICT",
      );
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM review_round_creation_receipts").get()).toEqual({ count: 1 });
      expect(
        fixture.db
          .prepare("SELECT COUNT(*) AS count FROM review_rounds WHERE workspace_id = ?")
          .get(fixture.workspaceId),
      ).toEqual({ count: 1 });

      const surface = readOrganizerReviewSurface(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        roundId: first.roundId,
        sort: "progress",
      });
      expect(surface.calls).toHaveLength(1);
      expect(surface.rounds).toHaveLength(1);
      expect(surface).toMatchObject({
        workspaceId: fixture.workspaceId,
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        selectedRoundId: first.roundId,
        selectedSort: "progress",
      });
      const round = surface.rounds[0]!;
      expect(round).toMatchObject({
        id: first.roundId,
        name: "Initial screening",
        state: "DRAFT",
        stateSequenceNumber: 1,
        schedule: {
          source: "call",
          timezone: "America/New_York",
          opensAt: OPEN_AT,
          closesAt: CLOSE_AT,
        },
        progress: {
          total: 0,
          submitted: 0,
          completionPercent: 0,
          blindPending: 0,
        },
      });
      expect(organizerReviewScheduleSummary(round)).toBe(
        JSON.stringify({
          closesAt: CLOSE_AT,
          opensAt: OPEN_AT,
          source: "call",
          timezone: "America/New_York",
        }),
      );
      expect(organizerReviewRoundFingerprint(round)).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects a caller-supplied schedule that disagrees with the call boundary", () => {
    const fixture = setup();
    try {
      expectCode(
        () =>
          createOrganizerReviewRound(fixture.db, fixture.session, {
            workspaceSlug: "northstar",
            eventId: fixture.eventId,
            callId: fixture.callId,
            name: "Mismatched dates",
            opensAt: "2026-09-02T09:00:00.000Z",
            closesAt: CLOSE_AT,
          }),
        "ROUND_SCHEDULE_MISMATCH",
      );
      expect(
        fixture.db
          .prepare("SELECT COUNT(*) AS count FROM review_rounds WHERE workspace_id = ?")
          .get(fixture.workspaceId),
      ).toEqual({ count: 0 });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("versions schedule edits idempotently and rejects stale or cross-event writes", () => {
    const fixture = setup();
    try {
      const createInput = {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        callId: fixture.callId,
        name: "Versioned dates",
        opensAt: ROUND_ONE_OPEN,
        closesAt: ROUND_ONE_CLOSE,
        idempotencyKey: "versioned-dates-create",
      } as const;
      const round = createOrganizerReviewRound(fixture.db, fixture.session, createInput);
      fixture.db.prepare(
        "UPDATE calls SET timezone = 'Europe/Paris', opens_at = NULL, closes_at = NULL WHERE id = ?",
      ).run(fixture.callId);
      const input = {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        roundId: round.roundId,
        expectedScheduleVersion: round.scheduleVersion,
        opensAt: "2026-09-03T09:00:00.000Z",
        closesAt: "2026-09-10T09:00:00.000Z",
        idempotencyKey: "schedule-edit-one",
      } as const;
      const updated = setOrganizerReviewRoundSchedule(fixture.db, fixture.session, input);
      expect(updated).toMatchObject({ scheduleVersion: 3, replayed: false });
      expect(setOrganizerReviewRoundSchedule(fixture.db, fixture.session, input)).toEqual({
        ...updated,
        replayed: true,
      });
      expect(createOrganizerReviewRound(fixture.db, fixture.session, createInput)).toEqual({
        ...round,
        replayed: true,
      });
      expectCode(
        () => setOrganizerReviewRoundSchedule(fixture.db, fixture.session, {
          ...input,
          idempotencyKey: "schedule-edit-stale",
          closesAt: "2026-09-11T09:00:00.000Z",
        }),
        "ROUND_SCHEDULE_STALE",
      );
      expectCode(
        () => setOrganizerReviewRoundSchedule(fixture.db, fixture.session, {
          ...input,
          closesAt: "2026-09-11T09:00:00.000Z",
        }),
        "ROUND_SCHEDULE_IDEMPOTENCY_CONFLICT",
      );
      fixture.db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES ('another-event', ?, 'Another event', 'UTC', ?, ?, 'planning', ?)`,
      ).run(
        fixture.workspaceId,
        "2026-10-01T00:00:00.000Z",
        "2026-10-31T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      expectCode(
        () => setOrganizerReviewRoundSchedule(fixture.db, fixture.session, {
          ...input,
          eventId: "another-event",
          idempotencyKey: "wrong-event",
        }),
        "ROUND_NOT_AVAILABLE",
      );
      expect(
        fixture.db.prepare(
          "SELECT COUNT(*) AS count FROM review_round_schedule_versions WHERE round_id = ?",
        ).get(round.roundId),
      ).toEqual({ count: 3 });
      const projection = readOrganizerReviewSurface(fixture.db, fixture.session, {
        workspaceSlug: "northstar",
        eventId: fixture.eventId,
        roundId: round.roundId,
      }).rounds[0]!;
      expect(projection.schedule).toMatchObject({
        version: 3,
        timezone: "America/New_York",
        opensAt: updated.opensAt,
        closesAt: updated.closesAt,
      });
      expect(
        fixture.db.prepare("SELECT id, name FROM review_rounds WHERE id = ?").get(round.roundId),
      ).toEqual({ id: round.roundId, name: "Versioned dates" });
    } finally {
      closeDb(fixture.db);
    }
  });

  it("denies cross-workspace and non-organizer reads before returning event data", () => {
    const fixture = setup();
    try {
      expectCode(
        () =>
          readOrganizerReviewSurface(fixture.db, fixture.session, {
            workspaceSlug: "acme",
            eventId: fixture.eventId,
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
        () =>
          readOrganizerReviewSurface(fixture.db, acmeSession, {
            workspaceSlug: "acme",
            eventId: fixture.eventId,
          }),
        "EVENT_NOT_AVAILABLE",
      );

      fixture.db
        .prepare(
          `INSERT INTO accounts
             (id, workspace_id, email, display_name, role, created_at)
           VALUES ('organizer-console-reviewer', ?, ?, ?, 'reviewer', ?)`,
        )
        .run(
          fixture.workspaceId,
          "organizer-console-reviewer@synthetic.example",
          "Review-only account",
          "2026-08-01T00:00:00.000Z",
        );
      const reviewerSession = createSession(
        fixture.db,
        "organizer-console-reviewer",
        fixture.workspaceId,
      ).session;
      expectCode(
        () =>
          readOrganizerReviewSurface(fixture.db, reviewerSession, {
            workspaceSlug: "northstar",
            eventId: fixture.eventId,
          }),
        "ACCESS_DENIED",
      );
    } finally {
      closeDb(fixture.db);
    }
  });
});
