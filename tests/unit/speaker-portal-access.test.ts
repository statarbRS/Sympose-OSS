import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, deterministicUuid, fingerprintOf, sha256Hex } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  issueSpeakerPortalToken,
  reserveSpeakerPortalRequesterLookup,
  resetSpeakerPortalAccessRateLimitForTest,
  resolveSpeakerPortalToken,
  revokeSpeakerPortalToken,
  speakerPortalLookupBudgetKey,
  speakerPortalLookupBudgetKeyFromHeaders,
  SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY,
  type SpeakerPortalAccessScope,
  type SpeakerPortalTokenActor,
} from "../../src/server/services/speaker-portal-access";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../../src/server/services/evaluator-speaker-identity";
import { createSyntheticSpeakerOperationsRepository, getSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import { DDL } from "../../src/server/schema";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T12:31:00.000Z";
const SCOPE: SpeakerPortalAccessScope = {
  workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
  eventId: EVALUATOR_ARTIFACT_EVENT_ID,
  personId: EVALUATOR_ARTIFACT_PERSON_ID,
};
const DEVFLOW_SCOPE: SpeakerPortalAccessScope = {
  workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
  personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
};

const databases: Db[] = [];
const paths: string[] = [];

function setup(path = ":memory:"): Db {
  const db = openDb({ path, seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  seedEvaluatorSpeakerTaskFixtures(db);
  return db;
}

function organizerActor(db: Db, workspaceId: string): SpeakerPortalTokenActor {
  const row = db.prepare(
    `SELECT session_row.id AS sessionId, account.id AS accountId
       FROM sessions session_row
       JOIN accounts account
         ON account.id = session_row.account_id
        AND account.workspace_id = session_row.workspace_id
      WHERE session_row.workspace_id = ?
        AND account.role = 'organizer'
      ORDER BY session_row.created_at DESC, session_row.rowid DESC
      LIMIT 1`,
  ).get(workspaceId) as { sessionId: string; accountId: string } | undefined;
  if (!row) throw new Error("test organizer session unavailable");
  return { accountId: row.accountId, sessionId: row.sessionId };
}

function issue(
  db: Db,
  scope: SpeakerPortalAccessScope,
  options: { readonly now?: string; readonly ttlMs?: number } = {},
) {
  return issueSpeakerPortalToken(db, scope, organizerActor(db, scope.workspaceId), options);
}

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) closeDb(db);
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  resetSpeakerPortalAccessRateLimitForTest();
  delete process.env.SYMPOSE_REAL_IP_HEADER;
});

describe("durable speaker portal access", () => {
  it("stores only a CSPRNG token hash and resolves the canonical Mina identity after restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const directory = mkdtempSync(join(tmpdir(), "sympose-speaker-portal-"));
    const path = join(directory, "portal.sqlite");
    paths.push(path, directory);
    const db = setup(path);
    const issued = issue(db, SCOPE, { now: NOW });

    expect(issued.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(issued.access).toMatchObject({
      ...SCOPE,
      purpose: "speaker-content",
      expiresAt: "2026-08-12T12:30:00.000Z",
      active: true,
      assignmentId: expect.any(String),
      planVersionId: expect.any(String),
      planVersionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      acceptedTermsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      authorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const stored = db.prepare(
      "SELECT token_hash AS tokenHash, purpose, expires_at AS expiresAt FROM speaker_portal_tokens WHERE person_id = ?",
    ).get(SCOPE.personId) as { tokenHash: string; purpose: string; expiresAt: string };
    expect(stored).toEqual({
      tokenHash: sha256Hex(issued.token),
      purpose: "speaker-content",
      expiresAt: "2026-08-12T12:30:00.000Z",
    });
    expect(stored.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(db.prepare("SELECT * FROM speaker_portal_tokens").all())).not.toContain(issued.token);
    const authorityEvent = db.prepare(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'`,
    ).get(SCOPE.workspaceId) as { id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload_json: string; payload_fingerprint: string };
    const authorityPayload = JSON.parse(authorityEvent.payload_json) as Record<string, unknown>;
    expect(authorityEvent).toMatchObject({
      event_type: "speaker.portal.token.authority.bound",
      aggregate_type: "speaker_portal_token",
      aggregate_id: expect.any(String),
    });
    expect(authorityPayload).toMatchObject({
      schema: "speaker-portal-token-authority/v1",
      operation: "bind-accepted-assignment",
      workspaceId: SCOPE.workspaceId,
      eventId: SCOPE.eventId,
      personId: SCOPE.personId,
      tokenId: authorityEvent.aggregate_id,
      assignmentId: issued.access.assignmentId,
      planVersionId: issued.access.planVersionId,
      planVersionFingerprint: issued.access.planVersionFingerprint,
      acceptedTermsFingerprint: issued.access.acceptedTermsFingerprint,
      authorityFingerprint: issued.access.authorityFingerprint,
    });
    expect(canonicalJson(authorityPayload)).toBe(authorityEvent.payload_json);
    expect(fingerprintOf(authorityPayload)).toBe(authorityEvent.payload_fingerprint);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE domain_event_id = ?").get(authorityEvent.id)).toEqual({ count: 1 });
    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toMatchObject({ ...SCOPE, active: true });

    closeDb(db);
    databases.splice(databases.indexOf(db), 1);
    const restarted = openDb({ path, seed: false });
    databases.push(restarted);
    expect(resolveSpeakerPortalToken(restarted, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toMatchObject({
      ...SCOPE,
      active: true,
    });
    const persistedEvent = restarted.prepare(
      "SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE workspace_id = ? AND id = ?",
    ).get(SCOPE.workspaceId, SCOPE.eventId);
    const persistedAssignment = restarted.prepare(
      "SELECT id FROM plan_assignments WHERE workspace_id = ? AND plan_version_id = (SELECT current_plan_version_id FROM events WHERE workspace_id = ? AND id = ?) AND person_id = ?",
    ).get(SCOPE.workspaceId, SCOPE.workspaceId, SCOPE.eventId, SCOPE.personId) as { id: string };
    const coldRepository = createSyntheticSpeakerOperationsRepository({ db: restarted, clock: () => NOW });
    const portal = coldRepository.getPortalProjection(issued.token, speakerPortalLookupBudgetKey("restart", "page"));
    expect(portal?.event).toEqual(persistedEvent);
    expect(portal?.event.name).toBe("Acme Evaluator Summit");
    expect(portal?.assignment.assignmentId).toBe(persistedAssignment.id);
    expect(portal?.invitation.offeredTerms).toMatchObject({
      eventId: SCOPE.eventId,
      eventName: "Acme Evaluator Summit",
      programUnitName: "Trustworthy Evaluation Keynote",
    });
    expect(JSON.stringify(portal)).not.toContain("Synthetic Speaker Forum");
  });

  it("uses generic behavior for malformed, expired, revoked, and cross-scope access", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });
    const otherScope = { ...SCOPE, eventId: "other-event" };

    expect(resolveSpeakerPortalToken(db, "2099-01-01T00:00:00.000Z", { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    expect(resolveSpeakerPortalToken(db, "not-a-token", { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    expect(resolveSpeakerPortalToken(db, issued.token, { now: LATER, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    expect(revokeSpeakerPortalToken(db, otherScope, issued.token, "wrong scope", "tester", NOW)).toBe(false);
    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toMatchObject({ ...SCOPE, active: true });
    expect(revokeSpeakerPortalToken(db, SCOPE, issued.token, "speaker requested", "tester", NOW)).toBe(true);
    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    expect(revokeSpeakerPortalToken(db, SCOPE, issued.token, "duplicate", "tester", NOW)).toBe(false);
  });

  it("fails closed when the durable speaker acceptance is withdrawn", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });

    db.prepare(
      `UPDATE event_speakers
       SET participation_status = 'DECLINED', updated_at = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run(NOW, SCOPE.workspaceId, SCOPE.eventId, SCOPE.personId);

    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
  });

  it("fails closed when the accepted plan is superseded after token issuance", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });
    const plan = db.prepare(
      `SELECT current_plan_version_id AS planVersionId
         FROM events WHERE workspace_id = ? AND id = ?`,
    ).get(SCOPE.workspaceId, SCOPE.eventId) as { planVersionId: string };
    db.prepare(
      `INSERT INTO plan_states
         (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'superseded', NULL, 'portal authority replacement probe', ?)`,
    ).run(deterministicUuid(`speaker-portal-superseded:${SCOPE.workspaceId}:${SCOPE.eventId}`), SCOPE.workspaceId, plan.planVersionId, NOW);

    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
  });

  it("binds a token to one assignment and rejects an assignment replacement", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });
    const plan = db.prepare(
      `SELECT current_plan_version_id AS planVersionId
         FROM events WHERE workspace_id = ? AND id = ?`,
    ).get(SCOPE.workspaceId, SCOPE.eventId) as { planVersionId: string };
    const original = db.prepare(
      `SELECT assignment_type AS assignmentType, explanation
         FROM plan_assignments
        WHERE workspace_id = ? AND plan_version_id = ? AND person_id = ?`,
    ).get(SCOPE.workspaceId, plan.planVersionId, SCOPE.personId) as { assignmentType: string; explanation: string };
    const replacementUnitId = deterministicUuid(`speaker-portal-replacement-unit:${SCOPE.workspaceId}:${SCOPE.eventId}`);
    const replacementAssignmentId = deterministicUuid(`speaker-portal-replacement-assignment:${SCOPE.workspaceId}:${SCOPE.eventId}:${SCOPE.personId}`);
    db.prepare(
      `INSERT INTO program_units
         (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, ?, 'SESSION', ?, ?, 1, ?)`,
    ).run(replacementUnitId, SCOPE.workspaceId, SCOPE.eventId, "Replacement authority probe", NOW, "2026-08-12T13:00:00.000Z", NOW);
    db.prepare(
      `INSERT INTO plan_assignments
         (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation, is_pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(replacementAssignmentId, SCOPE.workspaceId, plan.planVersionId, SCOPE.personId, replacementUnitId, original.assignmentType, original.explanation);

    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 1 });
  });

  it("fails closed when a divergent immutable authority binding is present", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });
    const original = db.prepare(
      `SELECT id, aggregate_id, payload_json, created_at
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'`,
    ).get(SCOPE.workspaceId) as { id: string; aggregate_id: string; payload_json: string; created_at: string };
    const payload = JSON.parse(original.payload_json) as Record<string, unknown>;
    const tampered = {
      ...payload,
      acceptedTermsFingerprint: "f".repeat(64),
      authorityFingerprint: fingerprintOf({
        schema: "speaker-portal-token-authority/v1",
        workspaceId: SCOPE.workspaceId,
        eventId: SCOPE.eventId,
        personId: SCOPE.personId,
        assignmentId: payload.assignmentId,
        planVersionId: payload.planVersionId,
        planVersionFingerprint: payload.planVersionFingerprint,
        acceptedTermsFingerprint: "f".repeat(64),
      }),
    };
    const tamperedJson = canonicalJson(tampered);
    const tamperedFingerprint = fingerprintOf(tampered);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'speaker.portal.token.authority.bound', 'speaker_portal_token', ?, ?, ?, ?)`,
    ).run(deterministicUuid(`speaker-portal-authority-tampered:${SCOPE.workspaceId}:${original.aggregate_id}`), SCOPE.workspaceId, original.aggregate_id, tamperedJson, tamperedFingerprint, original.created_at);

    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
  });

  it("rolls back the relationship, token, authority event, and outbox on an issuance failure", () => {
    const db = setup();
    const before = {
      speakers: (db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(SCOPE.workspaceId, SCOPE.eventId, SCOPE.personId) as { count: number }).count,
      tokens: (db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get() as { count: number }).count,
      events: (db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'").get(SCOPE.workspaceId) as { count: number }).count,
      outbox: (db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE workspace_id = ? AND destination_key = 'speaker-portal-authority'").get(SCOPE.workspaceId) as { count: number }).count,
    };
    db.exec(`
      CREATE TEMP TRIGGER speaker_portal_issuance_abort
      BEFORE INSERT ON speaker_portal_tokens
      BEGIN SELECT RAISE(ABORT, 'deterministic issuance failure'); END;
    `);

    expect(() => issue(db, SCOPE, { now: NOW })).toThrow(/deterministic issuance failure/u);
    expect((db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(SCOPE.workspaceId, SCOPE.eventId, SCOPE.personId) as { count: number }).count).toBe(before.speakers);
    expect((db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get() as { count: number }).count).toBe(before.tokens);
    expect((db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'").get(SCOPE.workspaceId) as { count: number }).count).toBe(before.events);
    expect((db.prepare("SELECT COUNT(*) AS count FROM outbox_messages WHERE workspace_id = ? AND destination_key = 'speaker-portal-authority'").get(SCOPE.workspaceId) as { count: number }).count).toBe(before.outbox);
  });

  it("rechecks accepted authority after a deterministic supersession interleaving", () => {
    const db = setup();
    // The DevFlow compatibility profile now materializes the accepted speaker link up front so
    // the browser journey and scheduler share one canonical participant. Remove that fixture row
    // for this probe so issuance must exercise the link-creation boundary where the deterministic
    // supersession interleaving is injected.
    db.exec("DROP TRIGGER trg_v12_event_speakers_no_delete");
    try {
      db.prepare(
        `DELETE FROM event_speakers
          WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
      ).run(DEVFLOW_SCOPE.workspaceId, DEVFLOW_SCOPE.eventId, DEVFLOW_SCOPE.personId);
    } finally {
      db.exec(DDL);
    }
    const plan = db.prepare(
      `SELECT current_plan_version_id AS planVersionId
         FROM events WHERE workspace_id = ? AND id = ?`,
    ).get(DEVFLOW_SCOPE.workspaceId, DEVFLOW_SCOPE.eventId) as { planVersionId: string };
    const before = {
      speakers: (db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(DEVFLOW_SCOPE.workspaceId, DEVFLOW_SCOPE.eventId, DEVFLOW_SCOPE.personId) as { count: number }).count,
      states: (db.prepare("SELECT COUNT(*) AS count FROM plan_states WHERE workspace_id = ? AND plan_version_id = ?").get(DEVFLOW_SCOPE.workspaceId, plan.planVersionId) as { count: number }).count,
    };
    const supersessionId = deterministicUuid(`speaker-portal-interleaving-supersession:${DEVFLOW_SCOPE.workspaceId}:${DEVFLOW_SCOPE.eventId}`);
    db.exec(`
      CREATE TEMP TRIGGER speaker_portal_supersession_interleaving
      AFTER INSERT ON event_speakers
      WHEN NEW.workspace_id = '${DEVFLOW_SCOPE.workspaceId}' AND NEW.event_id = '${DEVFLOW_SCOPE.eventId}' AND NEW.person_id = '${DEVFLOW_SCOPE.personId}'
      BEGIN
        INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
        VALUES ('${supersessionId}', '${DEVFLOW_SCOPE.workspaceId}', '${plan.planVersionId}', 'superseded', NULL, 'deterministic interleaving probe', '${NOW}');
      END;
    `);

    expect(() => issue(db, DEVFLOW_SCOPE, { now: NOW })).toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    expect((db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(DEVFLOW_SCOPE.workspaceId, DEVFLOW_SCOPE.eventId, DEVFLOW_SCOPE.personId) as { count: number }).count).toBe(before.speakers);
    expect((db.prepare("SELECT COUNT(*) AS count FROM plan_states WHERE workspace_id = ? AND plan_version_id = ?").get(DEVFLOW_SCOPE.workspaceId, plan.planVersionId) as { count: number }).count).toBe(before.states);
    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'").get(DEVFLOW_SCOPE.workspaceId)).toEqual({ count: 0 });
  });

  it("denies a prechecked actor after session revocation, demotion, or deletion with zero issuer side effects", () => {
    const cases = [
      {
        label: "session revocation",
        mutate(connection: Db, actor: SpeakerPortalTokenActor): void {
          connection.prepare("DELETE FROM sessions WHERE id = ?").run(actor.sessionId);
        },
      },
      {
        label: "account demotion",
        mutate(connection: Db, actor: SpeakerPortalTokenActor): void {
          connection.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(actor.accountId);
        },
      },
      {
        label: "account deletion",
        mutate(connection: Db, actor: SpeakerPortalTokenActor): void {
          connection.prepare("DELETE FROM sessions WHERE id = ?").run(actor.sessionId);
          connection.prepare("DELETE FROM accounts WHERE id = ?").run(actor.accountId);
        },
      },
    ] as const;

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), `sympose-speaker-portal-auth-${testCase.label.replaceAll(" ", "-")}-`));
      const path = join(directory, "portal.sqlite");
      paths.push(path, directory);
      const db = setup(path);
      const actor: SpeakerPortalTokenActor = {
        accountId: deterministicUuid(`speaker-portal-auth-race-account:${testCase.label}`),
        sessionId: deterministicUuid(`speaker-portal-auth-race-session:${testCase.label}`),
      };
      db.prepare(
        `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'organizer', ?)`,
      ).run(actor.accountId, SCOPE.workspaceId, `${testCase.label.replaceAll(" ", "-")}@speaker-auth.test`, "Speaker Auth Race Organizer", NOW);
      db.prepare(
        `INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(actor.sessionId, "a".repeat(64), actor.accountId, SCOPE.workspaceId, NOW, "2099-01-01T00:00:00.000Z");
      const raceScope: SpeakerPortalAccessScope = {
        ...SCOPE,
        personId: deterministicUuid(`speaker-portal-auth-race-person:${testCase.label}`),
      };
      const source = db.prepare(
        `SELECT event_row.current_plan_version_id AS planVersionId,
                assignment.program_unit_id AS programUnitId,
                assignment.assignment_type AS assignmentType,
                offer.terms_json AS termsJson
           FROM events event_row
           JOIN plan_assignments assignment
             ON assignment.workspace_id = event_row.workspace_id
            AND assignment.plan_version_id = event_row.current_plan_version_id
            AND assignment.person_id = ?
           JOIN commitment_offers offer
             ON offer.workspace_id = assignment.workspace_id
            AND offer.event_id = event_row.id
            AND offer.plan_version_id = assignment.plan_version_id
            AND offer.person_id = assignment.person_id
          WHERE event_row.workspace_id = ?
            AND event_row.id = ?
          LIMIT 1`,
      ).get(SCOPE.personId, SCOPE.workspaceId, SCOPE.eventId) as {
        planVersionId: string;
        programUnitId: string;
        assignmentType: string;
        termsJson: string;
      } | undefined;
      if (!source) throw new Error("seeded speaker authority unavailable");
      const terms = JSON.parse(source.termsJson) as Record<string, unknown>;
      db.prepare(
        `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(raceScope.personId, raceScope.workspaceId, `${testCase.label.replaceAll(" ", "-")}@speaker-auth-person.test`, "Speaker Auth Race Person", NOW);
      db.prepare(
        `INSERT INTO plan_assignments
           (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deterministicUuid(`speaker-portal-auth-race-assignment:${testCase.label}`),
        raceScope.workspaceId,
        source.planVersionId,
        raceScope.personId,
        source.programUnitId,
        source.assignmentType,
        "transactional speaker authorization race fixture",
      );
      const offerId = deterministicUuid(`speaker-portal-auth-race-offer:${testCase.label}`);
      db.prepare(
        `INSERT INTO commitment_offers
           (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?)`,
      ).run(
        offerId,
        raceScope.workspaceId,
        raceScope.eventId,
        source.planVersionId,
        raceScope.personId,
        canonicalJson(terms),
        fingerprintOf(terms),
        NOW,
      );
      db.prepare(
        `INSERT INTO commitment_responses
           (id, workspace_id, offer_id, response, responded_at, actor_person_id)
         VALUES (?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        deterministicUuid(`speaker-portal-auth-race-response:${testCase.label}`),
        raceScope.workspaceId,
        offerId,
        NOW,
        raceScope.personId,
      );

      const prechecked = db.prepare(
        `SELECT session_row.id AS sessionId,
                account.id AS accountId,
                account.role AS role,
                event_row.id AS eventId
           FROM sessions session_row
           JOIN accounts account
             ON account.id = session_row.account_id
            AND account.workspace_id = session_row.workspace_id
           JOIN events event_row
             ON event_row.id = ?
            AND event_row.workspace_id = session_row.workspace_id
          WHERE session_row.id = ?
            AND session_row.account_id = ?
            AND session_row.workspace_id = ?`,
      ).get(raceScope.eventId, actor.sessionId, actor.accountId, raceScope.workspaceId);
      expect(prechecked, testCase.label).toMatchObject({
        sessionId: actor.sessionId,
        accountId: actor.accountId,
        role: "organizer",
        eventId: raceScope.eventId,
      });

      const sideEffects = () => ({
        speakers: (db.prepare(
          "SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?",
        ).get(raceScope.workspaceId, raceScope.eventId, raceScope.personId) as { count: number }).count,
        tokens: (db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get() as { count: number }).count,
        authorityEvents: (db.prepare(
          "SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ? AND event_type = 'speaker.portal.token.authority.bound'",
        ).get(raceScope.workspaceId) as { count: number }).count,
        authorityOutbox: (db.prepare(
          "SELECT COUNT(*) AS count FROM outbox_messages WHERE workspace_id = ? AND destination_key = 'speaker-portal-authority'",
        ).get(raceScope.workspaceId) as { count: number }).count,
        audits: (db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?").get(raceScope.workspaceId) as { count: number }).count,
      });
      const before = sideEffects();
      const concurrent = openDb({ path, seed: false });
      try {
        testCase.mutate(concurrent, actor);
        expect(() => issueSpeakerPortalToken(db, raceScope, actor, { now: NOW }), testCase.label).toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
        expect(sideEffects(), testCase.label).toEqual(before);
      } finally {
        closeDb(concurrent);
      }
    }
  });

  it("bounds repeated token lookups without weakening the generic result", () => {
    const db = setup();
    const issued = issue(db, SCOPE, { now: NOW });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toMatchObject({ active: true });
    }
    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
  });

  it("bounds database lookups across unique token guesses", () => {
    const db = setup();
    const prepare = vi.spyOn(db, "prepare");

    for (let attempt = 0; attempt < 16; attempt += 1) {
      expect(resolveSpeakerPortalToken(db, `${attempt.toString(16).padStart(63, "0")}a`, { now: NOW, lookupBudgetKey: SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY })).toBeNull();
    }

    expect(prepare).toHaveBeenCalledTimes(8);
  });

  it("keeps requester buckets independent for unique valid-format guesses", () => {
    const db = setup();
    const prepare = vi.spyOn(db, "prepare");
    for (const requester of ["requester-a", "requester-b"]) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(resolveSpeakerPortalToken(db, `${(attempt + (requester === "requester-b" ? 8 : 0)).toString(16).padStart(63, "0")}a`, { now: NOW, lookupBudgetKey: `speaker-content:resolve:${requester}` })).toBeNull();
      }
    }
    expect(prepare).toHaveBeenCalledTimes(16);
  });

  it("ignores spoofable forwarding headers unless the deployment explicitly configures one", () => {
    const headers = new Headers({
      "cf-connecting-ip": "spoofed-cloudflare-client",
      "x-real-ip": "trusted-proxy-client",
    });

    expect(speakerPortalLookupBudgetKeyFromHeaders(headers, "open")).toBe("speaker-content:open:anonymous");
    process.env.SYMPOSE_REAL_IP_HEADER = "x-real-ip";
    expect(speakerPortalLookupBudgetKeyFromHeaders(headers, "open")).toBe("speaker-content:open:trusted-proxy-client");
    process.env.SYMPOSE_REAL_IP_HEADER = "cf-connecting-ip";
    expect(speakerPortalLookupBudgetKeyFromHeaders(headers, "open")).toBe("speaker-content:open:spoofed-cloudflare-client");
  });

  it("reserves evaluator-open capacity before issuing tokens so denied calls create no rows", () => {
    const db = setup();
    const budgetKey = speakerPortalLookupBudgetKey("anonymous", "evaluator-open");

    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (reserveSpeakerPortalRequesterLookup(budgetKey, Date.parse(NOW))) {
        issue(db, SCOPE, { now: NOW });
      }
    }

    expect(db.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 8 });
  });

  it("rechecks durable revocation and actual expiry before using cached resolved access", () => {
    const db = setup();
    const issuedAt = new Date().toISOString();
    let clock = issuedAt;
    const issued = issue(db, SCOPE, { now: issuedAt, ttlMs: 10_000 });
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => clock });
    const access = repository.resolvePortalToken(issued.token, speakerPortalLookupBudgetKey("cached", "submit"));
    expect(access).not.toBeNull();
    const currentAssignment = db.prepare(
      `SELECT id FROM plan_assignments
        WHERE workspace_id = ?
          AND plan_version_id = (SELECT current_plan_version_id FROM events WHERE workspace_id = ? AND id = ?)
          AND person_id = ?`,
    ).get(
      EVALUATOR_ARTIFACT_WORKSPACE_ID,
      EVALUATOR_ARTIFACT_WORKSPACE_ID,
      EVALUATOR_ARTIFACT_EVENT_ID,
      EVALUATOR_ARTIFACT_PERSON_ID,
    ) as { id: string };
    const headshotTaskId = deterministicUuid(`speaker-task:${EVALUATOR_ARTIFACT_PERSON_ID}:${currentAssignment.id}:HEADSHOT`);
    const payload = {
      kind: "HEADSHOT" as const,
      asset: {
        assetId: "a".repeat(64),
        fileName: "headshot.png",
        mediaType: "image/png",
        byteSize: 64,
        checksum: "b".repeat(64),
        storageRef: `synthetic://artifact/${"a".repeat(64)}`,
      },
    };

    expect(revokeSpeakerPortalToken(db, SCOPE, issued.token, "speaker requested", "tester", issuedAt)).toBe(true);
    expect(() => repository.submitContentWithRollbackForResolvedAccess(issued.token, access!, headshotTaskId, payload, "revoked-race")).toThrow(/unavailable/i);

    const expiring = issue(db, SCOPE, { now: issuedAt, ttlMs: 10_000 });
    const expiringAccess = repository.resolvePortalToken(expiring.token, speakerPortalLookupBudgetKey("cached-expiry", "submit"));
    expect(expiringAccess).not.toBeNull();
    clock = new Date(Date.parse(issuedAt) + 10_001).toISOString();
    expect(() => repository.submitContentWithRollbackForResolvedAccess(expiring.token, expiringAccess!, headshotTaskId, payload, "expired-race")).toThrow(/unavailable/i);

    const verification = issue(db, SCOPE, { now: clock });
    expect(repository.getPortalProjection(verification.token, speakerPortalLookupBudgetKey("verify", "page"))?.tasks.find((task) => task.id === headshotTaskId)?.submissionVersionId).toBeNull();
  });

  it("completes atomically after seven prior requester lookups without rebuilding through a second lookup", () => {
    const db = setup();
    const requestNow = new Date().toISOString();
    const issued = issue(db, SCOPE, { now: requestNow });
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => requestNow });
    const taskId = repository.createTask(
      {
        kind: "organizer",
        workspaceId: SCOPE.workspaceId,
        eventId: SCOPE.eventId,
        actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      },
      {
        personId: SCOPE.personId,
        kind: "BRIEFING",
        contentKind: null,
        title: "Speaker briefing",
        description: "Confirm the speaker briefing is complete.",
        required: true,
        gate: "CONFIRMATION",
        dueAt: "2026-09-12T17:00:00.000Z",
        owner: "SPEAKER",
        idempotencyKey: "portal-access-briefing-v1",
      },
    ).id;

    const budgetKey = speakerPortalLookupBudgetKey("same-requester", "complete");
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: budgetKey })).toMatchObject({ active: true });
    }

    const completed = repository.completeTask(issued.token, taskId, { note: "Ready", idempotencyKey: "complete-after-seven" }, budgetKey);
    expect(completed.created).toBe(true);
    expect(completed.task.state).toBe("COMPLETED");
    expect(resolveSpeakerPortalToken(db, issued.token, { now: NOW, lookupBudgetKey: budgetKey })).toBeNull();
    const verificationToken = issue(db, SCOPE, { now: requestNow });
    expect(repository.getPortalProjection(verificationToken.token, speakerPortalLookupBudgetKey("verification", "verify"))?.tasks.find((candidate) => candidate.id === taskId)?.state).toBe("COMPLETED");
  });
});
