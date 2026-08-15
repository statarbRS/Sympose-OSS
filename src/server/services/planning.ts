import type { Db } from "../db";
import { fingerprintOf, nowIso, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit } from "./audit";
import { getEvent, type EventRow } from "./events";
import { latestSnapshot } from "./cohorts";
import { DenialError, roleHasCapability } from "../auth";
import {
  compileRoundtables,
  validateCompilerOutput,
  type CompilerInput,
  type CompilerOutput,
} from "../adapters/compiler";

export const COMPILER_VERSION = "simulated-1";
const COMPILER_KIND = "fixture-backed-simulated-compiler";

export interface PlanCompileResult {
  planVersionId: string;
  runId: string;
  versionNumber: number;
  fingerprint: string;
  assignmentCount: number;
  status: "FEASIBLE" | "INFEASIBLE";
  created: boolean;
  validationViolations: string[];
}

export function compilePlan(
  db: Db,
  workspaceId: string,
  eventId: string,
  actor: { kind: "account"; ref: string },
): PlanCompileResult {
  return withTransaction(db, () => {
    const event = getEvent(db, workspaceId, eventId);
    if (!event) {
      throw new Error("EVENT_NOT_FOUND: create the event before compiling a plan.");
    }
    const snapshot = latestSnapshot(db, workspaceId);
    if (!snapshot) {
      throw new Error("NO_SNAPSHOT: freeze a cohort snapshot before compiling a plan.");
    }
    const units = db
      .prepare(
        `SELECT id, name, starts_at AS startsAt, ends_at AS endsAt, capacity
         FROM program_units WHERE workspace_id = ? AND event_id = ? ORDER BY name`,
      )
      .all(workspaceId, eventId) as {
      id: string;
      name: string;
      startsAt: string;
      endsAt: string;
      capacity: number;
    }[];
    if (units.length === 0) {
      throw new Error("NO_PROGRAM_UNITS: create the event with a program unit before compiling a plan.");
    }

    const memberRows = db
      .prepare(
        `SELECT m.person_id AS personId, p.canonical_email AS email, p.full_name AS fullName,
                COALESCE(p.organization, 'Unknown') AS organization, p.title
         FROM cohort_snapshot_members m
         JOIN people p ON p.id = m.person_id AND p.workspace_id = m.workspace_id
         WHERE m.snapshot_id = ? AND m.workspace_id = ?
         ORDER BY m.rank`,
      )
      .all(snapshot.id, workspaceId) as {
      personId: string;
      email: string;
      fullName: string;
      organization: string;
      title: string | null;
    }[];

    const payloadByPerson = new Map<string, string>();
    const links = db
      .prepare(
        `SELECT l.person_id AS personId, r.payload_json AS payload
         FROM source_links l
         JOIN source_records r
           ON r.id = l.source_record_id AND r.workspace_id = l.workspace_id
         WHERE l.workspace_id = ?`,
      )
      .all(workspaceId) as { personId: string; payload: string }[];
    for (const link of links) {
      payloadByPerson.set(link.personId, link.payload);
    }

    const members = memberRows.map((member, index) => {
      let moderatorEligible = false;
      const payload = payloadByPerson.get(member.personId);
      if (payload) {
        try {
          const parsed = JSON.parse(payload) as { record?: { moderatorEligible?: boolean } };
          moderatorEligible = parsed.record?.moderatorEligible === true;
        } catch {
          moderatorEligible = false;
        }
      }
      return {
        personId: member.personId,
        email: member.email,
        fullName: member.fullName,
        organization: member.organization,
        moderatorEligible,
        rank: index + 1,
      };
    });

    const input: CompilerInput = {
      schema: "compiler-input/v1",
      inputManifest: {
        event: {
          id: event.id,
          name: event.name,
          timezone: event.timezone,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
        },
        snapshot: { id: snapshot.id, fingerprint: snapshot.fingerprint, asOf: snapshot.asOf },
        programUnits: units.map((u) => ({
          id: u.id,
          name: u.name,
          startsAt: u.startsAt,
          endsAt: u.endsAt,
          capacity: u.capacity,
        })),
        members,
        constraints: [],
      },
    };

    const inputFingerprint = fingerprintOf(input.inputManifest);
    const existing = db
      .prepare(
        `SELECT pv.id, pv.run_id AS runId, pv.version_number AS versionNumber, pv.fingerprint,
                pv.content_json AS content, pr.status AS runStatus
         FROM plan_versions pv
         JOIN plan_runs pr ON pr.id = pv.run_id AND pr.workspace_id = pv.workspace_id
         WHERE pv.workspace_id = ? AND pv.event_id = ?
           AND pr.compiler = ? AND pr.compiler_version = ? AND pr.input_fingerprint = ?
         ORDER BY pv.version_number DESC LIMIT 1`,
      )
      .get(workspaceId, eventId, COMPILER_KIND, COMPILER_VERSION, inputFingerprint) as
      | {
          id: string;
          runId: string;
          versionNumber: number;
          fingerprint: string;
          content: string;
          runStatus: "FEASIBLE" | "INFEASIBLE";
        }
      | undefined;
    if (existing) {
      const existingContent = JSON.parse(existing.content) as { assignments?: unknown[] };
      return {
        planVersionId: existing.id,
        runId: existing.runId,
        versionNumber: existing.versionNumber,
        fingerprint: existing.fingerprint,
        assignmentCount: existingContent.assignments?.length ?? 0,
        status: existing.runStatus,
        created: false,
        validationViolations: [],
      };
    }

    const output = compileRoundtables(input);
    const violations = validateCompilerOutput(input, output);
    if (violations.length > 0) {
      writeAudit(db, workspaceId, {
        actorKind: actor.kind,
        actorRef: actor.ref,
        action: "plan.compile.rejected",
        targetType: "event",
        targetId: eventId,
        details: { inputFingerprint, violations },
      });
      throw new Error(`PLAN_VALIDATION_FAILED: ${violations.join("; ")}`);
    }

    const runId = uuid();
    db.prepare(
      `INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      workspaceId,
      eventId,
      output.status,
      inputFingerprint,
      JSON.stringify(input),
      COMPILER_KIND,
      COMPILER_VERSION,
      nowIso(),
    );

    const versionNumber = (db
      .prepare("SELECT COALESCE(MAX(version_number), 0) AS n FROM plan_versions WHERE workspace_id = ? AND event_id = ?")
      .get(workspaceId, eventId) as { n: number }).n + 1;

    const content = {
      schema: "plan-version/v1",
      eventId,
      eventName: event.name,
      timezone: event.timezone,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      runId,
      inputFingerprint,
      snapshotFingerprint: snapshot.fingerprint,
      versionNumber,
      assignments: output.assignments,
      exclusions: output.exclusions,
      diagnostics: output.diagnostics,
    };
    const fingerprint = fingerprintOf(content);

    const planVersionId = uuid();
    db.prepare(
      `INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(planVersionId, workspaceId, eventId, runId, versionNumber, fingerprint, JSON.stringify(content), nowIso());

    const insertAssignment = db.prepare(
      `INSERT INTO plan_assignments (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation, is_pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const assignment of output.assignments) {
      insertAssignment.run(
        uuid(),
        workspaceId,
        planVersionId,
        assignment.personId,
        assignment.programUnitId,
        assignment.assignmentType,
        assignment.explanation,
      );
    }

    db.prepare(
      `INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'candidate', ?, NULL, ?)`,
    ).run(uuid(), workspaceId, planVersionId, actor.ref, nowIso());

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "plan.compiled",
      targetType: "plan_version",
      targetId: planVersionId,
      details: { runId, fingerprint, versionNumber, assignmentCount: output.assignments.length, inputFingerprint },
    });

    return {
      planVersionId,
      runId,
      versionNumber,
      fingerprint,
      assignmentCount: output.assignments.length,
      status: output.status,
      created: true,
      validationViolations: violations,
    };
  });
}

interface ApprovedPlanRow {
  id: string;
  versionNumber: number;
}

/**
 * Approved history for one event, newest first. A plan is approved truth only when the row
 * exists in this exact workspace/event, carries a persisted approval for the same
 * workspace/event/plan whose decision is the exact canonical `approved`, and has `approved`
 * as its latest immutable transition.
 *
 * The decision column is unconstrained text, so a `rejected`, unknown, malformed, padded, or
 * differently cased value must never join here. Comparison uses the column's default binary
 * collation, which is exact rather than case- or whitespace-folding. The schema's unique key
 * on (workspace_id, event_id, plan_version_id) means at most one approval row per plan is
 * reachable, so this filter can only ever remove a plan, never duplicate one.
 *
 * The approval row and the state row are independent: neither substitutes for the other.
 * Ordering is by immutable version_number. Row, approval, and state timestamps are all
 * caller-influenced and can never establish which approval is the newest one.
 */
function approvedPlanHistory(db: Db, workspaceId: string, eventId: string): ApprovedPlanRow[] {
  const rows = db
    .prepare(
      `SELECT pv.id, pv.version_number AS versionNumber
       FROM plan_versions pv
       JOIN approvals a
         ON a.workspace_id = pv.workspace_id
        AND a.event_id = pv.event_id
        AND a.plan_version_id = pv.id
        AND a.decision = 'approved'
       WHERE pv.workspace_id = ? AND pv.event_id = ?
       ORDER BY pv.version_number DESC`,
    )
    .all(workspaceId, eventId) as unknown as ApprovedPlanRow[];
  return rows.filter((row) => planState(db, workspaceId, row.id) === "approved");
}

/**
 * Validate stored pointer truth before trusting any caller expectation. A caller that echoes
 * an already-corrupt pointer must not be able to approve over corrupt operational state, so
 * this runs inside the approval transaction ahead of every mutation. The schema trigger only
 * refuses ordinary cross-event writes; legacy or hand-edited corruption still has to fail at
 * the mutation boundary. Corrupt history is never repaired in place.
 */
function assertCurrentPlanPointerTruth(
  db: Db,
  workspaceId: string,
  eventId: string,
  pointer: string | null,
): void {
  const approved = approvedPlanHistory(db, workspaceId, eventId);
  const latestApproved = approved[0] ?? null;
  if (pointer === null) {
    if (latestApproved) {
      throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
    }
    return;
  }
  const pointed = approved.find((row) => row.id === pointer);
  if (!pointed || !latestApproved || pointed.versionNumber !== latestApproved.versionNumber) {
    throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
  }
}

export function approvePlan(
  db: Db,
  workspaceId: string,
  eventId: string,
  planVersionId: string,
  expectedCurrentPlanVersionId: string | null,
  actor: { kind: "account"; ref: string },
): { approvalId: string; planVersionId: string; created: boolean } {
  return withTransaction(db, () => {
    const persistedActor = db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, actor.ref) as { role: string } | undefined;
    if (!persistedActor || !roleHasCapability(persistedActor.role, "phase0.pipeline.manage")) {
      throw new DenialError(
        "CAPABILITY_DENIED",
        "This account is not authorized to approve a plan in this workspace.",
        "phase0.pipeline.manage",
      );
    }
    const event = getEvent(db, workspaceId, eventId);
    if (!event) {
      throw new Error("EVENT_NOT_FOUND");
    }
    assertCurrentPlanPointerTruth(db, workspaceId, eventId, event.currentPlanVersionId);
    if (event.currentPlanVersionId !== expectedCurrentPlanVersionId) {
      throw new Error("PLAN_POINTER_EXPECTATION_FAILED");
    }

    const plan = db
      .prepare("SELECT id, event_id FROM plan_versions WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, planVersionId) as { id: string; event_id: string } | undefined;
    if (!plan || plan.event_id !== eventId) {
      throw new Error("PLAN_NOT_FOUND: plan version does not belong to this event/workspace.");
    }
    const run = db
      .prepare(
        `SELECT r.status
         FROM plan_versions p
         JOIN plan_runs r ON r.id = p.run_id AND r.workspace_id = p.workspace_id
         WHERE p.workspace_id = ? AND p.id = ?`,
      )
      .get(workspaceId, planVersionId) as { status: string } | undefined;
    if (run?.status !== "FEASIBLE") {
      throw new Error("PLAN_INFEASIBLE: only independently validated feasible plans may be approved.");
    }

    if (planState(db, workspaceId, planVersionId) === "approved") {
      throw new Error("PLAN_CANDIDATE_STATUS_INVALID");
    }

    const candidates = db
      .prepare(
        `SELECT pv.id
         FROM plan_versions pv
         WHERE pv.workspace_id = ? AND pv.event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM approvals a
             WHERE a.workspace_id = pv.workspace_id
               AND a.event_id = pv.event_id
               AND a.plan_version_id = pv.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM plan_states ps
             WHERE ps.workspace_id = pv.workspace_id
               AND ps.plan_version_id = pv.id
               AND ps.state = 'approved'
           )`,
      )
      .all(workspaceId, eventId) as { id: string }[];
    if (candidates.length !== 1) {
      throw new Error("PLAN_CANDIDATE_AMBIGUOUS");
    }
    const onlyCandidate = candidates.pop();
    if (!onlyCandidate || onlyCandidate.id !== planVersionId) {
      throw new Error("PLAN_NOT_CANDIDATE");
    }

    const approvalId = uuid();
    db.prepare(
      `INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
    ).run(approvalId, workspaceId, eventId, planVersionId, actor.ref, nowIso());

    db.prepare(
      `INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'approved', ?, NULL, ?)`,
    ).run(uuid(), workspaceId, planVersionId, actor.ref, nowIso());

    // Compare-and-set against the pointer this transaction validated (including null) rather
    // than trusting the earlier in-memory read alone, so the replacement can only land on the
    // exact pre-approval state even if BEGIN IMMEDIATE serialization is ever relaxed.
    const pointerUpdate = db
      .prepare(
        `UPDATE events SET current_plan_version_id = ?
         WHERE id = ? AND workspace_id = ? AND current_plan_version_id IS ?`,
      )
      .run(planVersionId, eventId, workspaceId, event.currentPlanVersionId);
    if (pointerUpdate.changes !== 1) {
      throw new Error("EVENT_CURRENT_PLAN_POINTER_UPDATE_FAILED");
    }

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "plan.approved",
      targetType: "plan_version",
      targetId: planVersionId,
      details: { approvalId },
    });

    return { approvalId, planVersionId, created: true };
  });
}

export interface PlanVersionSummary {
  id: string;
  runId: string;
  versionNumber: number;
  fingerprint: string;
  assignmentCount: number;
  runStatus: "FEASIBLE" | "INFEASIBLE";
  status: string;
  createdAt: string;
  eventId: string;
}

interface PlanSummaryRow {
  id: string;
  runId: string;
  versionNumber: number;
  fingerprint: string;
  content: string;
  createdAt: string;
  eventId: string;
  runStatus: "FEASIBLE" | "INFEASIBLE";
}

function summarizePlan(db: Db, workspaceId: string, row: PlanSummaryRow): PlanVersionSummary {
  const content = JSON.parse(row.content) as { assignments?: unknown[] };
  return {
    id: row.id,
    runId: row.runId,
    versionNumber: row.versionNumber,
    fingerprint: row.fingerprint,
    assignmentCount: content.assignments?.length ?? 0,
    runStatus: row.runStatus,
    status: planState(db, workspaceId, row.id),
    createdAt: row.createdAt,
    eventId: row.eventId,
  };
}

export function currentPlanVersionId(db: Db, workspaceId: string, eventId: string): string | null {
  const event = db
    .prepare(
      "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, eventId) as { currentPlanVersionId: string | null } | undefined;
  if (!event || event.currentPlanVersionId === null) {
    return null;
  }

  const pointer = db
    .prepare(
      `SELECT id
       FROM plan_versions
       WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    )
    .get(workspaceId, eventId, event.currentPlanVersionId) as { id: string } | undefined;
  if (!pointer) {
    throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
  }
  return pointer.id;
}

export function latestPlanVersion(db: Db, workspaceId: string, eventId: string): PlanVersionSummary | null {
  const currentId = currentPlanVersionId(db, workspaceId, eventId);
  if (!currentId) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT pv.id, pv.run_id AS runId, pv.version_number AS versionNumber, pv.fingerprint,
              pv.content_json AS content, pv.created_at AS createdAt, pv.event_id AS eventId,
              pr.status AS runStatus
        FROM plan_versions pv
        JOIN plan_runs pr ON pr.id = pv.run_id AND pr.workspace_id = pv.workspace_id AND pr.event_id = pv.event_id
        WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
    )
    .get(workspaceId, eventId, currentId) as
    | PlanSummaryRow
    | undefined;
  if (!row) {
    throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
  }
  const currentPlan = summarizePlan(db, workspaceId, row);
  if (currentPlan.status !== "approved") {
    throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
  }
  return currentPlan;
}

export const currentPlanVersion = latestPlanVersion;

export function candidatePlanVersion(db: Db, workspaceId: string, eventId: string): PlanVersionSummary | null {
  const rows = db
    .prepare(
      `SELECT pv.id, pv.run_id AS runId, pv.version_number AS versionNumber, pv.fingerprint,
              pv.content_json AS content, pv.created_at AS createdAt, pv.event_id AS eventId,
              pr.status AS runStatus
       FROM plan_versions pv
       JOIN plan_runs pr
         ON pr.id = pv.run_id AND pr.workspace_id = pv.workspace_id AND pr.event_id = pv.event_id
       WHERE pv.workspace_id = ? AND pv.event_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.workspace_id = pv.workspace_id
             AND a.event_id = pv.event_id
             AND a.plan_version_id = pv.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_states ps
           WHERE ps.workspace_id = pv.workspace_id
             AND ps.plan_version_id = pv.id
             AND ps.state = 'approved'
         )`,
    )
    .all(workspaceId, eventId) as unknown as PlanSummaryRow[];
  if (rows.length > 1) {
    throw new Error("PLAN_CANDIDATE_AMBIGUOUS");
  }
  const candidate = rows.pop();
  return candidate ? summarizePlan(db, workspaceId, candidate) : null;
}

export function planState(db: Db, workspaceId: string, planVersionId: string): string {
  const row = db
    .prepare(
      "SELECT state FROM plan_states WHERE workspace_id = ? AND plan_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(workspaceId, planVersionId) as { state: string } | undefined;
  return row?.state ?? "candidate";
}

export interface PlanDetail {
  version: PlanVersionSummary;
  content: {
    schema: string;
    eventId: string;
    eventName: string;
    runId: string;
    inputFingerprint: string;
    snapshotFingerprint: string;
    versionNumber: number;
    assignments: { personId: string; programUnitId: string; assignmentType: string; explanation: string }[];
    exclusions: { personId: string; reason: string }[];
    diagnostics: { messages: string[]; unitCounts: Record<string, number>; moderatorsWithoutUnit: string[] };
  };
  assignmentsJoined: {
    personId: string;
    fullName: string;
    email: string;
    organization: string | null;
    programUnitId: string;
    programUnitName: string;
    assignmentType: string;
    explanation: string;
  }[];
  run: { id: string; status: string; inputFingerprint: string; compiler: string; compilerVersion: string; createdAt: string };
  approvals: { id: string; createdAt: string; actorAccountId: string }[];
  states: { state: string; createdAt: string; reason: string | null }[];
}

export function planDetail(db: Db, workspaceId: string, eventId: string, planVersionId: string): PlanDetail | null {
  const version = db
    .prepare(
      `SELECT pv.id, pv.run_id AS runId, pv.version_number AS versionNumber, pv.fingerprint,
              pv.content_json AS content, pv.created_at AS createdAt, pv.event_id AS eventId,
              pr.status AS runStatus, pr.input_fingerprint AS runInputFingerprint, pr.compiler,
              pr.compiler_version AS compilerVersion, pr.created_at AS runCreatedAt
       FROM plan_versions pv
       JOIN plan_runs pr ON pr.id = pv.run_id AND pr.workspace_id = pv.workspace_id
       WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
    )
    .get(workspaceId, eventId, planVersionId) as
    | {
        id: string;
        runId: string;
        versionNumber: number;
        fingerprint: string;
        content: string;
        createdAt: string;
        eventId: string;
        runStatus: string;
        runInputFingerprint: string;
        compiler: string;
        compilerVersion: string;
        runCreatedAt: string;
      }
    | undefined;
  if (!version) {
    return null;
  }

  const content = JSON.parse(version.content) as PlanDetail["content"];
  const assignmentsJoined = db
    .prepare(
      `SELECT pa.person_id AS personId, p.full_name AS fullName, p.canonical_email AS email,
              p.organization AS organization, pa.program_unit_id AS programUnitId, pu.name AS programUnitName,
              pa.assignment_type AS assignmentType, pa.explanation AS explanation
       FROM plan_assignments pa
       JOIN people p ON p.id = pa.person_id AND p.workspace_id = pa.workspace_id
       JOIN program_units pu ON pu.id = pa.program_unit_id AND pu.workspace_id = pa.workspace_id
       WHERE pa.workspace_id = ? AND pa.plan_version_id = ?
       ORDER BY pu.name, pa.assignment_type DESC, p.full_name`,
    )
    .all(workspaceId, planVersionId) as PlanDetail["assignmentsJoined"];

  const approvals = db
    .prepare(
      `SELECT id, created_at AS createdAt, actor_account_id AS actorAccountId
       FROM approvals WHERE workspace_id = ? AND plan_version_id = ? ORDER BY created_at`,
    )
    .all(workspaceId, planVersionId) as PlanDetail["approvals"];

  const states = db
    .prepare(
      `SELECT state, created_at AS createdAt, reason FROM plan_states
       WHERE workspace_id = ? AND plan_version_id = ? ORDER BY created_at, rowid`,
    )
    .all(workspaceId, planVersionId) as PlanDetail["states"];

  return {
    version: {
      id: version.id,
      runId: version.runId,
      versionNumber: version.versionNumber,
      fingerprint: version.fingerprint,
      assignmentCount: content.assignments.length,
      runStatus: version.runStatus as "FEASIBLE" | "INFEASIBLE",
      status: states[states.length - 1]?.state ?? "candidate",
      createdAt: version.createdAt,
      eventId: version.eventId,
    },
    content,
    assignmentsJoined,
    run: {
      id: version.runId,
      status: version.runStatus,
      inputFingerprint: version.runInputFingerprint,
      compiler: version.compiler,
      compilerVersion: version.compilerVersion,
      createdAt: version.runCreatedAt,
    },
    approvals,
    states,
  };
}
