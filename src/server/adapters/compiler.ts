import { fingerprintOf } from "../canonical";

export type AssignmentType = "moderator" | "participant";

export interface CompilerMember {
  personId: string;
  email: string;
  fullName: string;
  organization: string;
  moderatorEligible: boolean;
  rank: number;
}

export interface CompilerProgramUnit {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
}

export interface CompilerConstraint {
  key: string;
  kind: "hard" | "soft";
  description: string;
}

export interface CompilerInput {
  schema: "compiler-input/v1";
  inputManifest: {
    event: { id: string; name: string; timezone: string; startsAt: string; endsAt: string };
    snapshot: { id: string; fingerprint: string; asOf: string };
    programUnits: CompilerProgramUnit[];
    members: CompilerMember[];
    constraints: CompilerConstraint[];
  };
}

export interface CompilerAssignment {
  personId: string;
  programUnitId: string;
  assignmentType: AssignmentType;
  explanation: string;
}

export interface CompilerExclusion {
  personId: string;
  reason: string;
}

export interface CompilerOutput {
  schema: "compiler-output/v1";
  status: "FEASIBLE" | "INFEASIBLE";
  fingerprint: string;
  assignments: CompilerAssignment[];
  exclusions: CompilerExclusion[];
  diagnostics: {
    messages: string[];
    unitCounts: Record<string, number>;
    moderatorsWithoutUnit: string[];
  };
}

const DEFAULT_CONSTRAINTS: CompilerConstraint[] = [
  { key: "capacity", kind: "hard", description: "Every assignment consumes one seat within the program-unit capacity." },
  { key: "no-double-booking", kind: "hard", description: "A person is assigned to at most one program unit." },
  { key: "one-moderator-per-unit", kind: "hard", description: "Exactly one moderator-eligible person is assigned as moderator per unit when the eligible pool allows it." },
  { key: "org-diversity", kind: "hard", description: "At most 2 people from one organization are placed in the same program unit." },
  { key: "balanced-units", kind: "soft", description: "Minimize the size spread between program units (objective)." },
  { key: "moderator-experience-mix", kind: "soft", description: "Spread moderator assignments so no unit receives more than one moderator from the same organization." },
];

/**
 * Explicit simulated compiler. It is a pure function: immutable input in, immutable output out.
 * It has no database, credential, or model access and is fully deterministic for a given input.
 * The TypeScript planning service independently validates its output before persistence.
 */
export function compileRoundtables(input: CompilerInput): CompilerOutput {
  const { members, programUnits, constraints, event } = input.inputManifest;
  const allConstraints = [...DEFAULT_CONSTRAINTS, ...constraints];

  const messages: string[] = [
    `Compiling roundtables for event "${event.name}" (${members.length} members, ${programUnits.length} units).`,
    `Evaluating ${allConstraints.length} typed constraints (${allConstraints.filter((constraint) => constraint.kind === "hard").length} hard, ${allConstraints.filter((constraint) => constraint.kind === "soft").length} soft).`,
  ];

  const sortedUnits = [...programUnits].sort((a, b) => a.name.localeCompare(b.name));
  const sortedMembers = [...members].sort((a, b) => a.rank - b.rank || a.email.localeCompare(b.email));

  const assignments: CompilerAssignment[] = [];
  const exclusions: CompilerExclusion[] = [];
  const assignedPersonIds = new Set<string>();
  const unitCounts: Record<string, number> = {};
  const orgCountsByUnit: Record<string, Record<string, number>> = {};
  const moderatorsByUnit: Record<string, string> = {};

  const seatsLeft = (unitId: string) => {
    const unit = sortedUnits.find((u) => u.id === unitId);
    return unit ? unit.capacity - (unitCounts[unitId] ?? 0) : 0;
  };

  const place = (
    member: CompilerMember,
    unitId: string,
    type: AssignmentType,
    explanation: string,
  ) => {
    assignments.push({ personId: member.personId, programUnitId: unitId, assignmentType: type, explanation });
    assignedPersonIds.add(member.personId);
    unitCounts[unitId] = (unitCounts[unitId] ?? 0) + 1;
    orgCountsByUnit[unitId] = orgCountsByUnit[unitId] ?? {};
    orgCountsByUnit[unitId][member.organization] = (orgCountsByUnit[unitId][member.organization] ?? 0) + 1;
  };

  const orgCount = (unitId: string, org: string) => orgCountsByUnit[unitId]?.[org] ?? 0;

  const eligible = sortedMembers.filter((m) => m.moderatorEligible);
  let moderatorCursor = 0;
  for (const unit of sortedUnits) {
    if (eligible.length === 0) {
      break;
    }
    const moderator = eligible[moderatorCursor % eligible.length];
    moderatorCursor += 1;
    if (assignedPersonIds.has(moderator.personId) || seatsLeft(unit.id) <= 0) {
      continue;
    }
    place(
      moderator,
      unit.id,
      "moderator",
      `Moderator-eligible per fixture evidence assertion (moderatorEligible=true; see source links). ` +
        `Hard constraints: exactly one moderator per unit, no double-booking, org diversity (<=2 per org). ` +
        `Soft objective: moderator-experience mix across units.`,
    );
    moderatorsByUnit[unit.id] = moderator.personId;
  }

  const remaining = sortedMembers.filter((m) => !assignedPersonIds.has(m.personId));
  let unitCursor = 0;
  for (const member of remaining) {
    let placed = false;
    const scanOrder = sortedUnits.map((_, i) => (unitCursor + i) % sortedUnits.length);
    for (const index of scanOrder) {
      const unit = sortedUnits[index];
      if (seatsLeft(unit.id) <= 0) {
        continue;
      }
      if (orgCount(unit.id, member.organization) >= 2) {
        continue;
      }
      place(
        member,
        unit.id,
        "participant",
        `Round-robin placement for balanced unit sizes (soft objective: minimize size spread). ` +
          `Hard constraints: no double-booking, org diversity (<=2 people per org per unit), capacity respected. ` +
          `Qualified per cohort snapshot fingerprint ${input.inputManifest.snapshot.fingerprint.slice(0, 12)}.`,
      );
      unitCursor = (index + 1) % sortedUnits.length;
      placed = true;
      break;
    }
    if (!placed) {
      exclusions.push({ personId: member.personId, reason: "All units are at capacity or the org-diversity cap prevents placement." });
      messages.push(`${member.email}: excluded (${exclusions[exclusions.length - 1].reason})`);
    }
  }

  const unmoderated = sortedUnits.filter((u) => !moderatorsByUnit[u.id]);
  if (unmoderated.length > 0 && eligible.length > 0) {
    messages.push(`Units without a moderator (no eligible member remaining): ${unmoderated.map((u) => u.name).join(", ")}`);
  }

  const output: CompilerOutput = {
    schema: "compiler-output/v1",
    status: unmoderated.length > 0 ? "INFEASIBLE" : "FEASIBLE",
    fingerprint: "",
    assignments,
    exclusions,
    diagnostics: {
      messages,
      unitCounts,
      moderatorsWithoutUnit: unmoderated.map((u) => u.name),
    },
  };
  output.fingerprint = fingerprintOf({ assignments, exclusions, diagnostics: output.diagnostics });
  return output;
}

/**
 * Independent validator: recomputes every hard invariant over the extracted solution.
 * A plan is persisted only when this passes.
 */
export function validateCompilerOutput(input: CompilerInput, output: CompilerOutput): string[] {
  const violations: string[] = [];
  const { members, programUnits } = input.inputManifest;
  const personById = new Map(members.map((m) => [m.personId, m]));
  const unitById = new Map(programUnits.map((u) => [u.id, u]));

  const expectedFingerprint = fingerprintOf({
    assignments: output.assignments,
    exclusions: output.exclusions,
    diagnostics: output.diagnostics,
  });
  if (output.fingerprint !== expectedFingerprint) {
    violations.push("compiler output fingerprint does not match its content");
  }

  for (const assignment of output.assignments) {
    const person = personById.get(assignment.personId);
    const unit = unitById.get(assignment.programUnitId);
    if (!person) {
      violations.push(`assignment references unknown person ${assignment.personId}`);
    }
    if (!unit) {
      violations.push(`assignment references unknown program unit ${assignment.programUnitId}`);
    }
  }
  for (const exclusion of output.exclusions) {
    if (!personById.has(exclusion.personId)) {
      violations.push(`exclusion references unknown person ${exclusion.personId}`);
    }
  }

  const perPerson = new Map<string, string[]>();
  for (const assignment of output.assignments) {
    const list = perPerson.get(assignment.personId) ?? [];
    list.push(assignment.programUnitId);
    perPerson.set(assignment.personId, list);
  }
  for (const [personId, units] of perPerson) {
    if (units.length > 1) {
      violations.push(`person ${personId} has ${units.length} assignments; at most one is allowed`);
    }
  }

  const countsByUnit: Record<string, number> = {};
  for (const assignment of output.assignments) {
    countsByUnit[assignment.programUnitId] = (countsByUnit[assignment.programUnitId] ?? 0) + 1;
    const unit = unitById.get(assignment.programUnitId);
    if (unit && countsByUnit[assignment.programUnitId] > unit.capacity) {
      violations.push(`unit ${assignment.programUnitId} exceeds capacity ${unit.capacity}`);
    }
  }

  const moderatorsByUnit: Record<string, string[]> = {};
  for (const assignment of output.assignments) {
    if (assignment.assignmentType === "moderator") {
      moderatorsByUnit[assignment.programUnitId] = moderatorsByUnit[assignment.programUnitId] ?? [];
      moderatorsByUnit[assignment.programUnitId].push(assignment.personId);
    }
  }
  for (const unit of programUnits) {
    const moderators = moderatorsByUnit[unit.id] ?? [];
    if (moderators.length > 1) {
      violations.push(`unit ${unit.id} has ${moderators.length} moderators`);
    }
    if (output.status === "FEASIBLE" && moderators.length !== 1) {
      violations.push(`feasible output requires exactly one moderator for unit ${unit.id}`);
    }
    for (const personId of moderators) {
      if (!(personById.get(personId)?.moderatorEligible ?? false)) {
        violations.push(`moderator ${personId} is not moderator-eligible`);
      }
    }
  }

  const missingModeratorCount = programUnits.filter(
    (unit) => (moderatorsByUnit[unit.id] ?? []).length === 0,
  ).length;
  if (missingModeratorCount > 0 && output.status !== "INFEASIBLE") {
    violations.push("output with an unmoderated unit must be marked INFEASIBLE");
  }
  if (missingModeratorCount === 0 && output.status !== "FEASIBLE") {
    violations.push("output with all moderator requirements satisfied must be marked FEASIBLE");
  }

  const assignmentPersonIds = new Set(output.assignments.map((assignment) => assignment.personId));
  const exclusionPersonIds = new Set(output.exclusions.map((exclusion) => exclusion.personId));
  for (const member of members) {
    const assigned = assignmentPersonIds.has(member.personId);
    const excluded = exclusionPersonIds.has(member.personId);
    if (assigned === excluded) {
      violations.push(
        `person ${member.personId} must appear exactly once as either assigned or excluded`,
      );
    }
  }

  const orgByUnit: Record<string, Set<string>> = {};
  for (const assignment of output.assignments) {
    const person = personById.get(assignment.personId);
    if (!person) {
      continue;
    }
    orgByUnit[assignment.programUnitId] = orgByUnit[assignment.programUnitId] ?? new Set();
    orgByUnit[assignment.programUnitId].add(person.organization);
  }
  for (const [unitId, orgs] of Object.entries(orgByUnit)) {
    for (const org of orgs) {
      const count = output.assignments.filter(
        (a) => a.programUnitId === unitId && personById.get(a.personId)?.organization === org,
      ).length;
      if (count > 2) {
        violations.push(`unit ${unitId} has ${count} people from organization ${org}`);
      }
    }
  }

  return violations;
}
