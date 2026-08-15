import { canonicalJson, fingerprintOf } from "../canonical";
import type { Db } from "../db";
import {
  createDurableContentOperationsRepository,
  evaluateContentPublicationGate,
  type ContentPublicationGate,
  type ContentPublicationRequirement,
} from "./content-operations";
import {
  acceptedInventoryFingerprint,
  cfpSessionAuthorities,
  cfpSessionInventoryFingerprint,
} from "./scheduling/canonical";
import {
  detectScheduleConflicts,
  scheduleContentFingerprint,
} from "./scheduling";
import {
  findScheduleDraftAuthorityEvidence,
  readScheduleDraft,
} from "./scheduling/persistence";
import { readCurrentScheduleApproval, scheduleApprovalSubject } from "./scheduling/approval";
import type {
  CfpScheduleSessionAuthority,
  ScheduleConflict,
  ScheduleSnapshot,
} from "./scheduling/types";
import { scheduleAllocationsAreDurable } from "./scheduling/durability";
import {
  readAcceptedCfpScheduleInventory,
  type AcceptedCfpScheduleInventoryEntry,
} from "./cfp/decisions";

export interface PublicationAcceptedSession {
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

export interface SealedScheduleSession {
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly slug: string;
  readonly title: string;
  readonly abstract: string;
  readonly titleVersionId: string | null;
  readonly titleContentHash: string | null;
  readonly abstractVersionId: string | null;
  readonly abstractContentHash: string | null;
  readonly durationMinutes: number;
  readonly capacity: number;
  readonly speakerPersonIds: readonly string[];
  readonly placement: {
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
}

interface SealedScheduleProjectionBase {
  readonly revision: number;
  readonly sourcePlanVersionId: string;
  readonly sourcePlanFingerprint: string;
  readonly sourceScheduleAuditId: string | null;
  readonly sourceSchedulePointerFingerprint: string | null;
  readonly acceptedInventoryFingerprint: string;
  readonly cfpSessionInventoryFingerprint: string;
  readonly cfpSessionAuthorities: readonly CfpScheduleSessionAuthority[];
  readonly scheduleFingerprint: string;
  readonly contentGateFingerprint: string;
  readonly sessions: readonly SealedScheduleSession[];
}

/** Retained immutable releases sealed before durable schedule approval existed. */
export interface SealedScheduleProjectionV1 extends SealedScheduleProjectionBase {
  readonly schema: "publication-schedule/v1";
}

/** New releases bind the exact immutable organizer approval for the persisted schedule draft. */
export interface SealedScheduleProjectionV2 extends SealedScheduleProjectionBase {
  readonly schema: "publication-schedule/v2";
  readonly sourceScheduleApprovalId: string;
  readonly sourceScheduleApprovalAuditId: string;
  readonly sourceScheduleApprovalFingerprint: string;
}

export type SealedScheduleProjection = SealedScheduleProjectionV1 | SealedScheduleProjectionV2;

interface StoredSessionTask {
  readonly id: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly kind: "SESSION_TITLE" | "SESSION_DESCRIPTION";
  readonly title: string;
  readonly required: boolean;
  readonly gate: string | null;
  readonly owner: string;
}

interface StoredSessionTaskEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
}

interface StoredPlanAssignment {
  readonly personId: string;
  readonly programUnitId: string;
  readonly assignmentId: string;
}

interface PublicationScheduleScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly planVersionId: string;
  readonly planFingerprint: string;
  readonly acceptedInventoryFingerprint: string;
  readonly accepted: readonly PublicationAcceptedSession[];
}

interface SessionContentRequirementPair {
  readonly personId: string;
  readonly assignmentId: string;
  readonly titleRequirementId: string;
  readonly descriptionRequirementId: string;
}

interface StoredCurrentContentVersion {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

export function hasSelectedScheduleConflict(
  conflicts: readonly Pick<ScheduleConflict, "sessionIds">[],
  selectedSessionIds: ReadonlySet<string>,
): boolean {
  return conflicts.some((conflict) => conflict.sessionIds.some((sessionId) => selectedSessionIds.has(sessionId)));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
}

function safeText(value: unknown, maximum = 240): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

function taskDefinition(value: unknown, workspaceId: string, eventId: string): StoredSessionTask | null {
  if (!record(value) || value.schema !== "sympose-speaker-operation/v1" || value.workspaceId !== workspaceId || value.eventId !== eventId || !record(value.task)) return null;
  const task = value.task;
  if (
    !safeId(task.id) ||
    !safeId(task.personId) ||
    !safeId(task.assignmentId) ||
    (task.contentKind !== "SESSION_TITLE" && task.contentKind !== "SESSION_DESCRIPTION") ||
    !safeText(task.title) ||
    typeof task.required !== "boolean" ||
    (task.gate !== null && task.gate !== "PUBLICATION") ||
    task.owner !== "SPEAKER"
  ) return null;
  return {
    id: task.id,
    personId: task.personId,
    assignmentId: task.assignmentId,
    kind: task.contentKind,
    title: task.title,
    required: task.required,
    gate: task.gate,
    owner: task.owner,
  };
}

function readSessionTasks(db: Db, scope: PublicationScheduleScope): StoredSessionTask[] {
  const rows = db.prepare(
    `SELECT event_type AS eventType, aggregate_id AS aggregateId,
            payload_json AS payloadJson,
            payload_fingerprint AS payloadFingerprint
       FROM domain_events
      WHERE workspace_id = ?
        AND aggregate_type = 'speaker_task'
        AND event_type IN ('speaker.task.created', 'speaker.task.updated')
      ORDER BY created_at, rowid`,
  ).all(scope.workspaceId) as unknown as StoredSessionTaskEvent[];
  const byTask = new Map<string, StoredSessionTask>();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      throw new Error("SESSION_CONTENT_TASK_INVALID");
    }
    if (canonicalJson(payload) !== row.payloadJson || fingerprintOf(payload) !== row.payloadFingerprint) {
      throw new Error("SESSION_CONTENT_TASK_INVALID");
    }
    const operationMatches =
      (row.eventType === "speaker.task.created" && payload && record(payload) && payload.operation === "create-task") ||
      (row.eventType === "speaker.task.updated" && payload && record(payload) && (payload.operation === "update-task" || payload.operation === "complete-task"));
    if (!operationMatches) throw new Error("SESSION_CONTENT_TASK_INVALID");
    if (!record(payload) || payload.operation !== "create-task" && payload.operation !== "update-task" && payload.operation !== "complete-task") continue;
    if (payload.workspaceId !== scope.workspaceId || payload.eventId !== scope.eventId) continue;
    if (record(payload.task) &&
        payload.task.contentKind !== "SESSION_TITLE" &&
        payload.task.contentKind !== "SESSION_DESCRIPTION") continue;
    const task = taskDefinition(payload, scope.workspaceId, scope.eventId);
    if (!task) throw new Error("SESSION_CONTENT_TASK_INVALID");
    if (row.aggregateId !== task.id) throw new Error("SESSION_CONTENT_TASK_INVALID");
    const prior = byTask.get(task.id);
    if (prior && (
      prior.personId !== task.personId ||
      prior.assignmentId !== task.assignmentId ||
      prior.kind !== task.kind ||
      prior.title !== task.title ||
      prior.required !== task.required ||
      prior.gate !== task.gate ||
      prior.owner !== task.owner
    )) throw new Error("SESSION_CONTENT_TASK_INVALID");
    byTask.set(task.id, task);
  }
  return [...byTask.values()].filter((task) => task.required && task.gate === "PUBLICATION");
}

function readAssignments(db: Db, scope: PublicationScheduleScope): StoredPlanAssignment[] {
  return db.prepare(
    `SELECT id AS assignmentId, person_id AS personId, program_unit_id AS programUnitId
       FROM plan_assignments
      WHERE workspace_id = ? AND plan_version_id = ?
      ORDER BY person_id, program_unit_id, id`,
  ).all(scope.workspaceId, scope.planVersionId) as unknown as StoredPlanAssignment[];
}

function readCurrentContentVersion(
  db: Db,
  scope: PublicationScheduleScope,
  item: ContentPublicationGate["items"][number],
): StoredCurrentContentVersion {
  if (item.currentVersionId === null || item.currentContentHash === null) {
    throw new Error("SESSION_CONTENT_NOT_APPROVED");
  }
  const rows = db.prepare(
    `SELECT payload_json AS payloadJson,
            payload_fingerprint AS payloadFingerprint
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = 'speaker.content.version.submitted'
        AND aggregate_id = ?
      ORDER BY created_at, rowid`,
  ).all(scope.workspaceId, item.requirement.taskId) as unknown as Array<{ payloadJson: string; payloadFingerprint: string }>;
  const matches: StoredCurrentContentVersion[] = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    if (canonicalJson(payload) !== row.payloadJson || fingerprintOf(payload) !== row.payloadFingerprint) {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    if (!record(payload) || payload.schema !== "sympose-content-operation/v1" || payload.operation !== "submit-version" || payload.eventId !== scope.eventId || payload.personId !== item.requirement.personId || payload.taskId !== item.requirement.taskId || payload.kind !== item.requirement.kind || !record(payload.version)) {
      continue;
    }
    const version = payload.version;
    if (
      typeof version.id !== "string" ||
      typeof version.version !== "number" ||
      !Number.isSafeInteger(version.version) ||
      version.version < 1 ||
      typeof version.contentHash !== "string"
    ) {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    if (version.id === item.currentVersionId) {
      matches.push({ id: version.id, version: version.version, contentHash: version.contentHash });
    }
  }
  if (matches.length !== 1 || matches[0]!.contentHash !== item.currentContentHash) {
    throw new Error("SESSION_CONTENT_NOT_APPROVED");
  }
  return matches[0]!;
}

function currentPublicationApprovalCount(
  db: Db,
  scope: PublicationScheduleScope,
  item: ContentPublicationGate["items"][number],
): number {
  if (item.currentVersionId === null || item.currentContentHash === null) {
    throw new Error("SESSION_CONTENT_NOT_APPROVED");
  }
  const rows = db.prepare(
    `SELECT payload_json AS payloadJson,
            payload_fingerprint AS payloadFingerprint
       FROM domain_events
      WHERE workspace_id = ?
        AND event_type = 'speaker.content.approved'
        AND aggregate_id = ?
      ORDER BY created_at, rowid`,
  ).all(scope.workspaceId, item.requirement.taskId) as unknown as Array<{ payloadJson: string; payloadFingerprint: string }>;
  let count = 0;
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    if (canonicalJson(payload) !== row.payloadJson || fingerprintOf(payload) !== row.payloadFingerprint) {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    if (!record(payload) || payload.schema !== "sympose-content-operation/v2" || payload.operation !== "approve" || payload.eventId !== scope.eventId || payload.personId !== item.requirement.personId || payload.taskId !== item.requirement.taskId || payload.kind !== item.requirement.kind || !record(payload.record)) {
      continue;
    }
    const approval = payload.record;
    if (
      approval.gate === "PUBLICATION" &&
      approval.submissionVersionId === item.currentVersionId &&
      approval.submissionContentHash === item.currentContentHash
    ) {
      count += 1;
    }
  }
  return count;
}

function contentGateForSchedule(
  db: Db,
  scope: PublicationScheduleScope,
  schedule: ScheduleSnapshot,
  assignments: readonly StoredPlanAssignment[],
  cfpInventory: readonly AcceptedCfpScheduleInventoryEntry[],
): {
  readonly gate: ContentPublicationGate | null;
  readonly fingerprint: string;
  readonly byUnit: ReadonlyMap<string, { readonly title: ContentPublicationGate["items"][number]; readonly description: ContentPublicationGate["items"][number] }>;
} {
  const cfpFingerprint = cfpSessionInventoryFingerprint(cfpInventory);
  if (scope.accepted.length === 0) {
    return {
      gate: null,
      fingerprint: fingerprintOf({
        schema: "publication-schedule-content-authority/v1",
        approvedContentGateFingerprint: null,
        cfpSessionInventoryFingerprint: cfpFingerprint,
      }),
      byUnit: new Map(),
    };
  }
  const tasks = readSessionTasks(db, scope);
  if (tasks.length === 0) throw new Error("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE");
  const assignmentsByPersonUnit = new Map<string, StoredPlanAssignment[]>();
  for (const assignment of assignments) {
    const key = `${assignment.personId}:${assignment.programUnitId}`;
    const rows = assignmentsByPersonUnit.get(key) ?? [];
    rows.push(assignment);
    assignmentsByPersonUnit.set(key, rows);
  }
  const requirements: ContentPublicationRequirement[] = [];
  const requirementUnit = new Map<string, SessionContentRequirementPair[]>();
  for (const accepted of scope.accepted) {
    const matchingAssignments = assignmentsByPersonUnit.get(`${accepted.personId}:${accepted.programUnitId}`) ?? [];
    if (matchingAssignments.length !== 1) throw new Error("SESSION_CONTENT_ASSIGNMENT_INVALID");
    const assignmentId = matchingAssignments[0]!.assignmentId;
    const matching = tasks.filter((task) => task.personId === accepted.personId && task.assignmentId === assignmentId);
    const titleTasks = matching.filter((task) => task.kind === "SESSION_TITLE");
    const descriptionTasks = matching.filter((task) => task.kind === "SESSION_DESCRIPTION");
    const title = titleTasks.length === 1 ? titleTasks[0] : undefined;
    const description = descriptionTasks.length === 1 ? descriptionTasks[0] : undefined;
    if (!title || !description) throw new Error("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE");
    for (const task of [title, description]) {
      requirements.push({
        id: task.id,
        label: `${accepted.programUnitName} ${task.kind === "SESSION_TITLE" ? "title" : "description"}`,
        personId: task.personId,
        taskId: task.id,
        kind: task.kind,
        required: true,
      });
    }
    const current = requirementUnit.get(accepted.programUnitId) ?? [];
    current.push({
      personId: accepted.personId,
      assignmentId,
      titleRequirementId: title.id,
      descriptionRequirementId: description.id,
    });
    requirementUnit.set(accepted.programUnitId, current);
  }
  const gate = evaluateContentPublicationGate(
    createDurableContentOperationsRepository(db),
    { workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: "publication-schedule", actorKind: "organizer" },
    requirements,
  );
  if (gate.state !== "READY") throw new Error("SESSION_CONTENT_NOT_APPROVED");
  const byUnit = new Map<string, { title: ContentPublicationGate["items"][number]; description: ContentPublicationGate["items"][number] }>();
  for (const session of schedule.sessions) {
    const requirementPairs = requirementUnit.get(session.id);
    if (!requirementPairs || requirementPairs.length === 0) continue;
    const resolvedPairs = requirementPairs.map((requirementPair) => {
      const title = gate.items.find((item) => item.requirement.id === requirementPair.titleRequirementId);
      const description = gate.items.find((item) => item.requirement.id === requirementPair.descriptionRequirementId);
      const titleTask = tasks.find((task) => task.id === requirementPair.titleRequirementId);
      const descriptionTask = tasks.find((task) => task.id === requirementPair.descriptionRequirementId);
      if (
        !title || !description ||
        !titleTask || !descriptionTask ||
        titleTask.personId !== requirementPair.personId || titleTask.assignmentId !== requirementPair.assignmentId || titleTask.kind !== "SESSION_TITLE" ||
        descriptionTask.personId !== requirementPair.personId || descriptionTask.assignmentId !== requirementPair.assignmentId || descriptionTask.kind !== "SESSION_DESCRIPTION" ||
        title.requirement.personId !== requirementPair.personId ||
        title.requirement.taskId !== requirementPair.titleRequirementId ||
        title.requirement.kind !== "SESSION_TITLE" ||
        description.requirement.personId !== requirementPair.personId ||
        description.requirement.taskId !== requirementPair.descriptionRequirementId ||
        description.requirement.kind !== "SESSION_DESCRIPTION" ||
        title.status !== "APPROVED" || description.status !== "APPROVED" ||
        title.currentVersionId === null || title.currentContentHash === null ||
        title.approvedVersionId !== title.currentVersionId || title.approvedContentHash !== title.currentContentHash ||
        description.currentVersionId === null || description.currentContentHash === null ||
        description.approvedVersionId !== description.currentVersionId || description.approvedContentHash !== description.currentContentHash ||
        currentPublicationApprovalCount(db, scope, title) !== 1 ||
        currentPublicationApprovalCount(db, scope, description) !== 1
      ) {
        throw new Error("SESSION_CONTENT_NOT_APPROVED");
      }
      return { title, description };
    });
    const titleKeys = new Set(resolvedPairs.map(({ title }) => {
      const version = readCurrentContentVersion(db, scope, title);
      return `${version.version}\u0000${version.contentHash}`;
    }));
    const descriptionKeys = new Set(resolvedPairs.map(({ description }) => {
      const version = readCurrentContentVersion(db, scope, description);
      return `${version.version}\u0000${version.contentHash}`;
    }));
    const pairKeys = new Set(resolvedPairs.map(({ title, description }) =>
      `${readCurrentContentVersion(db, scope, title).version}\u0000${title.currentContentHash}\u0000${readCurrentContentVersion(db, scope, description).version}\u0000${description.currentContentHash}`,
    ));
    if (titleKeys.size !== 1 || descriptionKeys.size !== 1 || pairKeys.size !== 1) {
      throw new Error("SESSION_CONTENT_NOT_APPROVED");
    }
    const canonical = resolvedPairs[0]!;
    byUnit.set(session.id, canonical);
  }
  const acceptedUnitIds = new Set(scope.accepted.map((accepted) => accepted.programUnitId));
  if (byUnit.size !== acceptedUnitIds.size) throw new Error("SESSION_CONTENT_GATE_INVALID");
  return {
    gate,
    fingerprint: fingerprintOf({
      schema: "publication-schedule-content-authority/v1",
      approvedContentGateFingerprint: gate.fingerprint,
      cfpSessionInventoryFingerprint: cfpFingerprint,
    }),
    byUnit,
  };
}

function contentValue(item: ContentPublicationGate["items"][number], kind: "SESSION_TITLE" | "SESSION_DESCRIPTION"): string {
  const payload = item.approvedPayload;
  if (kind === "SESSION_TITLE" && payload?.kind === "SESSION_TITLE") return payload.title;
  if (kind === "SESSION_DESCRIPTION" && payload?.kind === "SESSION_DESCRIPTION") return payload.description;
  throw new Error("SESSION_CONTENT_PAYLOAD_INVALID");
}

export function buildSealedScheduleProjection(
  db: Db,
  scope: PublicationScheduleScope,
): SealedScheduleProjectionV2 {
  const read = readScheduleDraft(db, { workspaceId: scope.workspaceId, eventId: scope.eventId });
  if (read.schedule.planVersionId !== scope.planVersionId || read.schedule.planFingerprint !== scope.planFingerprint) {
    throw new Error("SCHEDULE_PLAN_MISMATCH");
  }
  if (read.schedule.acceptedInventoryFingerprint !== scope.acceptedInventoryFingerprint ||
      acceptedInventoryFingerprint(scope.accepted) !== scope.acceptedInventoryFingerprint) {
    throw new Error("SCHEDULE_INVENTORY_MISMATCH");
  }
  const cfpInventory = readAcceptedCfpScheduleInventory(db, {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
  });
  const cfpFingerprint = cfpSessionInventoryFingerprint(cfpInventory);
  const cfpAuthorities = cfpSessionAuthorities(cfpInventory);
  if (
    read.schedule.cfpSessionInventoryFingerprint !== cfpFingerprint ||
    canonicalJson(read.schedule.cfpSessionAuthorities) !== canonicalJson(cfpAuthorities)
  ) {
    throw new Error("SCHEDULE_CFP_INVENTORY_MISMATCH");
  }
  const acceptedUnitIds = new Set(scope.accepted.map((accepted) => accepted.programUnitId));
  const cfpUnitIds = new Set(cfpInventory.map((entry) => entry.programUnitId));
  const exactUnitIds = new Set([...acceptedUnitIds, ...cfpUnitIds]);
  const selected = read.schedule.sessions;
  if (
    selected.length === 0 ||
    selected.length !== exactUnitIds.size ||
    selected.some((session) => !exactUnitIds.has(session.id))
  ) {
    throw new Error("SCHEDULE_NOT_READY");
  }
  const scheduleAuthority = read.persisted && read.pointer
    ? findScheduleDraftAuthorityEvidence(
        db,
        { workspaceId: scope.workspaceId, eventId: scope.eventId },
        read.pointer,
      )
    : null;
  if (!scheduleAuthority) throw new Error("SCHEDULE_POINTER_NOT_PERSISTED");
  if (scheduleAuthority && (
    scheduleAuthority.pointer.planVersionId !== scope.planVersionId ||
    scheduleAuthority.pointer.planFingerprint !== scope.planFingerprint ||
    scheduleAuthority.pointer.acceptedInventoryFingerprint !== scope.acceptedInventoryFingerprint ||
    scheduleAuthority.pointer.cfpSessionInventoryFingerprint !== cfpFingerprint ||
    canonicalJson(scheduleAuthority.pointer.cfpSessionAuthorities) !== canonicalJson(cfpAuthorities)
  )) {
    throw new Error("SCHEDULE_POINTER_AUTHORITY_MISMATCH");
  }
  const scheduleApproval = readCurrentScheduleApproval(db, {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
  });
  if (!scheduleApproval) throw new Error("SCHEDULE_NOT_APPROVED");
  if (
    scheduleApproval.scheduleRevision !== read.schedule.revision ||
    scheduleApproval.scheduleAuthorityFingerprint !== fingerprintOf(scheduleApprovalSubject(read.pointer!)) ||
    scheduleApproval.sourcePlanVersionId !== scope.planVersionId ||
    scheduleApproval.sourcePlanFingerprint !== scope.planFingerprint ||
    scheduleApproval.acceptedInventoryFingerprint !== scope.acceptedInventoryFingerprint ||
    scheduleApproval.cfpSessionInventoryFingerprint !== cfpFingerprint ||
    canonicalJson(scheduleApproval.cfpSessionAuthorities) !== canonicalJson(cfpAuthorities)
  ) {
    throw new Error("SCHEDULE_APPROVAL_AUTHORITY_MISMATCH");
  }
  if (selected.some((session) => session.placement === null)) throw new Error("SCHEDULE_NOT_READY");
  if (!scheduleAllocationsAreDurable(db, scope, selected)) throw new Error("SCHEDULE_NOT_DURABLE");
  const selectedIds = new Set(selected.map((session) => session.id));
  if (hasSelectedScheduleConflict(detectScheduleConflicts(read.schedule), selectedIds)) {
    throw new Error("SCHEDULE_HAS_CONFLICTS");
  }
  const content = contentGateForSchedule(
    db,
    scope,
    read.schedule,
    readAssignments(db, scope),
    cfpInventory,
  );
  const acceptedByUnit = new Map<string, string[]>();
  const acceptedNameByUnit = new Map<string, string>();
  const acceptedTimesByUnit = new Map<string, { startsAt: string; endsAt: string }>();
  for (const accepted of scope.accepted) {
    const people = acceptedByUnit.get(accepted.programUnitId) ?? [];
    if (!people.includes(accepted.personId)) people.push(accepted.personId);
    acceptedByUnit.set(accepted.programUnitId, people);
    const priorName = acceptedNameByUnit.get(accepted.programUnitId);
    if (priorName !== undefined && priorName !== accepted.programUnitName) throw new Error("SCHEDULE_PLAN_MISMATCH");
    acceptedNameByUnit.set(accepted.programUnitId, accepted.programUnitName);
    const priorTimes = acceptedTimesByUnit.get(accepted.programUnitId);
    if (priorTimes && (priorTimes.startsAt !== accepted.startsAt || priorTimes.endsAt !== accepted.endsAt)) {
      throw new Error("SCHEDULE_COMMITMENT_MISMATCH");
    }
    acceptedTimesByUnit.set(accepted.programUnitId, { startsAt: accepted.startsAt, endsAt: accepted.endsAt });
  }
  const cfpByUnit = new Map(cfpInventory.map((entry) => [entry.programUnitId, entry]));
  const sessions = selected.map((session) => {
    const placement = session.placement!;
    const acceptedTimes = acceptedTimesByUnit.get(session.id);
    const cfp = cfpByUnit.get(session.id);
    if (acceptedUnitIds.has(session.id) && !cfp && acceptedNameByUnit.get(session.id) !== session.title) {
      throw new Error("SCHEDULE_PLAN_MISMATCH");
    }
    if (acceptedTimes &&
        (placement.startsAt !== acceptedTimes.startsAt || placement.endsAt !== acceptedTimes.endsAt)) {
      throw new Error("SCHEDULE_COMMITMENT_MISMATCH");
    }
    if (cfp && (
      cfp.programUnitName !== session.title ||
      (cfp.abstract ?? "") !== session.abstract ||
      cfp.durationMinutes !== session.durationMinutes ||
      cfp.capacity !== session.capacity ||
      cfp.trackId !== session.trackId
    )) {
      throw new Error("SCHEDULE_CFP_SESSION_MISMATCH");
    }
    const room = read.schedule.rooms.find((candidate) => candidate.id === placement.roomId);
    const track = read.schedule.tracks.find((candidate) => candidate.id === placement.trackId);
    if (!room || !track) throw new Error("SCHEDULE_RESOURCE_INVALID");
    const exact = content.byUnit.get(session.id);
    if (!exact) throw new Error("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE");
    const speakerPersonIds = new Set(acceptedByUnit.get(session.id) ?? []);
    for (const link of cfp?.links ?? []) speakerPersonIds.add(link.speakerPersonId);
    return {
      programUnitId: session.id,
      programUnitName: acceptedNameByUnit.get(session.id) ?? session.title,
      slug: session.slug,
      title: contentValue(exact.title, "SESSION_TITLE"),
      abstract: contentValue(exact.description, "SESSION_DESCRIPTION"),
      titleVersionId: exact.title.currentVersionId,
      titleContentHash: exact.title.currentContentHash,
      abstractVersionId: exact.description.currentVersionId,
      abstractContentHash: exact.description.currentContentHash,
      durationMinutes: session.durationMinutes,
      capacity: session.capacity,
      speakerPersonIds: [...speakerPersonIds].sort(),
      placement: {
        dayId: placement.dayId,
        timeSlotId: placement.timeSlotId,
        roomId: room.id,
        roomName: room.name,
        venue: room.venue,
        trackId: track.id,
        trackName: track.name,
        startsAt: placement.startsAt,
        endsAt: placement.endsAt,
      },
    } satisfies SealedScheduleSession;
  }).sort((first, second) => first.programUnitId.localeCompare(second.programUnitId));
  return Object.freeze({
    schema: "publication-schedule/v2",
    revision: read.schedule.revision,
    sourcePlanVersionId: scope.planVersionId,
    sourcePlanFingerprint: scope.planFingerprint,
    sourceScheduleAuditId: scheduleApproval.sourceScheduleAuditId,
    sourceSchedulePointerFingerprint: scheduleApproval.sourceSchedulePointerFingerprint,
    sourceScheduleApprovalId: scheduleApproval.approvalEventId,
    sourceScheduleApprovalAuditId: scheduleApproval.approvalAuditId,
    sourceScheduleApprovalFingerprint: scheduleApproval.approvalFingerprint,
    acceptedInventoryFingerprint: scope.acceptedInventoryFingerprint,
    cfpSessionInventoryFingerprint: cfpFingerprint,
    cfpSessionAuthorities: cfpAuthorities,
    scheduleFingerprint: scheduleApproval.scheduleAuthorityFingerprint,
    contentGateFingerprint: content.fingerprint,
    sessions,
  });
}
