import type { ValidatedPublicRelease } from "@/server/services/publication";
import type {
  PublicationAudienceKind,
  PublicationAudienceMatrix,
  PublicationAudienceMatrixStatus,
  PublicationAudiencePurpose,
  PublicationAudienceVisibility,
} from "@/server/services/publication-audience";
import { publicReleaseReference } from "@/server/services/public-reference";

export interface PublicationConsolePreviewItem {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly placement: string;
  readonly peopleLabel: string;
}

/**
 * Explicit browser-safe projection for the organizer publication console. The immutable release
 * contains private agenda email addresses and offer lineage that this UI never renders, so those
 * fields must not cross the React Server Component boundary.
 */
export interface PublicationConsoleRelease {
  readonly releaseId: string;
  readonly fingerprint: string;
  readonly sealedAt: string;
  readonly publicAgendaPath: string;
  readonly content: {
    readonly schema: string;
    readonly eventName: string;
    readonly eventTimezone: string;
    readonly planId: string;
    readonly planVersionNumber: number;
    readonly planFingerprint: string;
    readonly audiencePolicyVersion: number;
    readonly commitmentWatermark: number;
    readonly agendaCount: number;
    readonly agendaItemCount: number;
    readonly acceptedPersonCount: number;
    readonly hasSchedule: boolean;
    readonly previewItems: readonly PublicationConsolePreviewItem[];
  };
}

export interface PublicationConsoleAudienceMatrix {
  readonly releases: readonly {
    readonly id: string;
    readonly releaseId: string;
    readonly versionNumber: number;
    readonly releaseFingerprint: string;
  }[];
  readonly channels: readonly {
    readonly id: string;
    readonly label: string;
    readonly purpose: PublicationAudiencePurpose;
    readonly audience: PublicationAudienceKind;
    readonly visibility: PublicationAudienceVisibility;
    readonly currentState: "ACTIVE" | "DISABLED";
    readonly fingerprint: string;
  }[];
  readonly policies: readonly {
    readonly id: string;
    readonly channelId: string;
    readonly versionNumber: number;
    readonly currentState: "DRAFT" | "BOUND" | "SUPERSEDED";
    readonly policyFingerprint: string;
  }[];
  readonly rows: readonly {
    readonly releaseVersionId: string;
    readonly releaseId: string;
    readonly releaseVersion: number;
    readonly releaseFingerprint: string;
    readonly channelId: string;
    readonly channelLabel: string;
    readonly purpose: PublicationAudiencePurpose;
    readonly audience: PublicationAudienceKind;
    readonly visibility: PublicationAudienceVisibility;
    readonly policyVersion: number | null;
    readonly bindingReceiptId: string | null;
    readonly status: PublicationAudienceMatrixStatus;
    readonly reason: string;
  }[];
  readonly commandSeed: string;
}

/**
 * The organizer matrix carries actor IDs, request keys, command receipts, and tenant scope for
 * server-side enforcement. The client only needs the exact opaque evidence used by its visible
 * table and scoped forms, so everything else is deliberately dropped at the RSC boundary.
 */
export function toPublicationConsoleAudienceMatrix(
  matrix: PublicationAudienceMatrix | null,
): PublicationConsoleAudienceMatrix | null {
  if (!matrix) return null;
  return {
    releases: matrix.releases.filter((release) =>
      matrix.currentReleaseValidated && release.releaseId === matrix.currentReleaseId).map((release) => ({
      id: release.id,
      releaseId: release.releaseId,
      versionNumber: release.versionNumber,
      releaseFingerprint: release.releaseFingerprint,
    })),
    channels: matrix.channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      purpose: channel.purpose,
      audience: channel.audience,
      visibility: channel.visibility,
      currentState: channel.currentState,
      fingerprint: channel.fingerprint,
    })),
    policies: matrix.policies.map((policy) => ({
      id: policy.id,
      channelId: policy.channelId,
      versionNumber: policy.versionNumber,
      currentState: policy.currentState,
      policyFingerprint: policy.policyFingerprint,
    })),
    rows: matrix.rows.map((row) => ({
      releaseVersionId: row.releaseVersionId,
      releaseId: row.releaseId,
      releaseVersion: row.releaseVersion,
      releaseFingerprint: row.releaseFingerprint,
      channelId: row.channelId,
      channelLabel: row.channelLabel,
      purpose: row.purpose,
      audience: row.audience,
      visibility: row.visibility,
      policyVersion: row.policyVersion,
      bindingReceiptId: row.bindingReceiptId,
      status: row.status,
      reason: row.reason,
    })),
    commandSeed: matrix.fingerprint.slice(0, 24),
  };
}

export function toPublicationConsoleRelease(
  release: ValidatedPublicRelease | null,
): PublicationConsoleRelease | null {
  if (!release) return null;
  const content = release.content;
  let previewItems: PublicationConsolePreviewItem[];
  if (content.schedule) {
    previewItems = content.schedule.sessions.map((session) => ({
      id: session.programUnitId,
      title: session.title,
      startsAt: session.placement.startsAt,
      endsAt: session.placement.endsAt,
      placement: `${session.placement.roomName} · ${session.placement.trackName}`,
      peopleLabel: `${session.speakerPersonIds.length} published speaker${session.speakerPersonIds.length === 1 ? "" : "s"}`,
    }));
  } else {
    const sessions = new Map<string, {
      readonly title: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly roles: Set<string>;
      readonly people: Set<string>;
    }>();
    for (const accepted of content.accepted) {
      const session = sessions.get(accepted.programUnitId) ?? {
        title: accepted.programUnitName,
        startsAt: accepted.startsAt,
        endsAt: accepted.endsAt,
        roles: new Set<string>(),
        people: new Set<string>(),
      };
      session.roles.add(accepted.role);
      session.people.add(accepted.personId);
      sessions.set(accepted.programUnitId, session);
    }
    previewItems = [...sessions.entries()].map(([id, session]) => ({
      id,
      title: session.title,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      placement: `${[...session.roles].sort().join(" · ")} · location redacted`,
      peopleLabel: `${session.people.size} published participant${session.people.size === 1 ? "" : "s"}`,
    }));
  }
  return {
    releaseId: release.releaseId,
    fingerprint: release.fingerprint,
    sealedAt: release.sealedAt,
    publicAgendaPath: `/events/${encodeURIComponent(publicReleaseReference({
      workspaceId: release.workspaceId,
      eventId: release.eventId,
      releaseId: release.releaseId,
    }))}/agenda`,
    content: {
      schema: content.schema,
      eventName: content.event.name,
      eventTimezone: content.event.timezone,
      planId: content.plan.id,
      planVersionNumber: content.plan.versionNumber,
      planFingerprint: content.plan.fingerprint,
      audiencePolicyVersion: content.audiencePolicyVersion,
      commitmentWatermark: content.commitmentWatermark,
      agendaCount: content.agendas.length,
      agendaItemCount: content.agendas.reduce((total, agenda) => total + agenda.items.length, 0),
      acceptedPersonCount: new Set(content.accepted.map((accepted) => accepted.personId)).size,
      hasSchedule: Boolean(content.schedule),
      previewItems,
    },
  };
}
