import type { Db } from "../db";
import {
  DenialError,
  requireCapability,
  roleHasCapability,
  type SessionInfo,
} from "../auth";
import { deterministicUuid, fingerprintOf, nowIso, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit } from "./audit";
import {
  commitmentResponseAuditDetails,
  commitmentResponseCommandKey,
} from "./commitments";
import {
  commitmentOfferTermsMatchAuthority,
  type CommitmentOfferTermsAuthority,
} from "./commitment-offer-contract";

export interface RecordAttendanceResult {
  observationId: string;
  created: boolean;
  previousObservationId: string | null;
  observedAt: string;
  recordedAt: string;
}

/**
 * Records an attendance observation as operational truth. Idempotent per
 * (workspace, idempotencyKey): a retried or duplicated submission never creates
 * a second row and never mutates earlier truth records.
 */
export function recordAttendance(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
  programUnitId: string,
  observedAtInput: string,
  idempotencyKey: string,
  actor: { kind: "account"; ref: string },
): RecordAttendanceResult {
  const dashboardIdempotencyKey = `attendance:${eventId}:${personId}:${programUnitId}`;
  const persistedIdempotencyKey = attendanceKey({ workspaceId, eventId, personId, programUnitId });
  return withTransaction(db, () => {
    const account = db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, actor.ref) as { role: unknown } | undefined;
    if (
      actor.kind !== "account" ||
      typeof account?.role !== "string" ||
      !roleHasCapability(account.role, "phase0.pipeline.manage")
    ) {
      throw new DenialError(
        "CAPABILITY_DENIED",
        "This account is not authorized to perform that workspace action.",
        "phase0.pipeline.manage",
      );
    }
    const observedAt = canonicalInstant(observedAtInput);
    if (!observedAt) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const event = db
      .prepare("SELECT id FROM events WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, eventId) as { id: string } | undefined;
    if (!event) {
      throw new Error("EVENT_NOT_FOUND");
    }
    const person = db
      .prepare("SELECT id FROM people WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, personId) as { id: string } | undefined;
    if (!person) {
      throw new Error("PERSON_NOT_FOUND");
    }
    const unit = db
      .prepare("SELECT id FROM program_units WHERE workspace_id = ? AND event_id = ? AND id = ?")
      .get(workspaceId, eventId, programUnitId) as { id: string } | undefined;
    if (!unit) {
      throw new Error("PROGRAM_UNIT_NOT_FOUND");
    }
    if (idempotencyKey !== dashboardIdempotencyKey) {
      throw new OperationsAttendanceError("ATTENDANCE_INPUT_INVALID");
    }
    const existing = db
      .prepare(
        `SELECT id, event_id AS eventId, person_id AS personId, program_unit_id AS programUnitId,
                observation_type AS observationType, observed_at AS observedAt,
                recorded_at AS recordedAt, source, corrected_by AS correctedBy
         FROM observations
         WHERE workspace_id = ? AND idempotency_key = ?`,
      )
      .get(workspaceId, persistedIdempotencyKey) as
      | {
          id: string;
          eventId: string;
          personId: string;
          programUnitId: string;
           observationType: string;
           observedAt: string;
           recordedAt: string;
           source: string;
           correctedBy: unknown;
        }
      | undefined;
    if (existing) {
      if (
        existing.eventId !== eventId ||
        existing.personId !== personId ||
        existing.programUnitId !== programUnitId ||
        existing.observationType !== "attendance" ||
        existing.source !== OPERATIONS_ATTENDANCE_SOURCE ||
        existing.observedAt !== observedAt ||
        canonicalInstant(existing.recordedAt) === null ||
        existing.correctedBy !== null
      ) {
        throw new Error("IDEMPOTENCY_KEY_REUSE_CONFLICT");
      }
      return {
        observationId: existing.id,
        created: false,
        previousObservationId: existing.id,
        observedAt: existing.observedAt,
        recordedAt: existing.recordedAt,
      };
    }

    targetIsAcceptedCurrentAssignment(db, workspaceId, eventId, personId, programUnitId);
    const recordedAt = nowIso();
    assertNewAttendanceWindow(
      db,
      workspaceId,
      eventId,
      programUnitId,
      observedAt,
      recordedAt,
    );
    const competing = db.prepare(
      `SELECT COUNT(*) AS count
       FROM observations
       WHERE workspace_id = ?
         AND event_id = ?
         AND person_id = ?
         AND program_unit_id = ?
         AND observation_type = 'attendance'`,
    ).get(workspaceId, eventId, personId, programUnitId) as { count: number };
    if (competing.count !== 0) {
      throw new OperationsAttendanceError("ATTENDANCE_RECORD_CONFLICT");
    }

    const observationId = uuid();
    db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance', ?, ?, ?, ?)`,
    ).run(
      observationId,
      workspaceId,
      eventId,
      personId,
      programUnitId,
      observedAt,
      OPERATIONS_ATTENDANCE_SOURCE,
      persistedIdempotencyKey,
      recordedAt,
    );

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "outcome.attendance.recorded",
      targetType: "observation",
      targetId: observationId,
      details: { eventId, personId, programUnitId, observedMeaning: "ATTENDED" },
    });

    return { observationId, created: true, previousObservationId: null, observedAt, recordedAt };
  });
}

export interface ObservationRow {
  id: string;
  eventId: string;
  personId: string;
  programUnitId: string;
  programUnitName: string;
  observationType: string;
  observedAt: string;
  recordedAt: string;
  source: string;
  idempotencyKey: string;
}

export function listObservations(db: Db, workspaceId: string, eventId?: string): ObservationRow[] {
  const rows = eventId
    ? db
        .prepare(
          `SELECT o.id, o.event_id AS eventId, o.person_id AS personId, o.program_unit_id AS programUnitId,
                  pu.name AS programUnitName, o.observation_type AS observationType,
                  o.observed_at AS observedAt, o.recorded_at AS recordedAt,
                  o.source, o.idempotency_key AS idempotencyKey
           FROM observations o
           JOIN program_units pu
             ON pu.id = o.program_unit_id AND pu.workspace_id = o.workspace_id
           WHERE o.workspace_id = ? AND o.event_id = ? ORDER BY o.observed_at`,
        )
        .all(workspaceId, eventId)
    : db
        .prepare(
          `SELECT o.id, o.event_id AS eventId, o.person_id AS personId, o.program_unit_id AS programUnitId,
                  pu.name AS programUnitName, o.observation_type AS observationType,
                  o.observed_at AS observedAt, o.recorded_at AS recordedAt,
                  o.source, o.idempotency_key AS idempotencyKey
           FROM observations o
           JOIN program_units pu
             ON pu.id = o.program_unit_id AND pu.workspace_id = o.workspace_id
           WHERE o.workspace_id = ? ORDER BY o.observed_at`,
        )
        .all(workspaceId);
  return rows as unknown as ObservationRow[];
}

const OPERATIONS_CAPABILITY = "phase0.pipeline.manage" as const;
const OPERATIONS_ATTENDANCE_SOURCE = "organizer-live-operations" as const;
const OPERATIONS_CORRECTION_SOURCE = "organizer-live-operations-correction" as const;
const OPERATIONS_ATTENDANCE_TYPE = "attendance" as const;
const OPERATIONS_CORRECTION_TYPE = "attendance_not_attended" as const;
const OPERATIONS_OBSERVATION_LIMIT = 200;
const EVENT_LIFECYCLES = new Set(["draft", "planning", "published", "live", "closed", "cancelled"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const AUTHORIZED_ACTOR_ROLES = new Set([
  "organizer",
  "workspace_admin",
  "event_manager",
  "program_manager",
]);

export type OperationsAttendanceErrorCode =
  | "ATTENDANCE_INPUT_INVALID"
  | "ATTENDANCE_TARGET_NOT_FOUND"
  | "ATTENDANCE_TARGET_AMBIGUOUS"
  | "ATTENDANCE_EVENT_CLOSED"
  | "ATTENDANCE_EVENT_NOT_LIVE"
  | "ATTENDANCE_TIME_INVALID"
  | "ATTENDANCE_RECORD_CONFLICT"
  | "ATTENDANCE_SOURCE_NOT_FOUND"
  | "ATTENDANCE_SOURCE_AMBIGUOUS"
  | "ATTENDANCE_ALREADY_CORRECTED"
  | "ATTENDANCE_IDEMPOTENCY_CONFLICT"
  | "ATTENDANCE_HISTORY_INVALID";

export class OperationsAttendanceError extends Error {
  readonly code: OperationsAttendanceErrorCode;

  constructor(code: OperationsAttendanceErrorCode) {
    super(code);
    this.name = "OperationsAttendanceError";
    this.code = code;
  }
}

export interface OperationsAttendanceReceipt {
  readonly observationId: string;
  readonly disposition: "created" | "replayed";
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly state: "current" | "superseded";
}

export interface OperationsAttendanceCorrectionReceipt {
  readonly relationId: string;
  readonly originalObservationId: string;
  readonly correctionObservationId: string;
  readonly disposition: "created" | "replayed";
  readonly correctedAt: string;
  readonly recordedAt: string;
}

export interface OperationsAttendanceTarget {
  readonly personId: string;
  readonly personName: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface OperationsAttendanceCorrectionProjection {
  readonly relationId: string;
  readonly observationId: string;
  readonly meaning: "DID_NOT_ATTEND";
  readonly reason: string;
  readonly actorAccountId: string;
  readonly actorDisplayName: string;
  readonly actorRole: string;
  readonly correctedAt: string;
  readonly recordedAt: string;
  readonly commandFingerprint: string;
  readonly state: "current";
}

export interface OperationsAttendanceLineageProjection {
  readonly originalObservationId: string;
  readonly personId: string;
  readonly personName: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly meaning: "ATTENDED";
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly state: "current" | "superseded";
  readonly correction: OperationsAttendanceCorrectionProjection | null;
}

export interface OperationsObservationSurface {
  readonly targets: readonly OperationsAttendanceTarget[];
  readonly lineages: readonly OperationsAttendanceLineageProjection[];
}

type PersistedSession = {
  readonly id: unknown;
  readonly tokenHash: unknown;
  readonly accountId: unknown;
  readonly workspaceId: unknown;
  readonly expiresAt: unknown;
  readonly email: unknown;
  readonly displayName: unknown;
  readonly role: unknown;
  readonly workspaceSlug: unknown;
  readonly workspaceName: unknown;
};

function invalidOperationsAttendance(code: OperationsAttendanceErrorCode): never {
  throw new OperationsAttendanceError(code);
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || CONTROL_CHARACTER.test(value)) {
    invalidOperationsAttendance("ATTENDANCE_INPUT_INVALID");
  }
  return value;
}

function boundedDisplay(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= maximum &&
    Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !CONTROL_CHARACTER.test(value)
    ? value
    : null;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function boundedReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    CONTROL_CHARACTER.test(value) ||
    Array.from(value).length < 8 ||
    Array.from(value).length > 280 ||
    Buffer.byteLength(value, "utf8") < 8 ||
    Buffer.byteLength(value, "utf8") > 1120
  ) {
    invalidOperationsAttendance("ATTENDANCE_INPUT_INVALID");
  }
  return value;
}

function readPersistedSession(db: Db, session: SessionInfo | null): PersistedSession {
  if (!session) {
    throw new DenialError("SESSION_REQUIRED", "Sign in to continue.", "session");
  }
  const row = db.prepare(
    `SELECT session.id,
            session.token_hash AS tokenHash,
            session.account_id AS accountId,
            session.workspace_id AS workspaceId,
            session.expires_at AS expiresAt,
            account.email,
            account.display_name AS displayName,
            account.role,
            workspace.slug AS workspaceSlug,
            workspace.name AS workspaceName
     FROM sessions session
     JOIN accounts account
       ON account.id = session.account_id
      AND account.workspace_id = session.workspace_id
     JOIN workspaces workspace ON workspace.id = session.workspace_id
     WHERE session.id = ?
       AND session.token_hash = ?
       AND session.account_id = ?
       AND session.workspace_id = ?`,
  ).get(session.id, session.tokenHash, session.accountId, session.workspaceId) as PersistedSession | undefined;
  if (
    !row ||
    row.id !== session.id ||
    row.tokenHash !== session.tokenHash ||
    row.accountId !== session.accountId ||
    row.workspaceId !== session.workspaceId ||
    row.expiresAt !== session.expiresAt ||
    row.email !== session.email ||
    row.displayName !== session.displayName ||
    row.role !== session.role ||
    row.workspaceSlug !== session.workspaceSlug ||
    row.workspaceName !== session.workspaceName ||
    canonicalInstant(row.expiresAt) === null ||
    (row.expiresAt as string) <= nowIso()
  ) {
    throw new DenialError("SESSION_INVALID", "No active server session.", "session");
  }
  return row;
}

function authorizeOperationsAttendance(db: Db, session: SessionInfo | null): SessionInfo {
  readPersistedSession(db, session);
  requireCapability(db, session!, OPERATIONS_CAPABILITY);
  return session!;
}

function reauthorizeOperationsAttendance(db: Db, session: SessionInfo): string {
  const persisted = readPersistedSession(db, session);
  if (
    typeof persisted.role !== "string" ||
    !AUTHORIZED_ACTOR_ROLES.has(persisted.role) ||
    !roleHasCapability(persisted.role, OPERATIONS_CAPABILITY)
  ) {
    throw new DenialError(
      "CAPABILITY_DENIED",
      "This account is not authorized to perform that workspace action.",
      OPERATIONS_CAPABILITY,
    );
  }
  return persisted.role;
}

function attendanceKey(input: {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly programUnitId: string;
}): string {
  return `attendance-observation:v1:${fingerprintOf({
    schema: "attendance-observation-key/v1",
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    personId: input.personId,
    programUnitId: input.programUnitId,
    observedMeaning: "ATTENDED",
  })}`;
}

function correctionKey(workspaceId: string, originalObservationId: string): string {
  return `attendance-correction:v1:${fingerprintOf({
    schema: "attendance-correction-key/v1",
    workspaceId,
    originalObservationId,
    correctedMeaning: "DID_NOT_ATTEND",
  })}`;
}

function correctionFingerprint(
  workspaceId: string,
  originalObservationId: string,
  reason: string,
): string {
  return fingerprintOf({
    schema: "attendance-correction-command/v1",
    workspaceId,
    originalObservationId,
    correctedMeaning: "DID_NOT_ATTEND",
    reason,
  });
}

type AcceptedAttendanceAuthorityRow = {
  readonly assignmentId: unknown;
  readonly assignmentType: unknown;
  readonly planVersionId: unknown;
  readonly planFingerprint: unknown;
  readonly authorityEventId: unknown;
  readonly eventName: unknown;
  readonly timezone: unknown;
  readonly authorityPersonId: unknown;
  readonly authorityProgramUnitId: unknown;
  readonly programUnitName: unknown;
  readonly startsAt: unknown;
  readonly endsAt: unknown;
  readonly offerId: unknown;
  readonly offerWorkspaceId: unknown;
  readonly offerEventId: unknown;
  readonly offerPlanVersionId: unknown;
  readonly offerPersonId: unknown;
  readonly offerStatus: unknown;
  readonly termsJson: unknown;
  readonly termsFingerprint: unknown;
  readonly responseId: unknown;
  readonly responseActorPersonId: unknown;
  readonly responseValue: unknown;
  readonly respondedAt: unknown;
  readonly acceptanceAuditActorKind: unknown;
  readonly acceptanceAuditActorRef: unknown;
  readonly acceptanceAuditDetailsJson: unknown;
  readonly acceptanceAuditCreatedAt: unknown;
};

function acceptedAttendanceAuthorityIsCanonical(
  row: AcceptedAttendanceAuthorityRow,
  expected: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly personId: string;
    readonly programUnitId: string;
  },
): boolean {
  const assignmentType = boundedDisplay(row.assignmentType, 80);
  const eventName = boundedDisplay(row.eventName, 240);
  const programUnitName = boundedDisplay(row.programUnitName, 240);
  const respondedAt = canonicalInstant(row.respondedAt);
  const acceptanceAuditCreatedAt = canonicalInstant(row.acceptanceAuditCreatedAt);
  if (
    typeof row.assignmentId !== "string" || !SAFE_IDENTIFIER.test(row.assignmentId) ||
    !assignmentType ||
    typeof row.planVersionId !== "string" || !SAFE_IDENTIFIER.test(row.planVersionId) ||
    typeof row.planFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.planFingerprint) ||
    row.authorityEventId !== expected.eventId || !eventName ||
    typeof row.timezone !== "string" ||
    row.authorityPersonId !== expected.personId ||
    row.authorityProgramUnitId !== expected.programUnitId || !programUnitName ||
    canonicalInstant(row.startsAt) === null || canonicalInstant(row.endsAt) === null ||
    (row.startsAt as string) >= (row.endsAt as string) ||
    typeof row.offerId !== "string" || !SAFE_IDENTIFIER.test(row.offerId) ||
    row.offerWorkspaceId !== expected.workspaceId ||
    row.offerEventId !== expected.eventId ||
    row.offerPlanVersionId !== row.planVersionId ||
    row.offerPersonId !== expected.personId ||
    row.offerStatus !== "offered" ||
    typeof row.responseId !== "string" || !SAFE_IDENTIFIER.test(row.responseId) ||
    row.responseActorPersonId !== expected.personId ||
    row.responseValue !== "accepted" ||
    !respondedAt ||
    row.acceptanceAuditActorKind !== "person" ||
    row.acceptanceAuditActorRef !== expected.personId ||
    !acceptanceAuditCreatedAt || acceptanceAuditCreatedAt < respondedAt ||
    typeof row.acceptanceAuditDetailsJson !== "string"
  ) {
    return false;
  }
  const authority: CommitmentOfferTermsAuthority = {
    planVersionId: row.planVersionId,
    planFingerprint: row.planFingerprint,
    eventId: expected.eventId,
    eventName,
    timezone: row.timezone,
    programUnitId: expected.programUnitId,
    programUnitName,
    role: assignmentType,
    startsAt: row.startsAt as string,
    endsAt: row.endsAt as string,
  };
  if (!commitmentOfferTermsMatchAuthority(row, authority)) return false;
  const auditWithoutCommand = JSON.stringify(commitmentResponseAuditDetails({
    eventId: expected.eventId,
    planVersionId: row.planVersionId,
    termsFingerprint: row.termsFingerprint as string,
  }));
  const auditWithCommand = JSON.stringify(commitmentResponseAuditDetails({
    eventId: expected.eventId,
    planVersionId: row.planVersionId,
    termsFingerprint: row.termsFingerprint as string,
    commandKey: commitmentResponseCommandKey(row.offerId, "accepted"),
  }));
  return row.acceptanceAuditDetailsJson === auditWithoutCommand ||
    row.acceptanceAuditDetailsJson === auditWithCommand;
}

function eventLifecycle(db: Db, workspaceId: string, eventId: string): string {
  const event = db.prepare(
    "SELECT lifecycle FROM events WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, eventId) as { lifecycle: unknown } | undefined;
  if (!event || typeof event.lifecycle !== "string" || !EVENT_LIFECYCLES.has(event.lifecycle)) {
    invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  }
  return event.lifecycle;
}

type AttendanceWindow = {
  readonly lifecycle: unknown;
  readonly eventStartsAt: unknown;
  readonly eventEndsAt: unknown;
  readonly unitStartsAt: unknown;
  readonly unitEndsAt: unknown;
};

function readAttendanceWindow(
  db: Db,
  workspaceId: string,
  eventId: string,
  programUnitId: string,
): AttendanceWindow {
  const row = db.prepare(
    `SELECT event_row.lifecycle,
            event_row.starts_at AS eventStartsAt,
            event_row.ends_at AS eventEndsAt,
            unit.starts_at AS unitStartsAt,
            unit.ends_at AS unitEndsAt
     FROM events event_row
     JOIN program_units unit
       ON unit.workspace_id = event_row.workspace_id
      AND unit.event_id = event_row.id
      AND unit.id = ?
     WHERE event_row.workspace_id = ? AND event_row.id = ?`,
  ).get(programUnitId, workspaceId, eventId) as AttendanceWindow | undefined;
  if (!row || typeof row.lifecycle !== "string" || !EVENT_LIFECYCLES.has(row.lifecycle)) {
    invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  }
  return row;
}

function assertNewAttendanceWindow(
  db: Db,
  workspaceId: string,
  eventId: string,
  programUnitId: string,
  observedAt: string,
  recordedAt: string,
): void {
  const window = readAttendanceWindow(db, workspaceId, eventId, programUnitId);
  if (window.lifecycle !== "live") {
    invalidOperationsAttendance(
      window.lifecycle === "closed" || window.lifecycle === "cancelled"
        ? "ATTENDANCE_EVENT_CLOSED"
        : "ATTENDANCE_EVENT_NOT_LIVE",
    );
  }
  const eventStartsAt = canonicalInstant(window.eventStartsAt);
  const eventEndsAt = canonicalInstant(window.eventEndsAt);
  const unitStartsAt = canonicalInstant(window.unitStartsAt);
  const unitEndsAt = canonicalInstant(window.unitEndsAt);
  if (
    !eventStartsAt || !eventEndsAt || !unitStartsAt || !unitEndsAt ||
    eventStartsAt >= eventEndsAt ||
    unitStartsAt < eventStartsAt || unitEndsAt > eventEndsAt || unitStartsAt >= unitEndsAt ||
    canonicalInstant(observedAt) === null || canonicalInstant(recordedAt) === null ||
    recordedAt < eventStartsAt || recordedAt >= eventEndsAt ||
    observedAt < eventStartsAt || observedAt >= eventEndsAt ||
    observedAt < unitStartsAt || observedAt >= unitEndsAt ||
    observedAt > recordedAt
  ) {
    invalidOperationsAttendance("ATTENDANCE_TIME_INVALID");
  }
}

function currentApprovedPlanPointerState(
  db: Db,
  workspaceId: string,
  eventId: string,
): "available" | "absent" {
  const event = db.prepare(
    `SELECT current_plan_version_id AS currentPlanVersionId
     FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, eventId) as { currentPlanVersionId: unknown } | undefined;
  const latestApproved = db.prepare(
    `SELECT plan.id
     FROM plan_versions plan
     JOIN approvals approval
       ON approval.workspace_id = plan.workspace_id
      AND approval.event_id = plan.event_id
      AND approval.plan_version_id = plan.id
      AND approval.decision = 'approved'
     JOIN plan_states current_state
       ON current_state.workspace_id = plan.workspace_id
      AND current_state.plan_version_id = plan.id
      AND current_state.state = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM plan_states newer_state
        WHERE newer_state.workspace_id = current_state.workspace_id
          AND newer_state.plan_version_id = current_state.plan_version_id
          AND (newer_state.created_at > current_state.created_at
            OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
      )
     WHERE plan.workspace_id = ? AND plan.event_id = ?
     GROUP BY plan.id, plan.version_number
     ORDER BY plan.version_number DESC
     LIMIT 1`,
  ).get(workspaceId, eventId) as { id: unknown } | undefined;
  if (!event) invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  if (event.currentPlanVersionId === null && latestApproved === undefined) return "absent";
  if (
    typeof event.currentPlanVersionId === "string" &&
    typeof latestApproved?.id === "string" &&
    event.currentPlanVersionId === latestApproved.id
  ) return "available";
  invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
}

function assertCurrentApprovedPlanPointer(db: Db, workspaceId: string, eventId: string): void {
  if (currentApprovedPlanPointerState(db, workspaceId, eventId) !== "available") {
    invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  }
}

function targetIsAcceptedCurrentAssignment(
  db: Db,
  workspaceId: string,
  eventId: string,
  personId: string,
  programUnitId: string,
): void {
  assertCurrentApprovedPlanPointer(db, workspaceId, eventId);
  const rows = db.prepare(
    `SELECT assignment.id AS assignmentId,
            assignment.assignment_type AS assignmentType,
            plan.id AS planVersionId,
            plan.fingerprint AS planFingerprint,
            event_row.id AS authorityEventId,
            event_row.name AS eventName,
            event_row.timezone,
            person.id AS authorityPersonId,
            unit.id AS authorityProgramUnitId,
            unit.name AS programUnitName,
            unit.starts_at AS startsAt,
            unit.ends_at AS endsAt,
            offer.id AS offerId,
            offer.workspace_id AS offerWorkspaceId,
            offer.event_id AS offerEventId,
            offer.plan_version_id AS offerPlanVersionId,
            offer.person_id AS offerPersonId,
            offer.status AS offerStatus,
            offer.terms_json AS termsJson,
            offer.terms_fingerprint AS termsFingerprint,
            response.id AS responseId,
            response.actor_person_id AS responseActorPersonId,
            response.response AS responseValue,
            response.responded_at AS respondedAt,
            acceptance_audit.actor_kind AS acceptanceAuditActorKind,
            acceptance_audit.actor_ref AS acceptanceAuditActorRef,
            acceptance_audit.details_json AS acceptanceAuditDetailsJson,
            acceptance_audit.created_at AS acceptanceAuditCreatedAt
     FROM events event_row
     JOIN plan_versions plan
       ON plan.id = event_row.current_plan_version_id
      AND plan.workspace_id = event_row.workspace_id
      AND plan.event_id = event_row.id
     JOIN plan_assignments assignment
       ON assignment.workspace_id = plan.workspace_id
      AND assignment.plan_version_id = plan.id
      AND assignment.person_id = ?
      AND assignment.program_unit_id = ?
     JOIN people person
       ON person.id = assignment.person_id
      AND person.workspace_id = assignment.workspace_id
     JOIN program_units unit
       ON unit.id = assignment.program_unit_id
      AND unit.workspace_id = assignment.workspace_id
      AND unit.event_id = event_row.id
     JOIN approvals approval
       ON approval.workspace_id = plan.workspace_id
      AND approval.event_id = event_row.id
      AND approval.plan_version_id = plan.id
      AND approval.decision = 'approved'
     JOIN plan_states current_state
       ON current_state.workspace_id = plan.workspace_id
      AND current_state.plan_version_id = plan.id
      AND current_state.state = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM plan_states newer_state
        WHERE newer_state.workspace_id = current_state.workspace_id
          AND newer_state.plan_version_id = current_state.plan_version_id
          AND (newer_state.created_at > current_state.created_at
            OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_states superseded_state
        WHERE superseded_state.workspace_id = plan.workspace_id
          AND superseded_state.plan_version_id = plan.id
          AND superseded_state.state = 'superseded'
      )
     JOIN commitment_offers offer
       ON offer.workspace_id = plan.workspace_id
      AND offer.event_id = event_row.id
      AND offer.plan_version_id = plan.id
      AND offer.person_id = assignment.person_id
      AND offer.status = 'offered'
     JOIN commitment_responses response
       ON response.workspace_id = offer.workspace_id
      AND response.offer_id = offer.id
      AND response.actor_person_id = offer.person_id
      AND response.response = 'accepted'
     LEFT JOIN audit_events acceptance_audit
       ON acceptance_audit.workspace_id = offer.workspace_id
      AND acceptance_audit.actor_kind = 'person'
      AND acceptance_audit.actor_ref = response.actor_person_id
      AND acceptance_audit.action = 'commitment.accepted'
      AND acceptance_audit.target_type = 'commitment_offer'
      AND acceptance_audit.target_id = offer.id
     WHERE event_row.workspace_id = ?
       AND event_row.id = ?
     ORDER BY assignment.id, offer.id, response.id, acceptance_audit.id
     LIMIT 2`,
  ).all(personId, programUnitId, workspaceId, eventId) as AcceptedAttendanceAuthorityRow[];
  if (rows.length === 0) invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  if (rows.length !== 1) {
    invalidOperationsAttendance("ATTENDANCE_TARGET_AMBIGUOUS");
  }
  if (!acceptedAttendanceAuthorityIsCanonical(rows[0]!, {
    workspaceId,
    eventId,
    personId,
    programUnitId,
  })) {
    invalidOperationsAttendance("ATTENDANCE_TARGET_NOT_FOUND");
  }
}

type ExistingAttendance = {
  readonly id: unknown;
  readonly eventId: unknown;
  readonly personId: unknown;
  readonly programUnitId: unknown;
  readonly observationType: unknown;
  readonly observedAt: unknown;
  readonly recordedAt: unknown;
  readonly source: unknown;
  readonly correctedBy: unknown;
  readonly correctedCount: unknown;
};

function validatedExistingAttendance(
  row: ExistingAttendance,
  expected: {
    readonly eventId: string;
    readonly personId: string;
    readonly programUnitId: string;
    readonly observedAt: string;
  },
): { readonly id: string; readonly observedAt: string; readonly recordedAt: string; readonly corrected: boolean } {
  if (
    typeof row.id !== "string" || !SAFE_IDENTIFIER.test(row.id) ||
    row.eventId !== expected.eventId ||
    row.personId !== expected.personId ||
    row.programUnitId !== expected.programUnitId ||
    row.observationType !== OPERATIONS_ATTENDANCE_TYPE ||
    row.source !== OPERATIONS_ATTENDANCE_SOURCE ||
    row.observedAt !== expected.observedAt ||
    canonicalInstant(row.observedAt) === null || canonicalInstant(row.recordedAt) === null ||
    (row.observedAt as string) > (row.recordedAt as string) ||
    row.correctedBy !== null ||
    (row.correctedCount !== 0 && row.correctedCount !== 1)
  ) {
    invalidOperationsAttendance("ATTENDANCE_IDEMPOTENCY_CONFLICT");
  }
  return {
    id: row.id,
    observedAt: row.observedAt as string,
    recordedAt: row.recordedAt as string,
    corrected: row.correctedCount === 1,
  };
}

export function recordOperationsAttendance(
  db: Db,
  sessionInput: SessionInfo | null,
  input: {
    readonly eventId: string;
    readonly personId: string;
    readonly programUnitId: string;
    readonly observedAt: string;
  },
): OperationsAttendanceReceipt {
  const session = authorizeOperationsAttendance(db, sessionInput);
  const eventId = safeIdentifier(input.eventId);
  const personId = safeIdentifier(input.personId);
  const programUnitId = safeIdentifier(input.programUnitId);
  const observedAt = canonicalInstant(input.observedAt);
  if (!observedAt) invalidOperationsAttendance("ATTENDANCE_INPUT_INVALID");
  const idempotencyKey = attendanceKey({
    workspaceId: session.workspaceId,
    eventId,
    personId,
    programUnitId,
  });

  return withTransaction(db, () => {
    reauthorizeOperationsAttendance(db, session);
    eventLifecycle(db, session.workspaceId, eventId);
    const existing = db.prepare(
      `SELECT observation.id,
              observation.event_id AS eventId,
              observation.person_id AS personId,
              observation.program_unit_id AS programUnitId,
              observation.observation_type AS observationType,
              observation.observed_at AS observedAt,
              observation.recorded_at AS recordedAt,
              observation.source,
              observation.corrected_by AS correctedBy,
              (SELECT COUNT(*) FROM observation_corrections relation
               WHERE relation.workspace_id = observation.workspace_id
                 AND relation.original_observation_id = observation.id) AS correctedCount
       FROM observations observation
       WHERE observation.workspace_id = ? AND observation.idempotency_key = ?`,
    ).get(session.workspaceId, idempotencyKey) as ExistingAttendance | undefined;
    if (existing) {
      const validated = validatedExistingAttendance(existing, {
        eventId,
        personId,
        programUnitId,
        observedAt,
      });
      return {
        observationId: validated.id,
        disposition: "replayed",
        observedAt: validated.observedAt,
        recordedAt: validated.recordedAt,
        state: validated.corrected ? "superseded" : "current",
      };
    }
    targetIsAcceptedCurrentAssignment(
      db,
      session.workspaceId,
      eventId,
      personId,
      programUnitId,
    );
    const recordedAt = nowIso();
    assertNewAttendanceWindow(
      db,
      session.workspaceId,
      eventId,
      programUnitId,
      observedAt,
      recordedAt,
    );
    const competing = db.prepare(
      `SELECT COUNT(*) AS count
       FROM observations observation
       WHERE observation.workspace_id = ?
         AND observation.event_id = ?
         AND observation.person_id = ?
         AND observation.program_unit_id = ?
         AND observation.observation_type = 'attendance'
         AND NOT EXISTS (
           SELECT 1 FROM observation_corrections relation
           WHERE relation.original_observation_id = observation.id
         )`,
    ).get(session.workspaceId, eventId, personId, programUnitId) as { count: number };
    if (competing.count > 1) invalidOperationsAttendance("ATTENDANCE_SOURCE_AMBIGUOUS");
    if (competing.count !== 0) invalidOperationsAttendance("ATTENDANCE_RECORD_CONFLICT");

    const observationId = deterministicUuid(`operations-attendance:${idempotencyKey}`);
    db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'organizer-live-operations', ?, ?)`,
    ).run(
      observationId,
      session.workspaceId,
      eventId,
      personId,
      programUnitId,
      observedAt,
      idempotencyKey,
      recordedAt,
    );
    writeAudit(db, session.workspaceId, {
      actorKind: "account",
      actorRef: session.accountId,
      action: "outcome.attendance.recorded",
      targetType: "observation",
      targetId: observationId,
      details: { eventId, personId, programUnitId, observedMeaning: "ATTENDED" },
    });
    return { observationId, disposition: "created", observedAt, recordedAt, state: "current" };
  });
}

type ExistingCorrection = {
  readonly relationId: unknown;
  readonly workspaceId: unknown;
  readonly originalObservationId: unknown;
  readonly correctionObservationId: unknown;
  readonly reason: unknown;
  readonly actorAccountId: unknown;
  readonly actorRole: unknown;
  readonly correctedAt: unknown;
  readonly idempotencyKey: unknown;
  readonly commandFingerprint: unknown;
  readonly originalEventId: unknown;
  readonly originalPersonId: unknown;
  readonly originalProgramUnitId: unknown;
  readonly originalObservedAt: unknown;
  readonly originalRecordedAt: unknown;
  readonly originalCorrectedBy: unknown;
  readonly originalType: unknown;
  readonly originalSource: unknown;
  readonly originalKey: unknown;
  readonly correctionEventId: unknown;
  readonly correctionPersonId: unknown;
  readonly correctionProgramUnitId: unknown;
  readonly correctionObservedAt: unknown;
  readonly correctionRecordedAt: unknown;
  readonly correctionCorrectedBy: unknown;
  readonly correctionType: unknown;
  readonly correctionSource: unknown;
  readonly correctionKey: unknown;
};

function existingCorrectionByOriginal(
  db: Db,
  workspaceId: string,
  originalObservationId: string,
): ExistingCorrection | undefined {
  return db.prepare(
    `SELECT relation.id AS relationId,
            relation.workspace_id AS workspaceId,
            relation.original_observation_id AS originalObservationId,
            relation.correction_observation_id AS correctionObservationId,
            relation.reason,
            relation.actor_account_id AS actorAccountId,
            relation.actor_role AS actorRole,
            relation.corrected_at AS correctedAt,
            relation.idempotency_key AS idempotencyKey,
            relation.command_fingerprint AS commandFingerprint,
            original.event_id AS originalEventId,
            original.person_id AS originalPersonId,
            original.program_unit_id AS originalProgramUnitId,
            original.observed_at AS originalObservedAt,
            original.recorded_at AS originalRecordedAt,
            original.corrected_by AS originalCorrectedBy,
            original.observation_type AS originalType,
            original.source AS originalSource,
            original.idempotency_key AS originalKey,
            correction.event_id AS correctionEventId,
            correction.person_id AS correctionPersonId,
            correction.program_unit_id AS correctionProgramUnitId,
            correction.observed_at AS correctionObservedAt,
            correction.recorded_at AS correctionRecordedAt,
            correction.corrected_by AS correctionCorrectedBy,
            correction.observation_type AS correctionType,
            correction.source AS correctionSource,
            correction.idempotency_key AS correctionKey
     FROM observation_corrections relation
     LEFT JOIN observations original
       ON original.id = relation.original_observation_id
      AND original.workspace_id = relation.workspace_id
     LEFT JOIN observations correction
       ON correction.id = relation.correction_observation_id
      AND correction.workspace_id = relation.workspace_id
     WHERE relation.workspace_id = ? AND relation.original_observation_id = ?`,
  ).get(workspaceId, originalObservationId) as ExistingCorrection | undefined;
}

function validateCorrectionRecord(
  db: Db,
  row: ExistingCorrection,
  expected: { readonly workspaceId: string; readonly eventId: string; readonly originalObservationId: string },
): {
  readonly relationId: string;
  readonly correctionObservationId: string;
  readonly correctedAt: string;
  readonly recordedAt: string;
  readonly reason: string;
} {
  const reason = boundedReason(row.reason);
  const originalPersonId = safeIdentifier(row.originalPersonId);
  const originalProgramUnitId = safeIdentifier(row.originalProgramUnitId);
  const originalKey = attendanceKey({
    workspaceId: expected.workspaceId,
    eventId: expected.eventId,
    personId: originalPersonId,
    programUnitId: originalProgramUnitId,
  });
  const expectedCorrectionKey = correctionKey(expected.workspaceId, expected.originalObservationId);
  if (
    typeof row.relationId !== "string" || !SAFE_IDENTIFIER.test(row.relationId) ||
    row.workspaceId !== expected.workspaceId ||
    row.originalObservationId !== expected.originalObservationId ||
    typeof row.correctionObservationId !== "string" || !SAFE_IDENTIFIER.test(row.correctionObservationId) ||
    row.originalEventId !== expected.eventId || row.correctionEventId !== expected.eventId ||
    row.originalPersonId !== row.correctionPersonId ||
    row.originalProgramUnitId !== row.correctionProgramUnitId ||
    row.originalType !== OPERATIONS_ATTENDANCE_TYPE ||
    row.originalSource !== OPERATIONS_ATTENDANCE_SOURCE ||
    row.originalKey !== originalKey ||
    row.correctionType !== OPERATIONS_CORRECTION_TYPE ||
    row.correctionSource !== OPERATIONS_CORRECTION_SOURCE ||
    row.correctionKey !== expectedCorrectionKey ||
    row.idempotencyKey !== expectedCorrectionKey ||
    row.commandFingerprint !== correctionFingerprint(expected.workspaceId, expected.originalObservationId, reason) ||
    typeof row.actorAccountId !== "string" || !SAFE_IDENTIFIER.test(row.actorAccountId) ||
    typeof row.actorRole !== "string" || !AUTHORIZED_ACTOR_ROLES.has(row.actorRole) ||
    canonicalInstant(row.originalObservedAt) === null ||
    canonicalInstant(row.originalRecordedAt) === null ||
    (row.originalObservedAt as string) > (row.originalRecordedAt as string) ||
    row.originalCorrectedBy !== null ||
    canonicalInstant(row.correctedAt) === null ||
    row.correctionObservedAt !== row.correctedAt ||
    canonicalInstant(row.correctionRecordedAt) === null ||
    (row.correctionObservedAt as string) > (row.correctionRecordedAt as string) ||
    row.correctionCorrectedBy !== null ||
    (row.correctedAt as string) <= (row.originalObservedAt as string)
  ) {
    invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
  }
  const competing = db.prepare(
    `SELECT COUNT(*) AS count
     FROM observations observation
     WHERE observation.workspace_id = ?
       AND observation.event_id = ?
       AND observation.person_id = ?
       AND observation.program_unit_id = ?
       AND observation.observation_type = 'attendance'
       AND observation.id <> ?
       AND NOT EXISTS (
         SELECT 1 FROM observation_corrections relation
         WHERE relation.original_observation_id = observation.id
       )`,
  ).get(
    expected.workspaceId,
    expected.eventId,
    originalPersonId,
    originalProgramUnitId,
    expected.originalObservationId,
  ) as { count: number };
  if (competing.count !== 0) invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
  return {
    relationId: row.relationId,
    correctionObservationId: row.correctionObservationId,
    correctedAt: row.correctedAt as string,
    recordedAt: row.correctionRecordedAt as string,
    reason,
  };
}

export function correctOperationsAttendance(
  db: Db,
  sessionInput: SessionInfo | null,
  input: { readonly eventId: string; readonly originalObservationId: string; readonly reason: string },
): OperationsAttendanceCorrectionReceipt {
  const session = authorizeOperationsAttendance(db, sessionInput);
  const eventId = safeIdentifier(input.eventId);
  const originalObservationId = safeIdentifier(input.originalObservationId);
  const reason = boundedReason(input.reason);
  const idempotencyKey = correctionKey(session.workspaceId, originalObservationId);
  const commandFingerprint = correctionFingerprint(session.workspaceId, originalObservationId, reason);

  return withTransaction(db, () => {
    const actorRole = reauthorizeOperationsAttendance(db, session);
    eventLifecycle(db, session.workspaceId, eventId);
    const prior = existingCorrectionByOriginal(db, session.workspaceId, originalObservationId);
    if (prior) {
      const validated = validateCorrectionRecord(db, prior, {
        workspaceId: session.workspaceId,
        eventId,
        originalObservationId,
      });
      if (prior.idempotencyKey !== idempotencyKey || prior.commandFingerprint !== commandFingerprint || validated.reason !== reason) {
        invalidOperationsAttendance("ATTENDANCE_IDEMPOTENCY_CONFLICT");
      }
      return {
        relationId: validated.relationId,
        originalObservationId,
        correctionObservationId: validated.correctionObservationId,
        disposition: "replayed",
        correctedAt: validated.correctedAt,
        recordedAt: validated.recordedAt,
      };
    }

    const original = db.prepare(
      `SELECT observation.id,
              observation.event_id AS eventId,
              observation.person_id AS personId,
              observation.program_unit_id AS programUnitId,
              observation.observation_type AS observationType,
              observation.observed_at AS observedAt,
              observation.recorded_at AS recordedAt,
              observation.source,
              observation.corrected_by AS correctedBy,
              observation.idempotency_key AS idempotencyKey
       FROM observations observation
       WHERE observation.workspace_id = ?
         AND observation.event_id = ?
         AND observation.id = ?`,
    ).get(session.workspaceId, eventId, originalObservationId) as
      | {
          id: unknown;
          eventId: unknown;
          personId: unknown;
          programUnitId: unknown;
          observationType: unknown;
          observedAt: unknown;
          recordedAt: unknown;
          source: unknown;
          correctedBy: unknown;
          idempotencyKey: unknown;
        }
      | undefined;
    if (!original) invalidOperationsAttendance("ATTENDANCE_SOURCE_NOT_FOUND");
    const personId = safeIdentifier(original.personId);
    const programUnitId = safeIdentifier(original.programUnitId);
    const expectedOriginalKey = attendanceKey({
      workspaceId: session.workspaceId,
      eventId,
      personId,
      programUnitId,
    });
    if (
      original.id !== originalObservationId ||
      original.eventId !== eventId ||
      original.observationType !== OPERATIONS_ATTENDANCE_TYPE ||
      original.source !== OPERATIONS_ATTENDANCE_SOURCE ||
      original.idempotencyKey !== expectedOriginalKey ||
      canonicalInstant(original.observedAt) === null ||
      canonicalInstant(original.recordedAt) === null ||
      (original.observedAt as string) > (original.recordedAt as string) ||
      original.correctedBy !== null
    ) {
      invalidOperationsAttendance("ATTENDANCE_SOURCE_NOT_FOUND");
    }
    const unsuperseded = db.prepare(
      `SELECT COUNT(*) AS count
       FROM observations observation
       WHERE observation.workspace_id = ?
         AND observation.event_id = ?
         AND observation.person_id = ?
         AND observation.program_unit_id = ?
         AND observation.observation_type = 'attendance'
         AND NOT EXISTS (
           SELECT 1 FROM observation_corrections relation
           WHERE relation.original_observation_id = observation.id
         )`,
    ).get(session.workspaceId, eventId, personId, programUnitId) as { count: number };
    if (unsuperseded.count > 1) invalidOperationsAttendance("ATTENDANCE_SOURCE_AMBIGUOUS");
    if (unsuperseded.count !== 1) invalidOperationsAttendance("ATTENDANCE_ALREADY_CORRECTED");

    const existingKeyUse = db.prepare(
      `SELECT observation.id
       FROM observations observation
       WHERE observation.workspace_id = ? AND observation.idempotency_key = ?`,
    ).get(session.workspaceId, idempotencyKey);
    if (existingKeyUse) invalidOperationsAttendance("ATTENDANCE_IDEMPOTENCY_CONFLICT");

    const originalTime = Date.parse(original.observedAt as string);
    const originalRecordedTime = Date.parse(original.recordedAt as string);
    const correctedAt = new Date(Math.max(Date.now(), originalTime + 1, originalRecordedTime)).toISOString();
    const recordedAt = correctedAt;
    const correctionObservationId = deterministicUuid(`operations-attendance-correction:${idempotencyKey}`);
    const relationId = deterministicUuid(`operations-attendance-relation:${idempotencyKey}`);
    db.prepare(
      `INSERT INTO observations
         (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
          observed_at, source, idempotency_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'attendance_not_attended', ?,
               'organizer-live-operations-correction', ?, ?)`,
    ).run(
      correctionObservationId,
      session.workspaceId,
      eventId,
      personId,
      programUnitId,
      correctedAt,
      idempotencyKey,
      recordedAt,
    );
    db.prepare(
      `INSERT INTO observation_corrections
         (id, workspace_id, original_observation_id, correction_observation_id, reason,
          actor_account_id, actor_role, corrected_at, idempotency_key, command_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      relationId,
      session.workspaceId,
      originalObservationId,
      correctionObservationId,
      reason,
      session.accountId,
      actorRole,
      correctedAt,
      idempotencyKey,
      commandFingerprint,
    );
    writeAudit(db, session.workspaceId, {
      actorKind: "account",
      actorRef: session.accountId,
      action: "outcome.attendance.corrected",
      targetType: "observation_correction",
      targetId: relationId,
      details: {
        eventId,
        originalObservationId,
        correctionObservationId,
        correctedMeaning: "DID_NOT_ATTEND",
        commandFingerprint,
      },
    });
    return {
      relationId,
      originalObservationId,
      correctionObservationId,
      disposition: "created",
      correctedAt,
      recordedAt,
    };
  });
}

type LineageRow = {
  readonly originalObservationId: unknown;
  readonly originalPersonId: unknown;
  readonly personName: unknown;
  readonly originalProgramUnitId: unknown;
  readonly programUnitName: unknown;
  readonly originalObservedAt: unknown;
  readonly originalRecordedAt: unknown;
  readonly originalCorrectedBy: unknown;
  readonly originalIdempotencyKey: unknown;
  readonly relationId: unknown;
  readonly correctionObservationId: unknown;
  readonly reason: unknown;
  readonly actorAccountId: unknown;
  readonly actorDisplayName: unknown;
  readonly actorRole: unknown;
  readonly correctedAt: unknown;
  readonly relationIdempotencyKey: unknown;
  readonly commandFingerprint: unknown;
  readonly correctionObservedAt: unknown;
  readonly correctionRecordedAt: unknown;
  readonly correctionCorrectedBy: unknown;
  readonly correctionType: unknown;
  readonly correctionSource: unknown;
  readonly correctionIdempotencyKey: unknown;
};

function readAttendanceTargets(db: Db, workspaceId: string, eventId: string): OperationsAttendanceTarget[] {
  if (currentApprovedPlanPointerState(db, workspaceId, eventId) === "absent") return [];
  const rows = db.prepare(
    `SELECT assignment.id AS assignmentId,
            assignment.assignment_type AS assignmentType,
            plan.id AS planVersionId,
            plan.fingerprint AS planFingerprint,
            event_row.id AS authorityEventId,
            event_row.name AS eventName,
            event_row.timezone,
            person.id AS personId,
            person.id AS authorityPersonId,
            person.full_name AS personName,
            unit.id AS programUnitId,
            unit.id AS authorityProgramUnitId,
            unit.name AS programUnitName,
            unit.starts_at AS startsAt,
            unit.ends_at AS endsAt,
            offer.id AS offerId,
            offer.workspace_id AS offerWorkspaceId,
            offer.event_id AS offerEventId,
            offer.plan_version_id AS offerPlanVersionId,
            offer.person_id AS offerPersonId,
            offer.status AS offerStatus,
            offer.terms_json AS termsJson,
            offer.terms_fingerprint AS termsFingerprint,
            response.id AS responseId,
            response.actor_person_id AS responseActorPersonId,
            response.response AS responseValue,
            response.responded_at AS respondedAt,
            acceptance_audit.actor_kind AS acceptanceAuditActorKind,
            acceptance_audit.actor_ref AS acceptanceAuditActorRef,
            acceptance_audit.details_json AS acceptanceAuditDetailsJson,
            acceptance_audit.created_at AS acceptanceAuditCreatedAt
     FROM events event_row
     JOIN plan_versions plan
       ON plan.id = event_row.current_plan_version_id
      AND plan.workspace_id = event_row.workspace_id
      AND plan.event_id = event_row.id
     JOIN plan_assignments assignment
       ON assignment.workspace_id = plan.workspace_id
      AND assignment.plan_version_id = plan.id
     JOIN people person
       ON person.id = assignment.person_id
      AND person.workspace_id = assignment.workspace_id
     JOIN program_units unit
       ON unit.id = assignment.program_unit_id
      AND unit.workspace_id = assignment.workspace_id
      AND unit.event_id = event_row.id
     JOIN approvals approval
       ON approval.workspace_id = plan.workspace_id
      AND approval.event_id = event_row.id
      AND approval.plan_version_id = plan.id
      AND approval.decision = 'approved'
     JOIN plan_states current_state
       ON current_state.workspace_id = plan.workspace_id
      AND current_state.plan_version_id = plan.id
      AND current_state.state = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM plan_states newer_state
        WHERE newer_state.workspace_id = current_state.workspace_id
          AND newer_state.plan_version_id = current_state.plan_version_id
          AND (newer_state.created_at > current_state.created_at
            OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_states superseded_state
        WHERE superseded_state.workspace_id = plan.workspace_id
          AND superseded_state.plan_version_id = plan.id
          AND superseded_state.state = 'superseded'
      )
     JOIN commitment_offers offer
       ON offer.workspace_id = plan.workspace_id
      AND offer.event_id = event_row.id
      AND offer.plan_version_id = plan.id
      AND offer.person_id = assignment.person_id
      AND offer.status = 'offered'
     JOIN commitment_responses response
       ON response.workspace_id = offer.workspace_id
      AND response.offer_id = offer.id
      AND response.actor_person_id = offer.person_id
      AND response.response = 'accepted'
     LEFT JOIN audit_events acceptance_audit
       ON acceptance_audit.workspace_id = offer.workspace_id
      AND acceptance_audit.actor_kind = 'person'
      AND acceptance_audit.actor_ref = response.actor_person_id
      AND acceptance_audit.action = 'commitment.accepted'
      AND acceptance_audit.target_type = 'commitment_offer'
      AND acceptance_audit.target_id = offer.id
     WHERE event_row.workspace_id = ?
       AND event_row.id = ?
     ORDER BY person.full_name, unit.name, person.id, unit.id,
              assignment.id, offer.id, response.id, acceptance_audit.id
     LIMIT ${OPERATIONS_OBSERVATION_LIMIT + 1}`,
  ).all(workspaceId, eventId) as Array<AcceptedAttendanceAuthorityRow & {
    readonly personId: unknown;
    readonly personName: unknown;
    readonly programUnitId: unknown;
  }>;
  if (rows.length > OPERATIONS_OBSERVATION_LIMIT) {
    invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
  }
  const targetKeys = new Set<string>();
  const targets: OperationsAttendanceTarget[] = [];
  for (const row of rows) {
    const personId = typeof row.personId === "string" && SAFE_IDENTIFIER.test(row.personId)
      ? row.personId
      : null;
    const programUnitId = typeof row.programUnitId === "string" && SAFE_IDENTIFIER.test(row.programUnitId)
      ? row.programUnitId
      : null;
    if (!personId || !programUnitId) continue;
    if (!acceptedAttendanceAuthorityIsCanonical(row, {
      workspaceId,
      eventId,
      personId,
      programUnitId,
    })) continue;
    const targetKey = JSON.stringify([personId, programUnitId]);
    if (targetKeys.has(targetKey)) invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
    const personName = boundedDisplay(row.personName, 240);
    const programUnitName = boundedDisplay(row.programUnitName, 240);
    if (!personName || !programUnitName) continue;
    targetKeys.add(targetKey);
    targets.push(Object.freeze({
      personId,
      personName,
      programUnitId,
      programUnitName,
      startsAt: row.startsAt as string,
      endsAt: row.endsAt as string,
    }));
  }
  return targets;
}

function readAttendanceLineages(db: Db, workspaceId: string, eventId: string): OperationsAttendanceLineageProjection[] {
  const malformedAmbiguity = db.prepare(
    `SELECT 1
     FROM observations observation
     WHERE observation.workspace_id = ?
       AND observation.event_id = ?
       AND observation.observation_type = 'attendance'
       AND NOT EXISTS (
         SELECT 1 FROM observation_corrections relation
         WHERE relation.original_observation_id = observation.id
       )
     GROUP BY observation.person_id, observation.program_unit_id
     HAVING COUNT(*) > 1
     LIMIT 1`,
  ).get(workspaceId, eventId);
  if (malformedAmbiguity) invalidOperationsAttendance("ATTENDANCE_SOURCE_AMBIGUOUS");
  const rows = db.prepare(
    `SELECT original.id AS originalObservationId,
            original.person_id AS originalPersonId,
            person.full_name AS personName,
            original.program_unit_id AS originalProgramUnitId,
            unit.name AS programUnitName,
            original.observed_at AS originalObservedAt,
            original.recorded_at AS originalRecordedAt,
            original.corrected_by AS originalCorrectedBy,
            original.idempotency_key AS originalIdempotencyKey,
            relation.id AS relationId,
            relation.correction_observation_id AS correctionObservationId,
            relation.reason,
            relation.actor_account_id AS actorAccountId,
            actor.display_name AS actorDisplayName,
            relation.actor_role AS actorRole,
            relation.corrected_at AS correctedAt,
            relation.idempotency_key AS relationIdempotencyKey,
            relation.command_fingerprint AS commandFingerprint,
            correction.observed_at AS correctionObservedAt,
            correction.recorded_at AS correctionRecordedAt,
            correction.corrected_by AS correctionCorrectedBy,
            correction.observation_type AS correctionType,
            correction.source AS correctionSource,
            correction.idempotency_key AS correctionIdempotencyKey
     FROM observations original
     JOIN people person
       ON person.id = original.person_id
      AND person.workspace_id = original.workspace_id
     JOIN program_units unit
       ON unit.id = original.program_unit_id
      AND unit.workspace_id = original.workspace_id
      AND unit.event_id = original.event_id
     LEFT JOIN observation_corrections relation
       ON relation.workspace_id = original.workspace_id
      AND relation.original_observation_id = original.id
     LEFT JOIN observations correction
       ON correction.id = relation.correction_observation_id
      AND correction.workspace_id = relation.workspace_id
     LEFT JOIN accounts actor
       ON actor.id = relation.actor_account_id
      AND actor.workspace_id = relation.workspace_id
     WHERE original.workspace_id = ?
       AND original.event_id = ?
       AND original.observation_type = 'attendance'
       AND original.source = 'organizer-live-operations'
     ORDER BY original.observed_at DESC, original.id DESC
     LIMIT ${OPERATIONS_OBSERVATION_LIMIT + 1}`,
  ).all(workspaceId, eventId) as LineageRow[];
  if (rows.length > OPERATIONS_OBSERVATION_LIMIT) {
    invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
  }

  return rows.map((row) => {
    const originalObservationId = safeIdentifier(row.originalObservationId);
    const personId = safeIdentifier(row.originalPersonId);
    const programUnitId = safeIdentifier(row.originalProgramUnitId);
    const personName = boundedDisplay(row.personName, 240);
    const programUnitName = boundedDisplay(row.programUnitName, 240);
    const observedAt = canonicalInstant(row.originalObservedAt);
    const recordedAt = canonicalInstant(row.originalRecordedAt);
    const expectedOriginalKey = attendanceKey({ workspaceId, eventId, personId, programUnitId });
    if (
      !personName || !programUnitName || !observedAt || !recordedAt ||
      observedAt > recordedAt || row.originalCorrectedBy !== null ||
      row.originalIdempotencyKey !== expectedOriginalKey
    ) {
      invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
    }
    if (row.relationId === null) {
      const correctionFields = [
        row.correctionObservationId, row.reason, row.actorAccountId, row.actorDisplayName,
        row.actorRole, row.correctedAt, row.relationIdempotencyKey, row.commandFingerprint,
        row.correctionObservedAt, row.correctionRecordedAt, row.correctionCorrectedBy,
        row.correctionType, row.correctionSource,
        row.correctionIdempotencyKey,
      ];
      if (correctionFields.some((value) => value !== null)) {
        invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
      }
      return Object.freeze({
        originalObservationId,
        personId,
        personName,
        programUnitId,
        programUnitName,
        meaning: "ATTENDED" as const,
        observedAt,
        recordedAt,
        state: "current" as const,
        correction: null,
      });
    }
    const existing = existingCorrectionByOriginal(db, workspaceId, originalObservationId);
    if (!existing) invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
    const correction = validateCorrectionRecord(db, existing, { workspaceId, eventId, originalObservationId });
    const actorDisplayName = boundedDisplay(row.actorDisplayName, 240);
    if (!actorDisplayName || row.relationId !== correction.relationId) {
      invalidOperationsAttendance("ATTENDANCE_HISTORY_INVALID");
    }
    return Object.freeze({
      originalObservationId,
      personId,
      personName,
      programUnitId,
      programUnitName,
      meaning: "ATTENDED" as const,
      observedAt,
      recordedAt,
      state: "superseded" as const,
      correction: Object.freeze({
        relationId: correction.relationId,
        observationId: correction.correctionObservationId,
        meaning: "DID_NOT_ATTEND" as const,
        reason: correction.reason,
        actorAccountId: safeIdentifier(row.actorAccountId),
        actorDisplayName,
        actorRole: row.actorRole as string,
        correctedAt: correction.correctedAt,
        recordedAt: correction.recordedAt,
        commandFingerprint: row.commandFingerprint as string,
        state: "current" as const,
      }),
    });
  });
}

export function getOperationsObservationSurface(
  db: Db,
  sessionInput: SessionInfo | null,
  eventIdInput: string,
): OperationsObservationSurface {
  const session = authorizeOperationsAttendance(db, sessionInput);
  const eventId = safeIdentifier(eventIdInput);
  const readSnapshot = <T>(operation: () => T): T => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        throw new Error("OPERATIONS_OBSERVATION_SNAPSHOT_CLEANUP_FAILED");
      }
      throw error;
    }
  };
  return readSnapshot(() => {
    reauthorizeOperationsAttendance(db, session);
    eventLifecycle(db, session.workspaceId, eventId);
    return Object.freeze({
      targets: Object.freeze(readAttendanceTargets(db, session.workspaceId, eventId)),
      lineages: Object.freeze(readAttendanceLineages(db, session.workspaceId, eventId)),
    });
  });
}
