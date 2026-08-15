import { roleHasCapability } from "../../auth";
import { canonicalJson, fingerprintOf } from "../../canonical";
import type { Db } from "../../db";
import {
  assessSourceVector,
  selectAudienceSourceVector,
  type DriftFamily,
  type JsonValue,
  type SourceRecordInput,
} from "../operator-release-core";
import {
  evaluateReadinessProofGraph,
  type AudienceKind,
  type AudienceReference,
  type AuthorizedEvidence,
  type AuthorityReference,
  type EvidenceState,
  type ProofScope,
  type ReadinessOutcome,
  type ReadinessRequirement,
  type SourceFamily,
} from "../readiness-proof-graph";
import {
  validatePublicReleaseForRead,
  type SealedReleaseContent,
  type ValidatedPublicRelease,
} from "../publication";
import {
  readCanonicalScheduleProjection,
} from "../scheduling";
import { readCurrentScheduleApproval, scheduleApprovalSubject } from "../scheduling/approval";
import {
  findScheduleDraftAuthorityEvidence,
  readScheduleDraft,
} from "../scheduling/persistence";

export const OPERATOR_PROOF_EXPERIENCE_SCHEMA = "operator-proof-experience/v1" as const;
export const OPERATOR_PROOF_HISTORY_LIMIT = 64;
export const OPERATOR_PROOF_ACTIVITY_LIMIT = 8;
export const OPERATOR_PROOF_REPLAY_LIMIT = 8;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export type OperatorProofStatus = "BLOCKED" | "READY" | "UNAVAILABLE";

export interface OperatorProofBlocker {
  readonly code: string;
  readonly message: string;
  readonly requirementId: string;
  readonly evidenceIds: readonly string[];
}

export interface OperatorProofOutcome {
  readonly outcome: ReadinessOutcome;
  readonly label: string;
  readonly status: OperatorProofStatus;
  readonly evidenceIds: readonly string[];
  readonly blockers: readonly OperatorProofBlocker[];
  readonly nextActions: readonly string[];
}

export interface OperatorProofReadiness {
  readonly status: OperatorProofStatus;
  readonly fingerprint: string;
  readonly outcomes: readonly OperatorProofOutcome[];
  readonly minimalBlockers: readonly OperatorProofBlocker[];
}

export interface OperatorProofReleaseItem {
  readonly releaseId: string;
  readonly releaseNumber: number | null;
  readonly current: boolean;
  readonly sealedAt: string;
  readonly supersedesReleaseId: string | null;
  readonly supersededByReleaseId: string | null;
  readonly planVersion: number;
  readonly includedAgendaCount: number;
  readonly includedAgendaItemCount: number;
  readonly acceptedPeopleCount: number;
  readonly excludedAcceptedPeopleCount: number;
  readonly redactedFieldGroupCount: number;
  readonly fingerprint: string;
  readonly planFingerprint: string;
}

export interface OperatorProofDriftEntry {
  readonly sourceId: string;
  readonly family: DriftFamily;
  readonly effect: "COMMON" | "PUBLIC_ONLY" | "OPERATOR_ONLY";
}

export interface OperatorProofReleaseTwin {
  readonly currentPointer: {
    readonly releaseId: string | null;
    readonly validated: boolean;
  };
  readonly publicPackage: OperatorProofReleaseItem | null;
  readonly operatorPackage: {
    readonly status: "UNAVAILABLE";
    readonly reason: string;
  };
  readonly drift: {
    readonly status: "EXACT_MATCH" | "STALE" | "UNAVAILABLE";
    readonly families: readonly DriftFamily[];
    readonly entries: readonly OperatorProofDriftEntry[];
    readonly blockers: readonly string[];
    readonly baselineFingerprint: string | null;
    readonly currentFingerprint: string | null;
  };
  readonly history: {
    readonly status: "PROVEN" | "UNAVAILABLE";
    readonly reason: string;
    readonly items: readonly OperatorProofReleaseItem[];
    readonly invalidCount: number;
    readonly truncated: boolean;
  };
}

export type OperatorProofActivityStage =
  | "PROPOSAL_ACCEPTED"
  | "SPEAKER_CREATED"
  | "ARTIFACT_SUBMITTED"
  | "ARTIFACT_APPROVED"
  | "SCHEDULED"
  | "RELEASE_SEALED";

export interface OperatorProofActivityEvidence {
  readonly id: string;
  readonly occurredAt: string;
  readonly label: string;
  readonly source: string;
  readonly fingerprint: string | null;
}

export interface OperatorProofActivityStageProjection {
  readonly stage: OperatorProofActivityStage;
  readonly label: string;
  readonly status: "PROVEN" | "UNAVAILABLE";
  readonly reason: string;
  readonly evidence: readonly OperatorProofActivityEvidence[];
  readonly truncated: boolean;
}

export interface OperatorProofExperienceProjection {
  readonly schema: typeof OPERATOR_PROOF_EXPERIENCE_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly readiness: OperatorProofReadiness;
  readonly releaseTwin: OperatorProofReleaseTwin;
  readonly boundedEvidence: {
    readonly decisionReplay: {
      readonly status: "UNAVAILABLE";
      readonly reason: string;
      readonly inspectedPlanRunCount: number;
      readonly bound: number;
      readonly sourceRecords: readonly {
        readonly id: string;
        readonly status: string;
        readonly compiler: string;
        readonly compilerVersion: string;
        readonly inputFingerprint: string;
        readonly createdAt: string;
      }[];
    };
    readonly nearMiss: {
      readonly status: "UNAVAILABLE";
      readonly reason: string;
      readonly inspectedDecisionCount: number;
      readonly receiptCount: 0;
      readonly bound: 128;
    };
  };
  readonly activitySpine: {
    readonly readOnly: true;
    readonly boundPerStage: number;
    readonly stages: readonly OperatorProofActivityStageProjection[];
  };
}

interface EventProjectionRow {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly currentPlanVersionId: string | null;
  readonly currentReleaseId: string | null;
}

interface CurrentPlanRow {
  readonly id: string;
  readonly versionNumber: number;
  readonly fingerprint: string;
  readonly state: string | null;
  readonly stateActorAccountId: string | null;
  readonly approvalId: string | null;
  readonly approvalDecision: string | null;
  readonly approvalActorAccountId: string | null;
  readonly approvalActorRole: string | null;
  readonly approvalCount: number;
}

interface CommitmentBasisEntry {
  readonly [key: string]: JsonValue;
  readonly offerId: string;
  readonly personId: string;
  readonly termsFingerprint: string;
}

interface CommitmentProjection {
  readonly exact: boolean;
  readonly acceptedCount: number;
  readonly declinedCount: number;
  readonly pendingCount: number;
  readonly malformed: boolean;
  readonly basis: readonly CommitmentBasisEntry[];
  readonly fingerprint: string;
}

interface ContentEvidenceVersion {
  readonly taskId: string;
  readonly personId: string;
  readonly kind: string;
  readonly id: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly rowId: number;
}

interface ContentEvidenceRead {
  readonly valid: boolean;
  readonly versions: readonly ContentEvidenceVersion[];
  readonly publicationApprovals: ReadonlySet<string>;
}

interface ContentBasisEntry {
  readonly [key: string]: JsonValue;
  readonly programUnitId: string;
  readonly slot: "ABSTRACT" | "TITLE";
  readonly taskId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly publicationApproved: boolean;
}

interface SourceBasis<T extends JsonValue> {
  readonly available: boolean;
  readonly value: T;
  readonly reason: string;
}

interface ActivityRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly label: string;
  readonly source: string;
  readonly fingerprint: string | null;
}

const OUTCOME_LABELS: Readonly<Record<ReadinessOutcome, string>> = Object.freeze({
  OFFER: "Offer authority",
  CONFIRMATION: "Confirmed commitment",
  SCHEDULING: "Exact schedule",
  PUBLICATION: "Audience publication",
  OPERATOR_RELEASE: "Operator release",
});

const STATUS_ORDER: Readonly<Record<OperatorProofStatus, number>> = Object.freeze({
  BLOCKED: 0,
  UNAVAILABLE: 1,
  READY: 2,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL_CHARACTER.test(value);
}

function safeInstant(value: unknown): value is string {
  if (!safeText(value, 128)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function publicRedactionCount(content: SealedReleaseContent): number {
  return content.schedule ? 3 : 6;
}

function releaseNumber(release: ValidatedPublicRelease): number | null {
  return release.content.lineage?.releaseNumber ?? null;
}

function releaseItem(
  release: ValidatedPublicRelease,
  supersededByReleaseId: string | null,
): OperatorProofReleaseItem {
  const acceptedPeople = new Set(release.content.accepted.map((entry) => entry.personId)).size;
  const agendaItems = release.content.agendas.reduce((count, agenda) => count + agenda.items.length, 0);
  return {
    releaseId: release.releaseId,
    releaseNumber: releaseNumber(release),
    current: release.current,
    sealedAt: release.sealedAt,
    supersedesReleaseId: release.content.lineage?.supersedesReleaseId ?? null,
    supersededByReleaseId,
    planVersion: release.content.plan.versionNumber,
    includedAgendaCount: release.content.agendas.length,
    includedAgendaItemCount: agendaItems,
    acceptedPeopleCount: acceptedPeople,
    excludedAcceptedPeopleCount: Math.max(0, acceptedPeople - release.content.agendas.length),
    redactedFieldGroupCount: publicRedactionCount(release.content),
    fingerprint: release.fingerprint,
    planFingerprint: release.content.plan.fingerprint,
  };
}

function readEvent(db: Db, workspaceId: string, eventId: string): EventProjectionRow | null {
  return db.prepare(
    `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt,
            current_plan_version_id AS currentPlanVersionId,
            current_release_id AS currentReleaseId
       FROM events
      WHERE workspace_id = ? AND id = ?
      LIMIT 1`,
  ).get(workspaceId, eventId) as EventProjectionRow | undefined ?? null;
}

function readCurrentPlan(db: Db, workspaceId: string, eventId: string): CurrentPlanRow | null {
  const row = db.prepare(
    `SELECT plan.id, plan.version_number AS versionNumber, plan.fingerprint,
            (SELECT state.state
               FROM plan_states state
              WHERE state.workspace_id = plan.workspace_id AND state.plan_version_id = plan.id
              ORDER BY state.created_at DESC, state.rowid DESC LIMIT 1) AS state,
            (SELECT state.actor_account_id
               FROM plan_states state
              WHERE state.workspace_id = plan.workspace_id AND state.plan_version_id = plan.id
              ORDER BY state.created_at DESC, state.rowid DESC LIMIT 1) AS stateActorAccountId,
            approval.id AS approvalId, approval.decision AS approvalDecision,
            approval.actor_account_id AS approvalActorAccountId,
            account.role AS approvalActorRole,
            (SELECT COUNT(*) FROM approvals counted
              WHERE counted.workspace_id = plan.workspace_id
                AND counted.event_id = plan.event_id
                AND counted.plan_version_id = plan.id) AS approvalCount
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
        AND plan.event_id = event_row.id
       LEFT JOIN approvals approval
         ON approval.workspace_id = plan.workspace_id
        AND approval.event_id = plan.event_id
        AND approval.plan_version_id = plan.id
       LEFT JOIN accounts account
         ON account.workspace_id = approval.workspace_id
        AND account.id = approval.actor_account_id
      WHERE event_row.workspace_id = ? AND event_row.id = ?
      LIMIT 1`,
  ).get(workspaceId, eventId) as CurrentPlanRow | undefined;
  return row ?? null;
}

function planIsExactlyApproved(plan: CurrentPlanRow | null): boolean {
  return Boolean(
    plan && plan.approvalCount === 1 && plan.approvalId && plan.approvalDecision === "approved" &&
    plan.state === "approved" && plan.stateActorAccountId === plan.approvalActorAccountId &&
    plan.approvalActorRole && roleHasCapability(plan.approvalActorRole, "phase0.pipeline.manage"),
  );
}

function readCommitments(
  db: Db,
  event: EventProjectionRow,
  plan: CurrentPlanRow | null,
  workspaceId: string,
): CommitmentProjection {
  if (!plan) {
    return { exact: false, acceptedCount: 0, declinedCount: 0, pendingCount: 0, malformed: false, basis: [], fingerprint: fingerprintOf([]) };
  }
  const assignments = db.prepare(
    `SELECT id, person_id AS personId, program_unit_id AS programUnitId, assignment_type AS assignmentType
       FROM plan_assignments
      WHERE workspace_id = ? AND plan_version_id = ?
      ORDER BY person_id, program_unit_id, assignment_type, id`,
  ).all(workspaceId, plan.id) as Array<{
    id: string;
    personId: string;
    programUnitId: string;
    assignmentType: string;
  }>;
  const offers = db.prepare(
    `SELECT offer.id AS offerId, offer.person_id AS personId,
            offer.terms_json AS termsJson, offer.terms_fingerprint AS termsFingerprint,
            response.response
       FROM commitment_offers offer
       LEFT JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id AND response.offer_id = offer.id
      WHERE offer.workspace_id = ? AND offer.event_id = ? AND offer.plan_version_id = ?
      ORDER BY offer.created_at, offer.rowid`,
  ).all(workspaceId, event.id, plan.id) as Array<{
    offerId: string;
    personId: string;
    termsJson: string;
    termsFingerprint: string;
    response: string | null;
  }>;
  const assignmentByPerson = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const entries = assignmentByPerson.get(assignment.personId) ?? [];
    entries.push(assignment);
    assignmentByPerson.set(assignment.personId, entries);
  }
  let malformed = false;
  const basis: CommitmentBasisEntry[] = [];
  let acceptedCount = 0;
  let declinedCount = 0;
  let pendingCount = 0;
  const people = new Set<string>();
  for (const offer of offers) {
    if (people.has(offer.personId) || !SAFE_ID.test(offer.offerId) || !SAFE_ID.test(offer.personId) || !HASH.test(offer.termsFingerprint)) {
      malformed = true;
      continue;
    }
    people.add(offer.personId);
    let terms: unknown;
    try {
      terms = JSON.parse(offer.termsJson) as unknown;
    } catch {
      malformed = true;
      continue;
    }
    const assignment = assignmentByPerson.get(offer.personId);
    if (
      !isRecord(terms) ||
      !exactKeys(terms, ["schema", "planVersionId", "planFingerprint", "eventId", "eventName", "timezone", "programUnitId", "programUnitName", "role", "startsAt", "endsAt"]) ||
      terms.schema !== "commitment-offer-terms/v1" || terms.planVersionId !== plan.id ||
      terms.planFingerprint !== plan.fingerprint || terms.eventId !== event.id ||
      terms.eventName !== event.name || terms.timezone !== event.timezone ||
      fingerprintOf(terms) !== offer.termsFingerprint ||
      !safeText(terms.programUnitId, 160) || !safeText(terms.role, 80) ||
      !safeInstant(terms.startsAt) || !safeInstant(terms.endsAt) ||
      !assignment || assignment.length !== 1 || assignment[0]!.programUnitId !== terms.programUnitId ||
      assignment[0]!.assignmentType !== terms.role
    ) {
      malformed = true;
      continue;
    }
    if (offer.response === "accepted") {
      acceptedCount += 1;
      basis.push({ offerId: offer.offerId, personId: offer.personId, termsFingerprint: offer.termsFingerprint });
    } else if (offer.response === "declined") {
      declinedCount += 1;
    } else if (offer.response === null) {
      pendingCount += 1;
    } else {
      malformed = true;
    }
  }
  basis.sort((left, right) => left.offerId.localeCompare(right.offerId));
  return {
    exact: !malformed,
    acceptedCount,
    declinedCount,
    pendingCount,
    malformed,
    basis,
    fingerprint: fingerprintOf(basis),
  };
}

function readContentEvidence(db: Db, workspaceId: string, eventId: string): ContentEvidenceRead {
  const rows = db.prepare(
    `SELECT rowid AS rowId, event_type AS eventType, aggregate_id AS taskId,
            payload_json AS payloadJson, payload_fingerprint AS payloadFingerprint,
            created_at AS createdAt
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type IN ('speaker.content.version.submitted', 'speaker.content.approved')
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.eventId') = ?
      ORDER BY created_at, rowid`,
  ).all(workspaceId, eventId) as Array<{
    rowId: number;
    eventType: string;
    taskId: string;
    payloadJson: string;
    payloadFingerprint: string;
    createdAt: string;
  }>;
  const versions: ContentEvidenceVersion[] = [];
  const publicationApprovals = new Set<string>();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      return { valid: false, versions: [], publicationApprovals: new Set<string>() };
    }
    if (
      !isRecord(payload) || canonicalJson(payload) !== row.payloadJson ||
      fingerprintOf(payload) !== row.payloadFingerprint || !SAFE_ID.test(row.taskId) ||
      !safeInstant(row.createdAt) || !Number.isSafeInteger(row.rowId) || row.rowId < 1
    ) {
      return { valid: false, versions: [], publicationApprovals: new Set<string>() };
    }
    if (row.eventType === "speaker.content.version.submitted") {
      const version = payload.version;
      if (
        payload.operation !== "submit-version" || payload.taskId !== row.taskId ||
        !safeText(payload.personId, 160) || !safeText(payload.kind, 80) || !isRecord(version) ||
        !safeText(version.id, 160) || !HASH.test(String(version.contentHash))
      ) {
        return { valid: false, versions: [], publicationApprovals: new Set<string>() };
      }
      versions.push({
        taskId: row.taskId,
        personId: payload.personId,
        kind: payload.kind,
        id: version.id,
        contentHash: version.contentHash as string,
        occurredAt: row.createdAt,
        rowId: row.rowId,
      });
    } else {
      const record = payload.record;
      if (
        payload.operation !== "approve" || payload.taskId !== row.taskId || !isRecord(record) ||
        !safeText(record.submissionVersionId, 160) ||
        !HASH.test(String(record.submissionContentHash))
      ) {
        return { valid: false, versions: [], publicationApprovals: new Set<string>() };
      }
      if (record.gate !== "CONFIRMATION" && record.gate !== "PUBLICATION" && record.gate !== "OPERATOR_RELEASE") {
        return { valid: false, versions: [], publicationApprovals: new Set<string>() };
      }
      if (record.gate !== "PUBLICATION") continue;
      publicationApprovals.add(`${row.taskId}:${record.submissionVersionId}:${record.submissionContentHash}`);
    }
  }
  return { valid: true, versions, publicationApprovals };
}

function contentBasis(
  content: SealedReleaseContent,
  evidence: ContentEvidenceRead,
): { readonly baseline: SourceBasis<ContentBasisEntry[]>; readonly current: SourceBasis<ContentBasisEntry[]> } {
  if (!content.schedule) {
    const reason = "The sealed release does not carry an exact schedule/content manifest.";
    return {
      baseline: { available: false, value: [], reason },
      current: { available: false, value: [], reason },
    };
  }
  if (!evidence.valid) {
    const reason = "Persisted content evidence did not validate as canonical scoped records.";
    return {
      baseline: { available: false, value: [], reason },
      current: { available: false, value: [], reason },
    };
  }
  const byVersion = new Map(evidence.versions.map((version) => [version.id, version] as const));
  const latestByTask = new Map<string, ContentEvidenceVersion>();
  for (const version of evidence.versions) {
    const prior = latestByTask.get(version.taskId);
    if (!prior || prior.occurredAt < version.occurredAt ||
        (prior.occurredAt === version.occurredAt && prior.rowId < version.rowId)) {
      latestByTask.set(version.taskId, version);
    }
  }
  const baseline: ContentBasisEntry[] = [];
  const current: ContentBasisEntry[] = [];
  for (const session of content.schedule.sessions) {
    const slots = [
      { slot: "TITLE" as const, versionId: session.titleVersionId, contentHash: session.titleContentHash },
      { slot: "ABSTRACT" as const, versionId: session.abstractVersionId, contentHash: session.abstractContentHash },
    ];
    for (const slot of slots) {
      if (slot.versionId === null && slot.contentHash === null) continue;
      if (slot.versionId === null || slot.contentHash === null) {
        const reason = "The sealed content lineage is incomplete.";
        return {
          baseline: { available: false, value: [], reason },
          current: { available: false, value: [], reason },
        };
      }
      const sealed = byVersion.get(slot.versionId);
      if (!sealed || sealed.contentHash !== slot.contentHash) {
        const reason = "The sealed content version cannot be matched to exact persisted evidence.";
        return {
          baseline: { available: false, value: [], reason },
          current: { available: false, value: [], reason },
        };
      }
      const latest = latestByTask.get(sealed.taskId);
      if (!latest) {
        const reason = "The current exact content version is unavailable.";
        return {
          baseline: { available: false, value: [], reason },
          current: { available: false, value: [], reason },
        };
      }
      baseline.push({
        programUnitId: session.programUnitId,
        slot: slot.slot,
        taskId: sealed.taskId,
        versionId: slot.versionId,
        contentHash: slot.contentHash,
        publicationApproved: true,
      });
      current.push({
        programUnitId: session.programUnitId,
        slot: slot.slot,
        taskId: latest.taskId,
        versionId: latest.id,
        contentHash: latest.contentHash,
        publicationApproved: evidence.publicationApprovals.has(`${latest.taskId}:${latest.id}:${latest.contentHash}`),
      });
    }
  }
  const compare = (left: ContentBasisEntry, right: ContentBasisEntry) =>
    left.programUnitId.localeCompare(right.programUnitId) || left.slot.localeCompare(right.slot) || left.taskId.localeCompare(right.taskId);
  baseline.sort(compare);
  current.sort(compare);
  return {
    baseline: { available: true, value: baseline, reason: "" },
    current: { available: true, value: current, reason: "" },
  };
}

function scheduleBasis(
  db: Db,
  workspaceId: string,
  event: EventProjectionRow,
  content: SealedReleaseContent,
): { readonly baseline: SourceBasis<JsonValue>; readonly current: SourceBasis<JsonValue> } {
  if (!content.schedule) {
    const reason = "The sealed release has no exact schedule manifest.";
    return {
      baseline: { available: false, value: [], reason },
      current: { available: false, value: [], reason },
    };
  }
  const sealedSchedule = content.schedule;
  const authority = (
    input: {
      readonly revision: number;
      readonly sourcePlanVersionId: string;
      readonly sourcePlanFingerprint: string;
      readonly sourceScheduleAuditId: string | null;
      readonly sourceSchedulePointerFingerprint: string | null;
      readonly acceptedInventoryFingerprint: string;
      readonly cfpSessionInventoryFingerprint: string;
      readonly cfpSessionAuthorities: readonly {
        readonly programUnitId: string;
        readonly sessionFingerprint: string;
        readonly linkFingerprints: readonly string[];
      }[];
      readonly scheduleFingerprint: string;
      readonly approvalStatus: "APPROVED" | "NOT_APPROVED";
      readonly sourceScheduleApprovalId: string | null;
      readonly sourceScheduleApprovalAuditId: string | null;
      readonly sourceScheduleApprovalFingerprint: string | null;
      readonly sessions: readonly {
        readonly programUnitId: string;
        readonly programUnitName: string;
        readonly slug: string;
        readonly durationMinutes: number;
        readonly capacity: number;
        readonly speakerPersonIds: readonly string[];
        readonly placement: null | {
          readonly dayId: string;
          readonly timeSlotId: string;
          readonly roomId: string;
          readonly roomName: string;
          readonly venue: string;
          readonly trackId: string;
          readonly trackName: string;
          readonly startsAt: string;
          readonly endsAt: string;
        };
      }[];
    },
  ): JsonValue => ({
    schema: "operator-proof-audience-schedule-authority/v2",
    revision: input.revision,
    sourcePlanVersionId: input.sourcePlanVersionId,
    sourcePlanFingerprint: input.sourcePlanFingerprint,
    sourceScheduleAuditId: input.sourceScheduleAuditId,
    sourceSchedulePointerFingerprint: input.sourceSchedulePointerFingerprint,
    acceptedInventoryFingerprint: input.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: input.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: input.cfpSessionAuthorities.map((entry) => ({
      programUnitId: entry.programUnitId,
      sessionFingerprint: entry.sessionFingerprint,
      linkFingerprints: [...entry.linkFingerprints].sort(),
    })).sort((left, right) => left.programUnitId.localeCompare(right.programUnitId)),
    scheduleFingerprint: input.scheduleFingerprint,
    approvalStatus: input.approvalStatus,
    sourceScheduleApprovalId: input.sourceScheduleApprovalId,
    sourceScheduleApprovalAuditId: input.sourceScheduleApprovalAuditId,
    sourceScheduleApprovalFingerprint: input.sourceScheduleApprovalFingerprint,
    sessions: input.sessions.map((session) => ({
      programUnitId: session.programUnitId,
      programUnitName: session.programUnitName,
      slug: session.slug,
      durationMinutes: session.durationMinutes,
      capacity: session.capacity,
      speakerPersonIds: [...session.speakerPersonIds].sort(),
      placement: session.placement === null ? null : { ...session.placement },
    })).sort((left, right) => left.programUnitId.localeCompare(right.programUnitId)),
  });
  const baseline = authority({
    ...sealedSchedule,
    approvalStatus: sealedSchedule.schema === "publication-schedule/v2" ? "APPROVED" : "NOT_APPROVED",
    sourceScheduleApprovalId: sealedSchedule.schema === "publication-schedule/v2"
      ? sealedSchedule.sourceScheduleApprovalId
      : null,
    sourceScheduleApprovalAuditId: sealedSchedule.schema === "publication-schedule/v2"
      ? sealedSchedule.sourceScheduleApprovalAuditId
      : null,
    sourceScheduleApprovalFingerprint: sealedSchedule.schema === "publication-schedule/v2"
      ? sealedSchedule.sourceScheduleApprovalFingerprint
      : null,
    sessions: sealedSchedule.sessions.map((session) => ({
      programUnitId: session.programUnitId,
      programUnitName: session.programUnitName,
      slug: session.slug,
      durationMinutes: session.durationMinutes,
      capacity: session.capacity,
      speakerPersonIds: session.speakerPersonIds,
      placement: session.placement,
    })),
  });
  let current: JsonValue;
  try {
    const scope = { workspaceId, eventId: event.id };
    const canonical = readCanonicalScheduleProjection(
      db,
      scope,
      event as unknown as Record<string, unknown>,
    );
    const draft = readScheduleDraft(db, scope);
    if (
      !canonical || canonical.sessions.length === 0 ||
      canonical.workspaceId !== workspaceId || canonical.eventId !== event.id ||
      draft.schedule.workspaceId !== workspaceId || draft.schedule.eventId !== event.id ||
      canonical.planVersionId !== draft.schedule.planVersionId ||
      canonical.planFingerprint !== draft.schedule.planFingerprint ||
      canonical.acceptedInventoryFingerprint !== draft.schedule.acceptedInventoryFingerprint ||
      canonical.cfpSessionInventoryFingerprint !== draft.schedule.cfpSessionInventoryFingerprint ||
      canonicalJson(canonical.cfpSessionAuthorities) !== canonicalJson(draft.schedule.cfpSessionAuthorities)
    ) {
      throw new Error("CURRENT_SCHEDULE_AUTHORITY_INCOMPLETE");
    }
    const rooms = new Map(canonical.rooms.map((room) => [room.id, room] as const));
    const audienceRooms = new Map(draft.schedule.rooms.map((room) => [room.id, room] as const));
    const tracks = new Map(canonical.tracks.map((track) => [track.id, track] as const));
    if (
      rooms.size !== canonical.rooms.length || audienceRooms.size !== draft.schedule.rooms.length ||
      tracks.size !== canonical.tracks.length ||
      new Set(canonical.sessions.map((session) => session.id)).size !== canonical.sessions.length
    ) {
      throw new Error("CURRENT_SCHEDULE_AUTHORITY_AMBIGUOUS");
    }
    const pointerEvidence = draft.pointer
      ? findScheduleDraftAuthorityEvidence(db, scope, draft.pointer)
      : null;
    const approval = readCurrentScheduleApproval(db, scope);
    current = authority({
      revision: draft.schedule.revision,
      sourcePlanVersionId: canonical.planVersionId,
      sourcePlanFingerprint: canonical.planFingerprint,
      sourceScheduleAuditId: approval?.sourceScheduleAuditId ?? pointerEvidence?.auditEventId ?? null,
      sourceSchedulePointerFingerprint: approval?.sourceSchedulePointerFingerprint ?? pointerEvidence?.pointerFingerprint ?? null,
      acceptedInventoryFingerprint: canonical.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: canonical.cfpSessionInventoryFingerprint,
      cfpSessionAuthorities: canonical.cfpSessionAuthorities,
      scheduleFingerprint: draft.pointer
        ? fingerprintOf(scheduleApprovalSubject(draft.pointer))
        : fingerprintOf({ schema: "schedule-approval-subject/unavailable" }),
      approvalStatus: approval ? "APPROVED" : "NOT_APPROVED",
      sourceScheduleApprovalId: approval?.approvalEventId ?? null,
      sourceScheduleApprovalAuditId: approval?.approvalAuditId ?? null,
      sourceScheduleApprovalFingerprint: approval?.approvalFingerprint ?? null,
      sessions: canonical.sessions.map((session) => {
        const placement = session.placement;
        if (placement === null) {
          return {
            programUnitId: session.id,
            programUnitName: session.title,
            slug: session.slug,
            durationMinutes: session.durationMinutes,
            capacity: session.capacity,
            speakerPersonIds: session.speakerIds,
            placement: null,
          };
        }
        const room = rooms.get(placement.roomId);
        const audienceRoom = audienceRooms.get(placement.roomId);
        const track = tracks.get(placement.trackId);
        if (!room || !audienceRoom || !track) {
          throw new Error("CURRENT_SCHEDULE_RESOURCE_INCOMPLETE");
        }
        return {
          programUnitId: session.id,
          programUnitName: session.title,
          slug: session.slug,
          durationMinutes: session.durationMinutes,
          capacity: session.capacity,
          speakerPersonIds: session.speakerIds,
          placement: {
            dayId: placement.dayId,
            timeSlotId: placement.timeSlotId,
            roomId: room.id,
            roomName: room.name,
            venue: audienceRoom.venue,
            trackId: track.id,
            trackName: track.name,
            startsAt: placement.startsAt,
            endsAt: placement.endsAt,
          },
        };
      }),
    });
  } catch {
    return {
      baseline: { available: true, value: baseline, reason: "" },
      current: {
        available: false,
        value: [],
        reason: "The complete current canonical audience schedule authority could not be reconstructed.",
      },
    };
  }
  return {
    baseline: { available: true, value: baseline, reason: "" },
    current: { available: true, value: current, reason: "" },
  };
}

function artifactBasis(
  db: Db,
  workspaceId: string,
  eventId: string,
  content: SealedReleaseContent,
): { readonly baseline: SourceBasis<JsonValue[]>; readonly current: SourceBasis<JsonValue[]> } {
  if (!content.artifactBindings) {
    const reason = "The sealed release predates the exact artifact-binding manifest.";
    return {
      baseline: { available: false, value: [], reason },
      current: { available: false, value: [], reason },
    };
  }
  const bindings = content.artifactBindings
    .filter((binding) => binding.intent === "PUBLIC_SPEAKER_HEADSHOT")
    .map((binding) => ({
      assignmentId: binding.assignmentId,
      personId: binding.personId,
      taskId: binding.taskId,
      kind: binding.kind,
      artifactId: binding.artifactId,
      contentVersionId: binding.contentVersionId,
      version: binding.version,
      sha256: binding.sha256,
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (bindings.length === 0) {
    return {
      baseline: { available: true, value: [], reason: "" },
      current: { available: true, value: [], reason: "" },
    };
  }
  const taskIds = bindings.map((binding) => binding.taskId);
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT artifact.id AS artifactId, artifact.person_id AS personId,
            artifact.task_id AS taskId, artifact.kind, artifact.version,
            artifact.sha256, artifact.content_version_id AS contentVersionId,
            task.assignment_id AS assignmentId
       FROM artifact_records artifact
       JOIN speaker_tasks task
         ON task.id = artifact.task_id
        AND task.workspace_id = artifact.workspace_id
        AND task.event_id = artifact.event_id
        AND task.person_id = artifact.person_id
      WHERE artifact.workspace_id = ? AND artifact.event_id = ?
        AND artifact.task_id IN (${placeholders})
      ORDER BY artifact.task_id, artifact.version DESC, artifact.id DESC`,
  ).all(workspaceId, eventId, ...taskIds) as Array<{
    artifactId: string;
    personId: string;
    taskId: string;
    kind: string;
    version: number;
    sha256: string;
    contentVersionId: string;
    assignmentId: string;
  }>;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.taskId)) latest.set(row.taskId, row);
  if (taskIds.some((taskId) => !latest.has(taskId))) {
    return {
      baseline: { available: true, value: bindings, reason: "" },
      current: { available: false, value: [], reason: "A current exact public artifact record is unavailable." },
    };
  }
  const current = [...latest.values()].map((row) => ({
    assignmentId: row.assignmentId,
    personId: row.personId,
    taskId: row.taskId,
    kind: row.kind,
    artifactId: row.artifactId,
    contentVersionId: row.contentVersionId,
    version: row.version,
    sha256: row.sha256,
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    baseline: { available: true, value: bindings, reason: "" },
    current: { available: true, value: current, reason: "" },
  };
}

function availableSource(
  sourceId: string,
  scope: "COMMON" | "PUBLIC",
  family: DriftFamily,
  version: number,
  field: string,
  value: JsonValue,
): SourceRecordInput {
  return { sourceId, scope, family, version, status: "AVAILABLE", fields: [{ field, family, value }] };
}

function unavailableSource(
  sourceId: string,
  scope: "COMMON" | "PUBLIC",
  family: DriftFamily,
  version: number,
  reason: string,
): SourceRecordInput {
  return { sourceId, scope, family, version, status: "UNAVAILABLE", fields: [], unavailableReason: reason.slice(0, 256) };
}

function basisSource<T extends JsonValue>(
  sourceId: string,
  scope: "COMMON" | "PUBLIC",
  family: DriftFamily,
  version: number,
  field: string,
  basis: SourceBasis<T>,
): SourceRecordInput {
  return basis.available
    ? availableSource(sourceId, scope, family, version, field, basis.value)
    : unavailableSource(sourceId, scope, family, version, basis.reason);
}

function assessCurrentReleaseSources(
  db: Db,
  workspaceId: string,
  event: EventProjectionRow,
  plan: CurrentPlanRow | null,
  commitments: CommitmentProjection,
  release: ValidatedPublicRelease | null,
): OperatorProofReleaseTwin["drift"] {
  if (!release) {
    return {
      status: "UNAVAILABLE",
      families: [],
      entries: [],
      blockers: ["No validated current sealed release exists as an exact comparison baseline."],
      baselineFingerprint: null,
      currentFingerprint: null,
    };
  }
  const vectorVersion = Math.max(1, release.content.lineage?.releaseNumber ?? release.content.plan.versionNumber);
  const schedule = scheduleBasis(db, workspaceId, event, release.content);
  const content = contentBasis(release.content, readContentEvidence(db, workspaceId, event.id));
  const artifacts = artifactBasis(db, workspaceId, event.id, release.content);
  const baselineSources: SourceRecordInput[] = [
    availableSource("event-identity", "COMMON", "IDENTITY", vectorVersion, "event.identity", {
      id: release.content.event.id,
      name: release.content.event.name,
    }),
    availableSource("event-time", "COMMON", "TIME", vectorVersion, "event.time", {
      timezone: release.content.event.timezone,
      startsAt: release.content.event.startsAt,
      endsAt: release.content.event.endsAt,
    }),
    availableSource("plan-content", "COMMON", "CONTENT", vectorVersion, "plan.content", {
      id: release.content.plan.id,
      versionNumber: release.content.plan.versionNumber,
      fingerprint: release.content.plan.fingerprint,
    }),
    availableSource("commitment-set", "COMMON", "COMMITMENT", vectorVersion, "commitment.set", release.content.accepted
      .map((entry) => ({ offerId: entry.offerId, personId: entry.personId, termsFingerprint: entry.termsFingerprint }))
      .sort((left, right) => left.offerId.localeCompare(right.offerId))),
    basisSource("schedule-placement", "COMMON", "LOCATION", vectorVersion, "schedule.placement", schedule.baseline),
    basisSource("session-content", "COMMON", "CONTENT", vectorVersion, "session.content", content.baseline),
    basisSource("public-artifacts", "PUBLIC", "CONTENT", vectorVersion, "public.artifacts", artifacts.baseline),
  ];
  const currentSources: SourceRecordInput[] = [
    availableSource("event-identity", "COMMON", "IDENTITY", vectorVersion, "event.identity", {
      id: event.id,
      name: event.name,
    }),
    availableSource("event-time", "COMMON", "TIME", vectorVersion, "event.time", {
      timezone: event.timezone,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    }),
    plan
      ? availableSource("plan-content", "COMMON", "CONTENT", vectorVersion, "plan.content", {
          id: plan.id,
          versionNumber: plan.versionNumber,
          fingerprint: plan.fingerprint,
        })
      : unavailableSource("plan-content", "COMMON", "CONTENT", vectorVersion, "The current exact plan source is unavailable."),
    commitments.exact
      ? availableSource("commitment-set", "COMMON", "COMMITMENT", vectorVersion, "commitment.set", [...commitments.basis])
      : unavailableSource("commitment-set", "COMMON", "COMMITMENT", vectorVersion, "Current commitment evidence is malformed."),
    basisSource("schedule-placement", "COMMON", "LOCATION", vectorVersion, "schedule.placement", schedule.current),
    basisSource("session-content", "COMMON", "CONTENT", vectorVersion, "session.content", content.current),
    basisSource("public-artifacts", "PUBLIC", "CONTENT", vectorVersion, "public.artifacts", artifacts.current),
  ];
  const baseline = selectAudienceSourceVector({
    workspaceId,
    eventId: event.id,
    audience: "PUBLIC",
    version: vectorVersion,
    sources: baselineSources,
  });
  const current = selectAudienceSourceVector({
    workspaceId,
    eventId: event.id,
    audience: "PUBLIC",
    version: vectorVersion,
    sources: currentSources,
  });
  const assessment = assessSourceVector({ audience: "PUBLIC", baseline, current });
  const unavailableReasons = [...baseline.sources, ...current.sources]
    .filter((source) => source.status === "UNAVAILABLE")
    .map((source) => `${source.sourceId}: ${source.unavailableReason ?? "exact source unavailable"}`);
  return {
    status: assessment.status,
    families: assessment.drift?.families ?? [],
    entries: (assessment.drift?.entries ?? []).map((entry) => ({
      sourceId: entry.sourceId,
      family: entry.family,
      effect: entry.effect,
    })),
    blockers: [...assessment.blockers.map((blocker) => blocker.message), ...unavailableReasons],
    baselineFingerprint: assessment.expectedFingerprint,
    currentFingerprint: assessment.actualFingerprint,
  };
}

function readReleaseTwin(
  db: Db,
  workspaceId: string,
  event: EventProjectionRow,
  plan: CurrentPlanRow | null,
  commitments: CommitmentProjection,
): { readonly twin: OperatorProofReleaseTwin; readonly current: ValidatedPublicRelease | null } {
  const rows = db.prepare(
    `SELECT id
       FROM publication_releases
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY sealed_at DESC, rowid DESC
      LIMIT ?`,
  ).all(workspaceId, event.id, OPERATOR_PROOF_HISTORY_LIMIT + 1) as { id: string }[];
  const truncated = rows.length > OPERATOR_PROOF_HISTORY_LIMIT;
  const inspected = rows.slice(0, OPERATOR_PROOF_HISTORY_LIMIT);
  const validated: ValidatedPublicRelease[] = [];
  let invalidCount = 0;
  for (const row of inspected) {
    const release = validatePublicReleaseForRead(db, {
      workspaceId,
      eventId: event.id,
      releaseId: row.id,
      mode: "HISTORICAL",
    });
    if (release) validated.push(release);
    else invalidCount += 1;
  }
  const current = event.currentReleaseId
    ? validatePublicReleaseForRead(db, {
        workspaceId,
        eventId: event.id,
        releaseId: event.currentReleaseId,
        mode: "CURRENT",
      })
    : null;
  const successorByRelease = new Map<string, string>();
  let lineageValid = validated.length > 0 && !truncated && invalidCount === 0;
  const numbered = validated
    .filter((release) => release.content.lineage)
    .sort((left, right) => left.content.lineage!.releaseNumber - right.content.lineage!.releaseNumber);
  if (numbered.length !== validated.length) lineageValid = validated.length === 0;
  for (let index = 0; index < numbered.length; index += 1) {
    const release = numbered[index]!;
    const lineage = release.content.lineage!;
    const prior = numbered[index - 1] ?? null;
    if (
      lineage.releaseNumber !== index + 1 ||
      lineage.supersedesReleaseId !== (prior?.releaseId ?? null) ||
      (lineage.supersedesReleaseId !== null && successorByRelease.has(lineage.supersedesReleaseId))
    ) lineageValid = false;
    if (lineage.supersedesReleaseId) successorByRelease.set(lineage.supersedesReleaseId, release.releaseId);
  }
  if (validated.length > 0 && (!current || numbered.at(-1)?.releaseId !== current.releaseId)) lineageValid = false;
  const items = validated
    .map((release) => releaseItem(release, successorByRelease.get(release.releaseId) ?? null))
    .sort((left, right) =>
      (left.releaseNumber ?? Number.MAX_SAFE_INTEGER) - (right.releaseNumber ?? Number.MAX_SAFE_INTEGER) ||
      left.sealedAt.localeCompare(right.sealedAt) || left.releaseId.localeCompare(right.releaseId));
  const publicPackage = current
    ? releaseItem(current, successorByRelease.get(current.releaseId) ?? null)
    : null;
  return {
    current,
    twin: {
      currentPointer: { releaseId: event.currentReleaseId, validated: Boolean(current) },
      publicPackage,
      operatorPackage: {
        status: "UNAVAILABLE",
        reason: "No canonical persisted operator-release package or immutable operator current pointer exists in this repository.",
      },
      drift: assessCurrentReleaseSources(db, workspaceId, event, plan, commitments, current),
      history: {
        status: lineageValid ? "PROVEN" : "UNAVAILABLE",
        reason: lineageValid
          ? "Every shown release validates and the explicit supersession chain reaches the validated current pointer."
          : truncated
            ? `Lineage exceeds the bounded ${OPERATOR_PROOF_HISTORY_LIMIT}-release inspection window.`
            : invalidCount > 0
              ? "At least one stored release failed exact historical validation."
              : "Explicit complete supersession lineage is unavailable.",
        items,
        invalidCount,
        truncated,
      },
    },
  };
}

function audienceReference(kind: AudienceKind, scope: ProofScope, id: string, version: string): AudienceReference {
  return {
    kind,
    id,
    version,
    fingerprint: fingerprintOf({ schema: "operator-proof-audience/v1", kind, scope, id, version }),
  };
}

function authorityReference(input: {
  readonly scope: ProofScope;
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly audienceKind: AudienceKind;
}): AuthorityReference {
  return {
    scope: input.scope,
    kind: input.kind,
    id: input.id,
    version: input.version,
    fingerprint: input.fingerprint,
    current: true,
    superseded: false,
    audience: audienceReference(input.audienceKind, input.scope, `${input.audienceKind.toLowerCase()}:${input.id}`, input.version),
  };
}

function missingAuthority(scope: ProofScope, kind: string, audienceKind: AudienceKind): AuthorityReference {
  return authorityReference({
    scope,
    kind,
    id: `required-${kind}`,
    version: "unavailable",
    fingerprint: fingerprintOf({ schema: "operator-proof-required-authority/v1", scope, kind, audienceKind }),
    audienceKind,
  });
}

function readinessRequirement(input: {
  readonly id: string;
  readonly scope: ProofScope;
  readonly outcome: ReadinessOutcome;
  readonly label: string;
  readonly sourceFamily: SourceFamily;
  readonly authority: AuthorityReference;
  readonly dependsOn: readonly string[];
  readonly actionKind: ReadinessRequirement["nextActions"][number]["kind"];
  readonly actionLabel: string;
}): ReadinessRequirement {
  return {
    id: input.id,
    scope: input.scope,
    outcome: input.outcome,
    label: input.label,
    sourceFamily: input.sourceFamily,
    authority: input.authority,
    dependsOn: input.dependsOn,
    nextActions: [{
      id: `action:${input.id}`,
      kind: input.actionKind,
      label: input.actionLabel,
      targetRequirementId: input.id,
    }],
  };
}

function evidence(
  id: string,
  scope: ProofScope,
  family: SourceFamily,
  authority: AuthorityReference,
  state: EvidenceState,
  reason?: string,
): AuthorizedEvidence {
  return { id, scope, family, authority, state, ...(reason ? { reason } : {}) };
}

function readReadiness(
  workspaceId: string,
  event: EventProjectionRow,
  plan: CurrentPlanRow | null,
  commitments: CommitmentProjection,
  twin: OperatorProofReleaseTwin,
  currentRelease: ValidatedPublicRelease | null,
): OperatorProofReadiness {
  const scope: ProofScope = { workspaceId, eventId: event.id };
  const planAuthority = plan && plan.approvalId
    ? authorityReference({
        scope,
        kind: "plan-approval",
        id: plan.approvalId,
        version: String(plan.versionNumber),
        fingerprint: plan.fingerprint,
        audienceKind: "ORGANIZER",
      })
    : missingAuthority(scope, "plan-approval", "ORGANIZER");
  const commitmentAuthority = plan
    ? authorityReference({
        scope,
        kind: "accepted-commitment-set",
        id: `commitments:${plan.id}`,
        version: String(commitments.acceptedCount),
        fingerprint: commitments.fingerprint,
        audienceKind: "ORGANIZER",
      })
    : missingAuthority(scope, "accepted-commitment-set", "ORGANIZER");
  const scheduleFingerprint = currentRelease?.content.schedule
    ? fingerprintOf(currentRelease.content.schedule)
    : fingerprintOf({ scope, source: "required-schedule" });
  const scheduleAuthority = currentRelease?.content.schedule
    ? authorityReference({
        scope,
        kind: "sealed-schedule",
        id: `schedule:${currentRelease.releaseId}`,
        version: String(currentRelease.content.schedule.revision),
        fingerprint: scheduleFingerprint,
        audienceKind: "ORGANIZER",
      })
    : missingAuthority(scope, "sealed-schedule", "ORGANIZER");
  const publicationAuthority = currentRelease
    ? authorityReference({
        scope,
        kind: "publication-release",
        id: currentRelease.releaseId,
        version: String(currentRelease.content.lineage?.releaseNumber ?? currentRelease.content.plan.versionNumber),
        fingerprint: currentRelease.fingerprint,
        audienceKind: "PUBLIC",
      })
    : missingAuthority(scope, "publication-release", "PUBLIC");
  const operatorAuthority = missingAuthority(scope, "operator-release", "OPERATOR");
  const requirements: ReadinessRequirement[] = [
    readinessRequirement({
      id: "requirement:offer", scope, outcome: "OFFER", label: "Current exact plan approval",
      sourceFamily: "PLAN_APPROVAL", authority: planAuthority, dependsOn: [],
      actionKind: "RECORD_CURRENT_APPROVAL", actionLabel: "Inspect and approve the current exact plan",
    }),
    readinessRequirement({
      id: "requirement:confirmation", scope, outcome: "CONFIRMATION", label: "Accepted exact offer terms",
      sourceFamily: "CONFIRMATION", authority: commitmentAuthority, dependsOn: ["requirement:offer"],
      actionKind: "CONFIRM_EXACT_OFFER", actionLabel: "Inspect exact offer responses",
    }),
    readinessRequirement({
      id: "requirement:scheduling", scope, outcome: "SCHEDULING", label: "Current exact schedule evidence",
      sourceFamily: "SCHEDULE", authority: scheduleAuthority, dependsOn: ["requirement:confirmation"],
      actionKind: "SCHEDULE_EXACT_COMMITMENT", actionLabel: "Resolve the exact committed schedule",
    }),
    readinessRequirement({
      id: "requirement:publication", scope, outcome: "PUBLICATION", label: "Validated immutable public release",
      sourceFamily: "PUBLICATION_RELEASE", authority: publicationAuthority, dependsOn: ["requirement:scheduling"],
      actionKind: "PUBLISH_EXACT_RELEASE", actionLabel: "Seal the exact approved audience release",
    }),
    readinessRequirement({
      id: "requirement:operator-release", scope, outcome: "OPERATOR_RELEASE", label: "Persisted immutable operator package",
      sourceFamily: "OPERATOR_RELEASE", authority: operatorAuthority, dependsOn: ["requirement:publication"],
      actionKind: "RELEASE_TO_OPERATOR", actionLabel: "Supply a durable operator-release source before release",
    }),
  ];
  const evidenceRows: AuthorizedEvidence[] = [];
  if (plan) {
    if (planIsExactlyApproved(plan)) {
      evidenceRows.push(evidence("evidence:plan-approval", scope, "PLAN_APPROVAL", planAuthority, "PROVEN"));
    } else if (plan.state === "rejected" || plan.state === "superseded" || plan.approvalDecision === "rejected") {
      evidenceRows.push(evidence("evidence:plan-approval", scope, "PLAN_APPROVAL", planAuthority, "BLOCKED", "The current plan has explicit non-approved decision evidence."));
    }
  }
  if (plan && commitments.malformed) {
    evidenceRows.push(evidence("evidence:commitments", scope, "CONFIRMATION", commitmentAuthority, "CONFLICTING", "Stored commitment terms do not match their exact plan authority."));
  } else if (plan && commitments.acceptedCount > 0) {
    evidenceRows.push(evidence("evidence:commitments", scope, "CONFIRMATION", commitmentAuthority, "PROVEN"));
  } else if (plan && commitments.declinedCount > 0 && commitments.pendingCount === 0) {
    evidenceRows.push(evidence("evidence:commitments", scope, "CONFIRMATION", commitmentAuthority, "BLOCKED", "Only explicit declined responses are available for the current plan."));
  }
  if (currentRelease?.content.schedule && twin.drift.status === "EXACT_MATCH") {
    evidenceRows.push(evidence("evidence:schedule", scope, "SCHEDULE", scheduleAuthority, "PROVEN"));
  } else if (currentRelease?.content.schedule && twin.drift.status === "STALE") {
    evidenceRows.push(evidence("evidence:schedule", scope, "SCHEDULE", scheduleAuthority, "CONFLICTING", "Current canonical inputs have materially drifted from the sealed schedule baseline."));
  }
  if (currentRelease) {
    evidenceRows.push(evidence("evidence:publication-release", scope, "PUBLICATION_RELEASE", publicationAuthority, "PROVEN"));
  } else if (event.currentReleaseId) {
    evidenceRows.push(evidence("evidence:publication-release", scope, "PUBLICATION_RELEASE", publicationAuthority, "BLOCKED", "The stored public pointer does not resolve to an exact validated current release."));
  }
  const graph = evaluateReadinessProofGraph({ scope, evidence: evidenceRows, requirements });
  const blocker = (item: (typeof graph.minimalBlockers)[number]): OperatorProofBlocker => ({
    code: item.code,
    message: item.message,
    requirementId: item.requirementId,
    evidenceIds: item.sourceEvidenceIds,
  });
  const matchedByOutcome = new Map<ReadinessOutcome, string[]>();
  for (const requirement of graph.requirements) {
    const ids = matchedByOutcome.get(requirement.outcome) ?? [];
    ids.push(...requirement.matchedEvidenceIds);
    matchedByOutcome.set(requirement.outcome, ids);
  }
  const outcomes = graph.outcomes.map((outcome) => ({
    outcome: outcome.outcome,
    label: OUTCOME_LABELS[outcome.outcome],
    status: outcome.status,
    evidenceIds: [...new Set(matchedByOutcome.get(outcome.outcome) ?? [])].sort(),
    blockers: outcome.minimalBlockers.map(blocker),
    nextActions: outcome.nextActions.map((action) => action.label),
  })).sort((left, right) =>
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.outcome.localeCompare(right.outcome));
  return {
    status: graph.status,
    fingerprint: graph.fingerprint,
    outcomes,
    minimalBlockers: graph.minimalBlockers.map(blocker),
  };
}

function normalizeActivityRows(rows: readonly ActivityRow[]): readonly OperatorProofActivityEvidence[] | null {
  const normalized: OperatorProofActivityEvidence[] = [];
  for (const row of rows) {
    if (
      !SAFE_ID.test(row.id) || !safeInstant(row.occurredAt) || !safeText(row.label, 180) ||
      !safeText(row.source, 180) || (row.fingerprint !== null && !safeText(row.fingerprint, 256))
    ) return null;
    normalized.push({ ...row });
  }
  return normalized;
}

function activityStage(
  stage: OperatorProofActivityStage,
  label: string,
  missingReason: string,
  rows: readonly ActivityRow[],
): OperatorProofActivityStageProjection {
  const truncated = rows.length > OPERATOR_PROOF_ACTIVITY_LIMIT;
  const normalized = normalizeActivityRows(rows.slice(0, OPERATOR_PROOF_ACTIVITY_LIMIT));
  if (!normalized) {
    return { stage, label, status: "UNAVAILABLE", reason: "Persisted stage evidence did not validate.", evidence: [], truncated };
  }
  return {
    stage,
    label,
    status: normalized.length > 0 ? "PROVEN" : "UNAVAILABLE",
    reason: normalized.length > 0 ? "Exact persisted event-scoped records are shown." : missingReason,
    evidence: normalized,
    truncated,
  };
}

function readActivitySpine(
  db: Db,
  workspaceId: string,
  eventId: string,
  releases: readonly OperatorProofReleaseItem[],
): OperatorProofExperienceProjection["activitySpine"] {
  const limit = OPERATOR_PROOF_ACTIVITY_LIMIT + 1;
  const accepted = db.prepare(
    `SELECT event_row.id, event_row.created_at AS occurredAt,
            'Proposal accepted' AS label,
            'domain_events · cfp.submission.decision' AS source,
            event_row.payload_fingerprint AS fingerprint
       FROM domain_events event_row
       JOIN submissions submission
         ON submission.id = event_row.aggregate_id
        AND submission.workspace_id = event_row.workspace_id
        AND submission.event_id = ?
      WHERE event_row.workspace_id = ?
        AND event_row.event_type = 'cfp.submission.decision'
        AND event_row.aggregate_type = 'cfp_submission'
        AND json_extract(event_row.payload_json, '$.eventId') = ?
        AND json_extract(event_row.payload_json, '$.submissionId') = submission.id
        AND json_extract(event_row.payload_json, '$.decision') = 'ACCEPTED'
      ORDER BY event_row.created_at DESC, event_row.id DESC LIMIT ?`,
  ).all(eventId, workspaceId, eventId, limit) as unknown as ActivityRow[];
  const speakers = db.prepare(
    `SELECT speaker.id, speaker.created_at AS occurredAt,
            'Speaker participation created · ' || speaker.participation_status AS label,
            'event_speakers' AS source, NULL AS fingerprint
       FROM event_speakers speaker
       JOIN people person
         ON person.id = speaker.person_id AND person.workspace_id = speaker.workspace_id
      WHERE speaker.workspace_id = ? AND speaker.event_id = ?
      ORDER BY speaker.created_at DESC, speaker.id DESC LIMIT ?`,
  ).all(workspaceId, eventId, limit) as unknown as ActivityRow[];
  const submitted = db.prepare(
    `SELECT artifact.id, artifact.created_at AS occurredAt,
            CASE artifact.kind WHEN 'HEADSHOT' THEN 'Headshot artifact submitted' ELSE 'Slides artifact submitted' END AS label,
            'artifact_records · speaker.artifact.submitted' AS source,
            artifact.sha256 AS fingerprint
       FROM artifact_records artifact
       JOIN speaker_tasks task
         ON task.id = artifact.task_id
        AND task.workspace_id = artifact.workspace_id
        AND task.event_id = artifact.event_id
        AND task.person_id = artifact.person_id
      WHERE artifact.workspace_id = ? AND artifact.event_id = ?
      ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT ?`,
  ).all(workspaceId, eventId, limit) as unknown as ActivityRow[];
  const approved = db.prepare(
    `SELECT review.id, review.reviewed_at AS occurredAt,
            version.kind || ' artifact approved for ' || review.gate AS label,
            'speaker_content_reviews · speaker_content_versions' AS source,
            review.submission_content_hash AS fingerprint
       FROM speaker_content_reviews review
       JOIN speaker_content_versions version
         ON version.id = review.submission_version_id
        AND version.workspace_id = review.workspace_id
        AND version.event_id = review.event_id
        AND version.person_id = review.person_id
        AND version.task_id = review.task_id
        AND version.content_hash = review.submission_content_hash
       JOIN artifact_records artifact
         ON artifact.workspace_id = version.workspace_id
        AND artifact.event_id = version.event_id
        AND artifact.person_id = version.person_id
        AND artifact.task_id = version.task_id
        AND artifact.content_version_id = version.id
      WHERE review.workspace_id = ? AND review.event_id = ?
        AND review.review_state = 'APPROVED'
      ORDER BY review.reviewed_at DESC, review.id DESC LIMIT ?`,
  ).all(workspaceId, eventId, limit) as unknown as ActivityRow[];
  const scheduled = db.prepare(
    `SELECT allocation.id, allocation.updated_at AS occurredAt,
            'Session scheduled · ' || allocation.allocation_status AS label,
            'event_session_allocations' AS source, NULL AS fingerprint
       FROM event_session_allocations allocation
       JOIN program_units unit
         ON unit.id = allocation.program_unit_id
        AND unit.workspace_id = allocation.workspace_id
        AND unit.event_id = allocation.event_id
      WHERE allocation.workspace_id = ? AND allocation.event_id = ?
        AND allocation.allocation_status IN ('DRAFT', 'PUBLISHED')
      ORDER BY allocation.updated_at DESC, allocation.id DESC LIMIT ?`,
  ).all(workspaceId, eventId, limit) as unknown as ActivityRow[];
  const sealed: ActivityRow[] = [...releases]
    .sort((left, right) => right.sealedAt.localeCompare(left.sealedAt) || right.releaseId.localeCompare(left.releaseId))
    .slice(0, limit)
    .map((release) => ({
      id: release.releaseId,
      occurredAt: release.sealedAt,
      label: `Audience release sealed${release.releaseNumber ? ` · v${release.releaseNumber}` : ""}`,
      source: "validated publication_releases",
      fingerprint: release.fingerprint,
    }));
  return {
    readOnly: true,
    boundPerStage: OPERATOR_PROOF_ACTIVITY_LIMIT,
    stages: [
      activityStage("PROPOSAL_ACCEPTED", "Proposal accepted", "No exact accepted-proposal decision exists for this event.", accepted),
      activityStage("SPEAKER_CREATED", "Speaker created", "No event-scoped speaker participation record exists.", speakers),
      activityStage("ARTIFACT_SUBMITTED", "Artifact submitted", "No durable speaker artifact record exists.", submitted),
      activityStage("ARTIFACT_APPROVED", "Artifact approved", "No exact artifact-version approval exists.", approved),
      activityStage("SCHEDULED", "Scheduled", "No active persisted session allocation exists.", scheduled),
      activityStage("RELEASE_SEALED", "Release sealed", "No validated immutable audience release exists.", sealed),
    ],
  };
}

function readBoundedEvidence(
  db: Db,
  workspaceId: string,
  eventId: string,
): OperatorProofExperienceProjection["boundedEvidence"] {
  const planRuns = db.prepare(
    `SELECT id, status, compiler, compiler_version AS compilerVersion,
            input_fingerprint AS inputFingerprint, created_at AS createdAt
       FROM plan_runs
      WHERE workspace_id = ? AND event_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(workspaceId, eventId, OPERATOR_PROOF_REPLAY_LIMIT + 1) as Array<{
    id: string;
    status: string;
    compiler: string;
    compilerVersion: string;
    inputFingerprint: string;
    createdAt: string;
  }>;
  const decisionCount = (db.prepare(
    `SELECT COUNT(*) AS count
       FROM domain_events event_row
       JOIN submissions submission
         ON submission.id = event_row.aggregate_id
        AND submission.workspace_id = event_row.workspace_id
        AND submission.event_id = ?
      WHERE event_row.workspace_id = ?
        AND event_row.event_type = 'cfp.submission.decision'
        AND event_row.aggregate_type = 'cfp_submission'
        AND json_extract(event_row.payload_json, '$.eventId') = ?`,
  ).get(eventId, workspaceId, eventId) as { count: number }).count;
  const sourceRecords = planRuns.slice(0, OPERATOR_PROOF_REPLAY_LIMIT).filter((row) =>
    SAFE_ID.test(row.id) && safeText(row.status, 80) && safeText(row.compiler, 120) &&
    safeText(row.compilerVersion, 120) && HASH.test(row.inputFingerprint) && safeInstant(row.createdAt));
  return {
    decisionReplay: {
      status: "UNAVAILABLE",
      reason: "Plan runs are inspectable source records, but no persisted decision-replay manifest plus execution-evidence envelope exists; a plan artifact is not treated as a replay.",
      inspectedPlanRunCount: sourceRecords.length,
      bound: OPERATOR_PROOF_REPLAY_LIMIT,
      sourceRecords,
    },
    nearMiss: {
      status: "UNAVAILABLE",
      reason: "No canonical persisted near-miss selection receipt with current purpose, retention, capacity, eligibility, and conflict evidence exists; ordinary proposal decisions do not qualify.",
      inspectedDecisionCount: Number.isSafeInteger(decisionCount) && decisionCount >= 0 ? decisionCount : 0,
      receiptCount: 0,
      bound: 128,
    },
  };
}

/**
 * Read-only organizer projection over existing canonical rows. It does not repair outbox state,
 * infer progress from dates, create release authority, or alter any current pointer.
 */
export function getOperatorProofExperience(
  db: Db,
  workspaceId: string,
  eventId: string,
): OperatorProofExperienceProjection | null {
  if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(eventId)) return null;
  const event = readEvent(db, workspaceId, eventId);
  if (!event) return null;
  const plan = readCurrentPlan(db, workspaceId, event.id);
  const commitments = readCommitments(db, event, plan, workspaceId);
  const release = readReleaseTwin(db, workspaceId, event, plan, commitments);
  const projection: OperatorProofExperienceProjection = {
    schema: OPERATOR_PROOF_EXPERIENCE_SCHEMA,
    workspaceId,
    eventId: event.id,
    readiness: readReadiness(workspaceId, event, plan, commitments, release.twin, release.current),
    releaseTwin: release.twin,
    boundedEvidence: readBoundedEvidence(db, workspaceId, event.id),
    activitySpine: readActivitySpine(db, workspaceId, event.id, release.twin.history.items),
  };
  return deepFreeze(projection);
}
