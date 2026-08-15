import { Buffer } from "node:buffer";

import {
  assertWorkspaceMatch,
  roleHasCapability,
  type SessionInfo,
} from "../auth";
import { canonicalJson, deterministicUuid, fingerprintOf } from "../canonical";
import type { Db } from "../db";
import { readCfpSubmissionDecision } from "./cfp/decisions";
import {
  queryInstitutionalMemory,
  type InstitutionalMemoryResult,
  type MemorySourceRecord,
} from "./institutional-memory";

/**
 * A read-only, person-centric projection over canonical records. The lens deliberately has no
 * authorization output: historical evidence can inform an organizer, but it cannot make any
 * prior decision, relationship, task state, or approval current for another event.
 */
export const RETURNER_LENS_SCHEMA = "sympose-returner-lens/v1" as const;
export const RETURNER_LENS_MAX_PEOPLE = 100;
export const RETURNER_LENS_MAX_EVENTS = 32;
export const RETURNER_LENS_MAX_ENTRIES = 400;
const RETURNER_LENS_MAX_LINEAGES = 8;
const CONTENT_EVENT_LIMIT = 200;

export type ReturnerTruthLayer =
  | "candidate"
  | "decision"
  | "commitment"
  | "operational"
  | "evidence";

export type ReturnerEvidenceFamily =
  | "application"
  | "proposal-review"
  | "proposal-decision"
  | "prior-guidance"
  | "candidate-assignment"
  | "plan-decision"
  | "commitment"
  | "session-role"
  | "operational-observation"
  | "readiness-task"
  | "editorial-version"
  | "editorial-review"
  | "artifact"
  | "source-evidence"
  | "cohort-evidence";

export interface ReturnerSourceReference {
  readonly label: string;
  readonly value: string;
}

export interface ReturnerLensEntry {
  readonly id: string;
  readonly eventId: string | null;
  readonly family: ReturnerEvidenceFamily;
  readonly truthLayer: ReturnerTruthLayer;
  readonly title: string;
  readonly detail: string;
  readonly recordedAt: string;
  readonly dueAt?: string;
  readonly currentUse: "historical" | "current-record" | "snapshot-at-read" | "not-applicable";
  readonly carriesAuthorityForward: false;
  readonly fingerprint: string | null;
  readonly fingerprintOrigin: "stored" | "derived-from-immutable-source" | "not-stored";
  readonly references: readonly ReturnerSourceReference[];
}

export interface ReturnerPersonSummary {
  readonly id: string;
  readonly fullName: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly returnerState: "MULTI_EVENT" | "SINGLE_EVENT" | "NO_EVENT_EVIDENCE";
}

export interface ReturnerEventHistory {
  readonly event: {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly lifecycle: string;
  };
  readonly entries: readonly ReturnerLensEntry[];
}

export interface ReturnerCoverageItem {
  readonly key: string;
  readonly label: string;
  readonly state: "PRESENT" | "EMPTY" | "UNAVAILABLE" | "WITHHELD" | "NOT_EVALUATED";
  readonly detail: string;
}

export interface ReturnerLensResult {
  readonly schema: typeof RETURNER_LENS_SCHEMA;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly readOnly: true;
  readonly authorityCarryover: false;
  readonly people: readonly ReturnerPersonSummary[];
  readonly selectedPerson: ReturnerPersonSummary | null;
  readonly eventHistory: readonly ReturnerEventHistory[];
  readonly workspaceEvidence: readonly ReturnerLensEntry[];
  readonly counts: {
    readonly eventsWithEvidence: number;
    readonly historicalRecords: number;
    readonly applications: number;
    readonly decisions: number;
    readonly sessionRoles: number;
    readonly editorialRecords: number;
  };
  readonly currentAuthorization: {
    readonly state: "NOT_EVALUATED";
    readonly carriesFromHistory: false;
    readonly detail: string;
  };
  readonly coverage: readonly ReturnerCoverageItem[];
}

export type ReturnerLensErrorCode =
  | "INPUT_INVALID"
  | "AUTHORIZATION_DENIED"
  | "TARGET_UNAVAILABLE"
  | "READ_FAILED"
  | "BOUND_EXCEEDED";

const ERROR_MESSAGES: Record<ReturnerLensErrorCode, string> = {
  INPUT_INVALID: "The returner-lens query is invalid.",
  AUTHORIZATION_DENIED: "The returner-lens query is not available.",
  TARGET_UNAVAILABLE: "The returner-lens target is not available.",
  READ_FAILED: "The returner-lens evidence could not be read safely.",
  BOUND_EXCEEDED: "The returner-lens result exceeds the bounded query limit.",
};

export class ReturnerLensError extends Error {
  readonly code: ReturnerLensErrorCode;

  constructor(code: ReturnerLensErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ReturnerLensError";
    this.code = code;
  }
}

function fail(code: ReturnerLensErrorCode): never {
  throw new ReturnerLensError(code);
}

const IDENTIFIER = /^[^\u0000-\u001F\u007F-\u009F]{1,128}$/u;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownRecord(value: unknown, error: ReturnerLensErrorCode = "READ_FAILED"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(error);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") fail(error);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail(error);
    output[key] = descriptor.value;
  }
  return output;
}

function normalizeInput(input: unknown): { readonly workspaceSlug: string; readonly personId?: string } {
  const value = ownRecord(input, "INPUT_INVALID");
  if (
    !Object.prototype.hasOwnProperty.call(value, "workspaceSlug") ||
    Object.keys(value).some((key) => key !== "workspaceSlug" && key !== "personId") ||
    typeof value.workspaceSlug !== "string" ||
    !IDENTIFIER.test(value.workspaceSlug)
  ) fail("INPUT_INVALID");
  if (value.personId !== undefined && value.personId !== null &&
    (typeof value.personId !== "string" || !IDENTIFIER.test(value.personId))) fail("INPUT_INVALID");
  return freeze({
    workspaceSlug: value.workspaceSlug,
    ...(typeof value.personId === "string" ? { personId: value.personId } : {}),
  });
}

function text(value: unknown, maxBytes = 4096): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("READ_FAILED");
  }
  return value;
}

function nullableText(value: unknown, maxBytes = 4096): string | null {
  return value === null ? null : text(value, maxBytes);
}

function eventTimezone(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" || CONTROL.test(value) || Buffer.byteLength(value, "utf8") > 128) fail("READ_FAILED");
  return value;
}

function id(value: unknown): string {
  const stored = text(value, 128);
  if (!IDENTIFIER.test(stored)) fail("READ_FAILED");
  return stored;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value) || new Date(value).toISOString() !== value) fail("READ_FAILED");
  return value;
}

type CfpSubmissionState = "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";

function cfpSubmissionState(value: unknown): CfpSubmissionState {
  const state = text(value, 32);
  if (state !== "DRAFT" && state !== "SUBMITTED" && state !== "WITHDRAWN" && state !== "INVALIDATED") {
    fail("READ_FAILED");
  }
  return state;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !HEX_64.test(value)) fail("READ_FAILED");
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("READ_FAILED");
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("READ_FAILED");
}

function parseCanonical(value: unknown, maxBytes = 524_288): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) fail("READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("READ_FAILED");
  }
  const record = ownRecord(parsed);
  if (canonicalJson(record) !== value) fail("READ_FAILED");
  return record;
}

function parseJsonRecord(value: unknown, maxBytes = 524_288): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) fail("READ_FAILED");
  try {
    return ownRecord(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof ReturnerLensError) throw error;
    return fail("READ_FAILED");
  }
}

function sessionIsCurrent(db: Db, session: SessionInfo): boolean {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare(`SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.expires_at,
        a.email, a.display_name, a.role, w.slug, w.name
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?`).get(session.id) as Record<string, unknown> | undefined;
  } catch {
    fail("READ_FAILED");
  }
  return !!row && row.id === session.id && row.token_hash === session.tokenHash &&
    row.account_id === session.accountId && row.workspace_id === session.workspaceId &&
    row.expires_at === session.expiresAt && row.email === session.email &&
    row.display_name === session.displayName && row.role === session.role &&
    row.slug === session.workspaceSlug && row.name === session.workspaceName &&
    ISO.test(session.expiresAt) && session.expiresAt >= new Date().toISOString();
}

function authorize(db: Db, session: SessionInfo, workspaceSlug: string): void {
  try {
    assertWorkspaceMatch(session, workspaceSlug);
    if (!roleHasCapability(session.role, "phase0.pipeline.manage") || !sessionIsCurrent(db, session)) {
      fail("AUTHORIZATION_DENIED");
    }
  } catch (error) {
    if (error instanceof ReturnerLensError) throw error;
    fail("AUTHORIZATION_DENIED");
  }
}

function readSnapshot<T>(db: Db, session: SessionInfo, workspaceSlug: string, read: () => T): T {
  if (db.isTransaction) fail("READ_FAILED");
  if (session.workspaceSlug !== workspaceSlug) fail("AUTHORIZATION_DENIED");
  try {
    db.exec("BEGIN");
    if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
    const result = read();
    db.exec("COMMIT");
    if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      fail("READ_FAILED");
    }
    if (error instanceof ReturnerLensError) throw error;
    fail("READ_FAILED");
  }
  return fail("READ_FAILED");
}

function sourceReferences(ids: Readonly<Record<string, string>>): readonly ReturnerSourceReference[] {
  return freeze(Object.entries(ids)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([label, value]) => ({ label, value })));
}

function entry(input: Omit<ReturnerLensEntry, "carriesAuthorityForward">): ReturnerLensEntry {
  return freeze({ ...input, carriesAuthorityForward: false });
}

function humanize(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ").toLocaleLowerCase("en-US");
  return words.charAt(0).toLocaleUpperCase("en-US") + words.slice(1);
}

function memoryDataText(source: MemorySourceRecord, key: string): string | null {
  const value = source.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function memoryDataNumber(source: MemorySourceRecord, key: string): number | null {
  const value = source.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeStructuredGuidance(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 12_000) fail("READ_FAILED");
  return serialized;
}

export function projectInstitutionalMemoryForReturnerLens(
  memory: InstitutionalMemoryResult,
): readonly ReturnerLensEntry[] {
  if (memory.authorityCarryover !== false) fail("READ_FAILED");
  return freeze(memory.sources.flatMap((source): ReturnerLensEntry[] => {
    if (source.carriesAuthorityForward !== false) fail("READ_FAILED");
    const common = {
      eventId: source.eventId,
      recordedAt: source.recordedAt,
      currentUse: source.currentUse === "current" ? "current-record" as const :
        source.currentUse === "historical" ? "historical" as const : "not-applicable" as const,
      fingerprint: source.fingerprint,
      fingerprintOrigin: source.fingerprintOrigin,
      references: sourceReferences(source.ids),
    };
    const key = `${source.family}:${Object.entries(source.ids).sort().map(([name, value]) => `${name}:${value}`).join("|")}`;
    switch (source.family) {
      case "submission-revision": {
        const revision = memoryDataNumber(source, "revisionNumber");
        return [entry({ ...common, id: key, family: "application", truthLayer: "candidate",
          title: revision ? `Application revision ${revision}` : "Application revision",
          detail: `${source.currentUse === "current" ? "Current stored submission revision" : "Historical immutable submission revision"}; it does not imply selection, commitment, or authorization.` })];
      }
      case "review-history": {
        const revision = memoryDataNumber(source, "revisionNumber");
        const latest = memoryDataNumber(source, "latestRevisionNumber");
        return [entry({ ...common, id: key, family: "proposal-review", truthLayer: "evidence",
          title: revision ? `Proposal review revision ${revision}${latest ? ` of ${latest}` : ""}` : "Proposal review history",
          detail: "Metadata proves this person’s proposal received a review. Reviewer identity, evaluation content, and notes are not exposed, and the person is not inferred to be a reviewer." })];
      }
      case "lineage": {
        const guidanceVersion = memoryDataText(source, "guidanceVersion");
        if (guidanceVersion) {
          return [entry({ ...common, id: key, family: "prior-guidance", truthLayer: "evidence",
            title: `Prior proposal guidance · ${guidanceVersion}`,
            detail: `Persisted structured guidance:\n${safeStructuredGuidance(source.data.guidance)}` })];
        }
        const relationship = memoryDataText(source, "relationshipType");
        const reason = memoryDataText(source, "reason");
        return [entry({ ...common, id: key, family: "application", truthLayer: "candidate",
          title: relationship ? `Proposal lineage · ${humanize(relationship)}` : "Proposal lineage",
          detail: `${reason ? `Persisted lineage reason: ${reason}` : "Persisted proposal relationship."} This relationship never carries an earlier decision into a new event.` })];
      }
      case "decision-outcome": {
        if (source.data.kind === "decision") return [];
        const observation = memoryDataText(source, "observationType") ?? "recorded outcome";
        const observationSource = memoryDataText(source, "source");
        return [entry({ ...common, id: key, family: "operational-observation", truthLayer: "operational",
          title: `Operational observation · ${humanize(observation)}`,
          detail: `${observationSource ? `Persisted source: ${observationSource}. ` : ""}Only this recorded observation is shown; no wider attendance, delivery quality, or reliability conclusion is inferred.` })];
      }
      case "person-history": {
        const provider = memoryDataText(source, "provider") ?? "source";
        const sourceRef = memoryDataText(source, "sourceRef");
        return [entry({ ...common, id: key, family: "source-evidence", truthLayer: "evidence",
          title: `Person source evidence · ${provider}`,
          detail: `${sourceRef ? `Source reference: ${sourceRef}. ` : ""}The provider payload remains withheld; its verified provenance fingerprint is shown.` })];
      }
      case "near-miss-snapshot": {
        const cohort = memoryDataText(source, "cohortName") ?? "cohort";
        const rank = memoryDataNumber(source, "rank");
        const whyIn = memoryDataText(source, "whyIn");
        return [entry({ ...common, id: key, family: "cohort-evidence", truthLayer: "evidence",
          title: `${cohort}${rank ? ` · rank ${rank}` : ""}`,
          detail: `${whyIn ?? "Persisted historical cohort membership."} Snapshot membership is eventless evidence and confers no current eligibility or authority.` })];
      }
    }
  }));
}

interface ScopeSnapshot {
  readonly people: readonly ReturnerPersonSummary[];
  readonly selectedPerson: ReturnerPersonSummary | null;
  readonly events: readonly ReturnerEventHistory["event"][];
  readonly lineageIds: readonly string[];
}

function scopeSnapshot(db: Db, session: SessionInfo, personId: string | undefined): ScopeSnapshot {
  const peopleRows = db.prepare(`SELECT id, full_name, organization, title, created_at
    FROM people WHERE workspace_id = ? ORDER BY full_name, id LIMIT ?`)
    .all(session.workspaceId, RETURNER_LENS_MAX_PEOPLE + 1) as Array<Record<string, unknown>>;
  if (peopleRows.length > RETURNER_LENS_MAX_PEOPLE) fail("BOUND_EXCEEDED");
  const eventPairs = db.prepare(`SELECT person_id, event_id FROM (
      SELECT owner_person_id AS person_id, event_id FROM submissions WHERE workspace_id = ?
      UNION SELECT pa.person_id, pv.event_id FROM plan_assignments pa
        JOIN plan_versions pv ON pv.workspace_id = pa.workspace_id AND pv.id = pa.plan_version_id
        WHERE pa.workspace_id = ?
      UNION SELECT person_id, event_id FROM commitment_offers WHERE workspace_id = ?
      UNION SELECT person_id, event_id FROM observations WHERE workspace_id = ?
      UNION SELECT person_id, event_id FROM event_speakers WHERE workspace_id = ?
      UNION SELECT person_id, event_id FROM speaker_tasks WHERE workspace_id = ?
    ) ORDER BY person_id, event_id LIMIT ?`)
    .all(...Array.from({ length: 6 }, () => session.workspaceId), RETURNER_LENS_MAX_PEOPLE * RETURNER_LENS_MAX_EVENTS + 1) as Array<Record<string, unknown>>;
  if (eventPairs.length > RETURNER_LENS_MAX_PEOPLE * RETURNER_LENS_MAX_EVENTS) fail("BOUND_EXCEEDED");
  const eventIdsByPerson = new Map<string, Set<string>>();
  for (const row of eventPairs) {
    const person = id(row.person_id);
    const eventId = id(row.event_id);
    const values = eventIdsByPerson.get(person) ?? new Set<string>();
    values.add(eventId);
    eventIdsByPerson.set(person, values);
  }
  const people = peopleRows.map((row): ReturnerPersonSummary => {
    const person = id(row.id);
    const eventCount = eventIdsByPerson.get(person)?.size ?? 0;
    return freeze({
      id: person,
      fullName: text(row.full_name, 512),
      organization: nullableText(row.organization, 512),
      title: nullableText(row.title, 512),
      createdAt: timestamp(row.created_at),
      eventCount,
      returnerState: eventCount > 1 ? "MULTI_EVENT" : eventCount === 1 ? "SINGLE_EVENT" : "NO_EVENT_EVIDENCE",
    });
  }).sort((left, right) => right.eventCount - left.eventCount || left.fullName.localeCompare(right.fullName, "en-US") || left.id.localeCompare(right.id, "en-US"));
  const selectedPerson = personId ? people.find((person) => person.id === personId) ?? null : people[0] ?? null;
  if (personId && !selectedPerson) fail("TARGET_UNAVAILABLE");

  const eventRows = db.prepare(`SELECT id, name, timezone, starts_at, ends_at, lifecycle
    FROM events WHERE workspace_id = ? ORDER BY starts_at DESC, id LIMIT ?`)
    .all(session.workspaceId, RETURNER_LENS_MAX_EVENTS + 1) as Array<Record<string, unknown>>;
  if (eventRows.length > RETURNER_LENS_MAX_EVENTS) fail("BOUND_EXCEEDED");
  const events = eventRows.map((row) => freeze({
    id: id(row.id),
    name: text(row.name, 512),
    timezone: eventTimezone(row.timezone),
    startsAt: timestamp(row.starts_at),
    endsAt: timestamp(row.ends_at),
    lifecycle: text(row.lifecycle, 128),
  }));

  let lineageIds: string[] = [];
  if (selectedPerson) {
    const rows = db.prepare(`SELECT DISTINCT lineage.id
      FROM proposal_lineages lineage
      JOIN submissions origin ON origin.workspace_id = lineage.workspace_id
        AND origin.id = lineage.originating_submission_id
      WHERE lineage.workspace_id = ? AND origin.owner_person_id = ?
      ORDER BY lineage.created_at, lineage.id LIMIT ?`)
      .all(session.workspaceId, selectedPerson.id, RETURNER_LENS_MAX_LINEAGES + 1) as Array<Record<string, unknown>>;
    if (rows.length > RETURNER_LENS_MAX_LINEAGES) fail("BOUND_EXCEEDED");
    lineageIds = rows.map((row) => id(row.id));
  }
  return freeze({ people, selectedPerson, events, lineageIds });
}

function addEntries(target: ReturnerLensEntry[], more: readonly ReturnerLensEntry[]): void {
  if (target.length + more.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  target.push(...more);
}

function derivedFingerprint(value: unknown): string {
  return fingerprintOf(value);
}

function directDecisionAndProgramEntries(
  db: Db,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): EvidenceSnapshot {
  const output: ReturnerLensEntry[] = [];
  const currentApplicationRevisions: Array<{
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly state: CfpSubmissionState;
  }> = [];
  const submissions = db.prepare(`SELECT submission.id, submission.event_id, submission.state,
      submission.current_revision_id,
      revision.revision_number AS current_revision_number,
      revision.fingerprint AS current_revision_fingerprint,
      revision.created_at AS current_revision_created_at
    FROM submissions submission
    LEFT JOIN submission_revisions revision
      ON revision.workspace_id = submission.workspace_id
      AND revision.id = submission.current_revision_id
      AND revision.submission_id = submission.id
    WHERE submission.workspace_id = ? AND submission.owner_person_id = ?
    ORDER BY submission.created_at, submission.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (submissions.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of submissions) {
    const submissionId = id(row.id);
    const eventId = id(row.event_id);
    const state = cfpSubmissionState(row.state);
    if (row.current_revision_id === null) {
      if (state !== "DRAFT") fail("READ_FAILED");
      continue;
    }
    const currentRevisionId = id(row.current_revision_id);
    const currentRevisionNumber = integer(row.current_revision_number, 1);
    fingerprint(row.current_revision_fingerprint);
    timestamp(row.current_revision_created_at);
    if (state === "DRAFT" || state === "WITHDRAWN" || state === "INVALIDATED") {
      currentApplicationRevisions.push({
        revisionId: currentRevisionId,
        revisionNumber: currentRevisionNumber,
        state,
      });
      continue;
    }
    // The CFP decision reader enforces the submitted-only decision contract. Terminal
    // submission states are projected above as candidate evidence and must never enter it.
    const decision = readCfpSubmissionDecision(db, {
      workspaceId: session.workspaceId,
      submissionId,
      currentRevisionId,
    });
    if (!decision) continue;
    if (decision.submissionId !== submissionId || decision.submissionRevisionId !== currentRevisionId) fail("READ_FAILED");
    addEntries(output, [entry({
      id: `cfp-decision:${decision.decisionEventId}`,
      eventId,
      family: "proposal-decision",
      truthLayer: "decision",
      title: `CFP decision · ${humanize(decision.decision)}`,
      detail: `${decision.decision === "ACCEPTED" && decision.handoff ? `Accepted proposal linked to session “${text(decision.handoff.title, 512)}”. ` : ""}This is the decision for one exact submission revision; it is not authorization for another event.`,
      recordedAt: timestamp(decision.decidedAt),
      currentUse: "historical",
      fingerprint: fingerprint(decision.submissionRevisionFingerprint),
      fingerprintOrigin: "stored",
      references: sourceReferences({
        decisionEventId: id(decision.decisionEventId),
        submissionId,
        submissionRevisionId: currentRevisionId,
        ...(decision.handoff ? { programUnitId: id(decision.handoff.linkedSession.programUnitId) } : {}),
      }),
    })]);
  }

  const assignmentRows = db.prepare(`SELECT
      assignment.id AS assignment_id, assignment.assignment_type, assignment.explanation,
      assignment.is_pinned, plan.id AS plan_version_id, plan.fingerprint AS plan_fingerprint,
      plan.created_at AS plan_created_at, unit.id AS program_unit_id, unit.name AS program_unit_name,
      unit.event_id, approval.id AS approval_id, approval.decision,
      approval.created_at AS approval_created_at
    FROM plan_assignments assignment
    JOIN plan_versions plan ON plan.workspace_id = assignment.workspace_id
      AND plan.id = assignment.plan_version_id
    JOIN program_units unit ON unit.workspace_id = assignment.workspace_id
      AND unit.id = assignment.program_unit_id AND unit.event_id = plan.event_id
    LEFT JOIN approvals approval ON approval.workspace_id = plan.workspace_id
      AND approval.event_id = plan.event_id AND approval.plan_version_id = plan.id
    WHERE assignment.workspace_id = ? AND assignment.person_id = ?
    ORDER BY plan.created_at, assignment.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (assignmentRows.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of assignmentRows) {
    const assignmentId = id(row.assignment_id);
    const planVersionId = id(row.plan_version_id);
    const eventId = id(row.event_id);
    const programUnitId = id(row.program_unit_id);
    const assignmentType = text(row.assignment_type, 128);
    const explanation = text(row.explanation, 4096);
    const planCreatedAt = timestamp(row.plan_created_at);
    const isPinned = integer(row.is_pinned) === 1;
    if (integer(row.is_pinned) > 1) fail("READ_FAILED");
    fingerprint(row.plan_fingerprint);
    const assignmentFingerprint = derivedFingerprint({
      schema: "returner-lens-assignment-reference/v1",
      workspaceId: session.workspaceId,
      eventId,
      assignmentId,
      planVersionId,
      personId: person.id,
      programUnitId,
      assignmentType,
      explanation,
      isPinned,
    });
    addEntries(output, [entry({
      id: `plan-assignment:${assignmentId}`,
      eventId,
      family: "candidate-assignment",
      truthLayer: "candidate",
      title: `${humanize(assignmentType)} candidate · ${text(row.program_unit_name, 512)}`,
      detail: `Persisted plan candidate assignment. Rationale: ${explanation} A candidate assignment is not an organizer decision, participant commitment, attendance record, or current authorization.`,
      recordedAt: planCreatedAt,
      currentUse: "historical",
      fingerprint: assignmentFingerprint,
      fingerprintOrigin: "derived-from-immutable-source",
      references: sourceReferences({ assignmentId, planVersionId, programUnitId }),
    })]);
    if (row.approval_id !== null) {
      const approvalId = id(row.approval_id);
      const approvalDecision = text(row.decision, 128);
      const approvalCreatedAt = timestamp(row.approval_created_at);
      addEntries(output, [entry({
        id: `plan-approval:${approvalId}:${assignmentId}`,
        eventId,
        family: "plan-decision",
        truthLayer: "decision",
        title: `Plan decision · ${humanize(approvalDecision)}`,
        detail: `Organizer decision on the exact plan version containing this assignment. It records a past decision only; it does not prove commitment, delivery, or present authority.`,
        recordedAt: approvalCreatedAt,
        currentUse: "historical",
        fingerprint: derivedFingerprint({
          schema: "returner-lens-plan-decision-reference/v1",
          workspaceId: session.workspaceId,
          eventId,
          approvalId,
          planVersionId,
          assignmentId,
          decision: approvalDecision,
          createdAt: approvalCreatedAt,
        }),
        fingerprintOrigin: "derived-from-immutable-source",
        references: sourceReferences({ approvalId, assignmentId, planVersionId, programUnitId }),
      })]);
    }
  }

  const commitmentRows = db.prepare(`SELECT offer.id AS offer_id, offer.event_id,
      offer.plan_version_id, offer.terms_json, offer.terms_fingerprint, offer.status,
      offer.created_at, response.id AS response_id, response.response,
      response.responded_at, response.actor_person_id
    FROM commitment_offers offer
    LEFT JOIN commitment_responses response ON response.workspace_id = offer.workspace_id
      AND response.offer_id = offer.id
    WHERE offer.workspace_id = ? AND offer.person_id = ?
    ORDER BY COALESCE(response.responded_at, offer.created_at), offer.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (commitmentRows.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of commitmentRows) {
    const offerId = id(row.offer_id);
    const eventId = id(row.event_id);
    const terms = parseJsonRecord(row.terms_json);
    const termsFingerprint = fingerprint(row.terms_fingerprint);
    if (fingerprintOf(terms) !== termsFingerprint) fail("READ_FAILED");
    const response = row.response_id === null ? null : text(row.response, 128);
    if (row.response_id !== null && row.actor_person_id !== person.id) fail("READ_FAILED");
    addEntries(output, [entry({
      id: `commitment:${offerId}`,
      eventId,
      family: "commitment",
      truthLayer: "commitment",
      title: response ? `Commitment response · ${humanize(response)}` : `Commitment offer · ${humanize(text(row.status, 128))}`,
      detail: response
        ? "Persisted participant response to one exact offer. The response belongs to that event and terms fingerprint only."
        : "A persisted offer exists without a participant response; no commitment is inferred.",
      recordedAt: timestamp(response ? row.responded_at : row.created_at),
      currentUse: "historical",
      fingerprint: termsFingerprint,
      fingerprintOrigin: "stored",
      references: sourceReferences({
        offerId,
        planVersionId: id(row.plan_version_id),
        ...(row.response_id === null ? {} : { responseId: id(row.response_id) }),
      }),
    })]);
  }
  return freeze({ entries: freeze(output), currentApplicationRevisions: freeze(currentApplicationRevisions) });
}

interface EvidenceSnapshot {
  readonly entries: readonly ReturnerLensEntry[];
  readonly currentApplicationRevisions: readonly {
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly state: CfpSubmissionState;
  }[];
}

function projectCurrentApplicationEvidence(
  entries: readonly ReturnerLensEntry[],
  currentApplicationRevisions: readonly {
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly state: CfpSubmissionState;
  }[],
): readonly ReturnerLensEntry[] {
  if (currentApplicationRevisions.length === 0) return entries;
  const byRevisionId = new Map(currentApplicationRevisions.map((revision) => [revision.revisionId, revision]));
  const seen = new Set<string>();
  const projected = entries.map((item) => {
    if (item.family !== "application") return item;
    const revisionId = item.references.find((reference) => reference.label === "submissionRevisionId")?.value;
    const currentRevision = revisionId === undefined ? undefined : byRevisionId.get(revisionId);
    if (!currentRevision) return item;
    seen.add(currentRevision.revisionId);
    const { carriesAuthorityForward: _carriesAuthorityForward, ...withoutAuthority } = item;
    const stateLabel = humanize(currentRevision.state);
    const detail = currentRevision.state === "DRAFT"
      ? "Current stored draft submission revision. No organizer decision is recorded because this application has not been submitted."
      : `Current stored ${currentRevision.state} submission revision. This terminal candidate state records that the application is ${stateLabel.toLocaleLowerCase("en-US")}; no organizer decision, commitment, or current authorization is inferred.`;
    return entry({
      ...withoutAuthority,
      title: `${stateLabel} application · revision ${currentRevision.revisionNumber}`,
      detail,
      currentUse: "current-record",
    });
  });
  if (seen.size !== byRevisionId.size) fail("READ_FAILED");
  return freeze(projected);
}

function relationshipAndTaskEntries(
  db: Db,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): readonly ReturnerLensEntry[] {
  const output: ReturnerLensEntry[] = [];
  const relationships = db.prepare(`SELECT id, event_id, role_key, participation_status,
      created_at, updated_at FROM event_speakers
    WHERE workspace_id = ? AND person_id = ? ORDER BY updated_at, id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (relationships.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of relationships) {
    const relationshipId = id(row.id);
    const participationStatus = text(row.participation_status, 128);
    addEntries(output, [entry({
      id: `event-role:${relationshipId}`,
      eventId: id(row.event_id),
      family: "session-role",
      truthLayer: "commitment",
      title: `${humanize(text(row.role_key, 128))} relationship · ${humanize(participationStatus)}`,
      detail: `Current persisted event-role relationship at read time: ${humanize(participationStatus)}. This is invitation/participation relationship evidence only; it does not prove session attendance, role fulfillment, talk quality, or reliability.`,
      recordedAt: timestamp(row.updated_at),
      currentUse: "snapshot-at-read",
      fingerprint: null,
      fingerprintOrigin: "not-stored",
      references: sourceReferences({ eventSpeakerId: relationshipId }),
    })]);
  }

  const tasks = db.prepare(`SELECT id, event_id, assignment_id, task_kind, content_kind,
      title, required, gate, owner, state, due_at, created_at, updated_at
    FROM speaker_tasks WHERE workspace_id = ? AND person_id = ?
    ORDER BY updated_at, id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (tasks.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of tasks) {
    const taskId = id(row.id);
    const required = integer(row.required);
    if (required > 1 || row.task_kind !== row.content_kind) fail("READ_FAILED");
    const dueAt = timestamp(row.due_at);
    addEntries(output, [entry({
      id: `readiness-task:${taskId}`,
      eventId: id(row.event_id),
      family: "readiness-task",
      truthLayer: "evidence",
      title: `${text(row.title, 240)} · ${humanize(text(row.state, 128))}`,
      detail: `${required === 1 ? "Required" : "Optional"} ${humanize(text(row.content_kind, 128))} task; gate ${humanize(text(row.gate, 128))}; due time is shown below in the event timezone. This record-level task state is evidence at read time, not an aggregate readiness or reliability verdict.`,
      recordedAt: timestamp(row.updated_at),
      dueAt,
      currentUse: "snapshot-at-read",
      fingerprint: null,
      fingerprintOrigin: "not-stored",
      references: sourceReferences({ taskId, assignmentId: id(row.assignment_id) }),
    })]);
  }
  return freeze(output);
}

const CONTENT_KINDS = new Set([
  "PROFILE", "BIO", "SESSION_TITLE", "SESSION_DESCRIPTION", "SOCIAL_LINKS",
  "HEADSHOT", "SLIDES", "LOGISTICS", "ACKNOWLEDGEMENT",
]);
const CONTENT_OPERATIONS = new Map([
  ["speaker.content.version.submitted", "submit-version"],
  ["speaker.content.comment.added", "comment"],
  ["speaker.content.finding.added", "finding"],
  ["speaker.content.revision.requested", "revision-request"],
  ["speaker.content.approved", "approve"],
] as const);

interface ParsedContentEnvelope {
  readonly rowId: string;
  readonly rowFingerprint: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly operation: string;
  readonly createdAt: string;
  readonly value: Record<string, unknown>;
}

function contentEnvelope(
  row: Record<string, unknown>,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): ParsedContentEnvelope | null {
  const rowId = id(row.id);
  const eventType = text(row.event_type, 128);
  const operation = CONTENT_OPERATIONS.get(eventType as (typeof CONTENT_OPERATIONS extends ReadonlyMap<infer Key, string> ? Key : never));
  if (!operation) fail("READ_FAILED");
  const storedPayload = typeof row.payload_json === "string" ? row.payload_json : fail("READ_FAILED");
  const value = parseCanonical(storedPayload);
  const rowFingerprint = fingerprint(row.payload_fingerprint);
  if (fingerprintOf(value) !== rowFingerprint || row.workspace_id !== session.workspaceId) fail("READ_FAILED");
  // The earlier artifact receipt contract uses this event type but is projected from the exact
  // artifact review table below, never interpreted as a generic editorial approval.
  if (eventType === "speaker.content.approved" &&
    (value.schema === "speaker-content-approval-receipt/v1" || value.schema === "speaker-content-approval-receipt/v2")) return null;
  const schema = value.schema;
  if (schema !== "sympose-content-operation/v1" && schema !== "sympose-content-operation/v2") fail("READ_FAILED");
  const assignmentBound = schema === "sympose-content-operation/v2";
  exactKeys(value, [
    "schema", "operation", "workspaceId", "eventId", "actorId", "actorKind",
    "personId", "taskId", "kind", "idempotencyKey", "requestFingerprint",
    ...(assignmentBound ? ["assignmentId"] : []),
    operation === "submit-version" ? "version" : "record",
  ]);
  const eventId = id(value.eventId);
  const taskId = id(value.taskId);
  const kind = text(value.kind, 128);
  const createdAt = timestamp(row.created_at);
  if (
    value.operation !== operation || value.workspaceId !== session.workspaceId ||
    value.personId !== person.id || row.aggregate_type !== "speaker_task" ||
    row.aggregate_id !== taskId || !CONTENT_KINDS.has(kind) ||
    (value.actorKind !== "organizer" && value.actorKind !== "speaker") ||
    typeof value.actorId !== "string" ||
    typeof value.requestFingerprint !== "string" || !HEX_64.test(value.requestFingerprint) ||
    rowId !== deterministicUuid(`speaker-content-event:${eventType}:${session.workspaceId}:${rowFingerprint}`)
  ) fail("READ_FAILED");
  if (assignmentBound) {
    const assignmentId = id(value.assignmentId);
    const assignment = row.__assignment_id;
    if (assignment !== assignmentId) fail("READ_FAILED");
  }
  return freeze({ rowId, rowFingerprint, eventId, taskId, kind, operation, createdAt, value });
}

function editorialEventEntries(
  db: Db,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): readonly ReturnerLensEntry[] {
  const rows = db.prepare(`SELECT event.id, event.workspace_id, event.event_type,
      event.aggregate_type, event.aggregate_id, event.payload_json,
      event.payload_fingerprint, event.created_at,
      (SELECT assignment.id
         FROM plan_assignments assignment
         JOIN plan_versions plan ON plan.workspace_id = assignment.workspace_id
           AND plan.id = assignment.plan_version_id
        WHERE assignment.workspace_id = event.workspace_id
          AND assignment.id = CASE WHEN json_valid(event.payload_json)
            THEN json_extract(event.payload_json, '$.assignmentId') END
          AND assignment.person_id = CASE WHEN json_valid(event.payload_json)
            THEN json_extract(event.payload_json, '$.personId') END
          AND plan.event_id = CASE WHEN json_valid(event.payload_json)
            THEN json_extract(event.payload_json, '$.eventId') END
        LIMIT 1) AS __assignment_id
    FROM domain_events event
    WHERE event.workspace_id = ?
      AND event.event_type IN ('speaker.content.version.submitted',
        'speaker.content.comment.added', 'speaker.content.finding.added',
        'speaker.content.revision.requested', 'speaker.content.approved')
      AND CASE WHEN json_valid(event.payload_json)
        THEN json_extract(event.payload_json, '$.personId') END = ?
    ORDER BY event.created_at, event.id LIMIT ?`)
    .all(session.workspaceId, person.id, CONTENT_EVENT_LIMIT + 1) as Array<Record<string, unknown>>;
  if (rows.length > CONTENT_EVENT_LIMIT) fail("BOUND_EXCEEDED");
  const envelopes = rows.map((row) => contentEnvelope(row, session, person)).filter((value): value is ParsedContentEnvelope => value !== null);
  const versionById = new Map<string, { readonly hash: string; readonly taskId: string; readonly eventId: string }>();
  const output: ReturnerLensEntry[] = [];
  for (const envelope of envelopes.filter((candidate) => candidate.operation === "submit-version")) {
    const version = ownRecord(envelope.value.version);
    exactKeys(version, [
      "id", "workspaceId", "eventId", "personId", "taskId", "kind", "version",
      "supersedesVersionId", "payload", "contentHash", "payloadBytes", "submittedAt",
      "submittedBy", "submittedByKind", "source",
    ]);
    const versionId = id(version.id);
    const versionNumber = integer(version.version, 1);
    const payload = ownRecord(version.payload);
    const contentHash = fingerprint(version.contentHash);
    if (
      version.workspaceId !== session.workspaceId || version.eventId !== envelope.eventId ||
      version.personId !== person.id || version.taskId !== envelope.taskId ||
      version.kind !== envelope.kind || payload.kind !== envelope.kind ||
      fingerprintOf(payload) !== contentHash ||
      integer(version.payloadBytes, 1) !== Buffer.byteLength(JSON.stringify(payload), "utf8") ||
      version.submittedAt !== envelope.createdAt || version.submittedBy !== envelope.value.actorId ||
      version.submittedByKind !== envelope.value.actorKind ||
      (version.source !== "synthetic-local-projection" && version.source !== "local-artifact-store") ||
      versionId !== deterministicUuid(`content-version:${session.workspaceId}:${envelope.eventId}:${person.id}:${envelope.taskId}:${envelope.kind}:${versionNumber}`)
    ) fail("READ_FAILED");
    if (versionById.has(versionId)) fail("READ_FAILED");
    versionById.set(versionId, { hash: contentHash, taskId: envelope.taskId, eventId: envelope.eventId });
    addEntries(output, [entry({
      id: `editorial-version:${versionId}`,
      eventId: envelope.eventId,
      family: "editorial-version",
      truthLayer: "evidence",
      title: `${humanize(envelope.kind)} version ${versionNumber}`,
      detail: "Immutable editorial version metadata. Content bodies and private fields are not reproduced in this cross-event lens.",
      recordedAt: envelope.createdAt,
      currentUse: "historical",
      fingerprint: contentHash,
      fingerprintOrigin: "stored",
      references: sourceReferences({ contentVersionId: versionId, taskId: envelope.taskId }),
    })]);
  }

  for (const envelope of envelopes.filter((candidate) => candidate.operation !== "submit-version")) {
    const record = ownRecord(envelope.value.record);
    const common = ["id", "workspaceId", "eventId", "personId", "taskId", "submissionVersionId", "submissionContentHash"];
    const recordId = id(record.id);
    const submissionVersionId = id(record.submissionVersionId);
    const submissionHash = fingerprint(record.submissionContentHash);
    if (
      record.workspaceId !== session.workspaceId || record.eventId !== envelope.eventId ||
      record.personId !== person.id || record.taskId !== envelope.taskId
    ) fail("READ_FAILED");
    const version = versionById.get(submissionVersionId);
    if (!version || version.hash !== submissionHash || version.taskId !== envelope.taskId || version.eventId !== envelope.eventId) fail("READ_FAILED");
    if (envelope.operation === "comment") {
      exactKeys(record, [...common, "body", "authorId", "authorKind", "createdAt"]);
      if (record.authorId !== envelope.value.actorId || record.authorKind !== envelope.value.actorKind ||
        record.createdAt !== envelope.createdAt || typeof record.body !== "string") fail("READ_FAILED");
      continue;
    }
    let title: string;
    let detail: string;
    let family: ReturnerEvidenceFamily = "editorial-review";
    if (envelope.operation === "finding") {
      exactKeys(record, [...common, "severity", "message", "blocksReadiness", "createdAt", "createdBy"]);
      if (envelope.value.actorKind !== "organizer" || record.createdBy !== envelope.value.actorId ||
        record.createdAt !== envelope.createdAt || !["INFO", "WARNING", "BLOCKER"].includes(String(record.severity)) ||
        typeof record.blocksReadiness !== "boolean") fail("READ_FAILED");
      title = `Editorial finding · ${humanize(text(record.severity, 128))}`;
      detail = `${text(record.message, 2400)} ${record.blocksReadiness ? "This record explicitly blocked readiness at that time." : "This record did not block readiness."}`;
      family = "prior-guidance";
    } else if (envelope.operation === "revision-request") {
      exactKeys(record, [...common, "reason", "requestedBy", "createdAt"]);
      if (envelope.value.actorKind !== "organizer" || record.requestedBy !== envelope.value.actorId || record.createdAt !== envelope.createdAt) fail("READ_FAILED");
      title = "Editorial revision requested";
      detail = `Persisted prior guidance: ${text(record.reason, 1600)} This request applied to the referenced version only.`;
      family = "prior-guidance";
    } else if (envelope.operation === "approve") {
      exactKeys(record, [...common, "approvedBy", "approvedAt", "gate"]);
      const gate = text(record.gate, 128);
      if (envelope.value.actorKind !== "organizer" || record.approvedBy !== envelope.value.actorId ||
        record.approvedAt !== envelope.createdAt || !["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(gate) ||
        recordId !== deterministicUuid(`content-approval:${session.workspaceId}:${envelope.eventId}:${submissionVersionId}:${gate}`)) fail("READ_FAILED");
      title = `Editorial approval · ${humanize(gate)} gate`;
      detail = "Approval is bound to one exact content version and historical gate. It does not approve later versions or authorize a later event.";
    } else {
      fail("READ_FAILED");
    }
    addEntries(output, [entry({
      id: `editorial-review:${recordId}`,
      eventId: envelope.eventId,
      family,
      truthLayer: "evidence",
      title,
      detail,
      recordedAt: envelope.createdAt,
      currentUse: "historical",
      fingerprint: envelope.rowFingerprint,
      fingerprintOrigin: "stored",
      references: sourceReferences({ reviewRecordId: recordId, contentVersionId: submissionVersionId, taskId: envelope.taskId }),
    })]);
  }
  return freeze(output);
}

function artifactAndStoredEditorialEntries(
  db: Db,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): readonly ReturnerLensEntry[] {
  const output: ReturnerLensEntry[] = [];
  const versionRows = db.prepare(`SELECT version.id, version.event_id, version.task_id,
      version.kind, version.version, version.supersedes_version_id, version.payload_json,
      version.content_hash, version.payload_bytes, version.submitted_at,
      version.submitted_by, version.submitted_by_kind, version.source,
      task.assignment_id, task.content_kind
    FROM speaker_content_versions version
    JOIN speaker_tasks task ON task.workspace_id = version.workspace_id
      AND task.event_id = version.event_id AND task.person_id = version.person_id
      AND task.id = version.task_id
    WHERE version.workspace_id = ? AND version.person_id = ?
    ORDER BY version.event_id, version.task_id, version.kind, version.version, version.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (versionRows.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  const versionById = new Map<string, { readonly eventId: string; readonly taskId: string; readonly kind: string; readonly hash: string; readonly version: number }>();
  const priorByTask = new Map<string, { readonly id: string; readonly version: number }>();
  for (const row of versionRows) {
    const versionId = id(row.id);
    const eventId = id(row.event_id);
    const taskId = id(row.task_id);
    const kind = text(row.kind, 128);
    const versionNumber = integer(row.version, 1);
    const payload = parseCanonical(row.payload_json, 4096);
    const contentHash = fingerprint(row.content_hash);
    if (
      row.content_kind !== kind || payload.kind !== kind ||
      fingerprintOf(payload) !== contentHash ||
      integer(row.payload_bytes, 1) !== Buffer.byteLength(String(row.payload_json), "utf8") ||
      row.submitted_by !== person.id || row.submitted_by_kind !== "speaker" ||
      row.source !== "local-artifact-store" ||
      versionId !== deterministicUuid(`content-version:${session.workspaceId}:${eventId}:${person.id}:${taskId}:${kind}:${versionNumber}`)
    ) fail("READ_FAILED");
    const taskKey = `${eventId}:${taskId}:${kind}`;
    const prior = priorByTask.get(taskKey);
    if (versionNumber !== (prior?.version ?? 0) + 1 || row.supersedes_version_id !== (prior?.id ?? null)) fail("READ_FAILED");
    priorByTask.set(taskKey, { id: versionId, version: versionNumber });
    if (versionById.has(versionId)) fail("READ_FAILED");
    versionById.set(versionId, { eventId, taskId, kind, hash: contentHash, version: versionNumber });
    addEntries(output, [entry({
      id: `editorial-version:${versionId}`,
      eventId,
      family: "editorial-version",
      truthLayer: "evidence",
      title: `${humanize(kind)} artifact version ${versionNumber}`,
      detail: "Immutable artifact-backed editorial version metadata. The stored asset body is not loaded or reproduced by this lens.",
      recordedAt: timestamp(row.submitted_at),
      currentUse: "historical",
      fingerprint: contentHash,
      fingerprintOrigin: "stored",
      references: sourceReferences({ contentVersionId: versionId, taskId, assignmentId: id(row.assignment_id) }),
    })]);
  }

  const reviewRows = db.prepare(`SELECT review.id, review.event_id, review.task_id,
      review.submission_version_id, review.submission_content_hash,
      review.review_state, review.gate, review.reviewed_at
    FROM speaker_content_reviews review
    WHERE review.workspace_id = ? AND review.person_id = ?
    ORDER BY review.reviewed_at, review.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (reviewRows.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  for (const row of reviewRows) {
    const reviewId = id(row.id);
    const contentVersionId = id(row.submission_version_id);
    const version = versionById.get(contentVersionId);
    const eventId = id(row.event_id);
    const taskId = id(row.task_id);
    const reviewState = text(row.review_state, 128);
    const gate = text(row.gate, 128);
    if (!version || version.eventId !== eventId || version.taskId !== taskId ||
      version.hash !== fingerprint(row.submission_content_hash) ||
      !["APPROVED", "CHANGES_REQUESTED", "BLOCKED"].includes(reviewState) ||
      !["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(gate)) fail("READ_FAILED");
    const reviewedAt = timestamp(row.reviewed_at);
    addEntries(output, [entry({
      id: `editorial-review:${reviewId}`,
      eventId,
      family: "editorial-review",
      truthLayer: "evidence",
      title: `${humanize(version.kind)} review · ${humanize(reviewState)}`,
      detail: `${humanize(gate)} gate review for artifact version ${version.version}. This exact-version review is historical evidence, not approval of another version or event.`,
      recordedAt: reviewedAt,
      currentUse: "historical",
      fingerprint: derivedFingerprint({
        schema: "returner-lens-artifact-review-reference/v1",
        workspaceId: session.workspaceId,
        eventId,
        reviewId,
        contentVersionId,
        submissionContentHash: version.hash,
        reviewState,
        gate,
        reviewedAt,
      }),
      fingerprintOrigin: "derived-from-immutable-source",
      references: sourceReferences({ reviewId, contentVersionId, taskId }),
    })]);
  }

  const artifactRows = db.prepare(`SELECT artifact.id, artifact.artifact_schema,
      artifact.event_id, artifact.task_id, artifact.kind, artifact.version,
      artifact.supersedes_record_id, artifact.storage_provider, artifact.storage_id,
      artifact.storage_filename, artifact.sha256, artifact.size_bytes,
      artifact.media_type, artifact.display_filename, artifact.created_at,
      artifact.content_version_id, artifact.authority_event_id,
      authority.workspace_id AS authority_workspace_id, authority.event_type AS authority_event_type,
      authority.aggregate_type AS authority_aggregate_type,
      authority.aggregate_id AS authority_aggregate_id,
      authority.payload_json AS authority_payload_json,
      authority.payload_fingerprint AS authority_payload_fingerprint,
      authority.created_at AS authority_created_at
    FROM artifact_records artifact
    JOIN domain_events authority ON authority.id = artifact.authority_event_id
    WHERE artifact.workspace_id = ? AND artifact.person_id = ?
    ORDER BY artifact.event_id, artifact.task_id, artifact.kind, artifact.version, artifact.id LIMIT ?`)
    .all(session.workspaceId, person.id, RETURNER_LENS_MAX_ENTRIES + 1) as Array<Record<string, unknown>>;
  if (artifactRows.length > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  const priorArtifactByTask = new Map<string, { readonly id: string; readonly version: number }>();
  for (const row of artifactRows) {
    const artifactId = fingerprint(row.id);
    const eventId = id(row.event_id);
    const taskId = id(row.task_id);
    const kind = text(row.kind, 128);
    const versionNumber = integer(row.version, 1);
    const contentVersionId = id(row.content_version_id);
    const version = versionById.get(contentVersionId);
    const storageId = fingerprint(row.storage_id);
    const sha256 = fingerprint(row.sha256);
    const sizeBytes = integer(row.size_bytes, 1);
    const mediaType = text(row.media_type, 128);
    const displayFilename = text(row.display_filename, 180);
    const createdAt = timestamp(row.created_at);
    const taskKey = `${eventId}:${taskId}:${kind}`;
    const prior = priorArtifactByTask.get(taskKey);
    if (
      row.artifact_schema !== "sympose-artifact-record/v1" || row.storage_provider !== "local" ||
      row.storage_filename !== `${storageId}.bin` || !version ||
      version.eventId !== eventId || version.taskId !== taskId || version.kind !== kind ||
      version.version !== versionNumber ||
      versionNumber !== (prior?.version ?? 0) + 1 || row.supersedes_record_id !== (prior?.id ?? null) ||
      row.authority_workspace_id !== session.workspaceId ||
      row.authority_event_type !== "speaker.artifact.submitted" ||
      row.authority_aggregate_type !== "speaker_task" || row.authority_aggregate_id !== taskId ||
      row.authority_event_id !== deterministicUuid(`speaker-artifact-event:${artifactId}`) ||
      row.authority_created_at !== createdAt
    ) fail("READ_FAILED");
    const authorityPayload = parseCanonical(row.authority_payload_json, 4096);
    const authorityFingerprint = fingerprint(row.authority_payload_fingerprint);
    exactKeys(authorityPayload, [
      "schema", "artifactId", "workspaceId", "eventId", "personId", "taskId", "kind",
      "version", "storageId", "storageFilename", "sha256", "byteSize", "mediaType",
      "displayFilename", "contentVersionId", "contentVersionHash",
    ]);
    if (
      fingerprintOf(authorityPayload) !== authorityFingerprint ||
      authorityPayload.schema !== "speaker-artifact-submission/v1" ||
      authorityPayload.artifactId !== artifactId || authorityPayload.workspaceId !== session.workspaceId ||
      authorityPayload.eventId !== eventId || authorityPayload.personId !== person.id ||
      authorityPayload.taskId !== taskId || authorityPayload.kind !== kind ||
      authorityPayload.version !== versionNumber || authorityPayload.storageId !== storageId ||
      authorityPayload.storageFilename !== `${storageId}.bin` || authorityPayload.sha256 !== sha256 ||
      authorityPayload.byteSize !== sizeBytes || authorityPayload.mediaType !== mediaType ||
      authorityPayload.displayFilename !== displayFilename || authorityPayload.contentVersionId !== contentVersionId ||
      authorityPayload.contentVersionHash !== version.hash
    ) fail("READ_FAILED");
    priorArtifactByTask.set(taskKey, { id: artifactId, version: versionNumber });
    addEntries(output, [entry({
      id: `artifact:${artifactId}`,
      eventId,
      family: "artifact",
      truthLayer: "evidence",
      title: `${humanize(kind)} artifact · version ${versionNumber}`,
      detail: `${displayFilename} · ${sizeBytes.toLocaleString("en-US")} bytes · ${mediaType}. Metadata only; the asset is not loaded by Returner Lens.`,
      recordedAt: createdAt,
      currentUse: "historical",
      fingerprint: sha256,
      fingerprintOrigin: "stored",
      references: sourceReferences({ artifactId, contentVersionId, authorityEventId: id(row.authority_event_id), taskId }),
    })]);
  }
  return freeze(output);
}

function evidenceSnapshot(
  db: Db,
  session: SessionInfo,
  person: ReturnerPersonSummary,
): EvidenceSnapshot {
  const entries: ReturnerLensEntry[] = [];
  const direct = directDecisionAndProgramEntries(db, session, person);
  addEntries(entries, direct.entries);
  addEntries(entries, relationshipAndTaskEntries(db, session, person));
  addEntries(entries, editorialEventEntries(db, session, person));
  addEntries(entries, artifactAndStoredEditorialEntries(db, session, person));
  return freeze({ entries: freeze(entries), currentApplicationRevisions: direct.currentApplicationRevisions });
}

function deduplicateEntries(entries: readonly ReturnerLensEntry[]): readonly ReturnerLensEntry[] {
  const byId = new Map<string, ReturnerLensEntry>();
  for (const candidate of entries) {
    const existing = byId.get(candidate.id);
    if (existing && canonicalJson(existing) !== canonicalJson(candidate)) fail("READ_FAILED");
    byId.set(candidate.id, candidate);
  }
  if (byId.size > RETURNER_LENS_MAX_ENTRIES) fail("BOUND_EXCEEDED");
  return freeze([...byId.values()].sort((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt) || left.id.localeCompare(right.id, "en-US")));
}

function coverage(entries: readonly ReturnerLensEntry[]): readonly ReturnerCoverageItem[] {
  const has = (...families: readonly ReturnerEvidenceFamily[]) => entries.some((item) => families.includes(item.family));
  const presentOrEmpty = (key: string, label: string, present: boolean, emptyDetail: string): ReturnerCoverageItem => freeze({
    key,
    label,
    state: present ? "PRESENT" : "EMPTY",
    detail: present ? "Canonical records are shown in the evidence timeline." : emptyDetail,
  });
  return freeze([
    presentOrEmpty("applications", "Applications & proposals", has("application", "proposal-review"), "No canonical application, proposal revision, lineage, or review metadata is present for this person."),
    presentOrEmpty("decisions", "Prior decisions", has("proposal-decision", "plan-decision"), "No canonical CFP or plan decision is present for this person."),
    presentOrEmpty("session-roles", "Talks & session roles", has("session-role"), "No canonical event-role relationship is present. Candidate assignments and operational observations remain separate evidence."),
    freeze({ key: "attendee-feedback", label: "Attendee feedback", state: "UNAVAILABLE", detail: "No authoritative attendee-feedback table or persisted feedback semantics exist in the canonical model." }),
    presentOrEmpty("readiness", "Speaker readiness evidence", has("readiness-task", "editorial-review", "artifact"), "No canonical task, exact-version review, or artifact record is present. No readiness conclusion is inferred."),
    freeze({ key: "reliability", label: "Speaker reliability", state: "UNAVAILABLE", detail: "No authoritative reliability record or persisted reliability semantics exist. Task and role records are never converted into a score." }),
    presentOrEmpty("editorial", "Editorial versions & approvals", has("editorial-version", "editorial-review"), "No canonical editorial version or exact-version approval record is present."),
    presentOrEmpty("guidance", "Prior guidance", has("prior-guidance"), "No canonical lineage guidance, revision request, or editorial finding is present."),
    freeze({ key: "review-comments", label: "Reviewer comments & evaluations", state: "WITHHELD", detail: "Review metadata may appear, but reviewer identity, evaluation content, comments, and private note bodies are intentionally not exposed by this lens." }),
    freeze({ key: "current-authorization", label: "Current authorization", state: "NOT_EVALUATED", detail: "Returner Lens does not evaluate, grant, or carry current authorization from any historical record." }),
  ]);
}

export function queryReturnerLens(
  db: Db,
  session: SessionInfo,
  input: { readonly workspaceSlug: string; readonly personId?: string },
): ReturnerLensResult {
  const query = normalizeInput(input);
  authorize(db, session, query.workspaceSlug);
  const scope = readSnapshot(db, session, query.workspaceSlug, () => scopeSnapshot(db, session, query.personId));
  if (!scope.selectedPerson) {
    return freeze({
      schema: RETURNER_LENS_SCHEMA,
      workspaceId: session.workspaceId,
      workspaceSlug: query.workspaceSlug,
      readOnly: true,
      authorityCarryover: false,
      people: scope.people,
      selectedPerson: null,
      eventHistory: scope.events.map((event) => freeze({ event, entries: freeze([] as ReturnerLensEntry[]) })),
      workspaceEvidence: freeze([] as ReturnerLensEntry[]),
      counts: freeze({ eventsWithEvidence: 0, historicalRecords: 0, applications: 0, decisions: 0, sessionRoles: 0, editorialRecords: 0 }),
      currentAuthorization: freeze({ state: "NOT_EVALUATED", carriesFromHistory: false, detail: "No current authorization evaluation is performed by Returner Lens." }),
      coverage: coverage([]),
    });
  }

  const memories: InstitutionalMemoryResult[] = [queryInstitutionalMemory(db, session, {
    workspaceSlug: query.workspaceSlug,
    personId: scope.selectedPerson.id,
  })];
  for (const lineageId of scope.lineageIds) {
    memories.push(queryInstitutionalMemory(db, session, {
      workspaceSlug: query.workspaceSlug,
      personId: scope.selectedPerson.id,
      lineageId,
    }));
  }
  for (const memory of memories) {
    if (memory.workspaceId !== session.workspaceId || memory.personId !== scope.selectedPerson.id || memory.authorityCarryover !== false) fail("READ_FAILED");
  }
  const memoryEntries = memories.flatMap((memory) => projectInstitutionalMemoryForReturnerLens(memory));
  const directSnapshot = readSnapshot(db, session, query.workspaceSlug, () => evidenceSnapshot(db, session, scope.selectedPerson!));
  if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
  const allEntries = deduplicateEntries([
    ...projectCurrentApplicationEvidence(memoryEntries, directSnapshot.currentApplicationRevisions),
    ...directSnapshot.entries,
  ]);
  const eventById = new Map(scope.events.map((event) => [event.id, event]));
  const entriesByEvent = new Map<string, ReturnerLensEntry[]>();
  const workspaceEvidence: ReturnerLensEntry[] = [];
  for (const candidate of allEntries) {
    if (candidate.eventId === null) {
      workspaceEvidence.push(candidate);
      continue;
    }
    if (!eventById.has(candidate.eventId)) fail("READ_FAILED");
    const items = entriesByEvent.get(candidate.eventId) ?? [];
    items.push(candidate);
    entriesByEvent.set(candidate.eventId, items);
  }
  const eventHistory = scope.events.map((event) => freeze({
    event,
    entries: freeze(entriesByEvent.get(event.id) ?? []),
  }));
  const decisions = allEntries.filter((candidate) => candidate.truthLayer === "decision").length;
  const editorialRecords = allEntries.filter((candidate) =>
    candidate.family === "editorial-version" || candidate.family === "editorial-review" || candidate.family === "artifact").length;
  return freeze({
    schema: RETURNER_LENS_SCHEMA,
    workspaceId: session.workspaceId,
    workspaceSlug: query.workspaceSlug,
    readOnly: true,
    authorityCarryover: false,
    people: scope.people,
    selectedPerson: scope.selectedPerson,
    eventHistory,
    workspaceEvidence,
    counts: freeze({
      eventsWithEvidence: eventHistory.filter((history) => history.entries.length > 0).length,
      historicalRecords: allEntries.length,
      applications: allEntries.filter((candidate) => candidate.family === "application").length,
      decisions,
      sessionRoles: allEntries.filter((candidate) => candidate.family === "session-role").length,
      editorialRecords,
    }),
    currentAuthorization: freeze({
      state: "NOT_EVALUATED",
      carriesFromHistory: false,
      detail: "Current authorization must be established by the current event’s own decision, commitment, and operational workflows. Returner Lens never evaluates or grants it.",
    }),
    coverage: coverage(allEntries),
  });
}

export const getReturnerLens = queryReturnerLens;
