import type { PlanDetail } from "./planning";
import type {
  CapacityLedgerEntry,
  CapacityTransferHistoryEntry,
  ProgramCapacitySurfaceProjection,
} from "./program-capacity";
import type { ScheduleSnapshot } from "./scheduling";

export const ACCEPTED_SESSION_DEMAND_UNIT = "SEAT" as const;

export class CapacityFlightDeckProjectionError extends Error {
  readonly code = "CAPACITY_FLIGHT_DECK_INVALID";

  constructor(message = "The Capacity Flight Deck sources do not form one valid event projection.") {
    super(message);
    this.name = "CapacityFlightDeckProjectionError";
  }
}

export interface CapacityFlightDeckPoolType {
  readonly unitKind: string;
  readonly configured: number;
  /** Current conserved balance after the explicit transfer ledger is applied. */
  readonly conserved: number;
  /** Accepted-session demand is projected only for the canonical SEAT unit. */
  readonly demand: number | null;
  /** Type-level demand covered by conserved balance; this is not a persisted pool allocation. */
  readonly allocated: number | null;
  readonly remaining: number | null;
  readonly over: number | null;
  readonly utilizationPercent: number | null;
  readonly state: "NOT_PROJECTED" | "CLEAR" | "OVER";
  readonly pools: readonly CapacityLedgerEntry[];
}

export interface CapacityFlightDeckSessionDemand {
  readonly id: string;
  readonly title: string;
  readonly demand: number;
  readonly unitKind: typeof ACCEPTED_SESSION_DEMAND_UNIT;
  readonly placement: null | {
    readonly roomId: string;
    readonly roomName: string;
    readonly roomCapacity: number;
    readonly remaining: number;
    readonly over: number;
  };
}

export interface CapacityFlightDeckDriver {
  readonly explanation: string;
  readonly assignmentCount: number;
  readonly assignmentTypes: readonly string[];
  readonly programUnits: readonly { readonly id: string; readonly name: string }[];
}

export interface CapacityFlightDeckTransfer extends CapacityTransferHistoryEntry {
  readonly sourcePoolName: string;
  readonly destinationPoolName: string;
}

export interface CapacityFlightDeckProjection {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly capacity: {
    readonly sequenceNumber: number;
    readonly ledgerFingerprint: string;
    readonly poolTypes: readonly CapacityFlightDeckPoolType[];
    readonly poolCount: number;
    readonly transfers: readonly CapacityFlightDeckTransfer[];
  };
  readonly acceptedDemand: {
    readonly available: boolean;
    readonly unitKind: typeof ACCEPTED_SESSION_DEMAND_UNIT;
    readonly total: number | null;
    readonly sessions: readonly CapacityFlightDeckSessionDemand[];
    readonly inventoryFingerprint: string | null;
    readonly planVersionId: string | null;
    readonly planFingerprint: string | null;
  };
  readonly plan: null | {
    readonly id: string;
    readonly versionNumber: number;
    readonly status: string;
    readonly fingerprint: string;
    readonly assignmentCount: number;
    readonly alignsWithAcceptedDemand: boolean | null;
    readonly drivers: readonly CapacityFlightDeckDriver[];
    readonly alternatives: readonly { readonly personId: string; readonly reason: string }[];
    readonly diagnosticMessages: readonly string[];
  };
}

function fail(message: string): never {
  throw new CapacityFlightDeckProjectionError(message);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    fail(`${label} exceeds the safe projection range.`);
  }
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key));
    }
    Object.freeze(value);
  }
  return value;
}

function acceptedSessionDemand(schedule: ScheduleSnapshot | null): CapacityFlightDeckProjection["acceptedDemand"] {
  if (!schedule) {
    return {
      available: false,
      unitKind: ACCEPTED_SESSION_DEMAND_UNIT,
      total: null,
      sessions: [],
      inventoryFingerprint: null,
      planVersionId: null,
      planFingerprint: null,
    };
  }

  const rooms = new Map(schedule.rooms.map((room) => [room.id, room]));
  let total = 0;
  const sessions = [...schedule.sessions]
    .sort((first, second) => first.title.localeCompare(second.title) || first.id.localeCompare(second.id))
    .map((session) => {
      const demand = positiveInteger(session.capacity, `Accepted session ${session.id} demand`);
      total = safeAdd(total, demand, "Accepted-session demand");
      if (!session.placement) {
        return {
          id: session.id,
          title: session.title,
          demand,
          unitKind: ACCEPTED_SESSION_DEMAND_UNIT,
          placement: null,
        } satisfies CapacityFlightDeckSessionDemand;
      }
      const room = rooms.get(session.placement.roomId);
      if (!room) {
        return fail(`Accepted session ${session.id} references an unknown room.`);
      }
      const roomCapacity = positiveInteger(room.capacity, `Room ${room.id} capacity`);
      return {
        id: session.id,
        title: session.title,
        demand,
        unitKind: ACCEPTED_SESSION_DEMAND_UNIT,
        placement: {
          roomId: room.id,
          roomName: room.name,
          roomCapacity,
          remaining: Math.max(roomCapacity - demand, 0),
          over: Math.max(demand - roomCapacity, 0),
        },
      } satisfies CapacityFlightDeckSessionDemand;
    });

  return {
    available: true,
    unitKind: ACCEPTED_SESSION_DEMAND_UNIT,
    total,
    sessions,
    inventoryFingerprint: schedule.acceptedInventoryFingerprint,
    planVersionId: schedule.planVersionId,
    planFingerprint: schedule.planFingerprint,
  };
}

function poolTypeProjection(
  capacity: ProgramCapacitySurfaceProjection,
  demand: CapacityFlightDeckProjection["acceptedDemand"],
): readonly CapacityFlightDeckPoolType[] {
  const poolsByUnit = new Map<string, CapacityLedgerEntry[]>();
  for (const pool of capacity.ledger.pools) {
    const pools = poolsByUnit.get(pool.unitKind) ?? [];
    pools.push(pool);
    poolsByUnit.set(pool.unitKind, pools);
  }
  if (demand.available && !poolsByUnit.has(ACCEPTED_SESSION_DEMAND_UNIT)) {
    poolsByUnit.set(ACCEPTED_SESSION_DEMAND_UNIT, []);
  }

  return [...poolsByUnit.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([unitKind, pools]) => {
      const orderedPools = pools.map((pool) => ({ ...pool })).sort((first, second) =>
        first.poolName.localeCompare(second.poolName) || first.poolId.localeCompare(second.poolId));
      let configured = 0;
      let conserved = 0;
      for (const pool of orderedPools) {
        configured = safeAdd(configured, pool.capacity, `${unitKind} configured capacity`);
        conserved = safeAdd(conserved, pool.remaining, `${unitKind} conserved capacity`);
      }
      const typedDemand = demand.available
        ? unitKind === ACCEPTED_SESSION_DEMAND_UNIT ? demand.total ?? 0 : 0
        : null;
      const allocated = typedDemand === null ? null : Math.min(typedDemand, conserved);
      const remaining = typedDemand === null ? null : Math.max(conserved - typedDemand, 0);
      const over = typedDemand === null ? null : Math.max(typedDemand - conserved, 0);
      const utilizationPercent = typedDemand === null
        ? null
        : conserved === 0
          ? typedDemand === 0 ? 0 : null
          : Math.round((typedDemand / conserved) * 100);
      return {
        unitKind,
        configured,
        conserved,
        demand: typedDemand,
        allocated,
        remaining,
        over,
        utilizationPercent,
        state: typedDemand === null ? "NOT_PROJECTED" : over !== null && over > 0 ? "OVER" : "CLEAR",
        pools: orderedPools,
      } satisfies CapacityFlightDeckPoolType;
    });
}

function planProjection(
  plan: PlanDetail | null,
  demand: CapacityFlightDeckProjection["acceptedDemand"],
): CapacityFlightDeckProjection["plan"] {
  if (!plan) return null;

  const grouped = new Map<string, {
    assignmentCount: number;
    assignmentTypes: Set<string>;
    programUnits: Map<string, string>;
  }>();
  for (const assignment of plan.assignmentsJoined) {
    const current = grouped.get(assignment.explanation) ?? {
      assignmentCount: 0,
      assignmentTypes: new Set<string>(),
      programUnits: new Map<string, string>(),
    };
    current.assignmentCount = safeAdd(current.assignmentCount, 1, "Plan driver assignment count");
    current.assignmentTypes.add(assignment.assignmentType);
    current.programUnits.set(assignment.programUnitId, assignment.programUnitName);
    grouped.set(assignment.explanation, current);
  }

  const drivers = [...grouped.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([explanation, group]) => ({
      explanation,
      assignmentCount: group.assignmentCount,
      assignmentTypes: [...group.assignmentTypes].sort(),
      programUnits: [...group.programUnits.entries()]
        .sort(([, first], [, second]) => first.localeCompare(second))
        .map(([id, name]) => ({ id, name })),
    }));

  return {
    id: plan.version.id,
    versionNumber: plan.version.versionNumber,
    status: plan.version.status,
    fingerprint: plan.version.fingerprint,
    assignmentCount: plan.assignmentsJoined.length,
    alignsWithAcceptedDemand: demand.available ? demand.planVersionId === plan.version.id : null,
    drivers,
    alternatives: [...plan.content.exclusions]
      .map(({ personId, reason }) => ({ personId, reason }))
      .sort((first, second) => first.personId.localeCompare(second.personId) || first.reason.localeCompare(second.reason)),
    diagnosticMessages: [...plan.content.diagnostics.messages],
  };
}

export function buildCapacityFlightDeckProjection(input: {
  readonly capacity: ProgramCapacitySurfaceProjection;
  readonly acceptedSchedule: ScheduleSnapshot | null;
  readonly plan: PlanDetail | null;
}): CapacityFlightDeckProjection {
  const { capacity, acceptedSchedule, plan } = input;
  const { workspaceId, eventId } = capacity.ledger;
  if (acceptedSchedule && (
    acceptedSchedule.workspaceId !== workspaceId
    || acceptedSchedule.eventId !== eventId
  )) {
    fail("Accepted-session demand belongs to a different workspace or event.");
  }
  if (plan && (
    plan.version.eventId !== eventId
    || plan.content.eventId !== eventId
  )) {
    fail("Plan evidence belongs to a different event.");
  }

  const acceptedDemand = acceptedSessionDemand(acceptedSchedule);
  const poolNames = new Map(capacity.ledger.pools.map((pool) => [pool.poolId, pool.poolName]));
  const transfers = capacity.history.map((entry) => ({
    ...entry,
    sourcePoolName: poolNames.get(entry.sourcePoolId) ?? entry.sourcePoolId,
    destinationPoolName: poolNames.get(entry.destinationPoolId) ?? entry.destinationPoolId,
  }));

  return deepFreeze({
    workspaceId,
    eventId,
    capacity: {
      sequenceNumber: capacity.ledger.sequenceNumber,
      ledgerFingerprint: capacity.ledger.ledgerFingerprint,
      poolTypes: poolTypeProjection(capacity, acceptedDemand),
      poolCount: capacity.ledger.pools.length,
      transfers,
    },
    acceptedDemand,
    plan: planProjection(plan, acceptedDemand),
  });
}
