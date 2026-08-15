import type { Db } from "../../db";
import type { ScheduleSnapshot } from "./types";

/**
 * Prove that every selected placement is represented by the exact tenant/event-scoped canonical
 * allocation rows. Draft and publication approval both use this same fail-closed predicate.
 */
export function scheduleAllocationsAreDurable(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  selected: readonly ScheduleSnapshot["sessions"][number][],
): boolean {
  const row = db.prepare(
    `SELECT (
        EXISTS (SELECT 1 FROM event_rooms WHERE workspace_id = ? AND event_id = ?)
        AND EXISTS (SELECT 1 FROM event_tracks WHERE workspace_id = ? AND event_id = ?)
      ) AS configured`,
  ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId) as { configured: number };
  if (row.configured !== 1 || selected.length === 0) return false;
  const allocations = db.prepare(
    `SELECT program_unit_id AS programUnitId, room_id AS roomId, track_id AS trackId,
            starts_at AS startsAt, ends_at AS endsAt, allocation_status AS allocationStatus
       FROM event_session_allocations
      WHERE workspace_id = ? AND event_id = ?
        AND allocation_status IN ('DRAFT', 'PUBLISHED')
      ORDER BY program_unit_id, id`,
  ).all(scope.workspaceId, scope.eventId) as Array<{
    programUnitId: string;
    roomId: string;
    trackId: string | null;
    startsAt: string;
    endsAt: string;
    allocationStatus: string;
  }>;
  if (allocations.length !== selected.length) return false;
  const selectedIds = new Set(selected.map((session) => session.id));
  if (selectedIds.size !== selected.length || allocations.some((allocation) => !selectedIds.has(allocation.programUnitId))) {
    return false;
  }
  const byUnit = new Map(allocations.map((allocation) => [allocation.programUnitId, allocation]));
  if (byUnit.size !== allocations.length) return false;
  return selected.every((session) => {
    const placement = session.placement;
    const allocation = byUnit.get(session.id);
    return Boolean(
      placement && allocation &&
      (allocation.allocationStatus === "DRAFT" || allocation.allocationStatus === "PUBLISHED") &&
      allocation.roomId === placement.roomId && allocation.trackId === placement.trackId &&
      allocation.startsAt === placement.startsAt && allocation.endsAt === placement.endsAt,
    );
  });
}
