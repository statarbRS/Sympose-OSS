export type DecisionPlanAssignment = Readonly<{
  personId: string;
  fullName: string;
  programUnitId: string;
  programUnitName: string;
  assignmentType: string;
}>;

export type DecisionPlanVersionInput = Readonly<{
  versionNumber: number;
  fingerprint: string;
  lifecycleStatus: string;
  assignments: readonly DecisionPlanAssignment[];
}>;

export type PlanChangeKind = "UNCHANGED" | "MOVED" | "ADDED" | "REMOVED";

export type PlanChangeProjection = Readonly<{
  kind: PlanChangeKind;
  personId: string;
  fullName: string;
  assignmentType: string;
  beforeProgramUnitId: string | null;
  beforeProgramUnitName: string | null;
  afterProgramUnitId: string | null;
  afterProgramUnitName: string | null;
  explicitCost: 0 | 1;
}>;

export type PlanDecisionProjection = Readonly<{
  status: "READY" | "UNAVAILABLE";
  authority: "NONE";
  previewOnly: true;
  currentVersionNumber: number | null;
  currentFingerprint: string | null;
  candidateVersionNumber: number;
  candidateFingerprint: string;
  candidateLifecycleStatus: string;
  counts: Readonly<{
    unchanged: number;
    moved: number;
    added: number;
    removed: number;
  }>;
  stabilityCost: Readonly<{
    total: number | null;
    formula: "0 × unchanged + 1 × moved + 1 × added + 1 × removed";
    authority: "NONE";
    explanation: string;
  }>;
  changes: readonly PlanChangeProjection[];
  namedObjectiveContributions: Readonly<{
    status: "UNAVAILABLE";
    contributions: readonly never[];
    explanation: string;
  }>;
  proofAvailability: readonly Readonly<{
    family: "PURPOSE" | "READINESS" | "CHANGE_RADIUS" | "RECONFIRMATION";
    status: "UNAVAILABLE";
    explanation: string;
  }>[];
}>;

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function exactKey(assignment: DecisionPlanAssignment): string {
  return JSON.stringify([
    assignment.personId,
    assignment.programUnitId,
    assignment.assignmentType,
  ]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAssignments(
  left: DecisionPlanAssignment,
  right: DecisionPlanAssignment,
): number {
  return compareText(exactKey(left), exactKey(right));
}

function copyAssignments(
  assignments: readonly DecisionPlanAssignment[],
): DecisionPlanAssignment[] {
  return assignments.map((assignment) => ({
    personId: assignment.personId,
    fullName: assignment.fullName,
    programUnitId: assignment.programUnitId,
    programUnitName: assignment.programUnitName,
    assignmentType: assignment.assignmentType,
  })).sort(compareAssignments);
}

function change(
  kind: PlanChangeKind,
  before: DecisionPlanAssignment | null,
  after: DecisionPlanAssignment | null,
): PlanChangeProjection {
  const identity = after ?? before;
  if (!identity) throw new Error("A plan comparison row requires a source assignment.");
  return {
    kind,
    personId: identity.personId,
    fullName: identity.fullName,
    assignmentType: identity.assignmentType,
    beforeProgramUnitId: before?.programUnitId ?? null,
    beforeProgramUnitName: before?.programUnitName ?? null,
    afterProgramUnitId: after?.programUnitId ?? null,
    afterProgramUnitName: after?.programUnitName ?? null,
    explicitCost: kind === "UNCHANGED" ? 0 : 1,
  };
}

function compareChange(left: PlanChangeProjection, right: PlanChangeProjection): number {
  const kindOrder: Record<PlanChangeKind, number> = {
    MOVED: 0,
    ADDED: 1,
    REMOVED: 2,
    UNCHANGED: 3,
  };
  return kindOrder[left.kind] - kindOrder[right.kind] ||
    compareText(left.fullName, right.fullName) ||
    compareText(left.personId, right.personId) ||
    compareText(left.assignmentType, right.assignmentType) ||
    compareText(
      left.afterProgramUnitId ?? left.beforeProgramUnitId ?? "",
      right.afterProgramUnitId ?? right.beforeProgramUnitId ?? "",
    );
}

const proofAvailability = [
  {
    family: "PURPOSE" as const,
    status: "UNAVAILABLE" as const,
    explanation: "The Plan route does not expose an exact current purpose-kernel receipt.",
  },
  {
    family: "READINESS" as const,
    status: "UNAVAILABLE" as const,
    explanation: "The Plan route does not expose an exact readiness proof graph for this comparison.",
  },
  {
    family: "CHANGE_RADIUS" as const,
    status: "UNAVAILABLE" as const,
    explanation: "No exact before-source vector or bounded change-radius command is present.",
  },
  {
    family: "RECONFIRMATION" as const,
    status: "UNAVAILABLE" as const,
    explanation: "No exact stakeholder/material-term evidence bundle is present.",
  },
] as const;

/**
 * Compares only exact assignment records already projected by the route. It
 * does not infer solver objectives, commitments, purpose, impact, or authority.
 */
export function buildPlanDecisionProjection(
  candidate: DecisionPlanVersionInput,
  current: DecisionPlanVersionInput | null,
): PlanDecisionProjection {
  if (current === null) {
    return freezeDeep({
      status: "UNAVAILABLE" as const,
      authority: "NONE" as const,
      previewOnly: true as const,
      currentVersionNumber: null,
      currentFingerprint: null,
      candidateVersionNumber: candidate.versionNumber,
      candidateFingerprint: candidate.fingerprint,
      candidateLifecycleStatus: candidate.lifecycleStatus,
      counts: { unchanged: 0, moved: 0, added: 0, removed: 0 },
      stabilityCost: {
        total: null,
        formula: "0 × unchanged + 1 × moved + 1 × added + 1 × removed" as const,
        authority: "NONE" as const,
        explanation: "An explicit comparison cost is unavailable until an exact current slate is present.",
      },
      changes: [],
      namedObjectiveContributions: {
        status: "UNAVAILABLE" as const,
        contributions: [] as readonly never[],
        explanation: "The existing route data has no named compiler objective-contribution ledger.",
      },
      proofAvailability,
    });
  }

  const before = copyAssignments(current.assignments);
  const after = copyAssignments(candidate.assignments);
  const beforeByExact = new Map<string, DecisionPlanAssignment[]>();
  for (const assignment of before) {
    const key = exactKey(assignment);
    const group = beforeByExact.get(key) ?? [];
    group.push(assignment);
    beforeByExact.set(key, group);
  }

  const changes: PlanChangeProjection[] = [];
  const unmatchedAfter: DecisionPlanAssignment[] = [];
  for (const assignment of after) {
    const group = beforeByExact.get(exactKey(assignment));
    const matched = group?.shift() ?? null;
    if (matched) changes.push(change("UNCHANGED", matched, assignment));
    else unmatchedAfter.push(assignment);
  }
  const unmatchedBefore = [...beforeByExact.values()].flat();

  // PlanDetail does not project immutable assignment lineage, so unmatched
  // records cannot be paired honestly as moves.
  for (const assignment of unmatchedAfter) {
    changes.push(change("ADDED", null, assignment));
  }
  for (const assignment of unmatchedBefore) {
    changes.push(change("REMOVED", assignment, null));
  }

  changes.sort(compareChange);
  const counts = {
    unchanged: changes.filter((item) => item.kind === "UNCHANGED").length,
    moved: changes.filter((item) => item.kind === "MOVED").length,
    added: changes.filter((item) => item.kind === "ADDED").length,
    removed: changes.filter((item) => item.kind === "REMOVED").length,
  };
  const total = counts.moved + counts.added + counts.removed;

  return freezeDeep({
    status: "READY" as const,
    authority: "NONE" as const,
    previewOnly: true as const,
    currentVersionNumber: current.versionNumber,
    currentFingerprint: current.fingerprint,
    candidateVersionNumber: candidate.versionNumber,
    candidateFingerprint: candidate.fingerprint,
    candidateLifecycleStatus: candidate.lifecycleStatus,
    counts,
    stabilityCost: {
      total,
      formula: "0 × unchanged + 1 × moved + 1 × added + 1 × removed" as const,
      authority: "NONE" as const,
      explanation: "This disclosed record-change count is a review aid only. It is not a solver objective, weighted quality score, or decision authority.",
    },
    changes,
    namedObjectiveContributions: {
      status: "UNAVAILABLE" as const,
      contributions: [] as readonly never[],
      explanation: "The existing route data has no named compiler objective-contribution ledger, so none is reconstructed from explanation prose.",
    },
    proofAvailability,
  });
}
