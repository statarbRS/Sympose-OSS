export const EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export type ScheduleStatus = "DRAFT" | "APPROVED";

export interface ScheduleScope {
  workspaceId: string;
  eventId: string;
}

export interface ScheduleEvent {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
}

export interface ScheduleDay {
  id: string;
  date: string;
  label: string;
  ordinal: number;
}

export interface ScheduleTrack {
  id: string;
  name: string;
  ordinal: number;
}

export interface ScheduleRoom {
  id: string;
  name: string;
  venue: string;
  capacity: number;
  internalNotes?: string;
}

export interface ScheduleTimeSlot {
  id: string;
  dayId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  ordinal: number;
}

export interface ScheduleSpeaker {
  id: string;
  slug: string;
  displayName: string;
  publicName: string;
  organization: string;
  bio: string;
  email: string;
  privateNotes?: string;
  public: boolean;
}

export interface SchedulePlacement {
  dayId: string;
  timeSlotId: string;
  roomId: string;
  trackId: string;
  startsAt: string;
  endsAt: string;
}

export interface SchedulePlacementTarget {
  dayId: string;
  timeSlotId: string;
  roomId: string;
  trackId: string;
}

export interface ScheduleConfigurationInput {
  rooms: ScheduleRoom[];
  tracks: ScheduleTrack[];
  expectedRevision: number;
  reason?: string;
}

export type ScheduleDraftCommand =
  | {
      kind: "MOVE";
      sessionId: string;
      target: SchedulePlacementTarget;
      reason?: string;
    }
  | {
      kind: "CLEAR";
      sessionId: string;
      reason?: string;
    }
  | {
      kind: "CLEAR_CONFLICT";
      conflictId: string;
      sessionId: string;
      reason?: string;
    }
  | {
      kind: "CONFIGURE";
      rooms: ScheduleRoom[];
      tracks: ScheduleTrack[];
      reason?: string;
    }
  | {
      kind: "AUTO_PLACE";
      reason?: string;
    };

export interface ScheduleSession {
  id: string;
  slug: string;
  title: string;
  abstract: string;
  durationMinutes: number;
  capacity: number;
  trackId: string;
  speakerIds: string[];
  priority: number;
  public: boolean;
  internalNotes?: string;
  placement: SchedulePlacement | null;
}

export interface CfpScheduleSessionAuthority {
  programUnitId: string;
  sessionFingerprint: string;
  linkFingerprints: string[];
}

export type ScheduleConflictKind = "SPEAKER_OVERLAP" | "ROOM_OVERLAP";

export interface ScheduleConflict {
  id: string;
  kind: ScheduleConflictKind;
  severity: "HARD";
  ruleKey: "SPEAKER_NO_OVERLAP" | "ROOM_NO_OVERLAP";
  sessionIds: [string, string];
  resourceId: string;
  resourceLabel: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  explanation: string;
  suggestedActions: string[];
}

export interface ScheduleSnapshot extends ScheduleScope {
  schema: "schedule-draft/v1";
  status: ScheduleStatus;
  revision: number;
  event: ScheduleEvent;
  days: ScheduleDay[];
  tracks: ScheduleTrack[];
  rooms: ScheduleRoom[];
  timeSlots: ScheduleTimeSlot[];
  speakers: ScheduleSpeaker[];
  sessions: ScheduleSession[];
  planVersionId: string;
  planFingerprint: string;
  acceptedInventoryFingerprint: string;
  cfpSessionInventoryFingerprint: string;
  cfpSessionAuthorities: CfpScheduleSessionAuthority[];
  approvedAt: string | null;
}

export interface ApprovedScheduleSnapshot extends ScheduleSnapshot {
  status: "APPROVED";
  approvedAt: string;
}

export interface ScheduleChange {
  kind: "MOVE" | "CLEAR" | "AUTO_PLACE" | "CONFIGURE" | "APPROVE";
  sessionId?: string;
  from: SchedulePlacement | null;
  to: SchedulePlacement | null;
  reason: string;
  changeFingerprint: string;
}

export interface ScheduleMutationResult {
  schedule: ScheduleSnapshot;
  conflicts: ScheduleConflict[];
  change: ScheduleChange;
}

export interface ClearConflictResult {
  schedule: ScheduleSnapshot;
  clearedConflictId: string;
  clearedSessionId: string;
  conflictsBefore: ScheduleConflict[];
  conflictsAfter: ScheduleConflict[];
  explanation: string;
}

export interface AutoPlaceResult {
  schedule: ScheduleSnapshot;
  placedSessionIds: string[];
  unplacedSessionIds: string[];
  conflicts: ScheduleConflict[];
  change: ScheduleChange | null;
}

export interface ScheduleDraftPointer extends ScheduleScope {
  schema: "schedule-draft-pointer/v1";
  revision: number;
  planVersionId: string;
  planFingerprint: string;
  acceptedInventoryFingerprint: string;
  cfpSessionInventoryFingerprint?: string;
  cfpSessionAuthorities?: CfpScheduleSessionAuthority[];
  activeDayId?: string;
  rooms?: Array<Pick<ScheduleRoom, "id" | "name" | "venue" | "capacity">>;
  tracks?: Array<Pick<ScheduleTrack, "id" | "name" | "ordinal">>;
  placements: Array<{
    sessionId: string;
    placement: SchedulePlacement | null;
  }>;
}

export interface ScheduleDraftActionSuccess {
  readonly ok: true;
  readonly code: "SCHEDULE_DRAFT_SAVED" | "SCHEDULE_DRAFT_UNCHANGED";
  readonly changed: boolean;
  readonly pointer: ScheduleDraftPointer | null;
  /** SHA-256 of the exact approval subject returned by the trusted server. */
  readonly scheduleAuthorityFingerprint: string | null;
}

export interface ScheduleDraftActionFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly pointer?: ScheduleDraftPointer | null;
}

export type ScheduleDraftActionResult = ScheduleDraftActionSuccess | ScheduleDraftActionFailure;
