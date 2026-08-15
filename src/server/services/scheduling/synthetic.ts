import { deterministicFingerprint, immutableSchedule, scheduleContentFingerprint } from "./deterministic";
import { EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT } from "./types";
import type {
  ApprovedScheduleSnapshot,
  ScheduleDay,
  ScheduleEvent,
  ScheduleRoom,
  ScheduleSession,
  ScheduleSnapshot,
  ScheduleSpeaker,
  ScheduleTimeSlot,
  ScheduleTrack,
} from "./types";

export const SYNTHETIC_PUBLIC_EVENT_SLUG = "sympose-summit-2026";
export const SYNTHETIC_PUBLIC_WORKSPACE_ID = "workspace-synthetic-public";
export const SYNTHETIC_PUBLIC_EVENT_ID = "synthetic-summit-2026";
export const SYNTHETIC_PUBLIC_CHANNEL_ID = "synthetic-public-channel";

export interface SyntheticScheduleOptions {
  eventName?: string;
  eventSlug?: string;
  timezone?: string;
}

function days(): ScheduleDay[] {
  return [
    { id: "day-1", date: "2026-09-15", label: "Tuesday, September 15", ordinal: 1 },
    { id: "day-2", date: "2026-09-16", label: "Wednesday, September 16", ordinal: 2 },
  ];
}

function tracks(): ScheduleTrack[] {
  return [
    { id: "track-main", name: "Main stage", ordinal: 1 },
    { id: "track-practice", name: "Practice rooms", ordinal: 2 },
  ];
}

function rooms(): ScheduleRoom[] {
  return [
    { id: "room-hall", name: "Harbor Hall", venue: "Northstar Center", capacity: 240, internalNotes: "Organizer load-in notes are not public." },
    { id: "room-studio", name: "Studio 2", venue: "Northstar Center", capacity: 64, internalNotes: "Room access code: synthetic-only fixture." },
    { id: "room-forum", name: "Forum 1", venue: "Northstar Center", capacity: 80, internalNotes: "Sponsor hold is internal." },
  ];
}

function timeSlots(): ScheduleTimeSlot[] {
  return [
    { id: "slot-d1-0900", dayId: "day-1", label: "09:00–10:00", startsAt: "2026-09-15T09:00:00.000Z", endsAt: "2026-09-15T10:00:00.000Z", ordinal: 1 },
    { id: "slot-d1-1015", dayId: "day-1", label: "10:15–11:15", startsAt: "2026-09-15T10:15:00.000Z", endsAt: "2026-09-15T11:15:00.000Z", ordinal: 2 },
    { id: "slot-d1-1300", dayId: "day-1", label: "13:00–14:00", startsAt: "2026-09-15T13:00:00.000Z", endsAt: "2026-09-15T14:00:00.000Z", ordinal: 3 },
    { id: "slot-d2-0900", dayId: "day-2", label: "09:00–10:00", startsAt: "2026-09-16T09:00:00.000Z", endsAt: "2026-09-16T10:00:00.000Z", ordinal: 4 },
    { id: "slot-d2-1030", dayId: "day-2", label: "10:30–11:30", startsAt: "2026-09-16T10:30:00.000Z", endsAt: "2026-09-16T11:30:00.000Z", ordinal: 5 },
    { id: "slot-d2-1400", dayId: "day-2", label: "14:00–15:00", startsAt: "2026-09-16T14:00:00.000Z", endsAt: "2026-09-16T15:00:00.000Z", ordinal: 6 },
  ];
}

function speakers(): ScheduleSpeaker[] {
  return [
    { id: "speaker-alex", slug: "alex-rivera", displayName: "Alex Rivera", publicName: "Alex Rivera", organization: "Harbor Labs", bio: "Works on evidence-aware product systems.", email: "alex.private@example.test", privateNotes: "Never show the organizer briefing.", public: true },
    { id: "speaker-priya", slug: "priya-shah", displayName: "Priya Shah", publicName: "Priya Shah", organization: "Civic Data Co.", bio: "Designs practical data governance programs.", email: "priya.private@example.test", privateNotes: "Internal readiness score: 91.", public: true },
    { id: "speaker-mila", slug: "mila-chen", displayName: "Mila Chen", publicName: "Mila Chen", organization: "Open Table", bio: "Facilitates durable communities of practice.", email: "mila.private@example.test", privateNotes: "Speaker liaison notes are private.", public: true },
    { id: "speaker-jon", slug: "jon-bell", displayName: "Jon Bell", publicName: "Jon Bell", organization: "Field Notes", bio: "Explores the operational side of inclusive events.", email: "jon.private@example.test", privateNotes: "Do not expose contract terms.", public: true },
    { id: "speaker-samira", slug: "samira-patel", displayName: "Samira Patel", publicName: "Samira Patel", organization: "Gather Works", bio: "Designs event programs that connect editorial intent with audience needs.", email: "samira.private@example.test", privateNotes: "Editorial briefing remains organizer-only.", public: true },
  ];
}

function placement(dayId: string, timeSlotId: string, roomId: string, trackId: string, startsAt: string, endsAt: string) {
  return { dayId, timeSlotId, roomId, trackId, startsAt, endsAt };
}

function sessions(): ScheduleSession[] {
  return [
    {
      id: "session-trust",
      slug: "trust-is-a-schedule",
      title: "Trust is a schedule",
      abstract: "How explicit constraints make event decisions legible.",
      durationMinutes: 60,
      capacity: 220,
      trackId: "track-main",
      speakerIds: ["speaker-alex", "speaker-samira"],
      priority: 100,
      public: true,
      internalNotes: "Opening session briefing is organizer-only.",
      placement: placement("day-1", "slot-d1-0900", "room-hall", "track-main", "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z"),
    },
    {
      id: "session-data",
      slug: "data-without-mystery",
      title: "Data without mystery",
      abstract: "A workshop on explainable evidence and bounded decisions.",
      durationMinutes: 60,
      capacity: 56,
      trackId: "track-practice",
      speakerIds: ["speaker-alex"],
      priority: 90,
      public: true,
      internalNotes: "Organizer notes contain private rehearsal details.",
      placement: placement("day-1", "slot-d1-0900", "room-studio", "track-practice", "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z"),
    },
    {
      id: "session-clinic",
      slug: "redaction-clinic",
      title: "Redaction clinic",
      abstract: "Practice turning internal records into audience-safe projections.",
      durationMinutes: 60,
      capacity: 56,
      trackId: "track-practice",
      speakerIds: ["speaker-priya"],
      priority: 80,
      public: true,
      internalNotes: "Private partner examples are withheld from publication.",
      placement: placement("day-1", "slot-d1-0900", "room-studio", "track-practice", "2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z"),
    },
    {
      id: "session-community",
      slug: "make-room-for-people",
      title: "Make room for people",
      abstract: "Facilitation patterns for a program that can adapt without erasing history.",
      durationMinutes: 60,
      capacity: 70,
      trackId: "track-practice",
      speakerIds: ["speaker-mila"],
      priority: 70,
      public: true,
      internalNotes: "Unscheduled draft session.",
      placement: null,
    },
    {
      id: "session-operations",
      slug: "operations-without-surprises",
      title: "Operations without surprises",
      abstract: "A field guide to turning approved plans into calm event-day work.",
      durationMinutes: 60,
      capacity: 76,
      trackId: "track-practice",
      speakerIds: ["speaker-jon"],
      priority: 60,
      public: true,
      internalNotes: "Operations checklist remains organizer-only.",
      placement: placement("day-2", "slot-d2-0900", "room-forum", "track-practice", "2026-09-16T09:00:00.000Z", "2026-09-16T10:00:00.000Z"),
    },
    {
      id: "session-closing",
      slug: "the-release-is-a-promise",
      title: "The release is a promise",
      abstract: "Why a public agenda should be stable, inspectable, and audience-specific.",
      durationMinutes: 60,
      capacity: 220,
      trackId: "track-main",
      speakerIds: ["speaker-alex", "speaker-mila"],
      priority: 50,
      public: true,
      internalNotes: "Closing remarks draft is not a public source record.",
      placement: placement("day-2", "slot-d2-1400", "room-hall", "track-main", "2026-09-16T14:00:00.000Z", "2026-09-16T15:00:00.000Z"),
    },
  ];
}

function baseEvent(scope: { eventId: string }, options: SyntheticScheduleOptions): ScheduleEvent {
  return {
    id: scope.eventId,
    slug: options.eventSlug ?? SYNTHETIC_PUBLIC_EVENT_SLUG,
    name: options.eventName ?? "Sympose Summit 2026",
    timezone: options.timezone ?? "UTC",
    startsAt: "2026-09-15T09:00:00.000Z",
    endsAt: "2026-09-16T15:00:00.000Z",
  };
}

export function createSyntheticScheduleProjection(
  scope: { workspaceId: string; eventId: string },
  options: SyntheticScheduleOptions = {},
): ScheduleSnapshot {
  const event = baseEvent(scope, options);
  const draft: ScheduleSnapshot = {
    schema: "schedule-draft/v1",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    status: "DRAFT",
    revision: 1,
    event,
    days: days(),
    tracks: tracks(),
    rooms: rooms(),
    timeSlots: timeSlots(),
    speakers: speakers(),
    sessions: sessions(),
    planVersionId: `synthetic-draft:${scope.eventId}`,
    planFingerprint: "",
    acceptedInventoryFingerprint: deterministicFingerprint({ scope, source: "synthetic-draft-inventory" }),
    cfpSessionInventoryFingerprint: EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT,
    cfpSessionAuthorities: [],
    approvedAt: null,
  };
  draft.planFingerprint = scheduleContentFingerprint(draft);
  return immutableSchedule(draft);
}

function cleanSessions(): ScheduleSession[] {
  return sessions().map((session) => {
    if (session.id === "session-data") {
      return { ...session, placement: placement("day-1", "slot-d1-1015", "room-studio", "track-practice", "2026-09-15T10:15:00.000Z", "2026-09-15T11:15:00.000Z") };
    }
    if (session.id === "session-clinic") {
      return { ...session, placement: placement("day-1", "slot-d1-1300", "room-forum", "track-practice", "2026-09-15T13:00:00.000Z", "2026-09-15T14:00:00.000Z") };
    }
    if (session.id === "session-community") {
      return { ...session, placement: placement("day-2", "slot-d2-1030", "room-studio", "track-practice", "2026-09-16T10:30:00.000Z", "2026-09-16T11:30:00.000Z") };
    }
    return { ...session, placement: session.placement ? { ...session.placement } : null };
  });
}

export function createSyntheticApprovedScheduleProjection(
  scope: { workspaceId: string; eventId: string },
  options: SyntheticScheduleOptions = {},
): ApprovedScheduleSnapshot {
  const approved: ApprovedScheduleSnapshot = {
    ...createSyntheticScheduleProjection(scope, options),
    status: "APPROVED",
    revision: 1,
    sessions: cleanSessions(),
    planVersionId: `synthetic-approved:${scope.eventId}`,
    approvedAt: "2026-08-12T09:00:00.000Z",
    planFingerprint: "",
    acceptedInventoryFingerprint: deterministicFingerprint({ scope, source: "synthetic-approved-inventory" }),
    cfpSessionInventoryFingerprint: EMPTY_CFP_SESSION_INVENTORY_FINGERPRINT,
    cfpSessionAuthorities: [],
  };
  approved.planFingerprint = scheduleContentFingerprint(approved);
  return immutableSchedule(approved) as ApprovedScheduleSnapshot;
}

export function syntheticScheduleFixtureFingerprint(scope: { workspaceId: string; eventId: string }): string {
  return deterministicFingerprint(createSyntheticScheduleProjection(scope));
}
