import { canonicalJson, deterministicUuid, fingerprintOf, randomToken, sha256Hex } from "../canonical";
import { roleHasCapability } from "../auth";
import { withTransaction, type Db } from "../db";

export const SPEAKER_PORTAL_TOKEN_PURPOSE = "speaker-content" as const;
export const SPEAKER_PORTAL_TOKEN_TTL_MS = 30 * 60 * 1000;
const SPEAKER_PORTAL_AUTHORITY_SCHEMA = "speaker-portal-token-authority/v1" as const;
const SPEAKER_PORTAL_AUTHORITY_EVENT_TYPE = "speaker.portal.token.authority.bound" as const;
const SPEAKER_PORTAL_AUTHORITY_AGGREGATE_TYPE = "speaker_portal_token" as const;
const SPEAKER_PORTAL_AUTHORITY_DESTINATION = "speaker-portal-authority" as const;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOOKUP_BUDGET_KEY_PATTERN = /^speaker-content:[A-Za-z0-9._:-]{1,159}$/u;
const MAX_LOOKUPS_PER_WINDOW = 8;
const LOOKUP_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 4096;

export interface SpeakerPortalAccessScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
}

/**
 * The issuer is an immutable identity tuple, not a caller-provided role or capability claim.
 * The transaction rehydrates both rows before it can create any portal authority.
 */
export interface SpeakerPortalTokenActor {
  readonly accountId: string;
  readonly sessionId: string;
}

export interface SpeakerPortalAccessProjection extends SpeakerPortalAccessScope {
  readonly purpose: typeof SPEAKER_PORTAL_TOKEN_PURPOSE;
  readonly assignmentId: string;
  readonly planVersionId: string;
  readonly planVersionFingerprint: string;
  readonly acceptedTermsFingerprint: string;
  readonly authorityFingerprint: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

export interface IssuedSpeakerPortalToken {
  readonly token: string;
  readonly access: SpeakerPortalAccessProjection;
}

const lookupWindows = new Map<string, { readonly startedAt: number; readonly count: number }>();
const requesterLookupWindows = new Map<string, { readonly startedAt: number; readonly count: number }>();

export const SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY = "speaker-content:test-anonymous" as const;

export function speakerPortalLookupBudgetKey(requester: string, route: string): string {
  const normalizedRequester = typeof requester === "string" && /^[A-Za-z0-9._:-]{1,96}$/u.test(requester)
    ? requester
    : "anonymous";
  const normalizedRoute = typeof route === "string" && /^[A-Za-z0-9._:-]{1,48}$/u.test(route)
    ? route
    : "resolve";
  return `speaker-content:${normalizedRoute}:${normalizedRequester}`;
}

export function speakerPortalLookupBudgetKeyFromHeaders(requestHeaders: Headers, route: string): string {
  const candidate = (name: string): string | null => {
    const value = requestHeaders.get(name)?.trim() ?? "";
    return value.length > 0 && value.length <= 96 && !value.includes(",") && /^[A-Za-z0-9._:-]+$/u.test(value)
      ? value
      : null;
  };
  const configuredHeader = process.env.SYMPOSE_REAL_IP_HEADER?.trim().toLowerCase();
  const requester = configuredHeader ? candidate(configuredHeader) ?? "anonymous" : "anonymous";
  return speakerPortalLookupBudgetKey(requester, route);
}

function validScope(scope: SpeakerPortalAccessScope): SpeakerPortalAccessScope {
  if (
    scope === null ||
    typeof scope !== "object" ||
    !SCOPE_PATTERN.test(scope.workspaceId) ||
    !SCOPE_PATTERN.test(scope.eventId) ||
    !SCOPE_PATTERN.test(scope.personId)
  ) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  return scope;
}

function validActor(actor: SpeakerPortalTokenActor): SpeakerPortalTokenActor {
  if (
    actor === null ||
    typeof actor !== "object" ||
    !SCOPE_PATTERN.test(actor.accountId) ||
    !SCOPE_PATTERN.test(actor.sessionId)
  ) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  return Object.freeze({ accountId: actor.accountId, sessionId: actor.sessionId });
}

function localEvaluatorProfile(): boolean {
  if (process.env.SYMPOSE_EVALUATOR_PROFILE !== "local") return false;
  return process.env.NODE_ENV !== "production" || process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO === "1";
}

export function isLocalEvaluatorProfile(): boolean {
  return localEvaluatorProfile();
}

function tokenHash(token: string): string | null {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return sha256Hex(token);
}

function pruneLookupWindows(now: number): void {
  for (const [key, window] of lookupWindows) {
    if (now - window.startedAt >= LOOKUP_WINDOW_MS) lookupWindows.delete(key);
  }
  for (const [key, window] of requesterLookupWindows) {
    if (now - window.startedAt >= LOOKUP_WINDOW_MS) requesterLookupWindows.delete(key);
  }
}

function allowRequesterLookup(budgetKey: string, now: number): boolean {
  const budgetHash = sha256Hex(budgetKey);
  pruneLookupWindows(now);
  const priorRequester = requesterLookupWindows.get(budgetHash);
  if (priorRequester && priorRequester.count >= MAX_LOOKUPS_PER_WINDOW) return false;
  if (!priorRequester && requesterLookupWindows.size >= MAX_RATE_KEYS) {
    const oldest = requesterLookupWindows.keys().next().value;
    if (typeof oldest === "string") requesterLookupWindows.delete(oldest);
  }
  requesterLookupWindows.set(budgetHash, { startedAt: priorRequester?.startedAt ?? now, count: (priorRequester?.count ?? 0) + 1 });
  return true;
}

function allowLookup(hash: string, budgetKey: string, now: number): boolean {
  if (!allowRequesterLookup(budgetKey, now)) return false;
  const prior = lookupWindows.get(hash);
  if (!prior || now - prior.startedAt >= LOOKUP_WINDOW_MS) {
    if (lookupWindows.size >= MAX_RATE_KEYS) {
      const oldest = lookupWindows.keys().next().value;
      if (typeof oldest === "string") lookupWindows.delete(oldest);
    }
    lookupWindows.set(hash, { startedAt: now, count: 1 });
    return true;
  }
  if (prior.count >= MAX_LOOKUPS_PER_WINDOW) return false;
  lookupWindows.set(hash, { startedAt: prior.startedAt, count: prior.count + 1 });
  return true;
}

export function reserveSpeakerPortalRequesterLookup(budgetKey: string, now = Date.now()): boolean {
  if (!LOOKUP_BUDGET_KEY_PATTERN.test(budgetKey) || !Number.isFinite(now)) return false;
  return allowRequesterLookup(budgetKey, now);
}

function activeProjection(row: {
  workspace_id: string;
  event_id: string;
  person_id: string;
  purpose: string;
  expires_at: string;
  revoked_at: string | null;
}, authority: SpeakerPortalAuthority, now: string): SpeakerPortalAccessProjection | null {
  if (
    row.purpose !== SPEAKER_PORTAL_TOKEN_PURPOSE ||
    row.revoked_at !== null ||
    Date.parse(row.expires_at) <= Date.parse(now)
  ) return null;
  return Object.freeze({
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    personId: row.person_id,
    purpose: SPEAKER_PORTAL_TOKEN_PURPOSE,
    assignmentId: authority.assignmentId,
    planVersionId: authority.planVersionId,
    planVersionFingerprint: authority.planVersionFingerprint,
    acceptedTermsFingerprint: authority.acceptedTermsFingerprint,
    authorityFingerprint: authority.authorityFingerprint,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    active: true,
  });
}

interface SpeakerPortalAuthority {
  readonly assignmentId: string;
  readonly planVersionId: string;
  readonly planVersionFingerprint: string;
  readonly acceptedTermsFingerprint: string;
  readonly authorityFingerprint: string;
}

interface SpeakerPortalAuthorityPayload extends SpeakerPortalAuthority {
  readonly schema: typeof SPEAKER_PORTAL_AUTHORITY_SCHEMA;
  readonly operation: "bind-accepted-assignment";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly tokenId: string;
  readonly tokenHash: string;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function authorityFingerprint(scope: SpeakerPortalAccessScope, authority: Pick<SpeakerPortalAuthority, "assignmentId" | "planVersionId" | "planVersionFingerprint" | "acceptedTermsFingerprint">): string {
  return fingerprintOf({
    schema: SPEAKER_PORTAL_AUTHORITY_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: scope.personId,
    assignmentId: authority.assignmentId,
    planVersionId: authority.planVersionId,
    planVersionFingerprint: authority.planVersionFingerprint,
    acceptedTermsFingerprint: authority.acceptedTermsFingerprint,
  });
}

function sameAuthority(left: SpeakerPortalAuthority, right: SpeakerPortalAuthority): boolean {
  return left.assignmentId === right.assignmentId &&
    left.planVersionId === right.planVersionId &&
    left.planVersionFingerprint === right.planVersionFingerprint &&
    left.acceptedTermsFingerprint === right.acceptedTermsFingerprint &&
    left.authorityFingerprint === right.authorityFingerprint;
}

function readCurrentAcceptedCanonicalAssignment(db: Db, scope: SpeakerPortalAccessScope): SpeakerPortalAuthority | null {
  const accepted = db.prepare(
    `SELECT assignment.id AS assignmentId,
            plan.id AS planVersionId,
            plan.fingerprint AS planVersionFingerprint,
            offer.terms_fingerprint AS acceptedTermsFingerprint,
            offer.terms_json AS termsJson
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
        AND plan.event_id = event_row.id
       JOIN plan_assignments assignment
         ON assignment.plan_version_id = plan.id
        AND assignment.workspace_id = plan.workspace_id
        AND assignment.person_id = ?
       LEFT JOIN event_speakers accepted_speaker
         ON accepted_speaker.workspace_id = plan.workspace_id
        AND accepted_speaker.event_id = event_row.id
        AND accepted_speaker.person_id = assignment.person_id
        AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
        AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
       JOIN program_units unit
         ON unit.id = assignment.program_unit_id
        AND unit.workspace_id = assignment.workspace_id
        AND unit.event_id = event_row.id
       JOIN approvals approval
         ON approval.plan_version_id = plan.id
        AND approval.workspace_id = plan.workspace_id
        AND approval.event_id = event_row.id
        AND approval.decision = 'approved'
       JOIN plan_states current_state
         ON current_state.plan_version_id = plan.id
        AND current_state.workspace_id = plan.workspace_id
        AND current_state.state = 'approved'
        AND NOT EXISTS (
          SELECT 1
            FROM plan_states newer_state
           WHERE newer_state.workspace_id = current_state.workspace_id
             AND newer_state.plan_version_id = current_state.plan_version_id
             AND (newer_state.created_at > current_state.created_at
               OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
        )
        AND NOT EXISTS (
          SELECT 1
            FROM plan_states superseded_state
           WHERE superseded_state.workspace_id = plan.workspace_id
             AND superseded_state.plan_version_id = plan.id
             AND superseded_state.state = 'superseded'
        )
       JOIN commitment_offers offer
         ON offer.plan_version_id = plan.id
        AND offer.workspace_id = plan.workspace_id
        AND offer.event_id = event_row.id
        AND offer.person_id = assignment.person_id
        AND offer.status = 'offered'
       JOIN commitment_responses response
         ON response.offer_id = offer.id
        AND response.workspace_id = offer.workspace_id
        AND response.actor_person_id = offer.person_id
        AND response.response = 'accepted'
      WHERE event_row.workspace_id = ?
        AND event_row.id = ?
        AND (accepted_speaker.id IS NOT NULL OR NOT EXISTS (
          SELECT 1
            FROM event_speakers any_speaker
           WHERE any_speaker.workspace_id = plan.workspace_id
             AND any_speaker.event_id = event_row.id
             AND any_speaker.person_id = assignment.person_id
             AND any_speaker.role_key IN ('SPEAKER', 'MODERATOR')
        ))
        AND json_extract(offer.terms_json, '$.planVersionId') = plan.id
        AND json_extract(offer.terms_json, '$.eventId') = event_row.id
        AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
        AND (accepted_speaker.id IS NULL OR CASE accepted_speaker.role_key
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
            END = CASE assignment.assignment_type
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'participant' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
              WHEN 'moderator' THEN 'MODERATOR'
            END)
        AND CASE assignment.assignment_type
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'participant' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
              WHEN 'moderator' THEN 'MODERATOR'
            END = CASE json_extract(offer.terms_json, '$.role')
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'participant' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
              WHEN 'moderator' THEN 'MODERATOR'
            END
        AND ((SELECT COUNT(*)
                FROM event_speakers accepted_scope_speaker
               WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
                 AND accepted_scope_speaker.event_id = event_row.id
                 AND accepted_scope_speaker.person_id = assignment.person_id
                 AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
                 AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
          OR (SELECT COUNT(*)
                FROM event_speakers any_scope_speaker
               WHERE any_scope_speaker.workspace_id = plan.workspace_id
                 AND any_scope_speaker.event_id = event_row.id
                 AND any_scope_speaker.person_id = assignment.person_id
                 AND any_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')) = 0)
        AND (SELECT COUNT(*)
               FROM plan_assignments current_assignment
              WHERE current_assignment.workspace_id = plan.workspace_id
                AND current_assignment.plan_version_id = plan.id
                AND current_assignment.person_id = assignment.person_id) = 1
      GROUP BY assignment.id
      HAVING COUNT(DISTINCT assignment.id) = 1
         AND COUNT(DISTINCT accepted_speaker.id) <= 1
         AND COUNT(DISTINCT offer.id) = 1
         AND COUNT(DISTINCT response.id) = 1
      LIMIT 1`,
  ).all(scope.personId, scope.workspaceId, scope.eventId) as unknown as readonly Record<string, unknown>[];
  if (accepted.length !== 1) return null;
  const row = accepted[0];
  if (
    typeof row?.assignmentId !== "string" ||
    typeof row.planVersionId !== "string" ||
    !isFingerprint(row.planVersionFingerprint) ||
    !isFingerprint(row.acceptedTermsFingerprint) ||
    typeof row.termsJson !== "string"
  ) return null;
  let terms: unknown;
  try {
    terms = JSON.parse(row.termsJson) as unknown;
  } catch {
    return null;
  }
  if (terms === null || typeof terms !== "object" || Array.isArray(terms) || fingerprintOf(terms) !== row.acceptedTermsFingerprint) return null;
  const scopeAuthority = {
    assignmentId: row.assignmentId,
    planVersionId: row.planVersionId,
    planVersionFingerprint: row.planVersionFingerprint,
    acceptedTermsFingerprint: row.acceptedTermsFingerprint,
  };
  return Object.freeze({ ...scopeAuthority, authorityFingerprint: authorityFingerprint(scope, scopeAuthority) });
}

function authorityPayload(value: unknown): SpeakerPortalAuthorityPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const expectedKeys = [
    "acceptedTermsFingerprint", "assignmentId", "authorityFingerprint", "eventId", "operation",
    "personId", "planVersionFingerprint", "planVersionId", "schema", "tokenHash", "tokenId", "workspaceId",
  ].sort();
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) return null;
  if (
    payload.schema !== SPEAKER_PORTAL_AUTHORITY_SCHEMA ||
    payload.operation !== "bind-accepted-assignment" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.eventId !== "string" ||
    typeof payload.personId !== "string" ||
    typeof payload.tokenId !== "string" ||
    !TOKEN_PATTERN.test(payload.tokenHash as string) ||
    typeof payload.assignmentId !== "string" ||
    typeof payload.planVersionId !== "string" ||
    !isFingerprint(payload.planVersionFingerprint) ||
    !isFingerprint(payload.acceptedTermsFingerprint) ||
    !isFingerprint(payload.authorityFingerprint)
  ) return null;
  return payload as unknown as SpeakerPortalAuthorityPayload;
}

function persistTokenAuthority(
  db: Db,
  scope: SpeakerPortalAccessScope,
  tokenId: string,
  tokenHashValue: string,
  authority: SpeakerPortalAuthority,
  occurredAt: string,
): void {
  const payload: SpeakerPortalAuthorityPayload = {
    schema: SPEAKER_PORTAL_AUTHORITY_SCHEMA,
    operation: "bind-accepted-assignment",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    personId: scope.personId,
    tokenId,
    tokenHash: tokenHashValue,
    assignmentId: authority.assignmentId,
    planVersionId: authority.planVersionId,
    planVersionFingerprint: authority.planVersionFingerprint,
    acceptedTermsFingerprint: authority.acceptedTermsFingerprint,
    authorityFingerprint: authority.authorityFingerprint,
  };
  const payloadJson = canonicalJson(payload);
  const payloadFingerprint = fingerprintOf(payload);
  const domainEventId = deterministicUuid(`speaker-portal-authority:${scope.workspaceId}:${tokenId}:${payloadFingerprint}`);
  db.prepare(
    `INSERT INTO domain_events
       (id, workspace_id, event_type, aggregate_type, aggregate_id,
        payload_json, payload_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    domainEventId,
    scope.workspaceId,
    SPEAKER_PORTAL_AUTHORITY_EVENT_TYPE,
    SPEAKER_PORTAL_AUTHORITY_AGGREGATE_TYPE,
    tokenId,
    payloadJson,
    payloadFingerprint,
    occurredAt,
  );
  const outboxPayload = canonicalJson({
    schema: "speaker-portal-authority-outbox/v1",
    domainEventId,
    eventType: SPEAKER_PORTAL_AUTHORITY_EVENT_TYPE,
    payload,
  });
  db.prepare(
    `INSERT INTO outbox_messages
       (id, workspace_id, domain_event_id, destination_key, payload_json, status, attempt_count, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
  ).run(
    deterministicUuid(`speaker-portal-authority-outbox:${scope.workspaceId}:${domainEventId}`),
    scope.workspaceId,
    domainEventId,
    SPEAKER_PORTAL_AUTHORITY_DESTINATION,
    outboxPayload,
    occurredAt,
    occurredAt,
  );
}

function readTokenAuthority(
  db: Db,
  row: { readonly id: string; readonly workspace_id: string; readonly event_id: string; readonly person_id: string; readonly token_hash: string },
): SpeakerPortalAuthority | null {
  const rows = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = ?
        AND aggregate_type = ?
        AND aggregate_id = ?`,
  ).all(row.workspace_id, SPEAKER_PORTAL_AUTHORITY_EVENT_TYPE, SPEAKER_PORTAL_AUTHORITY_AGGREGATE_TYPE, row.id) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== 1) return null;
  const event = rows[0];
  if (
    typeof event?.id !== "string" ||
    typeof event.payload_json !== "string" ||
    !isFingerprint(event.payload_fingerprint) ||
    typeof event.created_at !== "string"
  ) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload_json) as unknown;
  } catch {
    return null;
  }
  const payload = authorityPayload(parsed);
  if (
    !payload ||
    canonicalJson(payload) !== event.payload_json ||
    fingerprintOf(payload) !== event.payload_fingerprint ||
    event.id !== deterministicUuid(`speaker-portal-authority:${row.workspace_id}:${row.id}:${event.payload_fingerprint}`) ||
    payload.workspaceId !== row.workspace_id ||
    payload.eventId !== row.event_id ||
    payload.personId !== row.person_id ||
    payload.tokenId !== row.id ||
    payload.tokenHash !== row.token_hash ||
    payload.authorityFingerprint !== authorityFingerprint(payload, payload) ||
    payload.authorityFingerprint !== fingerprintOf({
      schema: SPEAKER_PORTAL_AUTHORITY_SCHEMA,
      workspaceId: payload.workspaceId,
      eventId: payload.eventId,
      personId: payload.personId,
      assignmentId: payload.assignmentId,
      planVersionId: payload.planVersionId,
      planVersionFingerprint: payload.planVersionFingerprint,
      acceptedTermsFingerprint: payload.acceptedTermsFingerprint,
    })
  ) return null;
  const outboxRows = db.prepare(
    `SELECT id, workspace_id, domain_event_id, destination_key, payload_json, created_at
       FROM outbox_messages
      WHERE workspace_id = ? AND domain_event_id = ?`,
  ).all(row.workspace_id, event.id) as unknown as Array<Record<string, unknown>>;
  const expectedOutboxPayload = canonicalJson({
    schema: "speaker-portal-authority-outbox/v1",
    domainEventId: event.id,
    eventType: SPEAKER_PORTAL_AUTHORITY_EVENT_TYPE,
    payload,
  });
  if (
    outboxRows.length !== 1 ||
    outboxRows[0]?.id !== deterministicUuid(`speaker-portal-authority-outbox:${row.workspace_id}:${event.id}`) ||
    outboxRows[0]?.workspace_id !== row.workspace_id ||
    outboxRows[0]?.domain_event_id !== event.id ||
    outboxRows[0]?.destination_key !== SPEAKER_PORTAL_AUTHORITY_DESTINATION ||
    outboxRows[0]?.payload_json !== expectedOutboxPayload ||
    outboxRows[0]?.created_at !== event.created_at
  ) return null;
  return Object.freeze({
    assignmentId: payload.assignmentId,
    planVersionId: payload.planVersionId,
    planVersionFingerprint: payload.planVersionFingerprint,
    acceptedTermsFingerprint: payload.acceptedTermsFingerprint,
    authorityFingerprint: payload.authorityFingerprint,
  });
}

function ensureCanonicalEventSpeakerLink(db: Db, scope: SpeakerPortalAccessScope, occurredAt: string): void {
  const assignment = db.prepare(
    `SELECT assignment.id AS assignment_id,
            CASE assignment.assignment_type
              WHEN 'SPEAKER' THEN 'SPEAKER'
              WHEN 'participant' THEN 'SPEAKER'
              WHEN 'MODERATOR' THEN 'MODERATOR'
              WHEN 'moderator' THEN 'MODERATOR'
            END AS role_key
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
        AND plan.event_id = event_row.id
       JOIN plan_assignments assignment
         ON assignment.plan_version_id = plan.id
        AND assignment.workspace_id = plan.workspace_id
        AND assignment.person_id = ?
      WHERE event_row.workspace_id = ?
        AND event_row.id = ?
        AND assignment.assignment_type IN ('SPEAKER', 'participant', 'MODERATOR', 'moderator')
        AND (SELECT COUNT(*)
               FROM plan_assignments current_assignment
              WHERE current_assignment.workspace_id = plan.workspace_id
                AND current_assignment.plan_version_id = plan.id
                AND current_assignment.person_id = assignment.person_id) = 1
      LIMIT 2`,
  ).all(scope.personId, scope.workspaceId, scope.eventId) as unknown as Array<{
    readonly assignment_id: unknown;
    readonly role_key: unknown;
  }>;
  if (
    assignment.length !== 1 ||
    typeof assignment[0]?.assignment_id !== "string" ||
    (assignment[0].role_key !== "SPEAKER" && assignment[0].role_key !== "MODERATOR")
  ) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  const roleKey = assignment[0].role_key;
  const existing = db.prepare(
    `SELECT id
       FROM event_speakers
      WHERE workspace_id = ? AND event_id = ? AND person_id = ?
        AND role_key = ? AND participation_status IN ('CONFIRMED', 'ACCEPTED')
      LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, scope.personId, roleKey) as { readonly id: string } | undefined;
  if (existing) return;
  db.prepare(
    `INSERT INTO event_speakers
       (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
  ).run(
    deterministicUuid(`speaker-portal-event-speaker:${scope.workspaceId}:${scope.eventId}:${scope.personId}:${assignment[0].assignment_id}`),
    scope.workspaceId,
    scope.eventId,
    scope.personId,
    roleKey,
    occurredAt,
    occurredAt,
  );
}

function assertTransactionalOrganizerCapability(
  db: Db,
  scope: SpeakerPortalAccessScope,
  actor: SpeakerPortalTokenActor,
  now: string,
): void {
  const persisted = db.prepare(
    `SELECT session_row.id AS sessionId,
            session_row.account_id AS accountId,
            session_row.workspace_id AS workspaceId,
            session_row.expires_at AS expiresAt,
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
        AND session_row.workspace_id = ?
      LIMIT 1`,
  ).get(scope.eventId, actor.sessionId, actor.accountId, scope.workspaceId) as {
    readonly sessionId: unknown;
    readonly accountId: unknown;
    readonly workspaceId: unknown;
    readonly expiresAt: unknown;
    readonly role: unknown;
    readonly eventId: unknown;
  } | undefined;
  const nowMs = Date.parse(now);
  const expiresAtMs = typeof persisted?.expiresAt === "string" ? Date.parse(persisted.expiresAt) : Number.NaN;
  if (
    !persisted ||
    persisted.sessionId !== actor.sessionId ||
    persisted.accountId !== actor.accountId ||
    persisted.workspaceId !== scope.workspaceId ||
    persisted.eventId !== scope.eventId ||
    typeof persisted.role !== "string" ||
    !roleHasCapability(persisted.role, "phase0.pipeline.manage") ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
}

export function issueSpeakerPortalToken(
  db: Db,
  rawScope: SpeakerPortalAccessScope,
  rawActor: SpeakerPortalTokenActor,
  options: { readonly now?: string; readonly ttlMs?: number } = {},
): IssuedSpeakerPortalToken {
  const scope = validScope(rawScope);
  const actor = validActor(rawActor);
  const now = options.now ?? new Date().toISOString();
  const ttlMs = options.ttlMs ?? SPEAKER_PORTAL_TOKEN_TTL_MS;
  if (Number.isNaN(Date.parse(now)) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > SPEAKER_PORTAL_TOKEN_TTL_MS) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  const token = randomToken();
  const id = randomToken();
  const hash = sha256Hex(token);
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  const authority = withTransaction(db, () => {
    assertTransactionalOrganizerCapability(db, scope, actor, now);
    const before = readCurrentAcceptedCanonicalAssignment(db, scope);
    if (!before) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    ensureCanonicalEventSpeakerLink(db, scope, now);
    const after = readCurrentAcceptedCanonicalAssignment(db, scope);
    if (!after || !sameAuthority(before, after)) throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    db.prepare(
      `INSERT INTO speaker_portal_tokens
         (id, workspace_id, event_id, person_id, token_hash, purpose, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, scope.workspaceId, scope.eventId, scope.personId, hash, SPEAKER_PORTAL_TOKEN_PURPOSE, now, expiresAt);
    persistTokenAuthority(db, scope, id, hash, after, now);
    return after;
  });
  return Object.freeze({
    token,
    access: Object.freeze({
      ...scope,
      purpose: SPEAKER_PORTAL_TOKEN_PURPOSE,
      ...authority,
      expiresAt,
      revokedAt: null,
      active: true,
    }),
  });
}

export function resolveSpeakerPortalToken(
  db: Db,
  token: string,
  options: { readonly now?: string; readonly lookupBudgetKey?: string } = {},
): SpeakerPortalAccessProjection | null {
  const hash = tokenHash(token);
  if (!hash || typeof options.lookupBudgetKey !== "string" || !LOOKUP_BUDGET_KEY_PATTERN.test(options.lookupBudgetKey)) return null;
  if (!allowLookup(hash, options.lookupBudgetKey, Date.now())) return null;
  const now = options.now ?? new Date().toISOString();
  return revalidateSpeakerPortalToken(db, token, { now });
}

export function revalidateSpeakerPortalToken(
  db: Db,
  token: string,
  options: { readonly now?: string } = {},
): SpeakerPortalAccessProjection | null {
  const hash = tokenHash(token);
  if (!hash) return null;
  const now = options.now ?? new Date().toISOString();
  try {
    const row = db.prepare(
      `SELECT id, workspace_id, event_id, person_id, token_hash, purpose, expires_at, revoked_at
         FROM speaker_portal_tokens
        WHERE token_hash = ? AND purpose = ?
        LIMIT 1`,
    ).get(hash, SPEAKER_PORTAL_TOKEN_PURPOSE) as {
      id: string;
      workspace_id: string;
      event_id: string;
      person_id: string;
      token_hash: string;
      purpose: string;
      expires_at: string;
      revoked_at: string | null;
    } | undefined;
    if (!row) return null;
    const binding = readTokenAuthority(db, row);
    const current = readCurrentAcceptedCanonicalAssignment(db, {
      workspaceId: row.workspace_id,
      eventId: row.event_id,
      personId: row.person_id,
    });
    if (!binding || !current || !sameAuthority(binding, current)) return null;
    return activeProjection(row, binding, now);
  } catch {
    return null;
  }
}

export function revokeSpeakerPortalToken(
  db: Db,
  scope: SpeakerPortalAccessScope,
  token: string,
  reason: string,
  revokedBy: string,
  now = new Date().toISOString(),
): boolean {
  const normalized = validScope(scope);
  const hash = tokenHash(token);
  if (!hash || typeof reason !== "string" || reason.length < 1 || reason.length > 240 || typeof revokedBy !== "string" || revokedBy.length < 1 || revokedBy.length > 160) {
    throw new Error("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
  }
  return withTransaction(db, () => db.prepare(
    `UPDATE speaker_portal_tokens
     SET revoked_at = ?, revoked_reason = ?, revoked_by = ?
     WHERE workspace_id = ? AND event_id = ? AND person_id = ?
       AND token_hash = ? AND purpose = ? AND revoked_at IS NULL`,
  ).run(now, reason, revokedBy, normalized.workspaceId, normalized.eventId, normalized.personId, hash, SPEAKER_PORTAL_TOKEN_PURPOSE).changes === 1);
}

export function resetSpeakerPortalAccessRateLimitForTest(): void {
  lookupWindows.clear();
  requesterLookupWindows.clear();
}
