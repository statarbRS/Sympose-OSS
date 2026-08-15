import { roleHasCapability } from "../../auth";
import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import { withTransaction, type Db } from "../../db";
import { writeAudit } from "../audit";
import { getEvent } from "../events";
import { detectScheduleConflicts } from "./deterministic";
import {
  findScheduleDraftAuthorityEvidence,
  readScheduleDraft,
  readScheduleDraftAuthorityEvidence,
} from "./persistence";
import type { CfpScheduleSessionAuthority, ScheduleSnapshot } from "./types";
import type { ScheduleDraftPointer } from "./types";
import { scheduleAllocationsAreDurable } from "./durability";

export const SCHEDULE_APPROVAL_EVENT_TYPE = "organizer.schedule.approved";
export const SCHEDULE_APPROVAL_AGGREGATE_TYPE = "schedule_approval";
export const SCHEDULE_APPROVAL_EVENT_SCHEMA = "organizer-schedule-approval/v1";
export const MAX_SCHEDULE_APPROVAL_EVENTS = 1_000;

const SCHEDULE_APPROVAL_AUDIT_SCHEMA = "organizer-schedule-approval-audit/v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const APPROVABLE_EVENT_LIFECYCLES = new Set(["draft", "planning", "published", "live"]);

export class ScheduleApprovalError extends Error {
  readonly code: string;

  constructor(code: string, message = "The schedule approval could not be recorded.") {
    super(message);
    this.name = "ScheduleApprovalError";
    this.code = code;
  }
}

export interface ApproveScheduleInput {
  readonly expectedRevision: number;
  readonly expectedScheduleAuthorityFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly actorAccountId: string;
}

export interface ScheduleApprovalEvidence {
  readonly approvalEventId: string;
  readonly approvalAuditId: string;
  readonly approvalFingerprint: string;
  readonly approvedAt: string;
  readonly approvedByAccountId: string;
  readonly approvedByRole: string;
  readonly capability: "phase0.pipeline.manage";
  readonly sourceScheduleAuditId: string;
  readonly sourceSchedulePointerFingerprint: string;
  readonly scheduleRevision: number;
  readonly scheduleAuthorityFingerprint: string;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanFingerprint: string;
  readonly acceptedInventoryFingerprint: string;
  readonly cfpSessionInventoryFingerprint: string;
  readonly cfpSessionAuthorities: readonly CfpScheduleSessionAuthority[];
}

export interface ScheduleApprovalMutationResult {
  readonly approval: ScheduleApprovalEvidence;
  readonly changed: boolean;
}

export type ScheduleApprovalActionResult =
  | {
      readonly ok: true;
      readonly code: "SCHEDULE_APPROVED" | "SCHEDULE_ALREADY_APPROVED";
      readonly approval: ScheduleApprovalEvidence;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

interface StoredScheduleApproval {
  readonly schema: typeof SCHEDULE_APPROVAL_EVENT_SCHEMA;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly sourceScheduleAuditId: string;
  readonly sourceSchedulePointerFingerprint: string;
  readonly scheduleRevision: number;
  readonly scheduleAuthorityFingerprint: string;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanFingerprint: string;
  readonly acceptedInventoryFingerprint: string;
  readonly cfpSessionInventoryFingerprint: string;
  readonly cfpSessionAuthorities: readonly CfpScheduleSessionAuthority[];
  readonly actorAccountId: string;
  readonly actorRole: string;
  readonly capability: "phase0.pipeline.manage";
  readonly approvedAt: string;
}

interface ApprovalEventRow {
  readonly id: string;
  readonly rowid: number;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function boundedString(value: unknown, maximum = 160, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !CONTROL_CHARACTER.test(value) && (!pattern || pattern.test(value));
}

function canonicalInstant(value: unknown): value is string {
  return boundedString(value, 128) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validAuthorities(value: unknown): value is readonly CfpScheduleSessionAuthority[] {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  let previousUnitId: string | null = null;
  for (const authority of value) {
    const linkFingerprints = isRecord(authority) && Array.isArray(authority.linkFingerprints)
      ? authority.linkFingerprints
      : null;
    if (!isRecord(authority) || !exactKeys(authority, ["programUnitId", "sessionFingerprint", "linkFingerprints"]) ||
        !boundedString(authority.programUnitId, 160, IDENTIFIER) ||
        !boundedString(authority.sessionFingerprint, 64, SHA256) ||
        !linkFingerprints || linkFingerprints.length < 1 || linkFingerprints.length > 24 ||
        linkFingerprints.some((entry) => !boundedString(entry, 64, SHA256)) ||
        new Set(linkFingerprints).size !== linkFingerprints.length ||
        linkFingerprints.some((entry, index) => index > 0 && String(linkFingerprints[index - 1]) >= String(entry)) ||
        (previousUnitId !== null && previousUnitId >= authority.programUnitId)) {
      return false;
    }
    previousUnitId = authority.programUnitId;
  }
  return true;
}

function approvalRows(db: Db, scope: { workspaceId: string; eventId: string }): ApprovalEventRow[] {
  const rows = db.prepare(
    `SELECT id, rowid, payload_json AS payloadJson,
            payload_fingerprint AS payloadFingerprint, created_at AS createdAt
       FROM domain_events
      WHERE workspace_id = ? AND event_type = ?
        AND aggregate_type = ? AND aggregate_id = ?
      ORDER BY rowid DESC
      LIMIT ?`,
  ).all(
    scope.workspaceId,
    SCHEDULE_APPROVAL_EVENT_TYPE,
    SCHEDULE_APPROVAL_AGGREGATE_TYPE,
    scope.eventId,
    MAX_SCHEDULE_APPROVAL_EVENTS + 1,
  ) as unknown as ApprovalEventRow[];
  if (rows.length > MAX_SCHEDULE_APPROVAL_EVENTS) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_TOO_MANY_EVENTS");
  }
  return rows;
}

function storedApprovalFromRow(
  row: ApprovalEventRow,
  scope: { workspaceId: string; eventId: string },
): StoredScheduleApproval {
  if (!boundedString(row.id, 160, IDENTIFIER) || !boundedString(row.payloadFingerprint, 64, SHA256) ||
      !canonicalInstant(row.createdAt) || Buffer.byteLength(row.payloadJson, "utf8") > 100_000) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson) as unknown;
  } catch {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  if (!isRecord(parsed) || !exactKeys(parsed, [
    "schema", "requestFingerprint", "idempotencyKey", "requestId", "workspaceId", "eventId",
    "sourceScheduleAuditId", "sourceSchedulePointerFingerprint", "scheduleRevision", "scheduleAuthorityFingerprint",
    "sourcePlanVersionId", "sourcePlanFingerprint", "acceptedInventoryFingerprint",
    "cfpSessionInventoryFingerprint", "cfpSessionAuthorities", "actorAccountId", "actorRole", "capability",
    "approvedAt",
  ])) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  if (parsed.schema !== SCHEDULE_APPROVAL_EVENT_SCHEMA || parsed.workspaceId !== scope.workspaceId ||
      parsed.eventId !== scope.eventId || parsed.capability !== "phase0.pipeline.manage" ||
      !boundedString(parsed.requestFingerprint, 64, SHA256) ||
      !boundedString(parsed.idempotencyKey, 160, IDENTIFIER) || !boundedString(parsed.requestId, 160, IDENTIFIER) ||
      !boundedString(parsed.sourceScheduleAuditId, 160, IDENTIFIER) ||
      !boundedString(parsed.sourceSchedulePointerFingerprint, 64, SHA256) ||
      !Number.isSafeInteger(parsed.scheduleRevision) || (parsed.scheduleRevision as number) < 1 ||
      !boundedString(parsed.scheduleAuthorityFingerprint, 64, SHA256) ||
      !boundedString(parsed.sourcePlanVersionId, 160, IDENTIFIER) ||
      !boundedString(parsed.sourcePlanFingerprint, 64, SHA256) ||
      !boundedString(parsed.acceptedInventoryFingerprint, 64, SHA256) ||
      !boundedString(parsed.cfpSessionInventoryFingerprint, 64, SHA256) ||
      !validAuthorities(parsed.cfpSessionAuthorities) ||
      fingerprintOf(parsed.cfpSessionAuthorities) !== parsed.cfpSessionInventoryFingerprint ||
      !boundedString(parsed.actorAccountId, 160, IDENTIFIER) || !boundedString(parsed.actorRole, 80) ||
      !canonicalInstant(parsed.approvedAt) || parsed.approvedAt !== row.createdAt) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  const stored = parsed as unknown as StoredScheduleApproval;
  if (!roleHasCapability(stored.actorRole, "phase0.pipeline.manage") ||
      canonicalJson(stored) !== row.payloadJson || fingerprintOf(stored) !== row.payloadFingerprint ||
      requestFingerprintForStored(stored) !== stored.requestFingerprint) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  return stored;
}

function approvalAuditDetails(
  row: Pick<ApprovalEventRow, "id" | "payloadFingerprint">,
  stored: StoredScheduleApproval,
): Record<string, unknown> {
  return {
    schema: SCHEDULE_APPROVAL_AUDIT_SCHEMA,
    capability: stored.capability,
    requestFingerprint: stored.requestFingerprint,
    idempotencyKey: stored.idempotencyKey,
    requestId: stored.requestId,
    approvalEventId: row.id,
    approvalPayloadFingerprint: row.payloadFingerprint,
    sourceScheduleAuditId: stored.sourceScheduleAuditId,
    sourceSchedulePointerFingerprint: stored.sourceSchedulePointerFingerprint,
    scheduleRevision: stored.scheduleRevision,
    scheduleAuthorityFingerprint: stored.scheduleAuthorityFingerprint,
    sourcePlanVersionId: stored.sourcePlanVersionId,
    sourcePlanFingerprint: stored.sourcePlanFingerprint,
    acceptedInventoryFingerprint: stored.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: stored.cfpSessionInventoryFingerprint,
    actorRole: stored.actorRole,
  };
}

function evidenceFromRow(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  row: ApprovalEventRow,
): ScheduleApprovalEvidence {
  const stored = storedApprovalFromRow(row, scope);
  const audits = db.prepare(
    `SELECT id, actor_kind AS actorKind, actor_ref AS actorRef, action,
            details_json AS detailsJson, created_at AS createdAt
       FROM audit_events
      WHERE workspace_id = ? AND target_type = 'event' AND target_id = ?
        AND action = 'schedule.approved'
        AND CASE WHEN json_valid(details_json)
                 THEN json_extract(details_json, '$.approvalEventId') ELSE NULL END = ?
      ORDER BY rowid
      LIMIT 2`,
  ).all(scope.workspaceId, scope.eventId, row.id) as unknown as Array<{
    id: string;
    actorKind: string;
    actorRef: string | null;
    action: string;
    detailsJson: string | null;
    createdAt: string;
  }>;
  const audit = audits[0];
  const expectedDetails = JSON.stringify(approvalAuditDetails(row, stored));
  let draftEvidence: ReturnType<typeof readScheduleDraftAuthorityEvidence> = null;
  try {
    draftEvidence = readScheduleDraftAuthorityEvidence(db, scope, stored.sourceScheduleAuditId);
  } catch {
    draftEvidence = null;
  }
  if (audits.length !== 1 || !audit || !boundedString(audit.id, 160, IDENTIFIER) ||
      audit.actorKind !== "account" || audit.actorRef !== stored.actorAccountId ||
      audit.action !== "schedule.approved" || audit.detailsJson !== expectedDetails ||
      !canonicalInstant(audit.createdAt) || Date.parse(audit.createdAt) < Date.parse(stored.approvedAt) ||
      !draftEvidence || draftEvidence.pointerFingerprint !== stored.sourceSchedulePointerFingerprint ||
      draftEvidence.pointer.revision !== stored.scheduleRevision ||
      draftEvidence.pointer.planVersionId !== stored.sourcePlanVersionId ||
      draftEvidence.pointer.planFingerprint !== stored.sourcePlanFingerprint ||
      draftEvidence.pointer.acceptedInventoryFingerprint !== stored.acceptedInventoryFingerprint ||
      draftEvidence.pointer.cfpSessionInventoryFingerprint !== stored.cfpSessionInventoryFingerprint ||
      canonicalJson(draftEvidence.pointer.cfpSessionAuthorities) !== canonicalJson(stored.cfpSessionAuthorities) ||
      fingerprintOf(scheduleApprovalSubject(draftEvidence.pointer)) !== stored.scheduleAuthorityFingerprint) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  }
  return Object.freeze({
    approvalEventId: row.id,
    approvalAuditId: audit.id,
    approvalFingerprint: row.payloadFingerprint,
    approvedAt: stored.approvedAt,
    approvedByAccountId: stored.actorAccountId,
    approvedByRole: stored.actorRole,
    capability: stored.capability,
    sourceScheduleAuditId: stored.sourceScheduleAuditId,
    sourceSchedulePointerFingerprint: stored.sourceSchedulePointerFingerprint,
    scheduleRevision: stored.scheduleRevision,
    scheduleAuthorityFingerprint: stored.scheduleAuthorityFingerprint,
    sourcePlanVersionId: stored.sourcePlanVersionId,
    sourcePlanFingerprint: stored.sourcePlanFingerprint,
    acceptedInventoryFingerprint: stored.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: stored.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: stored.cfpSessionAuthorities,
  });
}

export function scheduleApprovalSubject(pointer: ScheduleDraftPointer): Record<string, unknown> {
  return {
    schema: "schedule-approval-subject/v1",
    workspaceId: pointer.workspaceId,
    eventId: pointer.eventId,
    revision: pointer.revision,
    planVersionId: pointer.planVersionId,
    planFingerprint: pointer.planFingerprint,
    acceptedInventoryFingerprint: pointer.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: pointer.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: pointer.cfpSessionAuthorities,
    rooms: pointer.rooms,
    tracks: pointer.tracks,
    placements: pointer.placements,
  };
}

function evidenceMatchesSchedule(
  evidence: ScheduleApprovalEvidence,
  schedule: ScheduleSnapshot,
  pointer: ScheduleDraftPointer,
): boolean {
  return evidence.scheduleRevision === schedule.revision &&
    evidence.scheduleAuthorityFingerprint === fingerprintOf(scheduleApprovalSubject(pointer)) &&
    evidence.sourcePlanVersionId === schedule.planVersionId &&
    evidence.sourcePlanFingerprint === schedule.planFingerprint &&
    evidence.acceptedInventoryFingerprint === schedule.acceptedInventoryFingerprint &&
    evidence.cfpSessionInventoryFingerprint === schedule.cfpSessionInventoryFingerprint &&
    canonicalJson(evidence.cfpSessionAuthorities) === canonicalJson(schedule.cfpSessionAuthorities);
}

function allEvidence(
  db: Db,
  scope: { workspaceId: string; eventId: string },
): Array<{ row: ApprovalEventRow; stored: StoredScheduleApproval; evidence: ScheduleApprovalEvidence }> {
  const idempotencyKeys = new Set<string>();
  return approvalRows(db, scope).map((row) => {
    const stored = storedApprovalFromRow(row, scope);
    if (idempotencyKeys.has(stored.idempotencyKey)) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
    }
    idempotencyKeys.add(stored.idempotencyKey);
    return { row, stored, evidence: evidenceFromRow(db, scope, row) };
  });
}

export function readScheduleApprovalEvidence(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  approvalEventId: string,
): ScheduleApprovalEvidence | null {
  if (!boundedString(approvalEventId, 160, IDENTIFIER)) return null;
  const matches = allEvidence(db, scope).filter(({ row }) => row.id === approvalEventId);
  if (matches.length > 1) throw new ScheduleApprovalError("SCHEDULE_APPROVAL_CORRUPT");
  return matches[0]?.evidence ?? null;
}

export function readCurrentScheduleApproval(
  db: Db,
  scope: { workspaceId: string; eventId: string },
): ScheduleApprovalEvidence | null {
  const current = readScheduleDraft(db, scope);
  if (!current.persisted || !current.pointer) return null;
  return allEvidence(db, scope).find(({ evidence }) =>
    evidenceMatchesSchedule(evidence, current.schedule, current.pointer!)
  )?.evidence ?? null;
}

function approvalRequestFingerprint(
  scope: { workspaceId: string; eventId: string },
  input: Pick<ApproveScheduleInput, "expectedRevision" | "expectedScheduleAuthorityFingerprint" | "actorAccountId">,
  subject: {
    sourceScheduleAuditId: string;
    sourceSchedulePointerFingerprint: string;
    scheduleAuthorityFingerprint: string;
    sourcePlanVersionId: string;
    sourcePlanFingerprint: string;
    acceptedInventoryFingerprint: string;
    cfpSessionInventoryFingerprint: string;
    cfpSessionAuthorities: readonly CfpScheduleSessionAuthority[];
  },
): string {
  return fingerprintOf({
    schema: SCHEDULE_APPROVAL_EVENT_SCHEMA,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    expectedRevision: input.expectedRevision,
    expectedScheduleAuthorityFingerprint: input.expectedScheduleAuthorityFingerprint,
    sourceScheduleAuditId: subject.sourceScheduleAuditId,
    sourceSchedulePointerFingerprint: subject.sourceSchedulePointerFingerprint,
    scheduleAuthorityFingerprint: subject.scheduleAuthorityFingerprint,
    sourcePlanVersionId: subject.sourcePlanVersionId,
    sourcePlanFingerprint: subject.sourcePlanFingerprint,
    acceptedInventoryFingerprint: subject.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: subject.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: subject.cfpSessionAuthorities,
    actorAccountId: input.actorAccountId,
    capability: "phase0.pipeline.manage",
  });
}

function requestFingerprintForStored(stored: StoredScheduleApproval): string {
  return approvalRequestFingerprint(stored, {
    expectedRevision: stored.scheduleRevision,
    expectedScheduleAuthorityFingerprint: stored.scheduleAuthorityFingerprint,
    actorAccountId: stored.actorAccountId,
  }, stored);
}

function requestFingerprint(
  scope: { workspaceId: string; eventId: string },
  input: ApproveScheduleInput,
  schedule: ScheduleSnapshot,
  pointer: ScheduleDraftPointer,
  sourceScheduleAuditId: string,
  sourceSchedulePointerFingerprint: string,
): string {
  return approvalRequestFingerprint(scope, input, {
    sourceScheduleAuditId,
    sourceSchedulePointerFingerprint,
    scheduleAuthorityFingerprint: fingerprintOf(scheduleApprovalSubject(pointer)),
    sourcePlanVersionId: schedule.planVersionId,
    sourcePlanFingerprint: schedule.planFingerprint,
    acceptedInventoryFingerprint: schedule.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: schedule.cfpSessionInventoryFingerprint,
    cfpSessionAuthorities: schedule.cfpSessionAuthorities,
  });
}

export function approveScheduleDraft(
  db: Db,
  scope: { workspaceId: string; eventId: string },
  input: ApproveScheduleInput,
): ScheduleApprovalMutationResult {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !boundedString(input.expectedScheduleAuthorityFingerprint, 64, SHA256) ||
      !boundedString(input.idempotencyKey, 160, IDENTIFIER) ||
      !boundedString(input.requestId, 160, IDENTIFIER) ||
      !boundedString(input.actorAccountId, 160, IDENTIFIER)) {
    throw new ScheduleApprovalError("SCHEDULE_APPROVAL_INPUT_INVALID", "The schedule approval request is invalid.");
  }

  return withTransaction(db, () => {
    const event = getEvent(db, scope.workspaceId, scope.eventId);
    if (!event) throw new ScheduleApprovalError("SCHEDULE_APPROVAL_SCOPE_DENIED");
    if (!APPROVABLE_EVENT_LIFECYCLES.has(event.lifecycle)) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_EVENT_CLOSED", "The event schedule is closed to approval.");
    }
    const actor = db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, input.actorAccountId) as { role: string } | undefined;
    if (!actor || !roleHasCapability(actor.role, "phase0.pipeline.manage")) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_AUTHORITY_INVALID");
    }
    const existing = allEvidence(db, scope);
    const replay = existing.find(({ stored }) => stored.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.stored.scheduleRevision !== input.expectedRevision ||
          replay.stored.scheduleAuthorityFingerprint !== input.expectedScheduleAuthorityFingerprint ||
          replay.stored.actorAccountId !== input.actorAccountId ||
          replay.stored.requestFingerprint !== requestFingerprintForStored(replay.stored)) {
        throw new ScheduleApprovalError("SCHEDULE_APPROVAL_IDEMPOTENCY_CONFLICT", "The approval request key was already used.");
      }
      return { approval: replay.evidence, changed: false };
    }
    const current = readScheduleDraft(db, scope);
    if (!current.persisted || !current.pointer) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_DRAFT_NOT_PERSISTED");
    }
    const source = findScheduleDraftAuthorityEvidence(db, scope, current.pointer);
    if (!source) throw new ScheduleApprovalError("SCHEDULE_APPROVAL_DRAFT_AUTHORITY_INVALID");
    if (input.expectedRevision !== current.schedule.revision) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_REVISION_CONFLICT", "The schedule changed on the server.");
    }
    const currentAuthorityFingerprint = fingerprintOf(scheduleApprovalSubject(current.pointer));
    if (input.expectedScheduleAuthorityFingerprint !== currentAuthorityFingerprint) {
      throw new ScheduleApprovalError(
        "SCHEDULE_APPROVAL_CONTEXT_CONFLICT",
        "The exact schedule authority changed on the server.",
      );
    }
    if (current.schedule.sessions.length === 0 || current.schedule.sessions.some((session) => session.placement === null)) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_NOT_READY", "Every session needs an exact placement before approval.");
    }
    if (detectScheduleConflicts(current.schedule).length > 0) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_HAS_CONFLICTS", "Resolve every hard conflict before approval.");
    }
    if (!current.pointer.rooms || !current.pointer.tracks ||
        !scheduleAllocationsAreDurable(db, scope, current.schedule.sessions)) {
      throw new ScheduleApprovalError(
        "SCHEDULE_APPROVAL_NOT_DURABLE",
        "The exact schedule placements are not durably materialized.",
      );
    }

    const fingerprint = requestFingerprint(
      scope,
      input,
      current.schedule,
      current.pointer,
      source.auditEventId,
      source.pointerFingerprint,
    );
    const approvedAt = nowIso();
    const stored: StoredScheduleApproval = {
      schema: SCHEDULE_APPROVAL_EVENT_SCHEMA,
      requestFingerprint: fingerprint,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      sourceScheduleAuditId: source.auditEventId,
      sourceSchedulePointerFingerprint: source.pointerFingerprint,
      scheduleRevision: current.schedule.revision,
      scheduleAuthorityFingerprint: currentAuthorityFingerprint,
      sourcePlanVersionId: current.schedule.planVersionId,
      sourcePlanFingerprint: current.schedule.planFingerprint,
      acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
      cfpSessionAuthorities: current.schedule.cfpSessionAuthorities,
      actorAccountId: input.actorAccountId,
      actorRole: actor.role,
      capability: "phase0.pipeline.manage",
      approvedAt,
    };
    const payloadJson = canonicalJson(stored);
    if (Buffer.byteLength(payloadJson, "utf8") > 100_000) {
      throw new ScheduleApprovalError("SCHEDULE_APPROVAL_TOO_LARGE");
    }
    const row = {
      id: uuid(),
      payloadFingerprint: fingerprintOf(stored),
    };
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      scope.workspaceId,
      SCHEDULE_APPROVAL_EVENT_TYPE,
      SCHEDULE_APPROVAL_AGGREGATE_TYPE,
      scope.eventId,
      payloadJson,
      row.payloadFingerprint,
      approvedAt,
    );
    writeAudit(db, scope.workspaceId, {
      actorKind: "account",
      actorRef: input.actorAccountId,
      action: "schedule.approved",
      targetType: "event",
      targetId: scope.eventId,
      details: approvalAuditDetails(row, stored),
    });
    const inserted = approvalRows(db, scope).find((candidate) => candidate.id === row.id);
    if (!inserted) throw new ScheduleApprovalError("SCHEDULE_APPROVAL_WRITE_FAILED");
    return { approval: evidenceFromRow(db, scope, inserted), changed: true };
  });
}
