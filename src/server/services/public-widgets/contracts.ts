/**
 * The public-widget boundary is intentionally narrower than the organizer model.
 * Scheduling/publication can bind this contract to a sealed release without making
 * planner rows, provider payloads, or mutable event state a portal dependency.
 */

import {
  isAudienceReference,
  publicPersonReference,
  publicProgramUnitReference,
  publicReleaseReference,
  type AudienceReferenceScope,
} from "../public-reference";

export const PUBLISHED_EVENT_PROJECTION_SCHEMA = "published-event-projection/v1" as const;
export const PUBLIC_WIDGET_PROJECTION_SCHEMA = "public-widget-projection/v1" as const;

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SESSIONS = 500;
const MAX_SPEAKERS = 500;
const MAX_SPEAKER_REFERENCES = 24;

export type PublicationApproval = "APPROVED" | "PENDING" | "WITHHELD";
export type PublicationVisibility = "PUBLIC" | "PRIVATE";

export interface PublishedReleaseProjection {
  readonly channelReference: string;
  readonly releaseNumber: number;
  readonly status: "SEALED";
  readonly audience: "PUBLIC";
  readonly approval: "APPROVED";
  readonly current: boolean;
  readonly revokedAt: string | null;
  readonly sealedAt: string;
  readonly fingerprint: string;
  readonly sourcePlanVersionId: string;
  readonly audiencePolicyVersion: number;
  readonly commitmentWatermark: number;
}

export interface PublishedEventProjection {
  readonly schema: typeof PUBLISHED_EVENT_PROJECTION_SCHEMA;
  /** Integration binding fields. None are returned by the public redactor. */
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
  readonly release: PublishedReleaseProjection;
  readonly event: {
    readonly publicReference: string;
    readonly title: string;
    readonly summary: string;
    readonly timezone: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
  readonly sessions: readonly PublishedSessionProjection[];
  readonly speakers: readonly PublishedSpeakerProjection[];
}

export interface PublishedSessionProjection {
  readonly publicReference: string;
  readonly title: string;
  readonly description: string;
  readonly room: string | null;
  readonly track: string | null;
  readonly format: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly speakerReferences: readonly string[];
  readonly approval: PublicationApproval;
  readonly visibility: PublicationVisibility;
}

export interface PublishedSpeakerProjection {
  readonly publicReference: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly organization: string | null;
  readonly bio: string | null;
  readonly photoUrl: string | null;
  readonly sessionReferences: readonly string[];
  readonly approval: PublicationApproval;
  readonly visibility: PublicationVisibility;
}

export interface PublicSession {
  readonly publicReference: string;
  readonly title: string;
  readonly description: string;
  readonly room: string | null;
  readonly track: string | null;
  readonly format: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly speakerReferences: readonly string[];
  readonly speakers: readonly PublicSpeakerSummary[];
}

export interface PublicSpeakerSummary {
  readonly publicReference: string;
  readonly displayName: string;
}

export interface PublicSpeaker {
  readonly publicReference: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly organization: string | null;
  readonly bio: string | null;
  readonly photoUrl: string | null;
  readonly sessionReferences: readonly string[];
}

export interface PublicWidgetProjection {
  readonly schema: typeof PUBLIC_WIDGET_PROJECTION_SCHEMA;
  readonly event: {
    readonly publicReference: string;
    readonly title: string;
    readonly summary: string;
    readonly timezone: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
  readonly release: {
    readonly channelReference: string;
    readonly releaseNumber: number;
    readonly sealedAt: string;
    /** Dedicated audience reference for the exact sealed release. */
    readonly releaseReference: string;
  };
  readonly sessions: readonly PublicSession[];
  readonly speakers: readonly PublicSpeaker[];
}

export class PublishedProjectionValidationError extends Error {
  readonly code = "INVALID_PUBLISHED_EVENT_PROJECTION" as const;

  constructor(message = "The published event projection is not valid.") {
    super(message);
    this.name = "PublishedProjectionValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PublishedProjectionValidationError(`${label} must be an object.`);
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new PublishedProjectionValidationError(`${key} is invalid.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new PublishedProjectionValidationError(`${key} is invalid.`);
  }
  return value;
}

function requireReference(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 128);
  if (!REFERENCE_PATTERN.test(value)) {
    throw new PublishedProjectionValidationError(`${key} is not a valid public reference.`);
  }
  return value;
}

function requireDate(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 80);
  if (Number.isNaN(Date.parse(value))) {
    throw new PublishedProjectionValidationError(`${key} is not a valid timestamp.`);
  }
  return value;
}

function optionalDate(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 80 || Number.isNaN(Date.parse(value))) {
    throw new PublishedProjectionValidationError(`${key} is not a valid timestamp.`);
  }
  return value;
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new PublishedProjectionValidationError(`${key} is invalid.`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new PublishedProjectionValidationError(`${key} is invalid.`);
  }
  return value;
}

function requireReferenceList(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new PublishedProjectionValidationError(`${key} is invalid.`);
  }
  const references = value.map((item) => {
    if (typeof item !== "string" || !REFERENCE_PATTERN.test(item)) {
      throw new PublishedProjectionValidationError(`${key} contains an invalid reference.`);
    }
    return item;
  });
  if (new Set(references).size !== references.length) {
    throw new PublishedProjectionValidationError(`${key} contains duplicate references.`);
  }
  return references;
}

function normalizeApproval(value: unknown, key: string): PublicationApproval {
  if (value === "APPROVED" || value === "approved") return "APPROVED";
  if (value === "PENDING" || value === "pending") return "PENDING";
  if (value === "WITHHELD" || value === "withheld") return "WITHHELD";
  throw new PublishedProjectionValidationError(`${key} is invalid.`);
}

function normalizeVisibility(value: unknown, key: string): PublicationVisibility {
  if (value === "PUBLIC" || value === "public") return "PUBLIC";
  if (value === "PRIVATE" || value === "private") return "PRIVATE";
  throw new PublishedProjectionValidationError(`${key} is invalid.`);
}

function requireSealedPublicRelease(value: unknown): PublishedReleaseProjection {
  const record = requireRecord(value, "release");
  const status = record.status;
  const audience = record.audience;
  const approval = record.approval;
  if (status !== "SEALED" && status !== "sealed") {
    throw new PublishedProjectionValidationError("release must be sealed.");
  }
  if (audience !== "PUBLIC" && audience !== "public") {
    throw new PublishedProjectionValidationError("release audience must be public.");
  }
  if (approval !== "APPROVED" && approval !== "approved") {
    throw new PublishedProjectionValidationError("release must be approved.");
  }
  return {
    channelReference: requireReference(record, "channelReference"),
    releaseNumber: requireInteger(record, "releaseNumber", 1),
    status: "SEALED",
    audience: "PUBLIC",
    approval: "APPROVED",
    current: requireBoolean(record, "current"),
    revokedAt: optionalDate(record, "revokedAt"),
    sealedAt: requireDate(record, "sealedAt"),
    fingerprint: requireString(record, "fingerprint", 256),
    sourcePlanVersionId: requireReference(record, "sourcePlanVersionId"),
    audiencePolicyVersion: requireInteger(record, "audiencePolicyVersion", 1),
    commitmentWatermark: requireInteger(record, "commitmentWatermark", 0),
  };
}

function requireTimezone(record: Record<string, unknown>): string {
  const timezone = requireString(record, "timezone", 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new PublishedProjectionValidationError("timezone is invalid.");
  }
  return timezone;
}

function validateChronology(startsAt: string, endsAt: string, label: string): void {
  if (Date.parse(startsAt) >= Date.parse(endsAt)) {
    throw new PublishedProjectionValidationError(`${label} timestamps are not chronological.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  Object.freeze(value);
  return value;
}

export function parsePublishedEventProjection(input: unknown): PublishedEventProjection {
  const root = requireRecord(input, "projection");
  if (root.schema !== PUBLISHED_EVENT_PROJECTION_SCHEMA) {
    throw new PublishedProjectionValidationError("projection schema is unsupported.");
  }

  const eventRecord = requireRecord(root.event, "event");
  const event = {
    publicReference: requireReference(eventRecord, "publicReference"),
    title: requireString(eventRecord, "title", 240),
    summary: optionalString(eventRecord, "summary", 5000) ?? "",
    timezone: requireTimezone(eventRecord),
    startsAt: requireDate(eventRecord, "startsAt"),
    endsAt: requireDate(eventRecord, "endsAt"),
  };
  validateChronology(event.startsAt, event.endsAt, "event");

  const sessionValues = root.sessions;
  if (!Array.isArray(sessionValues) || sessionValues.length > MAX_SESSIONS) {
    throw new PublishedProjectionValidationError("sessions are invalid.");
  }
  const sessionReferences = new Set<string>();
  const sessions = sessionValues.map((value, index) => {
    const record = requireRecord(value, `sessions[${index}]`);
    const publicReference = requireReference(record, "publicReference");
    if (sessionReferences.has(publicReference)) {
      throw new PublishedProjectionValidationError("sessions contain duplicate references.");
    }
    sessionReferences.add(publicReference);
    const session = {
      publicReference,
      title: requireString(record, "title", 240),
      description: optionalString(record, "description", 5000) ?? "",
      room: optionalString(record, "room", 160),
      track: optionalString(record, "track", 160),
      format: requireString(record, "format", 120),
      startsAt: requireDate(record, "startsAt"),
      endsAt: requireDate(record, "endsAt"),
      speakerReferences: requireReferenceList(record, "speakerReferences", MAX_SPEAKER_REFERENCES),
      approval: normalizeApproval(record.approval, "approval"),
      visibility: normalizeVisibility(record.visibility, "visibility"),
    };
    validateChronology(session.startsAt, session.endsAt, `session ${publicReference}`);
    return session;
  });

  const speakerValues = root.speakers;
  if (!Array.isArray(speakerValues) || speakerValues.length > MAX_SPEAKERS) {
    throw new PublishedProjectionValidationError("speakers are invalid.");
  }
  const speakerReferences = new Set<string>();
  const speakers = speakerValues.map((value, index) => {
    const record = requireRecord(value, `speakers[${index}]`);
    const publicReference = requireReference(record, "publicReference");
    if (speakerReferences.has(publicReference)) {
      throw new PublishedProjectionValidationError("speakers contain duplicate references.");
    }
    speakerReferences.add(publicReference);
    return {
      publicReference,
      displayName: requireString(record, "displayName", 200),
      headline: optionalString(record, "headline", 240),
      organization: optionalString(record, "organization", 240),
      bio: optionalString(record, "bio", 5000),
      photoUrl: optionalString(record, "photoUrl", 2048),
      sessionReferences: requireReferenceList(record, "sessionReferences", MAX_SESSIONS),
      approval: normalizeApproval(record.approval, "approval"),
      visibility: normalizeVisibility(record.visibility, "visibility"),
    };
  });

  const projection: PublishedEventProjection = {
    schema: PUBLISHED_EVENT_PROJECTION_SCHEMA,
    workspaceId: requireReference(root, "workspaceId"),
    eventId: requireReference(root, "eventId"),
    releaseId: requireReference(root, "releaseId"),
    release: requireSealedPublicRelease(root.release),
    event,
    sessions,
    speakers,
  };

  return deepFreeze(projection);
}

export interface SafePublishedProjectionResult {
  readonly success: true;
  readonly data: PublishedEventProjection;
}

export interface FailedPublishedProjectionResult {
  readonly success: false;
  readonly error: {
    readonly code: "INVALID_PUBLISHED_EVENT_PROJECTION";
    readonly message: string;
  };
}

export function safeParsePublishedEventProjection(
  input: unknown,
): SafePublishedProjectionResult | FailedPublishedProjectionResult {
  try {
    return { success: true, data: parsePublishedEventProjection(input) };
  } catch (error) {
    if (error instanceof PublishedProjectionValidationError) {
      return { success: false, error: { code: error.code, message: error.message } };
    }
    return {
      success: false,
      error: {
        code: "INVALID_PUBLISHED_EVENT_PROJECTION",
        message: "The published event projection is not valid.",
      },
    };
  }
}

export function isPublicApproved(
  value: Pick<PublishedSessionProjection | PublishedSpeakerProjection, "approval" | "visibility">,
): boolean {
  return value.approval === "APPROVED" && value.visibility === "PUBLIC";
}

function safePhotoUrl(value: string | null): string | null {
  if (value === null) return null;
  if (value.startsWith("/public/releases/")) {
    const match = value.match(/^\/public\/releases\/([^/]+)\/speaker-artifacts\/([^/?#]+)$/u);
    if (!match) return null;
    try {
      if (!isAudienceReference(decodeURIComponent(match[1]!)) || !isAudienceReference(decodeURIComponent(match[2]!))) return null;
    } catch {
      return null;
    }
    return value;
  }
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return value;
  } catch {
    return null;
  }
}

export function toPublicWidgetProjection(input: PublishedEventProjection): PublicWidgetProjection {
  const projection = parsePublishedEventProjection(input);
  const referenceScope: AudienceReferenceScope = {
    workspaceId: projection.workspaceId,
    eventId: projection.eventId,
    releaseId: projection.releaseId,
  };
  const sessionReference = (value: string) => isAudienceReference(value)
    ? value
    : publicProgramUnitReference(referenceScope, value);
  const speakerReference = (value: string) => isAudienceReference(value)
    ? value
    : publicPersonReference(referenceScope, value);
  const normalizedSessions = projection.sessions.map((session) => ({
    ...session,
    publicReference: sessionReference(session.publicReference),
    speakerReferences: session.speakerReferences.map(speakerReference),
  }));
  const normalizedSpeakers = projection.speakers.map((speaker) => ({
    ...speaker,
    publicReference: speakerReference(speaker.publicReference),
    sessionReferences: speaker.sessionReferences.map(sessionReference),
  }));
  const approvedSpeakers = normalizedSpeakers.filter(isPublicApproved);
  const approvedSpeakerByReference = new Map(
    approvedSpeakers.map((speaker) => [speaker.publicReference, speaker]),
  );
  const approvedSessions = normalizedSessions.filter(isPublicApproved);
  const approvedSessionReferences = new Set(
    approvedSessions.map((session) => session.publicReference),
  );

  const sessions = approvedSessions.map((session) => {
    const speakerReferences = session.speakerReferences.filter((reference) =>
      approvedSpeakerByReference.has(reference),
    );
    return {
      publicReference: session.publicReference,
      title: session.title,
      description: session.description,
      room: session.room,
      track: session.track,
      format: session.format,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      speakerReferences,
      speakers: speakerReferences.map((reference) => {
        const speaker = approvedSpeakerByReference.get(reference)!;
        return { publicReference: speaker.publicReference, displayName: speaker.displayName };
      }),
    } satisfies PublicSession;
  });

  const speakers = approvedSpeakers.map((speaker) => {
    const sessionReferences = speaker.sessionReferences.filter((reference) => {
      const session = approvedSessions.find((candidate) => candidate.publicReference === reference);
      return approvedSessionReferences.has(reference) && session?.speakerReferences.includes(speaker.publicReference);
    });
    return {
      publicReference: speaker.publicReference,
      displayName: speaker.displayName,
      headline: speaker.headline,
      organization: speaker.organization,
      bio: speaker.bio,
      photoUrl: safePhotoUrl(speaker.photoUrl),
      sessionReferences,
    } satisfies PublicSpeaker;
  });

  return deepFreeze({
    schema: PUBLIC_WIDGET_PROJECTION_SCHEMA,
    event: { ...projection.event },
    release: {
      channelReference: projection.release.channelReference,
      releaseNumber: projection.release.releaseNumber,
      sealedAt: projection.release.sealedAt,
      releaseReference: publicReleaseReference(referenceScope),
    },
    sessions,
    speakers,
  });
}

/** Explicit deterministic test fixture; production public request resolution never calls this. */
export function createSyntheticPublishedEventProjection(): PublishedEventProjection {
  const referenceScope: AudienceReferenceScope = {
    workspaceId: "workspace-synthetic-public",
    eventId: "event-synthetic-sympose",
    releaseId: "release-synthetic-public-v1",
  };
  const sessionReference = (value: string) => publicProgramUnitReference(referenceScope, value);
  const speakerReference = (value: string) => publicPersonReference(referenceScope, value);
  return parsePublishedEventProjection({
    schema: PUBLISHED_EVENT_PROJECTION_SCHEMA,
    workspaceId: "workspace-synthetic-public",
    eventId: "event-synthetic-sympose",
    releaseId: "release-synthetic-public-v1",
    release: {
      channelReference: publicReleaseReference(referenceScope),
      releaseNumber: 1,
      status: "SEALED",
      audience: "PUBLIC",
      approval: "APPROVED",
      current: true,
      revokedAt: null,
      sealedAt: "2026-08-01T10:00:00.000Z",
      fingerprint: "synthetic-public-release-fingerprint-v1",
      sourcePlanVersionId: "plan-synthetic-approved-v1",
      audiencePolicyVersion: 1,
      commitmentWatermark: 7,
    },
    event: {
      publicReference: publicReleaseReference(referenceScope),
      title: "Sympose Commons 2026",
      summary: "A synthetic public program for testing the complete embed journey.",
      timezone: "Europe/Berlin",
      startsAt: "2026-09-18T07:00:00.000Z",
      endsAt: "2026-09-19T16:00:00.000Z",
    },
    speakers: [
      {
        publicReference: speakerReference("maya-chen"),
        displayName: "Maya Chen",
        headline: "Community systems designer",
        organization: "Northstar Collective",
        bio: "Maya studies how communities build durable collaboration rituals.",
        photoUrl: "https://images.example.test/speakers/maya-chen.jpg",
        sessionReferences: [sessionReference("opening-keynote"), sessionReference("designing-trust")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: speakerReference("jon-bell"),
        displayName: "Jon Bell",
        headline: "Researcher and facilitator",
        organization: "Common Thread Lab",
        bio: "Jon helps teams turn evidence into practical, shared decisions.",
        photoUrl: null,
        sessionReferences: [sessionReference("designing-trust")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: speakerReference("lara-owens"),
        displayName: "Lara Owens",
        headline: "Civic technology lead",
        organization: "Open Field Studio",
        bio: "Lara works on welcoming infrastructure for civic and cultural gatherings.",
        photoUrl: "https://images.example.test/speakers/lara-owens.jpg",
        sessionReferences: [sessionReference("future-of-commons")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: speakerReference("organizer-only"),
        displayName: "Organizer-only contact",
        headline: "Internal planning role",
        organization: "Private planning team",
        bio: "This record must never enter a public widget.",
        photoUrl: "javascript:alert(1)",
        sessionReferences: [sessionReference("organizer-briefing")],
        approval: "PENDING",
        visibility: "PRIVATE",
      },
    ],
    sessions: [
      {
        publicReference: sessionReference("opening-keynote"),
        title: "Opening keynote: Communities that compound",
        description: "A practical opening conversation about trust, time, and shared work.",
        room: "Hall A",
        track: "Main stage",
        format: "Keynote",
        startsAt: "2026-09-18T07:30:00.000Z",
        endsAt: "2026-09-18T08:15:00.000Z",
        speakerReferences: [speakerReference("maya-chen")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: sessionReference("designing-trust"),
        title: "Designing trust into the room",
        description: "A panel on the small choices that make participation feel possible.",
        room: "Studio 1",
        track: "Practice",
        format: "Panel",
        startsAt: "2026-09-18T09:00:00.000Z",
        endsAt: "2026-09-18T10:00:00.000Z",
        speakerReferences: [speakerReference("maya-chen"), speakerReference("jon-bell")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: sessionReference("future-of-commons"),
        title: "The future of commons",
        description: "Lightning talks about public imagination and useful infrastructure.",
        room: "Hall B",
        track: "Ideas",
        format: "Lightning talks",
        startsAt: "2026-09-19T08:30:00.000Z",
        endsAt: "2026-09-19T09:30:00.000Z",
        speakerReferences: [speakerReference("lara-owens")],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: sessionReference("open-commons-clinic"),
        title: "Open commons clinic",
        description: "Bring a question and leave with a next step.",
        room: "Workshop 2",
        track: "Practice",
        format: "Workshop",
        startsAt: "2026-09-19T10:00:00.000Z",
        endsAt: "2026-09-19T11:30:00.000Z",
        speakerReferences: [],
        approval: "APPROVED",
        visibility: "PUBLIC",
      },
      {
        publicReference: sessionReference("organizer-briefing"),
        title: "Organizer-only briefing",
        description: "Private operational notes and staffing decisions.",
        room: "Back office",
        track: "Internal",
        format: "Briefing",
        startsAt: "2026-09-18T06:00:00.000Z",
        endsAt: "2026-09-18T06:30:00.000Z",
        speakerReferences: [speakerReference("organizer-only")],
        approval: "PENDING",
        visibility: "PRIVATE",
      },
    ],
  });
}

export const SYNTHETIC_PUBLIC_PROJECTION = createSyntheticPublishedEventProjection();
