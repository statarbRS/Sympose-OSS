import { Buffer } from "node:buffer";

import {
  assertWorkspaceMatch,
  requireCapability,
  roleHasCapability,
  type SessionInfo,
} from "../auth";
import { canonicalJson, fingerprintOf, sha256Hex } from "../canonical";
import type { Db } from "../db";
import {
  PD01_FINGERPRINT_ALGORITHM,
  RESUBMISSION_REQUEST_SCHEMA,
  SUBMISSION_DERIVATION_RELATIONSHIPS,
  SUBMISSION_DERIVATION_SCHEMA,
} from "./cfp/proposal-lineage";
import { CFP_SUBMISSION_REVISION_SCHEMA } from "./cfp/form-documents";
import {
  CFP_REVIEW_FINGERPRINT_ALGORITHM,
} from "./cfp-review/artifact-types";
import { CFP_REVIEW_EVALUATION_SCHEMA } from "./cfp-review/reviewer-types";

/**
 * P1 institutional memory is deliberately a bounded read model. It never writes a memory row,
 * derives a score, or makes an old record current. Each item remains attributable to its source
 * family and exact immutable identifier.
 */
export const INSTITUTIONAL_MEMORY_SCHEMA = "pd01-institutional-memory/v1" as const;
export const INSTITUTIONAL_MEMORY_MAX_ITEMS = 200;
export const REVIEW_HISTORY_VISIBILITY_POLICY =
  "phase0.pipeline.manage:review-metadata-only/v1" as const;
const PERSON_PROVENANCE_SCHEMA = "pd01-person-provenance/v1" as const;
const COHORT_SNAPSHOT_SCHEMA = "cohort-snapshot/v1" as const;
const MAX_PROVENANCE_PAYLOAD_BYTES = 524_288;
const RELATIONSHIPS = new Set<string>(SUBMISSION_DERIVATION_RELATIONSHIPS);

export type MemoryFamily =
  | "lineage"
  | "submission-revision"
  | "review-history"
  | "decision-outcome"
  | "person-history"
  | "near-miss-snapshot";

export interface InstitutionalMemoryQuery {
  readonly workspaceSlug: string;
  readonly personId?: string;
  readonly lineageId?: string;
  readonly eventId?: string;
  readonly asOf?: string;
}

export interface MemorySourceRecord {
  readonly family: MemoryFamily;
  readonly eventId: string | null;
  readonly ids: Readonly<Record<string, string>>;
  readonly fingerprint: string | null;
  readonly fingerprintOrigin: "stored" | "derived-from-immutable-source" | "not-stored";
  readonly recordedAt: string;
  readonly currentUse: "current" | "historical" | "not-applicable";
  readonly authority: "evidence-only" | "historical-record";
  readonly carriesAuthorityForward: false;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface UnavailableMemoryFamily {
  readonly family: string;
  readonly available: false;
  readonly reason: string;
}

export interface InstitutionalMemoryResult {
  readonly schema: typeof INSTITUTIONAL_MEMORY_SCHEMA;
  readonly workspaceId: string;
  readonly personId: string | null;
  readonly lineageId: string | null;
  readonly eventId: string | null;
  readonly authorityCarryover: false;
  readonly sources: readonly MemorySourceRecord[];
  readonly unavailableFamilies: readonly UnavailableMemoryFamily[];
}

export type InstitutionalMemoryErrorCode =
  | "INPUT_INVALID"
  | "AUTHORIZATION_DENIED"
  | "TARGET_UNAVAILABLE"
  | "READ_FAILED"
  | "BOUND_EXCEEDED";

const ERROR_MESSAGES: Record<InstitutionalMemoryErrorCode, string> = {
  INPUT_INVALID: "The institutional-memory query is invalid.",
  AUTHORIZATION_DENIED: "The institutional-memory query is not available.",
  TARGET_UNAVAILABLE: "The institutional-memory target is not available.",
  READ_FAILED: "The institutional-memory record could not be read safely.",
  BOUND_EXCEEDED: "The institutional-memory result exceeds the bounded query limit.",
};

export class InstitutionalMemoryError extends Error {
  readonly code: InstitutionalMemoryErrorCode;

  constructor(code: InstitutionalMemoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "InstitutionalMemoryError";
    this.code = code;
  }
}

function fail(code: InstitutionalMemoryErrorCode): never {
  throw new InstitutionalMemoryError(code);
}

const IDENTIFIER = /^[^\u0000-\u001F\u007F-\u009F]{1,128}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function text(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("INPUT_INVALID");
  return value;
}

function ownRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INPUT_INVALID");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") fail("INPUT_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("INPUT_INVALID");
    output[key] = descriptor.value;
  }
  return output;
}

function normalize(input: unknown): Required<Pick<InstitutionalMemoryQuery, "workspaceSlug">>
  & Omit<InstitutionalMemoryQuery, "workspaceSlug"> {
  const value = ownRecord(input);
  const keys = Object.keys(value);
  if (keys.some((key) => !["workspaceSlug", "personId", "lineageId", "eventId", "asOf"].includes(key))
    || !Object.prototype.hasOwnProperty.call(value, "workspaceSlug")) fail("INPUT_INVALID");
  const optional = (key: string): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) return undefined;
    return text(value[key]);
  };
  const asOf = optional("asOf");
  if (asOf !== undefined && (!ISO.test(asOf) || new Date(asOf).toISOString() !== asOf)) fail("INPUT_INVALID");
  const result = { workspaceSlug: text(value.workspaceSlug), personId: optional("personId"), lineageId: optional("lineageId"), eventId: optional("eventId"), asOf };
  if (!result.personId && !result.lineageId) fail("INPUT_INVALID");
  return result;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sessionIsCurrent(db: Db, session: SessionInfo): boolean {
  let row: { id?: unknown; token_hash?: unknown; account_id?: unknown; workspace_id?: unknown; expires_at?: unknown;
    email?: unknown; display_name?: unknown; role?: unknown; slug?: unknown; name?: unknown } | undefined;
  try {
    row = db.prepare(`SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.expires_at,
        a.email, a.display_name, a.role, w.slug, w.name
        FROM sessions s JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
        JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`).get(session.id) as
      { id?: unknown; token_hash?: unknown; account_id?: unknown; workspace_id?: unknown; expires_at?: unknown;
        email?: unknown; display_name?: unknown; role?: unknown; slug?: unknown; name?: unknown } | undefined;
  } catch {
    fail("READ_FAILED");
  }
  return !!row && row.id === session.id && row.token_hash === session.tokenHash && row.account_id === session.accountId
    && row.workspace_id === session.workspaceId && row.role === session.role && row.slug === session.workspaceSlug
    && row.email === session.email && row.display_name === session.displayName && row.name === session.workspaceName
    && row.expires_at === session.expiresAt && ISO.test(session.expiresAt)
    && session.expiresAt >= new Date().toISOString();
}

function authorize(db: Db, session: SessionInfo, workspaceSlug: string): void {
  try {
    if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
    assertWorkspaceMatch(session, workspaceSlug);
    if (!roleHasCapability(session.role, "phase0.pipeline.manage")) {
      requireCapability(db, session, "phase0.pipeline.manage");
    }
  } catch (error) {
    if (error instanceof InstitutionalMemoryError) throw error;
    fail("AUTHORIZATION_DENIED");
  }
}

function rowText(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("READ_FAILED");
  return value;
}

function recordedAt(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value) || new Date(value).toISOString() !== value) fail("READ_FAILED");
  return value;
}

function provenanceText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000-\u001F\u007F-\u009F]/u.test(value)) fail("READ_FAILED");
  return value;
}

function positiveVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("READ_FAILED");
  return value;
}

function provenancePayload(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROVENANCE_PAYLOAD_BYTES) fail("READ_FAILED");
  try {
    JSON.parse(value);
  } catch {
    fail("READ_FAILED");
  }
  return value;
}

function source(family: MemoryFamily, eventId: string | null, ids: Record<string, string>, fingerprint: string | null,
  fingerprintOrigin: MemorySourceRecord["fingerprintOrigin"],
  at: string, currentUse: MemorySourceRecord["currentUse"], authority: MemorySourceRecord["authority"], data: Record<string, unknown>): MemorySourceRecord {
  if (fingerprint !== null && !/^[0-9a-f]{64}$/u.test(fingerprint)) fail("READ_FAILED");
  if ((fingerprint === null) !== (fingerprintOrigin === "not-stored")) fail("READ_FAILED");
  return { family, eventId, ids, fingerprint, fingerprintOrigin, recordedAt: recordedAt(at), currentUse, authority, carriesAuthorityForward: false, data };
}

function unavailableFamilies(): readonly UnavailableMemoryFamily[] {
  return [
    { family: "attendee-feedback", available: false, reason: "No authoritative attendee-feedback table or persisted feedback semantics exist." },
    { family: "reliability", available: false, reason: "No authoritative reliability record or persisted reliability semantics exist." },
    { family: "outreach-authorization", available: false, reason: "No authoritative current outreach-authorization source exists in the current schema." },
  ];
}

function addBounded(items: MemorySourceRecord[], more: readonly MemorySourceRecord[]): void {
  if (items.length + more.length > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("BOUND_EXCEEDED");
  items.push(...more);
}

function outputReadLimit(items: readonly MemorySourceRecord[]): number {
  const remaining = INSTITUTIONAL_MEMORY_MAX_ITEMS - items.length;
  if (remaining < 1) fail("BOUND_EXCEEDED");
  return remaining + 1;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

class MaterializationBudget {
  private used: number;

  constructor(initialUsed: number) {
    if (!Number.isSafeInteger(initialUsed) || initialUsed < 0 || initialUsed > INSTITUTIONAL_MEMORY_MAX_ITEMS) {
      fail("BOUND_EXCEEDED");
    }
    this.used = initialUsed;
  }

  remaining(): number {
    return INSTITUTIONAL_MEMORY_MAX_ITEMS - this.used;
  }

  reserve(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining()) fail("BOUND_EXCEEDED");
    this.used += count;
  }
}

function boundedRows(db: Db, sql: string, parameters: readonly (string | number)[]): Array<Record<string, unknown>> {
  const rows = db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
  if (rows.length > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("BOUND_EXCEEDED");
  return rows;
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("READ_FAILED");
  return Array.from({ length: count }, () => "?").join(",");
}

type StoredRevision = {
  readonly id: string;
  readonly submissionId: string;
  readonly revisionNumber: number;
  readonly fingerprint: string;
  readonly createdAt: string;
};

type StoredSubmission = {
  readonly id: string;
  readonly ownerPersonId: string;
  readonly eventId: string;
  readonly currentRevisionId: string | null;
  readonly revisions: readonly StoredRevision[];
};

type StoredDerivation = {
  readonly id: string;
  readonly relationshipType: string;
  readonly sourceSubmissionId: string;
  readonly sourceSubmissionRevisionId: string;
  readonly targetSubmissionId: string | null;
  readonly targetSubmissionRevisionId: string | null;
  readonly actorAccountId: string;
  readonly reason: string;
  readonly guidanceRequestId: string | null;
  readonly guidanceReference: string | null;
  readonly createdAt: string;
  readonly fingerprint: string;
};

type StoredGuidance = {
  readonly id: string;
  readonly sourceSubmissionId: string;
  readonly sourceSubmissionRevisionId: string;
  readonly targetCallId: string | null;
  readonly guidanceVersion: string;
  readonly guidance: unknown;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly fingerprint: string;
};

type CohortSnapshotCandidate = {
  readonly id: string;
  readonly workspaceId: string;
  readonly cohortDefinitionId: string;
  readonly definitionVersion: number;
  readonly asOf: string;
  readonly fingerprint: string;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly cohortName: string;
};

type CohortSnapshotMember = {
  readonly id: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly personId: string;
  readonly rank: number;
  readonly whyIn: string;
};

type BoundedLineage = {
  readonly submissionIds: readonly string[];
  readonly submissions: readonly StoredSubmission[];
  readonly derivations: readonly StoredDerivation[];
  readonly guidanceById: ReadonlyMap<string, StoredGuidance>;
};

const DERIVATION_COLUMNS = `id, workspace_id, relationship_type, source_submission_id,
  source_submission_revision_id, target_submission_id, target_submission_revision_id,
  actor_account_id, reason, guidance_request_id, guidance_reference, created_at, fingerprint`;

function canonicalStoredJson(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROVENANCE_PAYLOAD_BYTES) fail("READ_FAILED");
  try {
    const parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) fail("READ_FAILED");
    return parsed;
  } catch (error) {
    if (error instanceof InstitutionalMemoryError) throw error;
    fail("READ_FAILED");
  }
}

function immutableDocumentFingerprint(
  value: unknown,
  requiredKeys: readonly string[],
  storedFingerprint: unknown,
  schema: string,
  algorithm: string,
  bindings: Readonly<Record<string, unknown>> = {},
): string {
  const document = storedRecord(value);
  const keys = Object.keys(document).sort();
  const expectedKeys = [...requiredKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || document.schema !== schema) fail("READ_FAILED");
  for (const [key, expected] of Object.entries(bindings)) {
    if (document[key] !== expected) fail("READ_FAILED");
  }
  if (document.fingerprintAlgorithm !== undefined && document.fingerprintAlgorithm !== algorithm) fail("READ_FAILED");
  if (typeof storedFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(storedFingerprint)) fail("READ_FAILED");
  if (document.fingerprint !== undefined) {
    if (document.fingerprint !== storedFingerprint) fail("READ_FAILED");
    const { fingerprint, ...content } = document;
    if (fingerprintOf(content) !== fingerprint) fail("READ_FAILED");
  } else if (fingerprintOf(document) !== storedFingerprint) fail("READ_FAILED");
  return storedFingerprint;
}

function storedRecord(value: unknown): Record<string, unknown> {
  try {
    return ownRecord(value);
  } catch {
    fail("READ_FAILED");
  }
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("READ_FAILED");
  return value;
}

function cohortDefinitionRecord(value: unknown, expectedName: string, expectedVersion: number): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROVENANCE_PAYLOAD_BYTES) fail("READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("READ_FAILED");
  }
  const definition = storedRecord(parsed);
  if (Object.prototype.hasOwnProperty.call(definition, "name") && definition.name !== expectedName) fail("READ_FAILED");
  if (Object.prototype.hasOwnProperty.call(definition, "version") && definition.version !== expectedVersion) fail("READ_FAILED");
}

function nearMissSnapshotSources(
  db: Db,
  workspaceId: string,
  personId: string,
  historicalBoundary: string | undefined,
  budget: MaterializationBudget,
): MemorySourceRecord[] {
  // The current cohort schema has no event_id on a snapshot. Any event context therefore
  // contributes only a boundary; snapshot membership never chooses or creates an event
  // association. Historical scope is optional for person-only queries and is enforced by both
  // the snapshot's as_of and immutable created_at when present.
  const snapshotLimit = budget.remaining();
  if (snapshotLimit < 1) fail("BOUND_EXCEEDED");
  const snapshotRows = boundedRows(db, `SELECT
      s.id AS snapshot_id, s.workspace_id AS snapshot_workspace_id,
      s.cohort_definition_id AS snapshot_definition_id, s.definition_version AS snapshot_definition_version,
      s.as_of AS snapshot_as_of, s.fingerprint AS snapshot_fingerprint,
      s.member_count AS snapshot_member_count, s.created_at AS snapshot_created_at,
      d.id AS definition_id, d.workspace_id AS definition_workspace_id,
      d.version AS definition_version, d.name AS definition_name, d.definition_json
    FROM cohort_snapshot_members target_member
    JOIN cohort_snapshots s
      ON s.id = target_member.snapshot_id AND s.workspace_id = target_member.workspace_id
    JOIN cohort_definitions d
      ON d.id = s.cohort_definition_id AND d.workspace_id = s.workspace_id
    JOIN people target_person
      ON target_person.id = target_member.person_id AND target_person.workspace_id = target_member.workspace_id
    WHERE target_member.workspace_id = ? AND target_member.person_id = ?
    ORDER BY s.as_of, s.id, target_member.rank, target_member.id
    LIMIT ?`, [workspaceId, personId, snapshotLimit + 1]);
  if (snapshotRows.length > snapshotLimit) fail("BOUND_EXCEEDED");
  budget.reserve(snapshotRows.length);

  const candidates: CohortSnapshotCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const row of snapshotRows) {
    const id = rowText(row.snapshot_id);
    if (candidateIds.has(id)) fail("READ_FAILED");
    candidateIds.add(id);
    if (row.snapshot_workspace_id !== workspaceId || row.definition_workspace_id !== workspaceId
      || row.definition_id !== row.snapshot_definition_id) fail("READ_FAILED");
    const cohortDefinitionId = rowText(row.snapshot_definition_id);
    const definitionVersion = positiveVersion(row.snapshot_definition_version);
    if (positiveVersion(row.definition_version) !== definitionVersion) fail("READ_FAILED");
    const cohortName = provenanceText(row.definition_name, 256);
    cohortDefinitionRecord(row.definition_json, cohortName, definitionVersion);
    const asOf = recordedAt(row.snapshot_as_of);
    const fingerprint = rowText(row.snapshot_fingerprint);
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) fail("READ_FAILED");
    const memberCount = nonNegativeInteger(row.snapshot_member_count);
    const createdAt = recordedAt(row.snapshot_created_at);
    candidates.push(freeze({ id, workspaceId, cohortDefinitionId, definitionVersion, asOf,
      fingerprint, memberCount, createdAt, cohortName }));
  }
  if (candidates.length === 0) return [];

  const memberLimit = budget.remaining();
  if (memberLimit < 1) fail("BOUND_EXCEEDED");
  const memberRows = boundedRows(db, `SELECT
      m.id AS member_id, m.workspace_id AS member_workspace_id, m.snapshot_id,
      m.person_id, m.rank, m.why_in,
      p.workspace_id AS person_workspace_id
    FROM cohort_snapshot_members m
    JOIN people p ON p.id = m.person_id AND p.workspace_id = m.workspace_id
    WHERE m.workspace_id = ? AND m.snapshot_id IN (${placeholders(candidates.length)})
    ORDER BY m.snapshot_id, m.rank, m.person_id, m.id
    LIMIT ?`, [workspaceId, ...candidates.map((candidate) => candidate.id), memberLimit + 1]);
  if (memberRows.length > memberLimit) fail("BOUND_EXCEEDED");
  budget.reserve(memberRows.length);

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const membersBySnapshot = new Map<string, CohortSnapshotMember[]>();
  const memberIds = new Set<string>();
  for (const row of memberRows) {
    const id = rowText(row.member_id);
    if (memberIds.has(id)) fail("READ_FAILED");
    memberIds.add(id);
    const snapshotId = rowText(row.snapshot_id);
    if (!candidateById.has(snapshotId) || row.member_workspace_id !== workspaceId
      || row.person_workspace_id !== workspaceId) fail("READ_FAILED");
    const member: CohortSnapshotMember = freeze({
      id,
      workspaceId,
      snapshotId,
      personId: rowText(row.person_id),
      rank: positiveVersion(row.rank),
      whyIn: provenanceText(row.why_in, 4096),
    });
    const members = membersBySnapshot.get(snapshotId) ?? [];
    if (members.some((existing) => existing.personId === member.personId)) fail("READ_FAILED");
    members.push(member);
    membersBySnapshot.set(snapshotId, members);
  }

  const verified: Array<{ candidate: CohortSnapshotCandidate; targetMember: CohortSnapshotMember }> = [];
  for (const candidate of candidates) {
    const members = membersBySnapshot.get(candidate.id) ?? [];
    if (members.length !== candidate.memberCount || members.length === 0) fail("READ_FAILED");
    members.sort((left, right) => left.rank - right.rank
      || compareUtf16CodeUnits(left.personId, right.personId)
      || compareUtf16CodeUnits(left.id, right.id));
    for (const [index, member] of members.entries()) {
      if (member.rank !== index + 1) fail("READ_FAILED");
    }
    const expectedFingerprint = fingerprintOf({
      schema: COHORT_SNAPSHOT_SCHEMA,
      workspaceId,
      cohortName: candidate.cohortName,
      definitionVersion: candidate.definitionVersion,
      asOf: candidate.asOf,
      members: members.map((member) => ({ personId: member.personId, rank: member.rank, whyIn: member.whyIn })),
    });
    if (candidate.fingerprint !== expectedFingerprint) fail("READ_FAILED");
    const targetMember = members.find((member) => member.personId === personId);
    if (!targetMember) fail("READ_FAILED");
    if (historicalBoundary !== undefined && (candidate.asOf > historicalBoundary || candidate.createdAt > historicalBoundary)) continue;
    verified.push({ candidate, targetMember });
  }
  budget.reserve(verified.length);
  return verified.map(({ candidate, targetMember }) => source("near-miss-snapshot", null, {
      snapshotId: candidate.id,
      snapshotMemberId: targetMember.id,
      cohortDefinitionId: candidate.cohortDefinitionId,
      personId,
    }, candidate.fingerprint, "stored", candidate.createdAt, "historical", "historical-record", {
      workspaceId,
      personId,
      asOf: candidate.asOf,
      snapshotFingerprint: candidate.fingerprint,
      definitionVersion: candidate.definitionVersion,
      cohortName: candidate.cohortName,
      memberCount: candidate.memberCount,
      rank: targetMember.rank,
      whyIn: targetMember.whyIn,
      historicalOnly: true,
    }));
}

function validateReviewReceiptOutcome(value: unknown, reviewId: unknown, revisionNumber: number): void {
  const outcome = storedRecord(value);
  const keys = Object.keys(outcome).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["reviewRevisionId", "reviewRevisionNumber"])
    || rowText(outcome.reviewRevisionId) !== rowText(reviewId)
    || positiveVersion(outcome.reviewRevisionNumber) !== revisionNumber) fail("READ_FAILED");
}

function frontierEdges(
  db: Db,
  workspaceId: string,
  frontier: readonly string[],
  personId: string | undefined,
  eventId: string | undefined,
  seenEdgeIds: ReadonlySet<string>,
  remainingEdges: number,
): Array<Record<string, unknown>> {
  if (remainingEdges < 0) fail("BOUND_EXCEEDED");
  const unseenClause = seenEdgeIds.size
    ? `AND id NOT IN (${placeholders(seenEdgeIds.size)})`
    : "";
  const targetScope = personId || eventId
    ? `AND (target_submission_id IS NULL OR EXISTS (
        SELECT 1 FROM submissions target_scope
        WHERE target_scope.workspace_id = submission_derivations.workspace_id
          AND target_scope.id = submission_derivations.target_submission_id
          ${personId ? "AND target_scope.owner_person_id = ?" : ""}
          ${eventId ? "AND target_scope.event_id = ?" : ""}
      ))`
    : "";
  const rows = db.prepare(`SELECT ${DERIVATION_COLUMNS} FROM submission_derivations
    WHERE workspace_id = ? AND source_submission_id IN (${placeholders(frontier.length)}) ${unseenClause} ${targetScope}
    ORDER BY created_at, id LIMIT ?`).all(
    workspaceId, ...frontier, ...seenEdgeIds, ...(personId ? [personId] : []), ...(eventId ? [eventId] : []), remainingEdges + 1,
  ) as Array<Record<string, unknown>>;
  if (rows.length > remainingEdges) fail("BOUND_EXCEEDED");
  return rows;
}

function boundedLineageGraph(
  db: Db,
  workspaceId: string,
  lineageId: string,
  personId?: string,
  eventId?: string,
): { readonly lineage: Record<string, unknown>; readonly nodeIds: readonly string[]; readonly edgeRows: readonly Record<string, unknown>[] } {
  const lineage = db.prepare(`SELECT id, workspace_id, originating_submission_id,
      originating_submission_revision_id, display_projection_json, created_by_account_id, created_at
    FROM proposal_lineages WHERE workspace_id = ? AND id = ?`).get(workspaceId, lineageId) as Record<string, unknown> | undefined;
  if (!lineage || lineage.id !== lineageId || lineage.workspace_id !== workspaceId) fail("TARGET_UNAVAILABLE");
  const originId = rowText(lineage.originating_submission_id);
  const scope = `${personId ? "AND owner_person_id = ?" : ""} ${eventId ? "AND event_id = ?" : ""}`;
  const roots = boundedRows(db, `SELECT id, owner_person_id, event_id FROM submissions WHERE workspace_id = ?
    AND (lineage_id = ? OR id = ?) ${personId || eventId ? `AND (id = ? OR (1 = 1 ${scope}))` : ""}
    ORDER BY created_at, id LIMIT ?`,
  [workspaceId, lineageId, originId, ...(personId || eventId ? [originId] : []), ...(personId ? [personId] : []), ...(eventId ? [eventId] : []), INSTITUTIONAL_MEMORY_MAX_ITEMS + 1]);
  if (roots.length === 0) fail(personId || eventId ? "TARGET_UNAVAILABLE" : "READ_FAILED");
  const visited = new Set(roots.map((row) => rowText(row.id)));
  const originInScope = roots.some((root) => root.id === originId
    && (!personId || root.owner_person_id === personId)
    && (!eventId || root.event_id === eventId));
  const seenEdgeIds = new Set<string>();
  const edgeRows: Record<string, unknown>[] = [];
  let frontier = [...visited];
  while (frontier.length) {
    const nextNodes = new Set<string>();
    {
      const rows = frontierEdges(db, workspaceId, frontier, personId, eventId, seenEdgeIds,
        INSTITUTIONAL_MEMORY_MAX_ITEMS - seenEdgeIds.size);
      for (const row of rows) {
        const edgeId = rowText(row.id);
        if (seenEdgeIds.has(edgeId)) continue;
        seenEdgeIds.add(edgeId);
        const sourceId = rowText(row.source_submission_id);
        const targetId = row.target_submission_id === null ? null : rowText(row.target_submission_id);
        const sourceInScope = !personId && !eventId || sourceId !== originId || originInScope;
        if (sourceInScope) edgeRows.push(row);
        for (const nodeId of targetId === null ? [sourceId] : [sourceId, targetId]) {
          if (!visited.has(nodeId) && (nodeId !== sourceId || sourceInScope)) nextNodes.add(nodeId);
        }
      }
    }
    if (visited.size + nextNodes.size > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("BOUND_EXCEEDED");
    for (const nodeId of nextNodes) visited.add(nodeId);
    frontier = [...nextNodes];
  }
  edgeRows.sort((left, right) => {
    const byTime = compareUtf16CodeUnits(rowText(left.created_at), rowText(right.created_at));
    return byTime || compareUtf16CodeUnits(rowText(left.id), rowText(right.id));
  });
  const visibleIds = [...visited].filter((id) => id !== originId || originInScope);
  if (visibleIds.length === 0) fail("TARGET_UNAVAILABLE");
  return { lineage, nodeIds: freeze(visibleIds), edgeRows };
}

function loadBoundedLineage(db: Db, workspaceId: string, lineageId: string, outputUsed = 0,
  personId?: string, eventId?: string): BoundedLineage {
  const graph = boundedLineageGraph(db, workspaceId, lineageId, personId, eventId);
  const ids = graph.nodeIds;
  const inList = placeholders(ids.length);
  const submissionRows = boundedRows(db, `SELECT id, workspace_id, event_id, owner_person_id, call_id,
      current_revision_id, lineage_id, state, created_at FROM submissions
    WHERE workspace_id = ? AND id IN (${inList}) ORDER BY created_at, id LIMIT ?`,
  [workspaceId, ...ids, INSTITUTIONAL_MEMORY_MAX_ITEMS + 1]);
  if (submissionRows.length !== ids.length) fail("READ_FAILED");
  const requestIds = [...new Set(graph.edgeRows.flatMap((row) => row.guidance_request_id === null
    ? [] : [rowText(row.guidance_request_id)]))];
  const revisionBudget = INSTITUTIONAL_MEMORY_MAX_ITEMS - outputUsed - graph.edgeRows.length - requestIds.length;
  if (revisionBudget < 1) fail("BOUND_EXCEEDED");
  const revisionRows = boundedRows(db, `SELECT id, workspace_id, submission_id, revision_number,
      revision_schema, revision_json, fingerprint_algorithm, fingerprint, created_at FROM submission_revisions
    WHERE workspace_id = ? AND submission_id IN (${inList})
    ORDER BY submission_id, revision_number, id LIMIT ?`,
  [workspaceId, ...ids, revisionBudget + 1]);
  if (revisionRows.length > revisionBudget) fail("BOUND_EXCEEDED");
  const revisionOwner = new Map<string, string>();
  const submissions = submissionRows.map((row): StoredSubmission => {
    if (row.workspace_id !== workspaceId) fail("READ_FAILED");
    const submissionId = rowText(row.id);
    const revisions = revisionRows.filter((revision) => revision.submission_id === submissionId)
      .map((revision): StoredRevision => {
        if (revision.workspace_id !== workspaceId || revision.revision_schema !== CFP_SUBMISSION_REVISION_SCHEMA
          || revision.fingerprint_algorithm !== PD01_FINGERPRINT_ALGORITHM) fail("READ_FAILED");
        const stored = { id: rowText(revision.id), submissionId, revisionNumber: positiveVersion(revision.revision_number),
          fingerprint: rowText(revision.fingerprint), createdAt: recordedAt(revision.created_at) };
        immutableDocumentFingerprint(canonicalStoredJson(revision.revision_json),
          ["schema", "submissionId", "revisionNumber", "formDocument", "callPolicy", "consentReceipt", "fingerprintAlgorithm", "fingerprint"],
          stored.fingerprint, CFP_SUBMISSION_REVISION_SCHEMA, PD01_FINGERPRINT_ALGORITHM,
          { submissionId, revisionNumber: stored.revisionNumber });
        revisionOwner.set(stored.id, submissionId);
        return freeze(stored);
      });
    if (revisions.length === 0) fail("READ_FAILED");
    const currentRevisionId = row.current_revision_id === null ? null : rowText(row.current_revision_id);
    if (currentRevisionId !== null && !revisions.some((revision) => revision.id === currentRevisionId)) fail("READ_FAILED");
    return freeze({ id: submissionId, ownerPersonId: rowText(row.owner_person_id), eventId: rowText(row.event_id), currentRevisionId, revisions: freeze(revisions) });
  });
  const originSubmissionId = rowText(graph.lineage.originating_submission_id);
  const originRevisionId = rowText(graph.lineage.originating_submission_revision_id);
  if ((!personId && !eventId) && (!ids.includes(originSubmissionId) || revisionOwner.get(originRevisionId) !== originSubmissionId)) fail("READ_FAILED");
  canonicalStoredJson(graph.lineage.display_projection_json);
  const lineageActorId = rowText(graph.lineage.created_by_account_id);
  const lineageActor = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, lineageActorId) as { id?: unknown } | undefined;
  if (!lineageActor || lineageActor.id !== lineageActorId) fail("READ_FAILED");
  recordedAt(graph.lineage.created_at);

  const derivations = graph.edgeRows.map((row): StoredDerivation => {
    if (row.workspace_id !== workspaceId || !RELATIONSHIPS.has(String(row.relationship_type))) fail("READ_FAILED");
    const sourceSubmissionId = rowText(row.source_submission_id);
    const sourceSubmissionRevisionId = rowText(row.source_submission_revision_id);
    const targetSubmissionId = row.target_submission_id === null ? null : rowText(row.target_submission_id);
    const targetSubmissionRevisionId = row.target_submission_revision_id === null ? null : rowText(row.target_submission_revision_id);
    if (!ids.includes(sourceSubmissionId) || revisionOwner.get(sourceSubmissionRevisionId) !== sourceSubmissionId
      || (targetSubmissionId === null) !== (targetSubmissionRevisionId === null)
      || (targetSubmissionId !== null && (!ids.includes(targetSubmissionId)
        || revisionOwner.get(targetSubmissionRevisionId!) !== targetSubmissionId))) fail("READ_FAILED");
    const actorAccountId = rowText(row.actor_account_id);
    const actor = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, actorAccountId) as { id?: unknown } | undefined;
    if (!actor || actor.id !== actorAccountId) fail("READ_FAILED");
    const stored = {
      id: rowText(row.id), relationshipType: rowText(row.relationship_type), sourceSubmissionId,
      sourceSubmissionRevisionId, targetSubmissionId, targetSubmissionRevisionId, actorAccountId,
      reason: provenanceText(row.reason, 4096),
      guidanceRequestId: row.guidance_request_id === null ? null : rowText(row.guidance_request_id),
      guidanceReference: row.guidance_reference === null ? null : rowText(row.guidance_reference),
      createdAt: recordedAt(row.created_at), fingerprint: rowText(row.fingerprint),
    };
    const expected = fingerprintOf({ schema: SUBMISSION_DERIVATION_SCHEMA, workspaceId,
      relationshipType: stored.relationshipType, sourceSubmissionId, sourceSubmissionRevisionId,
      targetSubmissionId, targetSubmissionRevisionId, actorAccountId, reason: stored.reason,
      guidanceRequestId: stored.guidanceRequestId, guidanceReference: stored.guidanceReference,
      createdAt: stored.createdAt });
    if (stored.fingerprint !== expected) fail("READ_FAILED");
    return freeze(stored);
  });

  if (requestIds.length > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("BOUND_EXCEEDED");
  const guidanceById = new Map<string, StoredGuidance>();
  if (requestIds.length) {
    const guidanceBudget = INSTITUTIONAL_MEMORY_MAX_ITEMS - outputUsed - graph.edgeRows.length;
    if (guidanceBudget < requestIds.length) fail("BOUND_EXCEEDED");
    const rows = boundedRows(db, `SELECT id, workspace_id, source_submission_id,
        source_submission_revision_id, target_call_id, guidance_version, guidance_json,
        created_by_account_id, created_at, expires_at, fingerprint FROM resubmission_requests
      WHERE workspace_id = ? AND id IN (${placeholders(requestIds.length)}) ORDER BY created_at, id LIMIT ?`,
    [workspaceId, ...requestIds, guidanceBudget + 1]);
    if (rows.length !== requestIds.length) fail("READ_FAILED");
    for (const row of rows) {
      if (row.workspace_id !== workspaceId) fail("READ_FAILED");
      const id = rowText(row.id);
      const sourceSubmissionId = rowText(row.source_submission_id);
      const sourceSubmissionRevisionId = rowText(row.source_submission_revision_id);
      const targetCallId = row.target_call_id === null ? null : rowText(row.target_call_id);
      if (!ids.includes(sourceSubmissionId)
        || revisionOwner.get(sourceSubmissionRevisionId) !== sourceSubmissionId) fail("READ_FAILED");
      if (targetCallId !== null) {
        const call = db.prepare("SELECT id FROM calls WHERE workspace_id = ? AND id = ?")
          .get(workspaceId, targetCallId) as { id?: unknown } | undefined;
        if (!call || call.id !== targetCallId) fail("READ_FAILED");
      }
      const createdByAccountId = rowText(row.created_by_account_id);
      const creator = db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, createdByAccountId) as { id?: unknown } | undefined;
      if (!creator || creator.id !== createdByAccountId) fail("READ_FAILED");
      const guidance = canonicalStoredJson(row.guidance_json);
      const createdAt = recordedAt(row.created_at);
      const expiresAt = row.expires_at === null ? null : recordedAt(row.expires_at);
      const guidanceVersion = provenanceText(row.guidance_version, 128);
      const fingerprint = rowText(row.fingerprint);
      const expected = fingerprintOf({ schema: RESUBMISSION_REQUEST_SCHEMA, workspaceId,
        sourceSubmissionId, sourceSubmissionRevisionId, targetCallId, guidanceVersion, guidance,
        createdByAccountId, createdAt, expiresAt });
      if (fingerprint !== expected) fail("READ_FAILED");
      guidanceById.set(id, freeze({ id, sourceSubmissionId, sourceSubmissionRevisionId,
        targetCallId, guidanceVersion, guidance, createdAt, expiresAt, fingerprint }));
    }
  }
  for (const derivation of derivations) {
    if (derivation.guidanceRequestId !== null) {
      const guidance = guidanceById.get(derivation.guidanceRequestId);
      if (!guidance || guidance.sourceSubmissionId !== derivation.sourceSubmissionId
        || guidance.sourceSubmissionRevisionId !== derivation.sourceSubmissionRevisionId) fail("READ_FAILED");
    }
  }
  return freeze({ submissionIds: ids, submissions: freeze(submissions),
    derivations: freeze(derivations), guidanceById });
}

function reviewHistoryVisible(session: SessionInfo): boolean {
  // Existing organizer capability permits metadata-only review administration. Evaluation JSON,
  // reviewer identity, conflict reasons, and blind artifacts remain outside this projection.
  return roleHasCapability(session.role, "phase0.pipeline.manage");
}

function assembleInstitutionalMemory(db: Db, session: SessionInfo, query: ReturnType<typeof normalize>): InstitutionalMemoryResult {
  const person = query.personId
    ? db.prepare("SELECT id FROM people WHERE workspace_id = ? AND id = ?").get(session.workspaceId, query.personId) as { id?: unknown } | undefined
    : undefined;
  if (query.personId && (!person || person.id !== query.personId)) fail("TARGET_UNAVAILABLE");
  let eventAsOf: string | undefined;
  if (query.eventId) {
    const event = db.prepare(query.personId && !query.lineageId
      ? "SELECT id, starts_at FROM events WHERE workspace_id = ? AND id = ?"
      : "SELECT id FROM events WHERE workspace_id = ? AND id = ?")
      .get(session.workspaceId, query.eventId) as { id?: unknown; starts_at?: unknown } | undefined;
    if (!event || event.id !== query.eventId) fail("TARGET_UNAVAILABLE");
    if (query.personId && !query.lineageId) eventAsOf = recordedAt(event.starts_at);
  }

  const sources: MemorySourceRecord[] = [];
  const lineageId = query.lineageId ?? null;
  let lineageSubmissionIds: readonly string[] | null = null;
  let lineageSubmissions: readonly { id: string; ownerPersonId: string; eventId: string; currentRevisionId: string | null; revisions: readonly { id: string; fingerprint: string; createdAt: string; revisionNumber: number }[] }[] = [];
  let disclosedDerivations: readonly StoredDerivation[] = [];
  if (query.lineageId) {
    const boundedLineage = loadBoundedLineage(db, session.workspaceId, query.lineageId, 0, query.personId, query.eventId);
    const disclosed = boundedLineage.submissions.filter((submission) =>
      (!query.personId || submission.ownerPersonId === query.personId)
      && (!query.eventId || submission.eventId === query.eventId));
    if (query.personId && disclosed.length === 0) fail("TARGET_UNAVAILABLE");
    if (query.eventId && disclosed.length === 0) fail("TARGET_UNAVAILABLE");
    const disclosedIds = new Set(disclosed.map((submission) => submission.id));
    lineageSubmissionIds = [...disclosedIds];
    lineageSubmissions = disclosed;
    disclosedDerivations = boundedLineage.derivations.filter((item) => {
      if (!disclosedIds.has(item.sourceSubmissionId)) return false;
      if (item.targetSubmissionId !== null && !disclosedIds.has(item.targetSubmissionId)) return false;
      return true;
    });
    const eventBySubmission = new Map(lineageSubmissions.map((submission) => [submission.id, submission.eventId]));
    for (const item of disclosedDerivations) {
      const eventId = eventBySubmission.get(item.sourceSubmissionId);
      if (!eventId) fail("READ_FAILED");
      addBounded(sources, [source("lineage", eventId, { derivationId: item.id, sourceSubmissionId: item.sourceSubmissionId, sourceSubmissionRevisionId: item.sourceSubmissionRevisionId, ...(item.targetSubmissionId ? { targetSubmissionId: item.targetSubmissionId, targetSubmissionRevisionId: item.targetSubmissionRevisionId! } : {}) }, item.fingerprint, "stored", item.createdAt, "historical", "evidence-only", { relationshipType: item.relationshipType, reason: item.reason, guidanceRequestId: item.guidanceRequestId, guidanceReference: item.guidanceReference })]);
    }
    for (const item of disclosedDerivations) {
      if (item.guidanceRequestId !== null) {
        const eventId = eventBySubmission.get(item.sourceSubmissionId);
        if (!eventId) fail("READ_FAILED");
        const request = boundedLineage.guidanceById.get(item.guidanceRequestId);
        if (!request) fail("READ_FAILED");
        addBounded(sources, [source("lineage", eventId, { requestId: request.id,
          sourceSubmissionId: request.sourceSubmissionId,
          sourceSubmissionRevisionId: request.sourceSubmissionRevisionId }, request.fingerprint,
        "stored", request.createdAt, "historical", "evidence-only", {
          guidanceVersion: request.guidanceVersion, guidance: request.guidance,
          targetCallId: request.targetCallId, expiresAt: request.expiresAt,
        })]);
      }
    }
  } else if (query.personId) {
    const submissionRows = boundedRows(db, `SELECT id, event_id AS eventId, current_revision_id AS currentRevisionId
      FROM submissions WHERE workspace_id = ? AND owner_person_id = ? ${query.eventId ? "AND event_id = ?" : ""}
      ORDER BY created_at, id LIMIT ?`, [session.workspaceId, query.personId,
      ...(query.eventId ? [query.eventId] : []), outputReadLimit(sources)]);
    if (submissionRows.length) {
      const ids = submissionRows.map((row) => rowText(row.id));
      const revisions = boundedRows(db, `SELECT id, submission_id, revision_number, revision_json, fingerprint_algorithm, fingerprint, created_at
        FROM submission_revisions WHERE workspace_id = ? AND submission_id IN (${placeholders(ids.length)})
        ORDER BY submission_id, revision_number, id LIMIT ?`,
      [session.workspaceId, ...ids, outputReadLimit(sources)]);
      lineageSubmissions = submissionRows.map((row) => ({
        id: rowText(row.id), ownerPersonId: query.personId!, eventId: rowText(row.eventId),
        currentRevisionId: row.currentRevisionId === null ? null : rowText(row.currentRevisionId),
        revisions: revisions.filter((revision) => revision.submission_id === row.id).map((revision) => {
          const id = rowText(revision.id);
          const fingerprint = rowText(revision.fingerprint);
          if (revision.fingerprint_algorithm !== PD01_FINGERPRINT_ALGORITHM) fail("READ_FAILED");
          immutableDocumentFingerprint(canonicalStoredJson(revision.revision_json),
            ["schema", "submissionId", "revisionNumber", "formDocument", "callPolicy", "consentReceipt", "fingerprintAlgorithm", "fingerprint"],
            fingerprint, CFP_SUBMISSION_REVISION_SCHEMA, PD01_FINGERPRINT_ALGORITHM,
            { submissionId: row.id, revisionNumber: positiveVersion(revision.revision_number) });
          return { id, fingerprint, createdAt: recordedAt(revision.created_at), revisionNumber: positiveVersion(revision.revision_number) };
        }),
      }));
    }
  }
  for (const item of lineageSubmissions) {
    if (query.eventId && item.eventId !== query.eventId) continue;
    for (const revision of item.revisions) {
      addBounded(sources, [source("submission-revision", item.eventId, { submissionId: item.id, submissionRevisionId: revision.id }, revision.fingerprint, "stored", revision.createdAt, revision.id === item.currentRevisionId ? "current" : "historical", "historical-record", { revisionNumber: revision.revisionNumber })]);
    }
  }

  const personId = query.personId ?? null;
  const personEvents = query.eventId ? [query.eventId] : undefined;
  const eventArgs = personEvents ?? [];
  if (reviewHistoryVisible(session) && lineageSubmissions.length) {
    const submissionIds = lineageSubmissions.map((submission) => submission.id);
    const reviews = boundedRows(db, `SELECT rr.id, rr.assignment_id, rr.rubric_version_id, rr.submission_id,
        rr.submission_revision_id, rr.round_id, rr.revision_number, rr.evaluation_schema,
        rr.evaluation_json, rr.fingerprint_algorithm, rr.fingerprint, rr.created_at,
        assignment.workspace_id AS assignment_workspace_id,
        assignment.round_id AS assignment_round_id,
        assignment.rubric_version_id AS assignment_rubric_version_id,
        assignment.submission_id AS assignment_submission_id,
        assignment.submission_revision_id AS assignment_submission_revision_id,
        assignment.created_at AS assignment_created_at,
        assignment.assigned_by AS assignment_assigned_by,
        review_round.workspace_id AS review_round_workspace_id,
        review_round.call_id AS review_round_call_id,
        review_round.event_id AS review_round_event_id,
        rubric.workspace_id AS rubric_workspace_id,
        rubric.round_id AS rubric_round_id,
        assigned_submission.workspace_id AS assigned_submission_workspace_id,
        assigned_submission.call_id AS assigned_submission_call_id,
        assigned_submission.event_id AS assigned_submission_event_id,
        assigned_revision.workspace_id AS assigned_revision_workspace_id,
        assigned_revision.submission_id AS assigned_revision_submission_id,
        assigned_call.workspace_id AS assigned_call_workspace_id,
        assigned_call.event_id AS assigned_call_event_id,
        assigned_event.workspace_id AS assigned_event_workspace_id,
        assignment_state.workspace_id AS assignment_state_workspace_id,
        assignment_state.assignment_id AS assignment_state_assignment_id,
        assignment_state.state AS assignment_state_state,
        assignment_state.sequence_number AS assignment_state_sequence_number,
        assignment_state.actor_account_id AS assignment_state_actor_account_id,
        assignment_state.created_at AS assignment_state_created_at,
        assigned_by_account.workspace_id AS assigned_by_workspace_id,
        state_actor.workspace_id AS state_actor_workspace_id,
        receipt.id AS receipt_id,
        receipt.workspace_id AS receipt_workspace_id,
        receipt.assignment_id AS receipt_assignment_id,
        receipt.round_id AS receipt_round_id,
        receipt.rubric_version_id AS receipt_rubric_version_id,
        receipt.submission_revision_id AS receipt_submission_revision_id,
        receipt.effect_id AS receipt_effect_id,
        receipt.receipt_schema AS receipt_schema,
        receipt.receipt_fingerprint_algorithm AS receipt_fingerprint_algorithm,
        receipt.receipt_json AS receipt_json,
        receipt.receipt_fingerprint AS receipt_fingerprint,
        receipt.actor_account_id AS receipt_actor_account_id,
        receipt.command_kind AS receipt_command_kind,
        receipt.created_at AS receipt_created_at,
        receipt_actor.workspace_id AS receipt_actor_workspace_id,
        s.event_id, (SELECT MAX(latest.revision_number) FROM review_revisions latest
          WHERE latest.workspace_id = rr.workspace_id AND latest.assignment_id = rr.assignment_id) AS latest_revision_number
      FROM review_revisions rr
      LEFT JOIN review_assignments assignment
        ON assignment.workspace_id = rr.workspace_id AND assignment.id = rr.assignment_id
      LEFT JOIN review_rounds review_round
        ON review_round.workspace_id = rr.workspace_id AND review_round.id = assignment.round_id
      LEFT JOIN rubric_versions rubric
        ON rubric.workspace_id = rr.workspace_id AND rubric.id = assignment.rubric_version_id
      LEFT JOIN submissions assigned_submission
        ON assigned_submission.workspace_id = rr.workspace_id AND assigned_submission.id = assignment.submission_id
      LEFT JOIN submission_revisions assigned_revision
        ON assigned_revision.workspace_id = rr.workspace_id AND assigned_revision.id = assignment.submission_revision_id
      LEFT JOIN calls assigned_call
        ON assigned_call.workspace_id = rr.workspace_id AND assigned_call.id = assigned_submission.call_id
      LEFT JOIN events assigned_event
        ON assigned_event.workspace_id = rr.workspace_id AND assigned_event.id = review_round.event_id
      LEFT JOIN review_assignment_states assignment_state
        ON assignment_state.workspace_id = rr.workspace_id
        AND assignment_state.assignment_id = assignment.id AND assignment_state.sequence_number = 1
      LEFT JOIN accounts assigned_by_account
        ON assigned_by_account.workspace_id = rr.workspace_id AND assigned_by_account.id = assignment.assigned_by
      LEFT JOIN accounts state_actor
        ON state_actor.workspace_id = rr.workspace_id AND state_actor.id = assignment_state.actor_account_id
      LEFT JOIN review_command_receipts receipt
        ON receipt.workspace_id = rr.workspace_id AND receipt.effect_id = rr.id
        AND receipt.command_kind IN ('SAVE_REVIEW', 'SUBMIT_REVIEW')
      LEFT JOIN accounts receipt_actor
        ON receipt_actor.workspace_id = rr.workspace_id AND receipt_actor.id = receipt.actor_account_id
      JOIN submissions s ON s.workspace_id = rr.workspace_id AND s.id = rr.submission_id
      WHERE rr.workspace_id = ? AND s.id IN (${placeholders(submissionIds.length)})
      ${query.eventId ? "AND s.event_id = ?" : ""} ORDER BY rr.created_at, rr.id LIMIT ?`,
    [session.workspaceId, ...submissionIds, ...eventArgs, outputReadLimit(sources)]);
    addBounded(sources, reviews.map((row) => {
      const revisionNumber = positiveVersion(row.revision_number);
      const latestRevisionNumber = positiveVersion(row.latest_revision_number);
      if (row.assignment_workspace_id !== session.workspaceId
        || row.assignment_round_id !== row.round_id
        || row.assignment_rubric_version_id !== row.rubric_version_id
        || row.assignment_submission_id !== row.submission_id
        || row.assignment_submission_revision_id !== row.submission_revision_id) {
        fail("READ_FAILED");
      }
      const assignmentCreatedAt = recordedAt(row.assignment_created_at);
      const reviewCreatedAt = recordedAt(row.created_at);
      if (assignmentCreatedAt > reviewCreatedAt
        || row.review_round_workspace_id !== session.workspaceId
        || row.rubric_workspace_id !== session.workspaceId
        || row.rubric_round_id !== row.assignment_round_id
        || row.assigned_submission_workspace_id !== session.workspaceId
        || row.assigned_submission_call_id == null
        || row.assigned_submission_event_id == null
        || row.assigned_revision_workspace_id !== session.workspaceId
        || row.assigned_revision_submission_id !== row.assignment_submission_id
        || row.assigned_call_workspace_id !== session.workspaceId
        || row.assigned_call_event_id !== row.review_round_event_id
        || row.assigned_event_workspace_id !== session.workspaceId
        || row.review_round_call_id !== row.assigned_submission_call_id
        || row.review_round_event_id !== row.assigned_submission_event_id
        || (query.eventId !== undefined && row.review_round_event_id !== query.eventId)
        || row.assignment_state_workspace_id !== session.workspaceId
        || row.assignment_state_assignment_id !== row.assignment_id
        || row.assignment_state_state !== "ASSIGNED"
        || row.assignment_state_sequence_number !== 1
        || row.assignment_state_actor_account_id !== row.assignment_assigned_by
        || row.assignment_state_created_at !== row.assignment_created_at
        || row.assigned_by_workspace_id !== session.workspaceId
        || row.state_actor_workspace_id !== session.workspaceId) fail("READ_FAILED");
      if (row.receipt_id === null) fail("READ_FAILED");
      if (
        row.receipt_workspace_id !== session.workspaceId
        || row.receipt_assignment_id !== row.assignment_id
        || row.receipt_round_id !== row.round_id
        || row.receipt_rubric_version_id !== row.rubric_version_id
        || row.receipt_submission_revision_id !== row.submission_revision_id
        || row.receipt_effect_id !== row.id
        || row.receipt_schema !== "cfp-review-command-receipt/v1"
        || row.receipt_fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM
        || row.receipt_actor_account_id == null
        || row.receipt_actor_workspace_id !== session.workspaceId
        || recordedAt(row.receipt_created_at) > reviewCreatedAt) fail("READ_FAILED");
      const receiptDocument = canonicalStoredJson(row.receipt_json);
      if (row.receipt_command_kind !== "SAVE_REVIEW") fail("READ_FAILED");
      immutableDocumentFingerprint(receiptDocument,
        ["schema", "workspaceId", "assignmentId", "roundId", "rubricVersionId", "submissionRevisionId",
          "actorAccountId", "commandKind", "effectId", "createdAt", "outcome"],
        row.receipt_fingerprint, "cfp-review-command-receipt/v1", CFP_REVIEW_FINGERPRINT_ALGORITHM, {
          workspaceId: session.workspaceId, assignmentId: row.assignment_id, roundId: row.round_id,
          rubricVersionId: row.rubric_version_id, submissionRevisionId: row.submission_revision_id,
          actorAccountId: row.receipt_actor_account_id, commandKind: row.receipt_command_kind, effectId: row.id,
          createdAt: row.receipt_created_at,
        });
      validateReviewReceiptOutcome(storedRecord(receiptDocument).outcome, row.id, revisionNumber);
      // The persisted schema has no separate review-creation receipt binding the original
      // assignment tuple. The immutable assignment row, initial state, and creation ordering
      // are therefore the complete available anchor; any inconsistency fails closed.
      if (row.evaluation_schema !== CFP_REVIEW_EVALUATION_SCHEMA
        || row.fingerprint_algorithm !== CFP_REVIEW_FINGERPRINT_ALGORITHM) fail("READ_FAILED");
      const fingerprint = rowText(row.fingerprint);
      immutableDocumentFingerprint(canonicalStoredJson(row.evaluation_json),
        ["schema", "assignmentId", "rubricVersionId", "submissionRevisionId", "reviewRevisionNumber", "responses"],
        fingerprint, CFP_REVIEW_EVALUATION_SCHEMA, CFP_REVIEW_FINGERPRINT_ALGORITHM,
        { assignmentId: row.assignment_id, rubricVersionId: row.rubric_version_id,
          submissionRevisionId: row.submission_revision_id, reviewRevisionNumber: revisionNumber });
      return source("review-history", rowText(row.event_id), { reviewRevisionId: rowText(row.id), assignmentId: rowText(row.assignment_id), submissionId: rowText(row.submission_id), submissionRevisionId: rowText(row.submission_revision_id), roundId: rowText(row.round_id) }, rowText(row.fingerprint), "stored", reviewCreatedAt, revisionNumber === latestRevisionNumber ? "current" : "historical", "historical-record", { editorialRecord: "review revision", revisionNumber, latestRevisionNumber, visibilityPolicy: REVIEW_HISTORY_VISIBILITY_POLICY });
    }));
  }

  // Person-wide operational and provenance families are never appended to lineage scope. They are
  // available only when the caller explicitly selected that exact person without a lineage.
  if (personId && lineageSubmissionIds === null) {
    const candidateLimit = outputReadLimit(sources);
    const candidateRows = boundedRows(db, `SELECT pa.plan_version_id
      FROM plan_assignments pa
      ${query.eventId ? "JOIN plan_versions pv ON pv.workspace_id = pa.workspace_id AND pv.id = pa.plan_version_id AND pv.event_id = ?" : ""}
      WHERE pa.workspace_id = ? AND pa.person_id = ? ORDER BY pa.plan_version_id LIMIT ?`,
    [...(query.eventId ? [query.eventId] : []), session.workspaceId, personId, candidateLimit]);
    if (candidateRows.length >= candidateLimit) fail("BOUND_EXCEEDED");
    const candidateIds = [...new Set(candidateRows.map((row) => rowText(row.plan_version_id)))];
    if (candidateIds.length > INSTITUTIONAL_MEMORY_MAX_ITEMS) fail("BOUND_EXCEEDED");
    const approvals = candidateIds.length === 0 ? [] : boundedRows(db, `SELECT id, event_id, plan_version_id, decision, created_at
      FROM approvals WHERE workspace_id = ? AND plan_version_id IN (${placeholders(candidateIds.length)})
      ${query.eventId ? "AND event_id = ?" : ""}
      ORDER BY created_at, id LIMIT ?`, [session.workspaceId, ...candidateIds, ...eventArgs, outputReadLimit(sources)]);
    addBounded(sources, approvals.map((row) => source("decision-outcome", rowText(row.event_id), { approvalId: rowText(row.id), planVersionId: rowText(row.plan_version_id) }, null, "not-stored", rowText(row.created_at), "historical", "historical-record", { kind: "decision", decision: provenanceText(row.decision, 128) })));
    const observations = boundedRows(db, `SELECT o.id, o.event_id, o.program_unit_id, o.observation_type, o.observed_at, o.source
      FROM observations o WHERE o.workspace_id = ? AND o.person_id = ? ${query.eventId ? "AND o.event_id = ?" : ""}
      ORDER BY o.observed_at, o.id LIMIT ?`, [session.workspaceId, personId, ...eventArgs, outputReadLimit(sources)]);
    addBounded(sources, observations.map((row) => source("decision-outcome", rowText(row.event_id), { observationId: rowText(row.id), programUnitId: rowText(row.program_unit_id) }, null, "not-stored", rowText(row.observed_at), "historical", "historical-record", { kind: "operational-outcome", observationType: provenanceText(row.observation_type, 128), source: provenanceText(row.source, 256) })));
    const personHistory = boundedRows(db, `SELECT l.id, l.source_record_id, l.link_decision, l.created_at AS linked_at,
        r.provider, r.source_ref, r.version, r.payload_json, r.imported_at
      FROM source_links l JOIN source_records r ON r.workspace_id = l.workspace_id AND r.id = l.source_record_id
      WHERE l.workspace_id = ? AND l.person_id = ? ORDER BY r.imported_at, l.id LIMIT ?`,
    [session.workspaceId, personId, outputReadLimit(sources)]);
    addBounded(sources, personHistory.map((row) => {
      const sourceLinkId = rowText(row.id);
      const sourceRecordId = rowText(row.source_record_id);
      const provider = provenanceText(row.provider, 128);
      const sourceRef = provenanceText(row.source_ref, 512);
      const version = positiveVersion(row.version);
      const payload = provenancePayload(row.payload_json);
      const importedAt = recordedAt(row.imported_at);
      const linkedAt = recordedAt(row.linked_at);
      const linkDecision = provenanceText(row.link_decision, 256);
      const fingerprint = fingerprintOf({ schema: PERSON_PROVENANCE_SCHEMA, workspaceId: session.workspaceId,
        personId, sourceLinkId, sourceRecordId, provider, sourceRef, version,
        payloadFingerprint: sha256Hex(payload), importedAt, linkDecision, linkedAt });
      return source("person-history", null, { sourceLinkId, sourceRecordId }, fingerprint,
        "derived-from-immutable-source", importedAt, "historical", "evidence-only",
        { provider, sourceRef, version, payloadFingerprint: sha256Hex(payload), linkDecision, linkedAt });
    }));

    // Near-miss snapshots are person-scoped historical evidence. The current schema does not
    // persist an event binding on cohort_snapshots, so snapshot sources remain eventless. An
    // event context contributes only its historical boundary; person-only queries may project
    // all valid snapshot history or apply their explicit as-of boundary.
    const snapshotBudget = new MaterializationBudget(sources.length);
    addBounded(sources, nearMissSnapshotSources(db, session.workspaceId, personId,
      query.asOf ?? eventAsOf, snapshotBudget));
  }

  return freeze({ schema: INSTITUTIONAL_MEMORY_SCHEMA, workspaceId: session.workspaceId, personId, lineageId, eventId: query.eventId ?? null, authorityCarryover: false, sources, unavailableFamilies: unavailableFamilies() });
}

export function queryInstitutionalMemory(db: Db, session: SessionInfo, input: InstitutionalMemoryQuery): InstitutionalMemoryResult {
  let query: ReturnType<typeof normalize>;
  try {
    query = normalize(input);
  } catch (error) {
    if (error instanceof InstitutionalMemoryError) throw error;
    fail("INPUT_INVALID");
  }
  try {
    authorize(db, session, query.workspaceSlug);
    // A caller-owned transaction may be an old SQLite snapshot. Refusing it is the only safe
    // boundary available to this read-only service without changing the shared DB helper.
    if (db.isTransaction) fail("READ_FAILED");
    let result: InstitutionalMemoryResult;
    try {
      db.exec("BEGIN");
      if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
      result = assembleInstitutionalMemory(db, session, query);
      db.exec("COMMIT");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        fail("READ_FAILED");
      }
      if (error instanceof InstitutionalMemoryError) throw error;
      fail("READ_FAILED");
    }
    // This check is deliberately outside the transaction: it observes revocation committed by
    // another connection after the read snapshot was assembled and before the result is returned.
    if (!sessionIsCurrent(db, session)) fail("AUTHORIZATION_DENIED");
    return result!;
  } catch (error) {
    if (error instanceof InstitutionalMemoryError) throw error;
    fail("READ_FAILED");
  }
}

export const getInstitutionalMemory = queryInstitutionalMemory;
