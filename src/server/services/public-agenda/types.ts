import type { ApprovedScheduleSnapshot } from "../scheduling";
import type { ContentOperationsRepository, ContentPublicationGate, ContentPublicationRequirement } from "../content-operations";

export type PublicationAudience = "PUBLIC" | "ATTENDEE" | "SPEAKER";

export interface PublicationScope {
  workspaceId: string;
  eventId: string;
}

export interface PublicationChannel {
  id: string;
  workspaceId: string;
  eventId: string;
  slug: string;
  audience: PublicationAudience;
  publicationType: "AGENDA";
  currentReleaseId: string | null;
  createdAt: string;
}

export interface PublicEventProjection {
  schema: "public-event/v1";
  event: {
    slug: string;
    name: string;
    timezone: string;
    startsAt: string;
    endsAt: string;
  };
  release: {
    releaseId: string;
    releaseNumber: number;
    contentHash: string;
    publishedAt: string;
    audience: "PUBLIC";
  };
  days: Array<{
    id: string;
    date: string;
    label: string;
  }>;
  tracks: Array<{
    id: string;
    name: string;
  }>;
  rooms: Array<{
    id: string;
    name: string;
    venue: string;
  }>;
  sessions: Array<{
    slug: string;
    title: string;
    abstract: string;
    dayId: string;
    date: string;
    startsAt: string;
    endsAt: string;
    roomId: string;
    roomName: string;
    venue: string;
    trackId: string;
    trackName: string;
    speakerSlugs: string[];
  }>;
  speakers: Array<{
    slug: string;
    name: string;
    organization: string;
    bio: string;
    sessionSlugs: string[];
  }>;
  redaction: {
    excludedSessionCount: number;
    excludedSpeakerCount: number;
    omittedFields: string[];
  };
}

/**
 * The durable publication v2 contract is intentionally smaller than the synthetic
 * schedule projection. Rich Stage 3 releases carry only sealed public schedule fields;
 * legacy releases retain the accepted-commitment-only shape. Public rendering must preserve
 * the release's immutable redaction boundary.
 */
export interface DurablePublicEventProjection {
  schema: "public-event/durable-publication-release-v2";
  event: {
    /** A dedicated audience reference is the only public route reference. */
    slug: string;
    name: string;
    timezone: string;
    startsAt: string;
    endsAt: string;
  };
  release: {
    releaseReference: string;
    sealedAt: string;
    audience: "PUBLIC";
  };
  days: Array<{
    id: string;
    date: string;
    label: string;
  }>;
  sessions: Array<{
    slug: string;
    title: string;
    abstract?: string;
    date: string;
    startsAt: string;
    endsAt: string;
    roomName?: string | null;
    venue?: string | null;
    trackName?: string | null;
    speakerSlugs: string[];
  }>;
  speakers: Array<{
    slug: string;
    name: string;
    sessionSlugs: string[];
    roles: string[];
  }>;
  redaction: {
    omittedFields: string[];
  };
}

export type PublicAgendaProjection = PublicEventProjection | DurablePublicEventProjection;

export interface PublicationRelease {
  schema: "publication-release/v1";
  id: string;
  workspaceId: string;
  eventId: string;
  channelId: string;
  releaseNumber: number;
  audience: PublicationAudience;
  sourcePlanVersionId: string;
  sourcePlanFingerprint: string;
  audiencePolicyVersion: number;
  commitmentWatermark: string;
  contentHash: string;
  /** Exact content approval evidence consumed by this immutable release. */
  contentGate: ContentPublicationGate | null;
  contentGateFingerprint: string | null;
  supersedesReleaseId: string | null;
  publishedAt: string;
  sealedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  idempotencyKey: string;
  projection: PublicEventProjection;
}

export interface PublicationPreview {
  state: "READY" | "BLOCKED";
  sourcePlanVersionId: string;
  sourcePlanFingerprint: string;
  audiencePolicyVersion: number;
  commitmentWatermark: string;
  includedSessionCount: number;
  includedSpeakerCount: number;
  excludedSessionCount: number;
  excludedSpeakerCount: number;
  blockers: string[];
  redactions: string[];
  contentGate: ContentPublicationGate | null;
}

export interface PublicationPublishInput {
  scope: PublicationScope;
  channelId: string;
  audiencePolicyVersion: number;
  commitmentWatermark: string;
  publishedAt: string;
  idempotencyKey: string;
  /** Required by synthetic/publication-console paths; optional only for legacy callers. */
  contentGate?: ContentPublicationGate;
}

export interface PublicationWriteResult {
  release: PublicationRelease;
  created: boolean;
}

export interface PublicationRepository {
  getChannel(scope: PublicationScope, channelIdOrSlug: string): PublicationChannel | null;
  getCurrentRelease(scope: PublicationScope, channelIdOrSlug: string): PublicationRelease | null;
  getRelease(scope: PublicationScope, releaseId: string): PublicationRelease | null;
  putSealedRelease(input: {
    scope: PublicationScope;
    channelId: string;
    expectedCurrentReleaseId: string | null;
    release: PublicationRelease;
  }): PublicationWriteResult;
  revokeRelease(input: {
    scope: PublicationScope;
    releaseId: string;
    revokedAt: string;
    reason: string;
  }): PublicationRelease;
}

export interface SyntheticPublicationState {
  repository: PublicationRepository;
  approvedSchedule: ApprovedScheduleSnapshot;
  currentRelease: PublicationRelease;
  contentRepository: ContentOperationsRepository;
  contentRequirements: readonly ContentPublicationRequirement[];
  contentGate: ContentPublicationGate;
}

export interface CalendarExport {
  filename: string;
  mimeType: "text/calendar";
  content: string;
}
