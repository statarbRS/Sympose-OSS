import { nowIso, deterministicUuid, fingerprintOf } from "../../canonical";
import type { Db } from "../../db";
import {
  readAcceptedCfpScheduleInventory,
  readAcceptedCfpScheduleInventoryAt,
  type AcceptedCfpScheduleInventoryEntry,
} from "../cfp/decisions";
import { immutableSchedule, scheduleContentFingerprint } from "./deterministic";
import type {
  ScheduleDay,
  ScheduleEvent,
  SchedulePlacement,
  ScheduleSession,
  ScheduleSnapshot,
  ScheduleSpeaker,
  ScheduleTimeSlot,
  ScheduleTrack,
  ScheduleRoom,
  CfpScheduleSessionAuthority,
} from "./types";

const DEFAULT_ROOM_NAME = "Main room";
const DEFAULT_TRACK_NAME = "Main program";
const DEFAULT_VENUE = "Event venue";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export class CanonicalScheduleError extends Error {
  readonly code = "SCHEDULE_CANONICAL_UNAVAILABLE";

  constructor(message = "The canonical event schedule is unavailable.") {
    super(message);
    this.name = "CanonicalScheduleError";
  }
}

interface CanonicalScope {
  readonly workspaceId: string;
  readonly eventId: string;
}

interface EventResourceRow {
  readonly id: string;
  readonly name: string;
  readonly capacity?: number | null;
}

interface ProgramUnitRow {
  readonly id: string;
  readonly name: string;
  readonly unitType: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly abstract?: string | null;
  readonly trackId?: string;
}

interface AllocationRow {
  readonly id: string;
  readonly programUnitId: string;
  readonly roomId: string;
  readonly trackId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allocationStatus: string;
}

interface PlanRow {
  readonly id: string;
  readonly fingerprint: string;
}

interface HistoricalPlanRow extends PlanRow {
  readonly planCreatedAt: string;
  readonly approvalCreatedAt: string;
  readonly approvalAuditCreatedAt: string;
  readonly stateCreatedAt: string;
}

function defaultResourceId(scope: CanonicalScope, kind: "room" | "track"): string {
  return deterministicUuid(`canonical-schedule:${kind}:${scope.workspaceId}:${scope.eventId}`);
}

export interface AcceptedScheduleInventoryEntry {
  readonly offerId: string;
  readonly assignmentId: string;
  readonly personId: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly role: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly termsFingerprint: string;
}

export function acceptedInventoryFingerprint(entries: readonly AcceptedScheduleInventoryEntry[]): string {
  return fingerprintOf(
    [...entries]
      .map((entry) => ({
        offerId: entry.offerId,
        assignmentId: entry.assignmentId,
        personId: entry.personId,
        programUnitId: entry.programUnitId,
        programUnitName: entry.programUnitName,
        role: entry.role,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        termsFingerprint: entry.termsFingerprint,
      }))
      .sort((first, second) =>
        first.offerId.localeCompare(second.offerId) ||
        first.assignmentId.localeCompare(second.assignmentId),
      ),
  );
}

export function cfpSessionAuthorities(
  entries: readonly AcceptedCfpScheduleInventoryEntry[],
): CfpScheduleSessionAuthority[] {
  return [...entries]
    .map((entry) => ({
      programUnitId: entry.programUnitId,
      sessionFingerprint: entry.sessionFingerprint,
      linkFingerprints: entry.links.map((link) => link.linkFingerprint).sort(),
    }))
    .sort((first, second) => first.programUnitId.localeCompare(second.programUnitId));
}

export function cfpSessionInventoryFingerprint(
  entries: readonly AcceptedCfpScheduleInventoryEntry[],
): string {
  return fingerprintOf(cfpSessionAuthorities(entries));
}

interface AcceptedInventoryRow extends AcceptedScheduleInventoryEntry {
  readonly personName: string;
  readonly organization: string | null;
  readonly email: string;
  readonly unitType: string;
  readonly capacity: number;
}

interface ScheduleSpeakerInventoryRow {
  readonly personId: string;
  readonly programUnitId: string;
  readonly personName: string;
  readonly organization: string | null;
  readonly email: string;
}

function fail(message: string): never {
  throw new CanonicalScheduleError(message);
}

function safeText(value: unknown, label: string, maximum = 240): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    return fail(`${label} is invalid.`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const text = safeText(value, label, 160);
  if (!IDENTIFIER.test(text)) return fail(`${label} is invalid.`);
  return text;
}

export function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validInstant(value: unknown, label: string): string {
  const text = safeText(value, label, 128);
  if (!isCanonicalIsoInstant(text)) return fail(`${label} is invalid.`);
  return text;
}

function historicalInstantAtOrBefore(value: unknown, label: string, cutoff: string): string {
  const instant = validInstant(value, label);
  if (Date.parse(instant) > Date.parse(cutoff)) return fail(`${label} is after the authority cutoff.`);
  return instant;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${label} is invalid.`);
  return value as number;
}

function datePart(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function dayId(date: string): string {
  return `day-${date}`;
}

function slotId(startsAt: string, endsAt: string): string {
  return `slot-${startsAt.slice(0, 10)}-${startsAt.slice(11, 16).replace(":", "")}-${endsAt.slice(11, 16).replace(":", "")}`;
}

function dayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function durationMinutes(startsAt: string, endsAt: string): number {
  const duration = Math.ceil((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  return Number.isSafeInteger(duration) && duration > 0 ? duration : fail("program unit duration is invalid.");
}

function scheduleEvent(scope: CanonicalScope, row: Record<string, unknown>): ScheduleEvent {
  if (row.id !== scope.eventId) {
    return fail("event scope is invalid.");
  }
  return {
    id: scope.eventId,
    slug: safeId(row.id, "event id"),
    name: safeText(row.name, "event name"),
    timezone: safeText(row.timezone, "event timezone", 120),
    startsAt: validInstant(row.startsAt, "event start"),
    endsAt: validInstant(row.endsAt, "event end"),
  };
}

function readPlan(db: Db, scope: CanonicalScope, planVersionId: string | null): PlanRow | null {
  if (planVersionId === null) return null;
  const row = db.prepare(
    `SELECT id, fingerprint
       FROM plan_versions
      WHERE workspace_id = ? AND event_id = ? AND id = ?
      LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, planVersionId) as PlanRow | undefined;
  if (!row || row.id !== planVersionId || !/^[a-f0-9]{64}$/u.test(row.fingerprint)) {
    return fail("the event plan pointer is not a canonical plan.");
  }
  return row;
}

function readApprovedPlan(db: Db, scope: CanonicalScope, eventRow: Record<string, unknown>): PlanRow | null {
  const planVersionId = eventRow.currentPlanVersionId === null
    ? null
    : safeId(eventRow.currentPlanVersionId, "current plan id");
  const plan = readPlan(db, scope, planVersionId);
  if (!plan) return null;
  const approval = db.prepare(
    `SELECT COUNT(*) AS count,
            MAX(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved,
            MAX(actor_account_id) AS actorAccountId
       FROM approvals
      WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
  ).get(scope.workspaceId, scope.eventId, plan.id) as {
    count: number;
    approved: number | null;
    actorAccountId: string | null;
  };
  if (approval.count !== 1 || approval.approved !== 1 || approval.actorAccountId === null) {
    return fail("the current plan does not have exactly one approval.");
  }
  const newestApproved = db.prepare(
    `SELECT pv.id
       FROM plan_versions pv
       JOIN approvals a
         ON a.workspace_id = pv.workspace_id
        AND a.event_id = pv.event_id
        AND a.plan_version_id = pv.id
        AND a.decision = 'approved'
      WHERE pv.workspace_id = ? AND pv.event_id = ?
      ORDER BY pv.version_number DESC, pv.created_at DESC, pv.rowid DESC
      LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId) as { id: string } | undefined;
  if (!newestApproved || newestApproved.id !== plan.id) {
    return fail("the event plan pointer is not the newest approved plan.");
  }
  const state = db.prepare(
    `SELECT state, actor_account_id AS actorAccountId
       FROM plan_states
      WHERE workspace_id = ? AND plan_version_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
  ).get(scope.workspaceId, plan.id) as { state: string; actorAccountId: string | null } | undefined;
  if (state?.state !== "approved" || state.actorAccountId !== approval.actorAccountId) {
    return fail("the current plan is not in an approved state.");
  }
  return plan;
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function readAcceptedInventory(
  db: Db,
  scope: CanonicalScope,
  event: ScheduleEvent,
  plan: PlanRow,
): { readonly entries: AcceptedInventoryRow[]; readonly units: ProgramUnitRow[] } {
  const acceptedOffers = db.prepare(
    `SELECT o.id
       FROM commitment_offers o
       JOIN commitment_responses cr
         ON cr.workspace_id = o.workspace_id
        AND cr.offer_id = o.id
        AND cr.response = 'accepted'
      WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?
      ORDER BY o.created_at, o.rowid`,
  ).all(scope.workspaceId, scope.eventId, plan.id) as Array<{ id: string }>;
  if (acceptedOffers.length === 0) return { entries: [], units: [] };

  const rows = db.prepare(
    `SELECT o.id AS offerId, o.person_id AS personId,
            o.terms_json AS termsJson, o.terms_fingerprint AS termsFingerprint,
            cr.actor_person_id AS actorPersonId,
            assignment.id AS assignmentId,
            assignment.program_unit_id AS programUnitId,
            assignment.assignment_type AS role,
            unit.name AS unitName, unit.unit_type AS unitType,
            unit.starts_at AS unitStartsAt, unit.ends_at AS unitEndsAt,
            unit.capacity AS capacity,
            person.full_name AS personName,
            person.organization AS organization,
            person.canonical_email AS email
       FROM commitment_offers o
       JOIN commitment_responses cr
         ON cr.workspace_id = o.workspace_id
        AND cr.offer_id = o.id
        AND cr.response = 'accepted'
       JOIN plan_assignments assignment
         ON assignment.workspace_id = o.workspace_id
        AND assignment.plan_version_id = o.plan_version_id
        AND assignment.person_id = o.person_id
       JOIN program_units unit
         ON unit.workspace_id = assignment.workspace_id
        AND unit.event_id = o.event_id
        AND unit.id = assignment.program_unit_id
       JOIN people person
         ON person.workspace_id = o.workspace_id
        AND person.id = o.person_id
      WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?
      ORDER BY o.created_at, o.rowid, assignment.id`,
  ).all(scope.workspaceId, scope.eventId, plan.id) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== acceptedOffers.length) {
    return fail("every accepted commitment must match exactly one current plan assignment.");
  }

  const seenOffers = new Set<string>();
  const seenPeople = new Set<string>();
  const entries: AcceptedInventoryRow[] = rows.map((row) => {
    const offerId = safeId(row.offerId, "accepted offer id");
    const assignmentId = safeId(row.assignmentId, "accepted assignment id");
    const personId = safeId(row.personId, "accepted person id");
    if (seenOffers.has(offerId) || seenPeople.has(personId) || row.actorPersonId !== personId) {
      return fail("accepted commitment cardinality is invalid.");
    }
    seenOffers.add(offerId);
    seenPeople.add(personId);
    const programUnitId = safeId(row.programUnitId, "accepted program unit id");
    const programUnitName = safeText(row.unitName, "accepted program unit name");
    const role = safeText(row.role, "accepted assignment role", 80);
    const startsAt = validInstant(row.unitStartsAt, "accepted program unit start");
    const endsAt = validInstant(row.unitEndsAt, "accepted program unit end");
    if (Date.parse(startsAt) >= Date.parse(endsAt)) return fail("accepted program unit interval is invalid.");
    const termsFingerprint = safeText(row.termsFingerprint, "accepted terms fingerprint", 160);
    let terms: unknown;
    try {
      terms = JSON.parse(String(row.termsJson)) as unknown;
    } catch {
      return fail("accepted commitment terms are invalid.");
    }
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) return fail("accepted commitment terms are invalid.");
    const termRecord = terms as Record<string, unknown>;
    if (!exactObjectKeys(termRecord, [
      "schema", "planVersionId", "planFingerprint", "eventId", "eventName", "timezone",
      "programUnitId", "programUnitName", "role", "startsAt", "endsAt",
    ]) ||
        termRecord.schema !== "commitment-offer-terms/v1" ||
        termRecord.planVersionId !== plan.id ||
        termRecord.planFingerprint !== plan.fingerprint ||
        termRecord.eventId !== event.id ||
        termRecord.eventName !== event.name ||
        termRecord.timezone !== event.timezone ||
        termRecord.programUnitId !== programUnitId ||
        termRecord.programUnitName !== programUnitName ||
        termRecord.role !== role ||
        termRecord.startsAt !== startsAt ||
        termRecord.endsAt !== endsAt ||
        fingerprintOf(termRecord) !== termsFingerprint) {
      return fail("accepted commitment terms do not match the exact approved assignment.");
    }
    const unit = {
      id: programUnitId,
      name: programUnitName,
      unitType: safeText(row.unitType, "program unit type", 80),
      startsAt,
      endsAt,
      capacity: positiveInteger(row.capacity, "program unit capacity"),
    } satisfies ProgramUnitRow;
    return {
      offerId,
      assignmentId,
      personId,
      programUnitId,
      programUnitName,
      role,
      startsAt,
      endsAt,
      termsFingerprint,
      personName: safeText(row.personName, "accepted person name"),
      organization: row.organization === null ? null : safeText(row.organization, "accepted organization"),
      email: safeText(row.email, "accepted person email", 320),
      unitType: unit.unitType,
      capacity: unit.capacity,
    };
  });
  if (seenOffers.size !== acceptedOffers.length) return fail("accepted commitment cardinality is invalid.");
  return {
    entries: entries.sort((first, second) => first.programUnitId.localeCompare(second.programUnitId) || first.personId.localeCompare(second.personId)),
    units: [...new Map(entries.map((entry) => [entry.programUnitId, {
      id: entry.programUnitId,
      name: entry.programUnitName,
      unitType: entry.unitType,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      capacity: entry.capacity,
    } satisfies ProgramUnitRow])).values()].sort((first, second) => first.startsAt.localeCompare(second.startsAt) || first.name.localeCompare(second.name) || first.id.localeCompare(second.id)),
  };
}

function readCfpInventory(
  db: Db,
  scope: CanonicalScope,
): readonly AcceptedCfpScheduleInventoryEntry[] {
  try {
    return readAcceptedCfpScheduleInventory(db, scope);
  } catch {
    return fail("accepted CFP session inventory is invalid.");
  }
}

function mergeProgramUnits(
  acceptedUnits: readonly ProgramUnitRow[],
  cfpInventory: readonly AcceptedCfpScheduleInventoryEntry[],
): ProgramUnitRow[] {
  const byId = new Map<string, ProgramUnitRow>();
  for (const unit of acceptedUnits) byId.set(unit.id, unit);
  for (const entry of cfpInventory) {
    const startsAt = validInstant(entry.startsAt, "accepted CFP session start");
    const endsAt = validInstant(entry.endsAt, "accepted CFP session end");
    if (Date.parse(startsAt) >= Date.parse(endsAt)) return fail("accepted CFP session interval is invalid.");
    const candidate = {
      id: safeId(entry.programUnitId, "accepted CFP session id"),
      name: safeText(entry.programUnitName, "accepted CFP session name"),
      unitType: safeText(entry.unitType, "accepted CFP session type", 80),
      startsAt,
      endsAt,
      capacity: positiveInteger(entry.capacity, "accepted CFP session capacity"),
      abstract: entry.abstract === null ? null : safeText(entry.abstract, "accepted CFP session abstract", 4_000),
      trackId: safeId(entry.trackId, "accepted CFP session track id"),
    } satisfies ProgramUnitRow;
    const prior = byId.get(candidate.id);
    if (prior) {
      if (
        prior.unitType !== candidate.unitType ||
        prior.startsAt !== candidate.startsAt ||
        prior.endsAt !== candidate.endsAt ||
        prior.capacity !== candidate.capacity
      ) {
        return fail("scheduler inventory sources disagree about a program unit.");
      }
    }
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((first, second) =>
    first.startsAt.localeCompare(second.startsAt) ||
    first.name.localeCompare(second.name) ||
    first.id.localeCompare(second.id),
  );
}

export interface CanonicalScheduleAuthority {
  readonly planVersionId: string;
  readonly planFingerprint: string;
  readonly acceptedInventoryFingerprint: string;
  readonly cfpSessionInventoryFingerprint: string;
  readonly cfpSessionAuthorities: readonly CfpScheduleSessionAuthority[];
}

export interface CanonicalScheduleAuthorityCutoff {
  readonly auditEventId: string;
  readonly at: string;
}

function validateHistoricalAcceptedAuthorityTimestamps(
  db: Db,
  scope: CanonicalScope,
  plan: PlanRow,
  cutoffAuditRowid: number,
): void {
  // Keep this query free of timestamp predicates. Canonical spelling must be established before
  // the as-of queries below use SQLite text ordering to include or exclude authority evidence.
  const candidates = db.prepare(
    `SELECT offer.created_at AS offerCreatedAt,
            response.responded_at AS respondedAt,
            acceptance_audit.created_at AS acceptanceAuditCreatedAt
       FROM commitment_offers offer
       JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id
        AND response.offer_id = offer.id
        AND response.response = 'accepted'
       JOIN audit_events acceptance_audit
         ON acceptance_audit.workspace_id = offer.workspace_id
        AND acceptance_audit.action = 'commitment.accepted'
        AND acceptance_audit.target_type = 'commitment_offer'
        AND acceptance_audit.target_id = offer.id
        AND acceptance_audit.actor_kind = 'person'
        AND acceptance_audit.actor_ref = response.actor_person_id
        AND acceptance_audit.rowid < ?
      WHERE offer.workspace_id = ? AND offer.event_id = ? AND offer.plan_version_id = ?`,
  ).all(cutoffAuditRowid, scope.workspaceId, scope.eventId, plan.id) as unknown as Array<{
    readonly offerCreatedAt: unknown;
    readonly respondedAt: unknown;
    readonly acceptanceAuditCreatedAt: unknown;
  }>;
  for (const candidate of candidates) {
    validInstant(candidate.offerCreatedAt, "historical accepted offer timestamp");
    validInstant(candidate.respondedAt, "historical commitment response timestamp");
    validInstant(candidate.acceptanceAuditCreatedAt, "historical acceptance audit timestamp");
  }
}

function readHistoricalAcceptedInventory(
  db: Db,
  scope: CanonicalScope,
  plan: PlanRow,
  cutoff: { readonly auditRowid: number; readonly at: string },
): AcceptedScheduleInventoryEntry[] {
  validateHistoricalAcceptedAuthorityTimestamps(db, scope, plan, cutoff.auditRowid);
  const acceptedOffers = db.prepare(
    `SELECT offer.id
       FROM commitment_offers offer
       JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id
        AND response.offer_id = offer.id
        AND response.response = 'accepted'
        AND response.responded_at <= ?
       JOIN audit_events acceptance_audit
         ON acceptance_audit.workspace_id = offer.workspace_id
        AND acceptance_audit.action = 'commitment.accepted'
        AND acceptance_audit.target_type = 'commitment_offer'
        AND acceptance_audit.target_id = offer.id
        AND acceptance_audit.actor_kind = 'person'
        AND acceptance_audit.actor_ref = response.actor_person_id
        AND acceptance_audit.created_at <= ?
        AND acceptance_audit.rowid < ?
      WHERE offer.workspace_id = ? AND offer.event_id = ? AND offer.plan_version_id = ?
        AND offer.created_at <= ?
      GROUP BY offer.id
      HAVING COUNT(DISTINCT acceptance_audit.id) = 1
      ORDER BY offer.created_at, offer.rowid`,
  ).all(
    cutoff.at,
    cutoff.at,
    cutoff.auditRowid,
    scope.workspaceId,
    scope.eventId,
    plan.id,
    cutoff.at,
  ) as Array<{ id: string }>;
  if (acceptedOffers.length === 0) return [];

  const rows = db.prepare(
    `SELECT offer.id AS offerId, offer.person_id AS personId,
            offer.terms_json AS termsJson, offer.terms_fingerprint AS termsFingerprint,
            offer.created_at AS offerCreatedAt,
            response.actor_person_id AS actorPersonId,
            response.responded_at AS respondedAt,
            acceptance_audit.details_json AS acceptanceAuditDetailsJson,
            acceptance_audit.created_at AS acceptanceAuditCreatedAt,
            assignment.id AS assignmentId,
            assignment.program_unit_id AS programUnitId,
            assignment.assignment_type AS role
       FROM commitment_offers offer
       JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id
        AND response.offer_id = offer.id
        AND response.response = 'accepted'
        AND response.responded_at <= ?
       JOIN audit_events acceptance_audit
         ON acceptance_audit.workspace_id = offer.workspace_id
        AND acceptance_audit.action = 'commitment.accepted'
        AND acceptance_audit.target_type = 'commitment_offer'
        AND acceptance_audit.target_id = offer.id
        AND acceptance_audit.actor_kind = 'person'
        AND acceptance_audit.actor_ref = response.actor_person_id
        AND acceptance_audit.created_at <= ?
        AND acceptance_audit.rowid < ?
       JOIN plan_assignments assignment
         ON assignment.workspace_id = offer.workspace_id
        AND assignment.plan_version_id = offer.plan_version_id
        AND assignment.person_id = offer.person_id
      WHERE offer.workspace_id = ? AND offer.event_id = ? AND offer.plan_version_id = ?
        AND offer.created_at <= ?
      ORDER BY offer.created_at, offer.rowid, assignment.id`,
  ).all(
    cutoff.at,
    cutoff.at,
    cutoff.auditRowid,
    scope.workspaceId,
    scope.eventId,
    plan.id,
    cutoff.at,
  ) as unknown as Array<Record<string, unknown>>;
  if (rows.length !== acceptedOffers.length) {
    return fail("every historical accepted commitment must match exactly one plan assignment.");
  }

  const seenOffers = new Set<string>();
  const seenPeople = new Set<string>();
  const entries = rows.map((row) => {
    historicalInstantAtOrBefore(row.offerCreatedAt, "historical accepted offer timestamp", cutoff.at);
    historicalInstantAtOrBefore(row.respondedAt, "historical commitment response timestamp", cutoff.at);
    historicalInstantAtOrBefore(row.acceptanceAuditCreatedAt, "historical acceptance audit timestamp", cutoff.at);
    const offerId = safeId(row.offerId, "historical accepted offer id");
    const assignmentId = safeId(row.assignmentId, "historical accepted assignment id");
    const personId = safeId(row.personId, "historical accepted person id");
    if (seenOffers.has(offerId) || seenPeople.has(personId) || row.actorPersonId !== personId) {
      return fail("historical accepted commitment cardinality is invalid.");
    }
    seenOffers.add(offerId);
    seenPeople.add(personId);

    const programUnitId = safeId(row.programUnitId, "historical accepted program unit id");
    const role = safeText(row.role, "historical accepted assignment role", 80);
    const termsFingerprint = safeText(row.termsFingerprint, "historical accepted terms fingerprint", 160);
    const acceptanceAuditDetailsJson = String(row.acceptanceAuditDetailsJson);
    let acceptanceAuditDetails: unknown;
    try {
      acceptanceAuditDetails = JSON.parse(acceptanceAuditDetailsJson) as unknown;
    } catch {
      return fail("historical accepted commitment audit evidence is invalid.");
    }
    if (!acceptanceAuditDetails || typeof acceptanceAuditDetails !== "object" || Array.isArray(acceptanceAuditDetails)) {
      return fail("historical accepted commitment audit evidence is invalid.");
    }
    const auditRecord = acceptanceAuditDetails as Record<string, unknown>;
    const auditKeys = Object.keys(auditRecord);
    if (
      (auditKeys.length !== 3 && auditKeys.length !== 4) ||
      auditKeys.some((key) => !["eventId", "planVersionId", "termsFingerprint", "commandKey"].includes(key)) ||
      auditRecord.eventId !== scope.eventId ||
      auditRecord.planVersionId !== plan.id ||
      auditRecord.termsFingerprint !== termsFingerprint
    ) {
      return fail("historical accepted commitment audit evidence is invalid.");
    }
    const commandKey = "commandKey" in auditRecord
      ? safeId(auditRecord.commandKey, "historical accepted command key")
      : undefined;
    const expectedAcceptanceAuditDetailsJson = JSON.stringify({
      eventId: scope.eventId,
      planVersionId: plan.id,
      termsFingerprint,
      ...(commandKey === undefined ? {} : { commandKey }),
    });
    if (acceptanceAuditDetailsJson !== expectedAcceptanceAuditDetailsJson) {
      return fail("historical accepted commitment audit evidence is invalid.");
    }
    let terms: unknown;
    try {
      terms = JSON.parse(String(row.termsJson)) as unknown;
    } catch {
      return fail("historical accepted commitment terms are invalid.");
    }
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
      return fail("historical accepted commitment terms are invalid.");
    }
    const termRecord = terms as Record<string, unknown>;
    if (!exactObjectKeys(termRecord, [
      "schema", "planVersionId", "planFingerprint", "eventId", "eventName", "timezone",
      "programUnitId", "programUnitName", "role", "startsAt", "endsAt",
    ]) ||
        termRecord.schema !== "commitment-offer-terms/v1" ||
        termRecord.planVersionId !== plan.id ||
        termRecord.planFingerprint !== plan.fingerprint ||
        termRecord.eventId !== scope.eventId ||
        termRecord.programUnitId !== programUnitId ||
        termRecord.role !== role ||
        fingerprintOf(termRecord) !== termsFingerprint) {
      return fail("historical accepted commitment terms do not match the immutable assignment.");
    }
    safeText(termRecord.eventName, "historical accepted event name");
    safeText(termRecord.timezone, "historical accepted event timezone", 120);
    const programUnitName = safeText(termRecord.programUnitName, "historical accepted program unit name");
    const startsAt = validInstant(termRecord.startsAt, "historical accepted program unit start");
    const endsAt = validInstant(termRecord.endsAt, "historical accepted program unit end");
    if (Date.parse(startsAt) >= Date.parse(endsAt)) {
      return fail("historical accepted program unit interval is invalid.");
    }
    return {
      offerId,
      assignmentId,
      personId,
      programUnitId,
      programUnitName,
      role,
      startsAt,
      endsAt,
      termsFingerprint,
    } satisfies AcceptedScheduleInventoryEntry;
  });
  if (seenOffers.size !== acceptedOffers.length) {
    return fail("historical accepted commitment cardinality is invalid.");
  }
  return entries.sort((first, second) =>
    first.programUnitId.localeCompare(second.programUnitId) || first.personId.localeCompare(second.personId),
  );
}

function validateHistoricalPlanAuthorityTimestamps(
  db: Db,
  scope: CanonicalScope,
  cutoffAuditRowid: number,
): void {
  // Keep this query free of timestamp predicates. A noncanonical future-looking spelling can be
  // normalization-equivalent to the cutoff while sorting after it lexically.
  const candidates = db.prepare(
    `WITH candidate_approvals AS (
       SELECT plan.id AS planVersionId,
              plan.created_at AS planCreatedAt,
              approval.created_at AS approvalCreatedAt,
              approval_audit.created_at AS approvalAuditCreatedAt
         FROM plan_versions plan
         JOIN approvals approval
           ON approval.workspace_id = plan.workspace_id
          AND approval.event_id = plan.event_id
          AND approval.plan_version_id = plan.id
          AND approval.decision = 'approved'
         JOIN audit_events approval_audit
           ON approval_audit.workspace_id = approval.workspace_id
          AND approval_audit.action = 'plan.approved'
          AND approval_audit.target_type = 'plan_version'
          AND approval_audit.target_id = approval.plan_version_id
          AND approval_audit.actor_kind = 'account'
          AND approval_audit.actor_ref = approval.actor_account_id
        WHERE plan.workspace_id = ? AND plan.event_id = ?
          AND approval_audit.rowid < ?
     )
     SELECT planCreatedAt AS timestamp, 'historical plan timestamp' AS label
       FROM candidate_approvals
     UNION ALL
     SELECT approvalCreatedAt AS timestamp, 'historical approval timestamp' AS label
       FROM candidate_approvals
     UNION ALL
     SELECT approvalAuditCreatedAt AS timestamp, 'historical approval audit timestamp' AS label
       FROM candidate_approvals
     UNION ALL
     SELECT state.created_at AS timestamp, 'historical plan state timestamp' AS label
       FROM plan_states state
       JOIN candidate_approvals candidate
         ON candidate.planVersionId = state.plan_version_id
      WHERE state.workspace_id = ?`,
  ).all(
    scope.workspaceId,
    scope.eventId,
    cutoffAuditRowid,
    scope.workspaceId,
  ) as unknown as Array<{ readonly timestamp: unknown; readonly label: string }>;
  for (const candidate of candidates) {
    validInstant(candidate.timestamp, candidate.label);
  }

  // Validate the writer encoding independently of the as-of query. Filtering on exact details
  // first would let duplicate-key or otherwise non-writer JSON hide a newer approval and
  // incorrectly resurrect an older plan at the same timestamp.
  const approvalAudits = db.prepare(
    `SELECT plan.id AS planVersionId, approval.id AS approvalId,
            approval_audit.details_json AS detailsJson
       FROM plan_versions plan
       JOIN approvals approval
         ON approval.workspace_id = plan.workspace_id
        AND approval.event_id = plan.event_id
        AND approval.plan_version_id = plan.id
        AND approval.decision = 'approved'
       JOIN audit_events approval_audit
         ON approval_audit.workspace_id = approval.workspace_id
        AND approval_audit.action = 'plan.approved'
        AND approval_audit.target_type = 'plan_version'
        AND approval_audit.target_id = approval.plan_version_id
        AND approval_audit.actor_kind = 'account'
        AND approval_audit.actor_ref = approval.actor_account_id
      WHERE plan.workspace_id = ? AND plan.event_id = ?
        AND approval_audit.rowid < ?
      ORDER BY plan.rowid, approval.rowid, approval_audit.rowid`,
  ).all(
    scope.workspaceId,
    scope.eventId,
    cutoffAuditRowid,
  ) as unknown as Array<{
    readonly planVersionId: unknown;
    readonly approvalId: unknown;
    readonly detailsJson: unknown;
  }>;
  const approvalIdsByPlan = new Map<string, Set<string>>();
  const auditCountByApproval = new Map<string, number>();
  for (const candidate of approvalAudits) {
    const planVersionId = safeId(candidate.planVersionId, "historical approved plan id");
    const approvalId = safeId(candidate.approvalId, "historical approval id");
    if (candidate.detailsJson !== JSON.stringify({ approvalId })) {
      return fail("historical approval audit evidence is invalid.");
    }
    const approvalIds = approvalIdsByPlan.get(planVersionId) ?? new Set<string>();
    approvalIds.add(approvalId);
    approvalIdsByPlan.set(planVersionId, approvalIds);
    auditCountByApproval.set(approvalId, (auditCountByApproval.get(approvalId) ?? 0) + 1);
  }
  if (
    [...approvalIdsByPlan.values()].some((approvalIds) => approvalIds.size !== 1) ||
    [...auditCountByApproval.values()].some((auditCount) => auditCount !== 1)
  ) {
    return fail("historical approval audit evidence is invalid.");
  }
}

/**
 * Reconstruct the immutable schedule authority at one exact saved-draft audit event. Timestamps
 * bound ordinary history; the immutable audit row order breaks equal-millisecond ties across plan,
 * approval, acceptance, and draft transitions. This allows a later authority to begin a fresh draft
 * without mistaking a valid historical pointer for corruption or making the old draft current.
 */
export function readCanonicalScheduleAuthorityAt(
  db: Db,
  scope: CanonicalScope,
  cutoff: CanonicalScheduleAuthorityCutoff,
): CanonicalScheduleAuthority | null {
  const cutoffAt = validInstant(cutoff.at, "schedule authority timestamp");
  const cutoffAuditEventId = safeId(cutoff.auditEventId, "schedule authority audit event id");
  const cutoffAudit = db.prepare(
    `SELECT rowid, created_at AS createdAt
       FROM audit_events
      WHERE id = ? AND workspace_id = ?
        AND action IN ('schedule.draft.saved', 'schedule.draft.unchanged')
        AND target_type = 'event' AND target_id = ?
      LIMIT 1`,
  ).get(cutoffAuditEventId, scope.workspaceId, scope.eventId) as {
    rowid: number;
    createdAt: string;
  } | undefined;
  if (
    !cutoffAudit ||
    !Number.isSafeInteger(cutoffAudit.rowid) ||
    cutoffAudit.rowid < 1 ||
    cutoffAudit.createdAt !== cutoffAt
  ) {
    return fail("schedule authority cutoff evidence is invalid.");
  }
  validateHistoricalPlanAuthorityTimestamps(db, scope, cutoffAudit.rowid);
  const plans = db.prepare(
    `SELECT plan.id, plan.fingerprint,
            plan.created_at AS planCreatedAt,
            approval.created_at AS approvalCreatedAt,
            approval_audit.created_at AS approvalAuditCreatedAt,
            (SELECT state.created_at
               FROM plan_states state
              WHERE state.workspace_id = plan.workspace_id
                AND state.plan_version_id = plan.id
                AND state.created_at <= ?
              ORDER BY state.created_at DESC, state.rowid DESC
              LIMIT 1) AS stateCreatedAt
       FROM plan_versions plan
       JOIN approvals approval
         ON approval.workspace_id = plan.workspace_id
        AND approval.event_id = plan.event_id
        AND approval.plan_version_id = plan.id
        AND approval.decision = 'approved'
        AND approval.created_at <= ?
       JOIN audit_events approval_audit
         ON approval_audit.workspace_id = approval.workspace_id
        AND approval_audit.action = 'plan.approved'
        AND approval_audit.target_type = 'plan_version'
        AND approval_audit.target_id = approval.plan_version_id
        AND approval_audit.actor_kind = 'account'
        AND approval_audit.actor_ref = approval.actor_account_id
        AND approval_audit.details_json = json_object('approvalId', approval.id)
        AND approval_audit.created_at <= ?
        AND approval_audit.rowid < ?
      WHERE plan.workspace_id = ? AND plan.event_id = ?
        AND plan.created_at <= ?
        AND (SELECT state.state
               FROM plan_states state
              WHERE state.workspace_id = plan.workspace_id
                AND state.plan_version_id = plan.id
                AND state.created_at <= ?
              ORDER BY state.created_at DESC, state.rowid DESC
              LIMIT 1) = 'approved'
        AND (SELECT state.actor_account_id
               FROM plan_states state
              WHERE state.workspace_id = plan.workspace_id
                AND state.plan_version_id = plan.id
                AND state.created_at <= ?
              ORDER BY state.created_at DESC, state.rowid DESC
              LIMIT 1) = approval.actor_account_id
      GROUP BY plan.id
      HAVING COUNT(DISTINCT approval.id) = 1
         AND COUNT(DISTINCT approval_audit.id) = 1
      ORDER BY plan.version_number DESC, plan.created_at DESC, plan.rowid DESC
      LIMIT 2`,
  ).all(
    cutoffAt,
    cutoffAt,
    cutoffAt,
    cutoffAudit.rowid,
    scope.workspaceId,
    scope.eventId,
    cutoffAt,
    cutoffAt,
    cutoffAt,
  ) as unknown as HistoricalPlanRow[];
  for (const candidate of plans) {
    historicalInstantAtOrBefore(candidate.planCreatedAt, "historical plan timestamp", cutoffAt);
    historicalInstantAtOrBefore(candidate.approvalCreatedAt, "historical approval timestamp", cutoffAt);
    historicalInstantAtOrBefore(candidate.approvalAuditCreatedAt, "historical approval audit timestamp", cutoffAt);
    historicalInstantAtOrBefore(candidate.stateCreatedAt, "historical plan state timestamp", cutoffAt);
  }
  const plan = plans[0];
  if (!plan || !/^[a-f0-9]{64}$/u.test(plan.fingerprint)) return null;
  const inventory = readHistoricalAcceptedInventory(db, scope, plan, {
    auditRowid: cutoffAudit.rowid,
    at: cutoffAt,
  });
  let cfpInventory: readonly AcceptedCfpScheduleInventoryEntry[];
  try {
    cfpInventory = readAcceptedCfpScheduleInventoryAt(db, scope, {
      auditRowid: cutoffAudit.rowid,
      at: cutoffAt,
    });
  } catch {
    return fail("historical accepted CFP inventory is invalid.");
  }
  if (inventory.length === 0 && cfpInventory.length === 0) return null;
  return Object.freeze({
    planVersionId: plan.id,
    planFingerprint: plan.fingerprint,
    acceptedInventoryFingerprint: acceptedInventoryFingerprint(inventory),
    cfpSessionInventoryFingerprint: cfpSessionInventoryFingerprint(cfpInventory),
    cfpSessionAuthorities: Object.freeze(cfpSessionAuthorities(cfpInventory)),
  });
}

function readAllocations(db: Db, scope: CanonicalScope, unitIds: readonly string[]): AllocationRow[] {
  if (unitIds.length === 0) return [];
  const placeholders = unitIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT id, program_unit_id AS programUnitId, room_id AS roomId,
            track_id AS trackId, starts_at AS startsAt, ends_at AS endsAt,
            allocation_status AS allocationStatus
       FROM event_session_allocations
      WHERE workspace_id = ? AND event_id = ? AND program_unit_id IN (${placeholders})
      ORDER BY program_unit_id, id`,
  ).all(scope.workspaceId, scope.eventId, ...unitIds) as unknown as AllocationRow[];
  const seen = new Set<string>();
  return rows.map((row) => {
    if (seen.has(row.programUnitId)) return fail("multiple allocations exist for one program unit.");
    seen.add(row.programUnitId);
    const allocation = {
      id: safeId(row.id, "allocation id"),
      programUnitId: safeId(row.programUnitId, "allocation program unit id"),
      roomId: safeId(row.roomId, "allocation room id"),
      trackId: row.trackId === null ? null : safeId(row.trackId, "allocation track id"),
      startsAt: validInstant(row.startsAt, "allocation start"),
      endsAt: validInstant(row.endsAt, "allocation end"),
      allocationStatus: safeText(row.allocationStatus, "allocation status", 32),
    } satisfies AllocationRow;
    if (allocation.allocationStatus !== "DRAFT" && allocation.allocationStatus !== "PUBLISHED" && allocation.allocationStatus !== "CANCELLED") {
      return fail("allocation status is invalid.");
    }
    if (Date.parse(allocation.startsAt) >= Date.parse(allocation.endsAt)) return fail("allocation interval is invalid.");
    return allocation;
  });
}

function readResources(
  db: Db,
  scope: CanonicalScope,
  units: readonly ProgramUnitRow[],
  cfpInventory: readonly AcceptedCfpScheduleInventoryEntry[],
): {
  readonly rooms: ScheduleRoom[];
  readonly tracks: ScheduleTrack[];
  readonly persisted: boolean;
} {
  const roomRows = db.prepare(
    `SELECT id, name, capacity
       FROM event_rooms
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY created_at, id`,
  ).all(scope.workspaceId, scope.eventId) as unknown as EventResourceRow[];
  const trackRows = db.prepare(
    `SELECT id, name
       FROM event_tracks
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY created_at, id`,
  ).all(scope.workspaceId, scope.eventId) as unknown as EventResourceRow[];
  const capacity = Math.max(1, ...units.map((unit) => unit.capacity));
  const rooms = (roomRows.length > 0
    ? roomRows
    : [{ id: defaultResourceId(scope, "room"), name: DEFAULT_ROOM_NAME, capacity }]
  ).map((row) => ({
    id: safeId(row.id, "room id"),
    name: safeText(row.name, "room name"),
    venue: DEFAULT_VENUE,
    capacity: positiveInteger(row.capacity ?? capacity, "room capacity"),
  }));
  const trackById = new Map<string, { readonly id: string; readonly name: string }>();
  for (const row of trackRows) {
    const track = { id: safeId(row.id, "track id"), name: safeText(row.name, "track name", 120) };
    if (trackById.has(track.id)) return fail("duplicate event track identity is invalid.");
    trackById.set(track.id, track);
  }
  const cfpTrackIds = new Set(cfpInventory.map((entry) => entry.trackId));
  const scopedDefaultTrackId = defaultResourceId(scope, "track");
  const needsGeneralTrack = units.some((unit) => unit.trackId === undefined);
  const hasGeneralPersistedTrack = [...trackById.keys()].some((id) => !cfpTrackIds.has(id));
  if (needsGeneralTrack && !hasGeneralPersistedTrack) {
    trackById.set(scopedDefaultTrackId, { id: scopedDefaultTrackId, name: DEFAULT_TRACK_NAME });
  }
  for (const entry of cfpInventory) {
    const id = safeId(entry.trackId, "accepted CFP track id");
    const name = safeText(entry.trackName, "accepted CFP track name", 120);
    const prior = trackById.get(id);
    if (prior && prior.name !== name) return fail("accepted CFP track authority is inconsistent.");
    trackById.set(id, { id, name });
  }
  if (trackById.size === 0) {
    trackById.set(scopedDefaultTrackId, { id: scopedDefaultTrackId, name: DEFAULT_TRACK_NAME });
  }
  const tracks = [...trackById.values()]
    .sort((first, second) =>
      first.id === scopedDefaultTrackId ? -1 : second.id === scopedDefaultTrackId ? 1 : 0
    )
    .map((row, index) => ({
    id: row.id,
    name: row.name,
    ordinal: index + 1,
    }));
  return { rooms, tracks, persisted: roomRows.length > 0 && trackRows.length > 0 };
}

function readSpeakers(inventory: readonly ScheduleSpeakerInventoryRow[]): {
  readonly speakers: ScheduleSpeaker[];
  readonly byUnit: ReadonlyMap<string, readonly string[]>;
} {
  const speakers = new Map<string, ScheduleSpeaker>();
  const byUnit = new Map<string, string[]>();
  for (const row of inventory) {
    const personId = row.personId;
    const unitId = row.programUnitId;
    if (!speakers.has(personId)) {
      speakers.set(personId, {
        id: personId,
        slug: personId,
        displayName: row.personName,
        publicName: row.personName,
        organization: row.organization ?? "",
        bio: "",
        email: row.email,
        public: true,
      });
    }
    const unitSpeakers = byUnit.get(unitId) ?? [];
    if (!unitSpeakers.includes(personId)) unitSpeakers.push(personId);
    byUnit.set(unitId, unitSpeakers);
  }
  return { speakers: [...speakers.values()], byUnit };
}

function readSlots(
  event: ScheduleEvent,
  units: readonly ProgramUnitRow[],
  allocations: readonly AllocationRow[],
): { readonly days: ScheduleDay[]; readonly slots: ScheduleTimeSlot[] } {
  const intervals = new Map<string, { startsAt: string; endsAt: string }>();
  for (const unit of units) intervals.set(`${unit.startsAt}:${unit.endsAt}`, { startsAt: unit.startsAt, endsAt: unit.endsAt });
  for (const allocation of allocations) intervals.set(`${allocation.startsAt}:${allocation.endsAt}`, { startsAt: allocation.startsAt, endsAt: allocation.endsAt });
  intervals.set(`${event.startsAt}:${event.endsAt}`, { startsAt: event.startsAt, endsAt: event.endsAt });
  const orderedIntervals = [...intervals.values()].sort((first, second) => first.startsAt.localeCompare(second.startsAt) || first.endsAt.localeCompare(second.endsAt));
  const dates = new Set<string>([datePart(event.startsAt), datePart(event.endsAt), ...orderedIntervals.flatMap((interval) => [datePart(interval.startsAt), datePart(interval.endsAt)])]);
  const orderedDates = [...dates].sort();
  const days = orderedDates.map((date, index) => ({ id: dayId(date), date, label: dayLabel(date), ordinal: index + 1 }));
  const slots = orderedIntervals.map((interval, index) => ({
    id: safeId(slotId(interval.startsAt, interval.endsAt), "time slot id"),
    dayId: dayId(datePart(interval.startsAt)),
    label: `${interval.startsAt.slice(11, 16)}–${interval.endsAt.slice(11, 16)}`,
    startsAt: interval.startsAt,
    endsAt: interval.endsAt,
    ordinal: index + 1,
  }));
  return { days, slots };
}

function placementFor(
  startsAt: string,
  endsAt: string,
  roomId: string,
  trackId: string,
  slots: readonly ScheduleTimeSlot[],
): SchedulePlacement | null {
  const slot = slots.find((candidate) => candidate.startsAt === startsAt && candidate.endsAt === endsAt);
  if (!slot) return null;
  return {
    dayId: slot.dayId,
    timeSlotId: slot.id,
    roomId,
    trackId,
    startsAt,
    endsAt,
  };
}

function canonicalBase(
  scope: CanonicalScope,
  event: ScheduleEvent,
  units: readonly ProgramUnitRow[],
  resources: { readonly rooms: ScheduleRoom[]; readonly tracks: ScheduleTrack[]; readonly persisted: boolean },
  allocations: readonly AllocationRow[],
  speakers: { readonly speakers: ScheduleSpeaker[]; readonly byUnit: ReadonlyMap<string, readonly string[]> },
  plan: PlanRow,
  acceptedInventory: readonly AcceptedInventoryRow[],
  cfpInventory: readonly AcceptedCfpScheduleInventoryEntry[],
): ScheduleSnapshot {
  const { days, slots } = readSlots(event, units, allocations);
  const allocationByUnit = new Map(allocations.map((allocation) => [allocation.programUnitId, allocation]));
  const cfpUnitIds = new Set(cfpInventory.map((entry) => entry.programUnitId));
  const defaultRoom = resources.rooms[0]!;
  const defaultTrack = resources.tracks[0]!;
  const sessions: ScheduleSession[] = units.map((unit, index) => {
    const allocation = allocationByUnit.get(unit.id);
    const cancelled = allocation?.allocationStatus === "CANCELLED";
    const activeAllocation = allocation && !cancelled ? allocation : null;
    const roomId = activeAllocation?.roomId ?? defaultRoom.id;
    const sessionTrackId = unit.trackId ?? defaultTrack.id;
    const placementTrackId = activeAllocation?.trackId ?? sessionTrackId;
    const placement = cancelled
      ? null
      : activeAllocation
        ? placementFor(activeAllocation.startsAt, activeAllocation.endsAt, roomId, placementTrackId, slots)
        : resources.persisted && !cfpUnitIds.has(unit.id)
          ? placementFor(unit.startsAt, unit.endsAt, roomId, sessionTrackId, slots)
          : null;
    if (activeAllocation && !placement) return fail("allocation does not map to a canonical time slot.");
    return {
      id: unit.id,
      slug: unit.id,
      title: unit.name,
      abstract: unit.abstract ?? "",
      durationMinutes: durationMinutes(unit.startsAt, unit.endsAt),
      capacity: unit.capacity,
      trackId: sessionTrackId,
      speakerIds: [...(speakers.byUnit.get(unit.id) ?? [])],
      priority: Math.max(1, units.length - index),
      public: true,
      placement,
    };
  });
  const schedule: ScheduleSnapshot = {
    schema: "schedule-draft/v1",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    status: "DRAFT",
    revision: 1,
    event,
    days,
    tracks: resources.tracks,
    rooms: resources.rooms,
    timeSlots: slots,
    speakers: speakers.speakers,
    sessions,
    planVersionId: plan.id,
    planFingerprint: plan.fingerprint,
    acceptedInventoryFingerprint: acceptedInventoryFingerprint(acceptedInventory),
    cfpSessionInventoryFingerprint: cfpSessionInventoryFingerprint(cfpInventory),
    cfpSessionAuthorities: cfpSessionAuthorities(cfpInventory),
    approvedAt: null,
  };
  return immutableSchedule(schedule);
}

export function readCanonicalScheduleProjection(
  db: Db,
  scope: CanonicalScope,
  eventRow: Record<string, unknown>,
): ScheduleSnapshot | null {
  const event = scheduleEvent(scope, eventRow);
  const plan = readApprovedPlan(db, scope, eventRow);
  if (!plan) return null;
  const acceptedInventory = readAcceptedInventory(db, scope, event, plan);
  const cfpInventory = readCfpInventory(db, scope);
  if (acceptedInventory.entries.length === 0 && cfpInventory.length === 0) return null;
  const units = mergeProgramUnits(acceptedInventory.units, cfpInventory);
  const resources = readResources(db, scope, units, cfpInventory);
  const allocations = readAllocations(db, scope, units.map((unit) => unit.id));
  const speakerProjection = readSpeakers([
    ...acceptedInventory.entries,
    ...cfpInventory.flatMap((entry) => entry.links.map((link) => ({
      personId: link.speakerPersonId,
      programUnitId: entry.programUnitId,
      personName: link.speakerName,
      organization: link.speakerOrganization,
      email: link.speakerEmail,
    }))),
  ]);
  return canonicalBase(
    scope,
    event,
    units,
    resources,
    allocations,
    speakerProjection,
    plan,
    acceptedInventory.entries,
    cfpInventory,
  );
}

function scheduleUsesCanonicalUnits(db: Db, scope: CanonicalScope, schedule: ScheduleSnapshot): boolean {
  const ids = new Set((db.prepare(
    `SELECT id FROM program_units WHERE workspace_id = ? AND event_id = ?`,
  ).all(scope.workspaceId, scope.eventId) as Array<{ id: string }>).map((row) => row.id));
  return ids.size > 0 && schedule.sessions.length > 0 && schedule.sessions.every((session) => ids.has(session.id));
}

function upsertRoom(db: Db, scope: CanonicalScope, room: ScheduleRoom, timestamp: string): void {
  const existing = db.prepare(
    `SELECT id FROM event_rooms WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, room.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE event_rooms SET name = ?, capacity = ? WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).run(room.name, room.capacity, scope.workspaceId, scope.eventId, room.id);
    return;
  }
  db.prepare(
    `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(room.id, scope.workspaceId, scope.eventId, room.name, room.capacity, timestamp);
}

function upsertTrack(db: Db, scope: CanonicalScope, track: ScheduleTrack, timestamp: string): void {
  const existing = db.prepare(
    `SELECT id FROM event_tracks WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, track.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE event_tracks SET name = ? WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).run(track.name, scope.workspaceId, scope.eventId, track.id);
    return;
  }
  db.prepare(
    `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(track.id, scope.workspaceId, scope.eventId, track.name, track.id, timestamp);
}

function placementKey(placement: SchedulePlacement | null): string {
  return placement ? JSON.stringify(placement) : "null";
}

export function persistCanonicalScheduleMutation(
  db: Db,
  scope: CanonicalScope,
  previous: ScheduleSnapshot,
  next: ScheduleSnapshot,
  timestamp = nowIso(),
): void {
  timestamp = validInstant(timestamp, "schedule mutation timestamp");
  if (!scheduleUsesCanonicalUnits(db, scope, previous) || !scheduleUsesCanonicalUnits(db, scope, next)) return;
  for (const entry of readCfpInventory(db, scope)) {
    const track = next.tracks.find((candidate) => candidate.id === entry.trackId);
    if (!track || track.name !== entry.trackName) {
      return fail("accepted CFP track authority cannot be removed or renamed by a schedule draft.");
    }
  }
  for (const room of next.rooms) upsertRoom(db, scope, room, timestamp);
  for (const track of next.tracks) upsertTrack(db, scope, track, timestamp);

  // An approved-plan or accepted-inventory transition can remove a formerly selected program
  // unit from the canonical schedule. Retain its allocation as history, but cancel it before
  // materializing current defaults so obsolete room occupancy cannot block the new authority.
  const currentSessionIds = new Set(next.sessions.map((session) => session.id));
  const activeAllocations = db.prepare(
    `SELECT id, program_unit_id AS programUnitId
       FROM event_session_allocations
      WHERE workspace_id = ? AND event_id = ? AND allocation_status <> 'CANCELLED'`,
  ).all(scope.workspaceId, scope.eventId) as unknown as Array<{ id: string; programUnitId: string }>;
  for (const allocation of activeAllocations) {
    if (currentSessionIds.has(allocation.programUnitId)) continue;
    db.prepare(
      `UPDATE event_session_allocations
          SET allocation_status = 'CANCELLED', updated_at = ?
        WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).run(timestamp, scope.workspaceId, scope.eventId, allocation.id);
  }

  const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
  for (const session of next.sessions) {
    const prior = previousById.get(session.id);
    const allocation = db.prepare(
      `SELECT id FROM event_session_allocations
        WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?
        LIMIT 1`,
    ).get(scope.workspaceId, scope.eventId, session.id) as { id: string } | undefined;
    // Persisted resources can give a newly accepted session a deterministic default placement
    // before an allocation row exists. Equal before/after geometry is not a durable no-op in that
    // case: materialize the allocation so publication never seals a browser-only/default guess.
    if (allocation && prior && placementKey(prior.placement) === placementKey(session.placement)) continue;
    if (session.placement) {
      const allocationId = allocation?.id ?? deterministicUuid(`schedule-allocation:${scope.workspaceId}:${scope.eventId}:${session.id}`);
      if (allocation) {
        db.prepare(
          `UPDATE event_session_allocations
              SET room_id = ?, track_id = ?, starts_at = ?, ends_at = ?, allocation_status = 'DRAFT', updated_at = ?
            WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ? AND id = ?`,
        ).run(session.placement.roomId, session.placement.trackId, session.placement.startsAt, session.placement.endsAt, timestamp, scope.workspaceId, scope.eventId, session.id, allocationId);
      } else {
        db.prepare(
          `INSERT INTO event_session_allocations
             (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, allocation_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        ).run(allocationId, scope.workspaceId, scope.eventId, session.id, session.placement.roomId, session.placement.trackId, session.placement.startsAt, session.placement.endsAt, timestamp, timestamp);
      }
    } else if (allocation) {
      db.prepare(
        `UPDATE event_session_allocations
            SET allocation_status = 'CANCELLED', updated_at = ?
          WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ? AND id = ?`,
      ).run(timestamp, scope.workspaceId, scope.eventId, session.id, allocation.id);
    }
  }
}
