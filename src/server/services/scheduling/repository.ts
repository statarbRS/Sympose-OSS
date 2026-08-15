import { cloneSchedule, immutableSchedule, ScheduleCommandError } from "./deterministic";
import { createSyntheticScheduleProjection } from "./synthetic";
import type { ScheduleSnapshot } from "./types";

export interface ScheduleRepository {
  readSchedule(scope: { workspaceId: string; eventId: string }): ScheduleSnapshot | null;
  writeSchedule(
    scope: { workspaceId: string; eventId: string },
    expectedRevision: number,
    schedule: ScheduleSnapshot,
  ): ScheduleSnapshot;
}

function scopeKey(scope: { workspaceId: string; eventId: string }): string {
  return `${scope.workspaceId}\u0000${scope.eventId}`;
}

function assertScope(schedule: ScheduleSnapshot, scope: { workspaceId: string; eventId: string }): void {
  if (schedule.workspaceId !== scope.workspaceId || schedule.eventId !== scope.eventId) {
    throw new ScheduleCommandError(
      "SCHEDULE_SCOPE_MISMATCH",
      "The requested schedule is outside the authorized workspace and event scope.",
    );
  }
}

/**
 * S0 adapter seam. It intentionally stores only immutable snapshots in memory; a future repository
 * can bind these methods to reviewed persistence without changing scheduling commands or UI.
 */
export class InMemoryScheduleRepository implements ScheduleRepository {
  private readonly schedules = new Map<string, ScheduleSnapshot>();

  constructor(seed: ScheduleSnapshot[] = []) {
    for (const schedule of seed) {
      this.schedules.set(scopeKey(schedule), immutableSchedule(schedule));
    }
  }

  readSchedule(scope: { workspaceId: string; eventId: string }): ScheduleSnapshot | null {
    const schedule = this.schedules.get(scopeKey(scope));
    return schedule ? cloneSchedule(schedule) : null;
  }

  writeSchedule(
    scope: { workspaceId: string; eventId: string },
    expectedRevision: number,
    schedule: ScheduleSnapshot,
  ): ScheduleSnapshot {
    assertScope(schedule, scope);
    const key = scopeKey(scope);
    const current = this.schedules.get(key);
    if (!current) {
      throw new ScheduleCommandError("SCHEDULE_NOT_FOUND", "The requested schedule does not exist in this adapter.");
    }
    if (current.revision !== expectedRevision) {
      throw new ScheduleCommandError("SCHEDULE_REVISION_CONFLICT", "The schedule changed before this write was applied.");
    }
    if (schedule.revision !== expectedRevision + 1) {
      throw new ScheduleCommandError("SCHEDULE_REVISION_INVALID", "A schedule write must advance the revision exactly once.");
    }
    const stored = immutableSchedule(schedule);
    this.schedules.set(key, stored);
    return cloneSchedule(stored);
  }
}

export function createSyntheticScheduleRepository(scope: { workspaceId: string; eventId: string }): InMemoryScheduleRepository {
  return new InMemoryScheduleRepository([createSyntheticScheduleProjection(scope)]);
}
