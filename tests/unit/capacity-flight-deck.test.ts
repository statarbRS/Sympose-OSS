import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CapacityFlightDeck } from "@/app/w/[workspace]/events/[eventId]/_components/capacity-flight-deck";
import {
  buildCapacityFlightDeckProjection,
  CapacityFlightDeckProjectionError,
} from "@/server/services/capacity-flight-deck";
import type { PlanDetail } from "@/server/services/planning";
import type { ProgramCapacitySurfaceProjection } from "@/server/services/program-capacity";
import type { ScheduleSnapshot } from "@/server/services/scheduling";
import { cfpSessionInventoryFingerprint } from "@/server/services/scheduling/canonical";

const WORKSPACE_ID = "workspace-flight-deck";
const EVENT_ID = "event-flight-deck";
const PLAN_ID = "plan-flight-deck";
const PLAN_FINGERPRINT = "a".repeat(64);
const INVENTORY_FINGERPRINT = "b".repeat(64);
const LEDGER_FINGERPRINT = "c".repeat(64);
const RECEIPT_FINGERPRINT = "d".repeat(64);

function capacityProjection(): ProgramCapacitySurfaceProjection {
  const currentVersion = (poolId: string, capacity: number) => ({
    id: `${poolId}-v1`,
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    poolId,
    versionNumber: 1,
    unitKind: "SEAT",
    capacity,
    scope: null,
    eligibility: null,
    reservedFor: null,
    releasePolicy: null,
    effectiveFrom: "2026-08-13T09:00:00.000Z",
    effectiveTo: null,
    fingerprint: poolId === "main" ? "1".repeat(64) : "2".repeat(64),
    createdAt: "2026-08-13T08:00:00.000Z",
  });
  return {
    ledger: {
      schema: "pd01-capacity-ledger/v1",
      workspaceId: WORKSPACE_ID,
      eventId: EVENT_ID,
      sequenceNumber: 1,
      ledgerFingerprint: LEDGER_FINGERPRINT,
      pools: [
        {
          poolId: "main",
          poolName: "Main audience",
          unitKind: "SEAT",
          versionId: "main-v1",
          versionNumber: 1,
          latestVersionId: "main-v1",
          latestVersionNumber: 1,
          capacity: 4,
          remaining: 3,
          remainingCapacity: 3,
          transferredIn: 0,
          transferredOut: 1,
        },
        {
          poolId: "reserve",
          poolName: "Access reserve",
          unitKind: "SEAT",
          versionId: "reserve-v1",
          versionNumber: 1,
          latestVersionId: "reserve-v1",
          latestVersionNumber: 1,
          capacity: 1,
          remaining: 2,
          remainingCapacity: 2,
          transferredIn: 1,
          transferredOut: 0,
        },
      ],
      totalCapacity: 5,
      totalRemaining: 5,
    },
    pools: [
      {
        id: "main",
        workspaceId: WORKSPACE_ID,
        eventId: EVENT_ID,
        unitKind: "SEAT",
        name: "Main audience",
        createdAt: "2026-08-13T08:00:00.000Z",
        archivedAt: null,
        currentVersion: currentVersion("main", 4),
      },
      {
        id: "reserve",
        workspaceId: WORKSPACE_ID,
        eventId: EVENT_ID,
        unitKind: "SEAT",
        name: "Access reserve",
        createdAt: "2026-08-13T08:00:00.000Z",
        archivedAt: null,
        currentVersion: currentVersion("reserve", 1),
      },
    ],
    history: [{
      receiptId: "receipt:transfer-1",
      decisionId: "transfer-1",
      workspaceId: WORKSPACE_ID,
      eventId: EVENT_ID,
      sequenceNumber: 1,
      sourcePoolId: "main",
      sourcePoolVersionId: "main-v1",
      destinationPoolId: "reserve",
      destinationPoolVersionId: "reserve-v1",
      unitKind: "SEAT",
      quantity: 1,
      sourceBefore: 4,
      sourceAfter: 3,
      destinationBefore: 1,
      destinationAfter: 2,
      recordedAt: "2026-08-13T10:00:00.000Z",
      fingerprint: RECEIPT_FINGERPRINT,
      actorAccountId: "organizer-flight-deck",
      reason: "Protect access reserve",
      approvalReference: "approval-capacity-1",
      decidedAt: "2026-08-13T10:00:00.000Z",
      idempotencyKey: "flight-deck-transfer-1",
      operation: "transfer",
    }],
  };
}

function acceptedSchedule(roomCapacity = 5): ScheduleSnapshot {
  return {
    schema: "schedule-draft/v1",
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    status: "DRAFT",
    revision: 1,
    event: {
      id: EVENT_ID,
      slug: EVENT_ID,
      name: "Flight Deck Symposium",
      timezone: "UTC",
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    },
    days: [{ id: "day-1", date: "2026-09-01", label: "Sep 1", ordinal: 1 }],
    tracks: [{ id: "track-main", name: "Main", ordinal: 1 }],
    rooms: [{ id: "room-main", name: "Main room", venue: "Event venue", capacity: roomCapacity }],
    timeSlots: [{
      id: "slot-1",
      dayId: "day-1",
      label: "09:00–10:00",
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T10:00:00.000Z",
      ordinal: 1,
    }],
    speakers: [],
    sessions: [{
      id: "session-accepted",
      slug: "session-accepted",
      title: "Accepted architecture session",
      abstract: "",
      durationMinutes: 60,
      capacity: 6,
      trackId: "track-main",
      speakerIds: [],
      priority: 1,
      public: true,
      placement: {
        dayId: "day-1",
        timeSlotId: "slot-1",
        roomId: "room-main",
        trackId: "track-main",
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-01T10:00:00.000Z",
      },
    }],
    planVersionId: PLAN_ID,
    planFingerprint: PLAN_FINGERPRINT,
    acceptedInventoryFingerprint: INVENTORY_FINGERPRINT,
    cfpSessionInventoryFingerprint: cfpSessionInventoryFingerprint([]),
    cfpSessionAuthorities: [],
    approvedAt: null,
  };
}

function planDetail(): PlanDetail {
  const explanation = "Hard constraints: capacity respected and no double-booking. Soft objective: balanced units.";
  return {
    version: {
      id: PLAN_ID,
      runId: "run-flight-deck",
      versionNumber: 3,
      fingerprint: PLAN_FINGERPRINT,
      assignmentCount: 1,
      runStatus: "FEASIBLE",
      status: "approved",
      createdAt: "2026-08-13T09:00:00.000Z",
      eventId: EVENT_ID,
    },
    content: {
      schema: "plan-version/v1",
      eventId: EVENT_ID,
      eventName: "Flight Deck Symposium",
      runId: "run-flight-deck",
      inputFingerprint: "e".repeat(64),
      snapshotFingerprint: "f".repeat(64),
      versionNumber: 3,
      assignments: [{ personId: "person-selected", programUnitId: "session-accepted", assignmentType: "moderator", explanation }],
      exclusions: [{ personId: "person-alternative", reason: "Capacity prevented placement." }],
      diagnostics: { messages: ["Evaluated typed constraints."], unitCounts: { "session-accepted": 1 }, moderatorsWithoutUnit: [] },
    },
    assignmentsJoined: [{
      personId: "person-selected",
      fullName: "Selected Speaker",
      email: "selected@example.test",
      organization: "Example Org",
      programUnitId: "session-accepted",
      programUnitName: "Accepted architecture session",
      assignmentType: "moderator",
      explanation,
    }],
    run: {
      id: "run-flight-deck",
      status: "FEASIBLE",
      inputFingerprint: "e".repeat(64),
      compiler: "fixture-compiler",
      compilerVersion: "1",
      createdAt: "2026-08-13T09:00:00.000Z",
    },
    approvals: [{ id: "approval-plan-3", createdAt: "2026-08-13T09:30:00.000Z", actorAccountId: "organizer-flight-deck" }],
    states: [{ state: "approved", createdAt: "2026-08-13T09:30:00.000Z", reason: null }],
  };
}

describe("Capacity Flight Deck projection", () => {
  it("derives conserved type-level coverage without inventing a pool allocation", () => {
    const projection = buildCapacityFlightDeckProjection({
      capacity: capacityProjection(),
      acceptedSchedule: acceptedSchedule(),
      plan: planDetail(),
    });

    expect(projection.capacity.poolTypes).toHaveLength(1);
    expect(projection.capacity.poolTypes[0]).toMatchObject({
      unitKind: "SEAT",
      configured: 5,
      conserved: 5,
      demand: 6,
      allocated: 5,
      remaining: 0,
      over: 1,
      utilizationPercent: 120,
      state: "OVER",
    });
    expect(projection.capacity.poolTypes[0]?.pools.map((pool) => pool.poolName)).toEqual([
      "Access reserve",
      "Main audience",
    ]);
    expect(projection.acceptedDemand.sessions[0]).toMatchObject({
      title: "Accepted architecture session",
      demand: 6,
      placement: { roomName: "Main room", roomCapacity: 5, over: 1, remaining: 0 },
    });
    expect(projection.capacity.transfers[0]).toMatchObject({
      sourcePoolName: "Main audience",
      destinationPoolName: "Access reserve",
      quantity: 1,
      reason: "Protect access reserve",
    });
    expect(projection.plan).toMatchObject({
      versionNumber: 3,
      alignsWithAcceptedDemand: true,
      alternatives: [{ personId: "person-alternative", reason: "Capacity prevented placement." }],
    });
    expect(projection.plan?.drivers[0]).toMatchObject({
      assignmentCount: 1,
      assignmentTypes: ["moderator"],
      programUnits: [{ id: "session-accepted", name: "Accepted architecture session" }],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.capacity.poolTypes[0])).toBe(true);

    const emptyCapacity = capacityProjection();
    const withoutConservedSeats = buildCapacityFlightDeckProjection({
      capacity: {
        ...emptyCapacity,
        ledger: { ...emptyCapacity.ledger, pools: [], totalCapacity: 0, totalRemaining: 0 },
        pools: [],
        history: [],
      },
      acceptedSchedule: acceptedSchedule(),
      plan: planDetail(),
    });
    expect(withoutConservedSeats.capacity.poolTypes[0]).toMatchObject({
      demand: 6,
      conserved: 0,
      over: 6,
      utilizationPercent: null,
    });
  });

  it("keeps missing demand unknown and fails closed across event scopes", () => {
    const withoutDemand = buildCapacityFlightDeckProjection({
      capacity: capacityProjection(),
      acceptedSchedule: null,
      plan: planDetail(),
    });
    expect(withoutDemand.acceptedDemand).toMatchObject({ available: false, total: null });
    expect(withoutDemand.capacity.poolTypes[0]).toMatchObject({
      demand: null,
      allocated: null,
      remaining: null,
      over: null,
      state: "NOT_PROJECTED",
    });

    expect(() => buildCapacityFlightDeckProjection({
      capacity: capacityProjection(),
      acceptedSchedule: { ...acceptedSchedule(), eventId: "other-event" },
      plan: planDetail(),
    })).toThrow(CapacityFlightDeckProjectionError);
  });

  it("renders empty, over-capacity, transfer, and plan-evidence states from the projection", () => {
    const emptyCapacity = capacityProjection();
    const projection = buildCapacityFlightDeckProjection({
      capacity: {
        ...emptyCapacity,
        ledger: {
          ...emptyCapacity.ledger,
          sequenceNumber: 0,
          ledgerFingerprint: "0".repeat(64),
          pools: [],
          totalCapacity: 0,
          totalRemaining: 0,
        },
        pools: [],
        history: [],
      },
      acceptedSchedule: acceptedSchedule(100),
      plan: planDetail(),
    });
    const html = renderToStaticMarkup(createElement(CapacityFlightDeck, { projection }));

    expect(html).toContain('data-testid="capacity-flight-deck"');
    expect(html).toContain('data-testid="capacity-empty-state"');
    expect(html).toContain("No conserved capacity pools exist for this event");
    expect(html).toContain('data-unit-kind="SEAT"');
    expect(html).toContain('data-state="over"');
    expect(html).toContain("6 demand uncovered by conserved pools");
    expect(html).not.toContain("6 over capacity");
    expect(html).toContain("94 remaining");
    expect(html).toContain("Accepted architecture session");
    expect(html).toContain("Hard constraints: capacity respected and no double-booking");
    expect(html).toContain("Evaluated typed constraints");
    expect(html).toContain("No conserved capacity exists, so a utilization ratio is not defined");
    expect(html).toContain("Capacity prevented placement");
    expect(html).toContain("No transfer or release receipt exists");
    expect(html).toContain(INVENTORY_FINGERPRINT);
    expect(html).toContain(PLAN_FINGERPRINT);

    const populatedHtml = renderToStaticMarkup(createElement(CapacityFlightDeck, {
      projection: buildCapacityFlightDeckProjection({
        capacity: capacityProjection(),
        acceptedSchedule: acceptedSchedule(),
        plan: planDetail(),
      }),
    }));
    expect(populatedHtml).toContain("Main audience");
    expect(populatedHtml).toContain("Access reserve");
    expect(populatedHtml).toContain("1 over capacity");
    expect(populatedHtml).not.toContain("demand uncovered by conserved pools");
    expect(populatedHtml).toContain("Protect access reserve");
    expect(populatedHtml).toContain("approval-capacity-1");
    expect(populatedHtml).toContain(RECEIPT_FINGERPRINT);
  });
});
