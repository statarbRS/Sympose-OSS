import type { Db } from "../db";
import { fingerprintOf } from "../canonical";
import { roleHasCapability } from "../auth";
import { candidatePlanVersion, currentPlanVersion, planDetail } from "./planning";
import { latestSnapshot } from "./cohorts";
import {
  assertCanonicalPlanVersionContent,
  listPortalTokens,
  validatePublicReleaseForRead,
} from "./publication";
import { listOffers } from "./commitments";
import { listObservations } from "./outcomes";
import { listEvents, getEvent, type EventRow } from "./events";
import {
  EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST,
  EVALUATOR_REVIEWER_LOGIN_ALLOWLIST,
  type EvaluatorLoginAccount,
} from "../evaluator-login-accounts";
import { requireRuntimeDataMode } from "../runtime-mode";

export interface LoginChoice {
  accountId: string;
  email: string;
  displayName: string;
  role: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

function matchesEvaluatorLoginAccount(
  account: Readonly<{
    accountId: string;
    workspaceId: string;
    role: string;
    email: string;
  }>,
  expected: EvaluatorLoginAccount,
): boolean {
  return (
    account.accountId === expected.accountId &&
    account.workspaceId === expected.workspaceId &&
    account.role === expected.role &&
    account.email === expected.email
  );
}

export function listLoginChoices(db: Db): LoginChoice[] {
  if (requireRuntimeDataMode() !== "synthetic-evaluator") return [];
  const accountIds = EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST.map((account) => account.accountId);
  const accounts = db
    .prepare(
      `SELECT a.id AS accountId, a.email, a.display_name AS displayName, a.role,
              a.workspace_id AS workspaceId, w.slug AS workspaceSlug, w.name AS workspaceName
       FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id IN (${accountIds.map(() => "?").join(", ")})
       ORDER BY w.slug, a.email`,
    )
    .all(...accountIds) as unknown as LoginChoice[];
  return accounts.filter((account) =>
    EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST.some((expected) =>
      matchesEvaluatorLoginAccount(account, expected),
    ) && roleHasCapability(account.role, "phase0.pipeline.manage"),
  );
}

export interface SyntheticReviewerChoice {
  accountId: string;
  displayName: string;
  workspaceSlug: string;
  workspaceName: string;
}

/** Root-route choices are deliberately limited to repository-owned synthetic reviewer accounts. */
export function listSyntheticReviewerChoices(db: Db): SyntheticReviewerChoice[] {
  if (requireRuntimeDataMode() !== "synthetic-evaluator") return [];
  const accountIds = EVALUATOR_REVIEWER_LOGIN_ALLOWLIST.map((account) => account.accountId);
  const accounts = db
    .prepare(
      `SELECT a.id AS accountId, a.display_name AS displayName,
              a.email, a.role, a.workspace_id AS workspaceId,
              w.slug AS workspaceSlug, w.name AS workspaceName
       FROM accounts a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id IN (${accountIds.map(() => "?").join(", ")})
       ORDER BY w.slug, a.display_name`,
    )
    .all(...accountIds) as unknown as Array<SyntheticReviewerChoice & EvaluatorLoginAccount>;
  return accounts
    .filter((account) =>
      EVALUATOR_REVIEWER_LOGIN_ALLOWLIST.some((expected) =>
        matchesEvaluatorLoginAccount(account, expected),
      ) && roleHasCapability(account.role, "cfp.review"),
    )
    .map(({ accountId, displayName, workspaceSlug, workspaceName }) => ({
      accountId,
      displayName,
      workspaceSlug,
      workspaceName,
    }));
}

export function getWorkspaceBySlug(db: Db, slug: string): { id: string; slug: string; name: string } | null {
  const row = db.prepare("SELECT id, slug, name FROM workspaces WHERE slug = ?").get(slug) as
    | { id: string; slug: string; name: string }
    | undefined;
  return row ?? null;
}

export interface PersonSummary {
  id: string;
  canonicalEmail: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  sourceCount: number;
}

export function listPeople(db: Db, workspaceId: string): PersonSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.canonical_email AS canonicalEmail, p.full_name AS fullName,
              p.organization, p.title,
              (SELECT COUNT(*) FROM source_links l
               WHERE l.person_id = p.id AND l.workspace_id = p.workspace_id) AS sourceCount
       FROM people p WHERE p.workspace_id = ? ORDER BY p.full_name`,
    )
    .all(workspaceId) as unknown as PersonSummary[];
  return rows;
}

export interface SourceRecordView {
  id: string;
  provider: string;
  sourceRef: string;
  version: number;
  payload: Record<string, unknown>;
  importedAt: string;
  linkDecision: string | null;
}

export type TruthLayer = "candidate" | "decision" | "commitment" | "operational";
export type ProjectionKind = "proposed-assignment" | "publication";

export interface TruthLedgerEntry {
  kind: "truth" | "projection";
  layer: TruthLayer | null;
  projection: ProjectionKind | null;
  title: string;
  detail: string;
  fingerprint: string | null;
  occurredAt: string;
}

export interface PersonDetail {
  person: PersonSummary;
  sources: SourceRecordView[];
  ledgers: TruthLedgerEntry[];
}

export function getPersonDetail(db: Db, workspaceId: string, personId: string): PersonDetail | null {
  const person = db
    .prepare(
      `SELECT p.id, p.canonical_email AS canonicalEmail, p.full_name AS fullName,
              p.organization, p.title,
              (SELECT COUNT(*) FROM source_links l
               WHERE l.person_id = p.id AND l.workspace_id = p.workspace_id) AS sourceCount
       FROM people p WHERE p.workspace_id = ? AND p.id = ?`,
    )
    .get(workspaceId, personId) as PersonSummary | undefined;
  if (!person) {
    return null;
  }

  const sources = db
    .prepare(
      `SELECT r.id, r.provider, r.source_ref AS sourceRef, r.version, r.payload_json AS payloadJson,
              r.imported_at AS importedAt, l.link_decision AS linkDecision
       FROM source_links l
       JOIN source_records r
         ON r.id = l.source_record_id AND r.workspace_id = l.workspace_id
       WHERE l.workspace_id = ? AND l.person_id = ? ORDER BY r.source_ref`,
    )
    .all(workspaceId, personId) as {
    id: string;
    provider: string;
    sourceRef: string;
    version: number;
    payloadJson: string;
    importedAt: string;
    linkDecision: string | null;
  }[];

  const sourceViews: SourceRecordView[] = sources.map((s) => ({
    id: s.id,
    provider: s.provider,
    sourceRef: s.sourceRef,
    version: s.version,
    payload: JSON.parse(s.payloadJson) as Record<string, unknown>,
    importedAt: s.importedAt,
    linkDecision: s.linkDecision,
  }));

  const ledgers: TruthLedgerEntry[] = [];

  const membership = db
    .prepare(
      `SELECT m.rank, m.why_in AS whyIn, s.fingerprint, s.created_at AS createdAt
       FROM cohort_snapshot_members m
       JOIN cohort_snapshots s ON s.id = m.snapshot_id AND s.workspace_id = m.workspace_id
       WHERE m.workspace_id = ? AND m.person_id = ? ORDER BY s.created_at`,
    )
    .all(workspaceId, personId) as { rank: number; whyIn: string; fingerprint: string; createdAt: string }[];
  for (const row of membership) {
    ledgers.push({
      kind: "truth",
      layer: "candidate",
      projection: null,
      title: `Qualified in cohort snapshot (rank ${row.rank})`,
      detail: row.whyIn,
      fingerprint: row.fingerprint,
      occurredAt: row.createdAt,
    });
  }

  const assignments = db
    .prepare(
      `SELECT pa.assignment_type AS assignmentType, pa.explanation, pa.is_pinned AS isPinned,
              pu.name AS programUnitName, pv.version_number AS planVersionNumber, pv.fingerprint,
              pv.created_at AS createdAt
       FROM plan_assignments pa
       JOIN program_units pu
         ON pu.id = pa.program_unit_id AND pu.workspace_id = pa.workspace_id
       JOIN plan_versions pv
         ON pv.id = pa.plan_version_id AND pv.workspace_id = pa.workspace_id
       WHERE pa.workspace_id = ? AND pa.person_id = ?
       ORDER BY pv.version_number, pu.name`,
    )
    .all(workspaceId, personId) as {
    assignmentType: string;
    explanation: string;
    isPinned: number;
    programUnitName: string;
    planVersionNumber: number;
    fingerprint: string;
    createdAt: string;
  }[];
  for (const row of assignments) {
    ledgers.push({
      kind: "projection",
      layer: null,
      projection: "proposed-assignment",
      title: `Candidate assignment to "${row.programUnitName}" as ${row.assignmentType} in plan v${row.planVersionNumber}`,
      detail: row.explanation,
      fingerprint: row.fingerprint,
      occurredAt: row.createdAt,
    });
  }

  const approvals = db
    .prepare(
      `SELECT a.created_at AS createdAt, pv.version_number AS planVersionNumber,
              pv.fingerprint, pu.name AS programUnitName, pa.assignment_type AS assignmentType
       FROM approvals a
       JOIN plan_versions pv
         ON pv.id = a.plan_version_id AND pv.workspace_id = a.workspace_id
       JOIN plan_assignments pa
         ON pa.plan_version_id = pv.id AND pa.workspace_id = pv.workspace_id
       JOIN program_units pu
         ON pu.id = pa.program_unit_id AND pu.workspace_id = pa.workspace_id
       WHERE a.workspace_id = ? AND pa.person_id = ?
       ORDER BY a.created_at, a.rowid`,
    )
    .all(workspaceId, personId) as {
    createdAt: string;
    planVersionNumber: number;
    fingerprint: string;
    programUnitName: string;
    assignmentType: string;
  }[];
  for (const row of approvals) {
    ledgers.push({
      kind: "truth",
      layer: "decision",
      projection: null,
      title: `Organizer approved plan v${row.planVersionNumber}`,
      detail: `Approved assignment: ${row.programUnitName} (${row.assignmentType}).`,
      fingerprint: row.fingerprint,
      occurredAt: row.createdAt,
    });
  }

  const offers = db
    .prepare(
      `SELECT o.terms_fingerprint AS termsFingerprint, o.status, o.created_at AS createdAt,
              cr.response, cr.responded_at AS respondedAt
       FROM commitment_offers o
       LEFT JOIN commitment_responses cr
         ON cr.offer_id = o.id AND cr.workspace_id = o.workspace_id
       WHERE o.workspace_id = ? AND o.person_id = ? ORDER BY o.created_at`,
    )
    .all(workspaceId, personId) as {
    termsFingerprint: string;
    status: string;
    createdAt: string;
    response: string | null;
    respondedAt: string | null;
  }[];
  for (const row of offers) {
    ledgers.push({
      kind: "truth",
      layer: "commitment",
      projection: null,
      title:
        row.response === null
          ? "Exact commitment offer delivered (awaiting response)"
          : `Commitment ${row.response} on exact offer terms`,
      detail:
        row.response === null
          ? `Offer status: ${row.status}. Terms fingerprint ${row.termsFingerprint.slice(0, 12)}…`
          : `Responded ${row.respondedAt}. Terms fingerprint ${row.termsFingerprint.slice(0, 12)}…`,
      fingerprint: row.termsFingerprint,
      occurredAt: row.respondedAt ?? row.createdAt,
    });
  }

  const agendas = db
    .prepare(
      `SELECT ag.agenda_json AS agendaJson, r.fingerprint, r.sealed_at AS sealedAt
       FROM personal_agendas ag
       JOIN publication_releases r
         ON r.id = ag.release_id AND r.workspace_id = ag.workspace_id
       WHERE ag.workspace_id = ? AND ag.person_id = ? ORDER BY r.sealed_at`,
    )
    .all(workspaceId, personId) as { agendaJson: string; fingerprint: string; sealedAt: string }[];
  for (const row of agendas) {
    const agenda = JSON.parse(row.agendaJson) as { items: { programUnitName: string; role: string }[] };
    const items = agenda.items.map((i) => `${i.programUnitName} (${i.role})`).join(", ");
    ledgers.push({
      kind: "projection",
      layer: null,
      projection: "publication",
      title: "Personal agenda materialized from sealed release",
      detail: items ? `Items: ${items}` : "No agenda items in this release.",
      fingerprint: row.fingerprint,
      occurredAt: row.sealedAt,
    });
  }

  const observations = listObservations(db, workspaceId).filter((o) => o.personId === personId);
  for (const row of observations) {
    ledgers.push({
      kind: "truth",
      layer: "operational",
      projection: null,
      title: `Attendance observed at "${row.programUnitName}"`,
      detail: `Source: ${row.source}. Idempotency key ${row.idempotencyKey.slice(0, 12)}…`,
      fingerprint: null,
      occurredAt: row.observedAt,
    });
  }

  ledgers.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return { person, sources: sourceViews, ledgers };
}

export interface AuditRow {
  id: string;
  actorKind: string;
  actorRef: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export function listAudit(db: Db, workspaceId: string, limit = 40): AuditRow[] {
  const rows = db
    .prepare(
      `SELECT id, actor_kind AS actorKind, actor_ref AS actorRef, action,
              target_type AS targetType, target_id AS targetId, details_json AS detailsJson, created_at AS createdAt
       FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as {
    id: string;
    actorKind: string;
    actorRef: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    detailsJson: string | null;
    createdAt: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    actorKind: r.actorKind,
    actorRef: r.actorRef,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    details: r.detailsJson ? (JSON.parse(r.detailsJson) as Record<string, unknown>) : null,
    createdAt: r.createdAt,
  }));
}

export interface EventState {
  event: EventRow | null;
  units: { id: string; name: string; unitType: string; startsAt: string; endsAt: string; capacity: number }[];
}

export function getEventState(db: Db, workspaceId: string, eventId: string): EventState {
  const event = getEvent(db, workspaceId, eventId);
  if (!event) {
    return { event: null, units: [] };
  }
  const units = db
    .prepare(
      `SELECT id, name, unit_type AS unitType, starts_at AS startsAt, ends_at AS endsAt, capacity
       FROM program_units WHERE workspace_id = ? AND event_id = ? ORDER BY name`,
    )
    .all(workspaceId, eventId) as EventState["units"];
  return { event, units };
}

export interface DashboardState {
  people: PersonSummary[];
  sourceRecordCount: number;
  snapshot: ReturnType<typeof latestSnapshot>;
  snapshotPersonIds: string[];
  event: EventState;
  candidatePlan: ReturnType<typeof candidatePlanVersion>;
  currentPlan: ReturnType<typeof currentPlanVersion>;
  planDetailView: ReturnType<typeof planDetail>;
  approvals: { planVersionId: string; createdAt: string }[];
  offers: ReturnType<typeof listOffers>;
  release: {
    id: string;
    fingerprint: string;
    sealedAt: string;
    planVersionId: string;
    commitmentWatermark: number;
  } | null;
  tokens: ReturnType<typeof listPortalTokens>;
  observations: ReturnType<typeof listObservations>;
  audit: AuditRow[];
  otherWorkspaceSlugs: string[];
}

type DashboardSnapshot = ReturnType<typeof latestSnapshot>;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).sort().join("\0") === [...keys].sort().join("\0");
}

function boundedStoredString(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

/**
 * Resolve the cohort materialization sealed into one exact plan run. The workspace-latest
 * snapshot is only prospective input before a plan exists; it must never replace the
 * qualification lineage shown beside an event's durable plan and commitments.
 */
function dashboardSnapshotForPlan(
  db: Db,
  workspaceId: string,
  event: EventRow,
  planVersionId: string,
): DashboardSnapshot {
  const authority = db
    .prepare(
      `SELECT pr.input_manifest_json AS inputManifest,
              pr.input_fingerprint AS inputFingerprint,
              pr.id AS runId,
              pr.status AS runStatus,
              pv.version_number AS versionNumber,
              pv.fingerprint AS planFingerprint,
              pv.content_json AS planContent
         FROM plan_versions pv
         JOIN plan_runs pr
           ON pr.id = pv.run_id
          AND pr.workspace_id = pv.workspace_id
          AND pr.event_id = pv.event_id
        WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
    )
    .get(workspaceId, event.id, planVersionId) as
    | {
        inputManifest: string;
        inputFingerprint: string;
        runId: string;
        runStatus: string;
        versionNumber: number;
        planFingerprint: string;
        planContent: string;
      }
    | undefined;
  if (!authority) return null;

  let manifest: unknown;
  let content: unknown;
  try {
    manifest = JSON.parse(authority.inputManifest) as unknown;
    content = JSON.parse(authority.planContent) as unknown;
  } catch {
    return null;
  }
  if (!exactRecord(manifest, ["schema", "inputManifest"]) || manifest.schema !== "compiler-input/v1" ||
      !exactRecord(manifest.inputManifest, ["event", "snapshot", "programUnits", "members", "constraints"]) ||
      fingerprintOf(manifest.inputManifest) !== authority.inputFingerprint ||
      !exactRecord(content, [
        "schema", "eventId", "eventName", "timezone", "startsAt", "endsAt", "runId",
        "inputFingerprint", "snapshotFingerprint", "versionNumber", "assignments", "exclusions", "diagnostics",
      ])) {
    return null;
  }
  const input = manifest.inputManifest;
  const inputEvent = input.event;
  const snapshot = input.snapshot;
  if (!exactRecord(inputEvent, ["id", "name", "timezone", "startsAt", "endsAt"]) ||
      inputEvent.id !== event.id || inputEvent.name !== event.name ||
      inputEvent.timezone !== event.timezone || inputEvent.startsAt !== event.startsAt ||
      inputEvent.endsAt !== event.endsAt || !Array.isArray(input.programUnits) ||
      !Array.isArray(input.members) || !Array.isArray(input.constraints) || input.members.length > 10_000) {
    return null;
  }
  if (
    !exactRecord(snapshot, ["id", "fingerprint", "asOf"]) ||
    !boundedStoredString(snapshot.id, 160) || !/^[a-f0-9]{64}$/u.test(String(snapshot.fingerprint)) ||
    !boundedStoredString(snapshot.asOf, 128) || content.snapshotFingerprint !== snapshot.fingerprint
  ) {
    return null;
  }

  const assignments = db.prepare(
    `SELECT person_id AS personId, program_unit_id AS programUnitId,
            assignment_type AS assignmentType, explanation
       FROM plan_assignments
      WHERE workspace_id = ? AND plan_version_id = ?`,
  ).all(workspaceId, planVersionId) as {
    personId: string;
    programUnitId: string;
    assignmentType: string;
    explanation: string;
  }[];
  try {
    assertCanonicalPlanVersionContent({
      id: planVersionId,
      runId: authority.runId,
      fingerprint: authority.planFingerprint,
      versionNumber: authority.versionNumber,
      content: authority.planContent,
      inputFingerprint: authority.inputFingerprint,
    }, event, assignments);
  } catch {
    return null;
  }

  const contentAssignments = content.assignments;
  if (!Array.isArray(contentAssignments) ||
      fingerprintOf(contentAssignments.map((assignment) => exactRecord(assignment, ["personId", "programUnitId", "assignmentType", "explanation"])
        ? [assignment.personId, assignment.programUnitId, assignment.assignmentType, assignment.explanation]
        : null).sort()) !==
      fingerprintOf(assignments.map((assignment) => [
        assignment.personId,
        assignment.programUnitId,
        assignment.assignmentType,
        assignment.explanation,
      ]).sort())) {
    return null;
  }

  const persisted = db
    .prepare(
      `SELECT s.id, s.fingerprint, s.member_count AS memberCount, s.as_of AS asOf,
              s.created_at AS createdAt, s.definition_version AS definitionVersion,
              d.name AS cohortName,
              (SELECT COUNT(*) FROM cohort_snapshot_members m
                WHERE m.workspace_id = s.workspace_id AND m.snapshot_id = s.id) AS storedMemberCount
         FROM cohort_snapshots s
         JOIN cohort_definitions d
           ON d.workspace_id = s.workspace_id AND d.id = s.cohort_definition_id
        WHERE s.workspace_id = ? AND s.id = ?`,
    )
    .get(workspaceId, snapshot.id) as
    | (NonNullable<DashboardSnapshot> & {
        storedMemberCount: number;
        definitionVersion: number;
        cohortName: string;
      })
    | undefined;
  const persistedMembers = persisted
    ? (db.prepare(
        `SELECT person_id AS personId, rank, why_in AS whyIn
           FROM cohort_snapshot_members
          WHERE workspace_id = ? AND snapshot_id = ?
          ORDER BY rank, person_id`,
      ).all(workspaceId, persisted.id) as { personId: string; rank: number; whyIn: string }[])
    : [];
  const manifestMemberAuthority = input.members.map((member) =>
    exactRecord(member, ["personId", "email", "fullName", "organization", "moderatorEligible", "rank"]) &&
    boundedStoredString(member.personId, 160) && Number.isSafeInteger(member.rank) && Number(member.rank) >= 1
      ? { personId: member.personId, rank: Number(member.rank) }
      : null);
  const recomputedSnapshotFingerprint = persisted
    ? fingerprintOf({
        schema: "cohort-snapshot/v1",
        workspaceId,
        cohortName: persisted.cohortName,
        definitionVersion: persisted.definitionVersion,
        asOf: persisted.asOf,
        members: persistedMembers,
      })
    : null;
  if (
    !persisted ||
    persisted.fingerprint !== snapshot.fingerprint || persisted.asOf !== snapshot.asOf ||
    persisted.memberCount !== persisted.storedMemberCount || persisted.memberCount !== persistedMembers.length ||
    recomputedSnapshotFingerprint !== persisted.fingerprint || manifestMemberAuthority.some((member) => member === null) ||
    fingerprintOf(manifestMemberAuthority) !== fingerprintOf(persistedMembers.map(({ personId, rank }) => ({ personId, rank })))
  ) {
    return null;
  }
  const {
    storedMemberCount: _storedMemberCount,
    definitionVersion: _definitionVersion,
    cohortName: _cohortName,
    ...validated
  } = persisted;
  return validated;
}

export function getDashboardState(db: Db, workspaceId: string, otherWorkspaceSlugs: string[]): DashboardState {
  const events = listEvents(db, workspaceId);
  // The legacy dashboard pipeline has no event pointer of its own. Keep it deterministic while
  // the event portfolio remains the authoritative switcher for work across multiple events.
  const event = events[0] ?? null;
  const eventState = event
    ? getEventState(db, workspaceId, event.id)
    : { event: null as EventRow | null, units: [] };
  const currentPlan = event ? currentPlanVersion(db, workspaceId, event.id) : null;
  const candidatePlan = event ? candidatePlanVersion(db, workspaceId, event.id) : null;
  const planForSnapshot = candidatePlan ?? currentPlan;
  const snapshot = event && planForSnapshot
    ? dashboardSnapshotForPlan(db, workspaceId, event, planForSnapshot.id)
    : latestSnapshot(db, workspaceId);
  const planDetailView = event && planForSnapshot
    ? planDetail(db, workspaceId, event.id, planForSnapshot.id)
    : null;
  const validatedRelease = event?.currentReleaseId
    ? validatePublicReleaseForRead(db, {
        workspaceId,
        eventId: event.id,
        releaseId: event.currentReleaseId,
        mode: "CURRENT",
      })
    : null;
  const release = validatedRelease
    ? {
        id: validatedRelease.releaseId,
        fingerprint: validatedRelease.fingerprint,
        sealedAt: validatedRelease.sealedAt,
        planVersionId: validatedRelease.planVersionId,
        commitmentWatermark: validatedRelease.commitmentWatermark,
      }
    : null;
  const approvals = currentPlan
    ? (db
        .prepare(
          `SELECT plan_version_id AS planVersionId, created_at AS createdAt
             FROM approvals
            WHERE workspace_id = ? AND plan_version_id = ? AND decision = 'approved'`,
        )
        .all(workspaceId, currentPlan.id) as { planVersionId: string; createdAt: string }[])
    : [];

  return {
    people: listPeople(db, workspaceId),
    sourceRecordCount: (db
      .prepare("SELECT COUNT(*) AS n FROM source_records WHERE workspace_id = ?")
      .get(workspaceId) as { n: number }).n,
    snapshot,
    snapshotPersonIds: snapshot
      ? (db
          .prepare(
            `SELECT person_id AS personId
             FROM cohort_snapshot_members
             WHERE workspace_id = ? AND snapshot_id = ?
             ORDER BY rank, person_id`,
          )
          .all(workspaceId, snapshot.id) as { personId: string }[]).map((row) => row.personId)
      : [],
    event: eventState,
    candidatePlan,
    currentPlan,
    planDetailView,
    approvals,
    offers: event ? listOffers(db, workspaceId, event.id) : [],
    release,
    tokens: release ? listPortalTokens(db, workspaceId, release.id) : [],
    observations: event ? listObservations(db, workspaceId, event.id) : [],
    audit: listAudit(db, workspaceId),
    otherWorkspaceSlugs,
  };
}
