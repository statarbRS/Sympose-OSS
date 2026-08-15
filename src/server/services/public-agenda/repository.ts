import type {
  PublicationChannel,
  PublicationRelease,
  PublicationRepository,
  PublicationScope,
  PublicationWriteResult,
} from "./types";

export class PublicationCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicationCommandError";
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function scopeKey(scope: PublicationScope): string {
  return `${scope.workspaceId}\u0000${scope.eventId}`;
}

function assertReleaseScope(release: PublicationRelease, scope: PublicationScope): void {
  if (release.workspaceId !== scope.workspaceId || release.eventId !== scope.eventId) {
    throw new PublicationCommandError("PUBLICATION_SCOPE_MISMATCH", "The release is outside the authorized workspace and event scope.");
  }
  if (release.contentGate && (release.contentGate.workspaceId !== release.workspaceId || release.contentGate.eventId !== release.eventId)) {
    throw new PublicationCommandError("CONTENT_GATE_SCOPE_MISMATCH", "The sealed release content gate is outside the release workspace and event scope.");
  }
  if ((release.contentGate?.fingerprint ?? null) !== release.contentGateFingerprint) {
    throw new PublicationCommandError("CONTENT_GATE_BINDING_INVALID", "The sealed release does not preserve its exact content-gate fingerprint.");
  }
}

/** S0 adapter: a transaction-shaped in-memory implementation for synthetic browser flows and tests. */
export class InMemoryPublicationRepository implements PublicationRepository {
  private readonly channels = new Map<string, PublicationChannel>();
  private readonly releases = new Map<string, PublicationRelease>();

  constructor(channels: PublicationChannel[] = []) {
    for (const channel of channels) {
      // The channel pointer is mutable metadata; sealed release content is frozen separately.
      this.channels.set(`${scopeKey(channel)}\u0000${channel.id}`, clone(channel));
    }
  }

  getChannel(scope: PublicationScope, channelIdOrSlug: string): PublicationChannel | null {
    for (const channel of this.channels.values()) {
      if (scopeKey(channel) === scopeKey(scope) && (channel.id === channelIdOrSlug || channel.slug === channelIdOrSlug)) return clone(channel);
    }
    return null;
  }

  getCurrentRelease(scope: PublicationScope, channelIdOrSlug: string): PublicationRelease | null {
    const channel = this.getChannel(scope, channelIdOrSlug);
    if (!channel?.currentReleaseId) return null;
    const release = this.releases.get(channel.currentReleaseId);
    if (!release) return null;
    assertReleaseScope(release, scope);
    return clone(release);
  }

  getRelease(scope: PublicationScope, releaseId: string): PublicationRelease | null {
    const release = this.releases.get(releaseId);
    if (!release) return null;
    if (release.workspaceId !== scope.workspaceId || release.eventId !== scope.eventId) return null;
    return clone(release);
  }

  putSealedRelease(input: {
    scope: PublicationScope;
    channelId: string;
    expectedCurrentReleaseId: string | null;
    release: PublicationRelease;
  }): PublicationWriteResult {
    const channelKey = `${scopeKey(input.scope)}\u0000${input.channelId}`;
    const channel = this.channels.get(channelKey);
    if (!channel) throw new PublicationCommandError("PUBLICATION_CHANNEL_NOT_FOUND", "The publication channel is not in the requested scope.");
    assertReleaseScope(input.release, input.scope);
    if (input.release.contentGate && input.release.contentGate.state !== "READY") {
      throw new PublicationCommandError("CONTENT_PUBLICATION_NOT_READY", "A sealed release requires a ready exact-content publication gate.");
    }
    if (input.release.channelId !== channel.id) throw new PublicationCommandError("PUBLICATION_CHANNEL_MISMATCH", "The release does not belong to the selected channel.");
    if (channel.currentReleaseId !== input.expectedCurrentReleaseId) throw new PublicationCommandError("PUBLICATION_POINTER_CONFLICT", "The channel pointer changed before this release could be sealed.");
    const existing = this.releases.get(input.release.id);
    if (existing) return { release: clone(existing), created: false };
    const sameCurrent = channel.currentReleaseId ? this.releases.get(channel.currentReleaseId) : null;
    if (sameCurrent && sameCurrent.contentHash === input.release.contentHash && sameCurrent.sourcePlanVersionId === input.release.sourcePlanVersionId && sameCurrent.audiencePolicyVersion === input.release.audiencePolicyVersion && sameCurrent.commitmentWatermark === input.release.commitmentWatermark) {
      return { release: clone(sameCurrent), created: false };
    }
    if (input.release.supersedesReleaseId !== channel.currentReleaseId) throw new PublicationCommandError("PUBLICATION_SUPERSESSION_INVALID", "A new release must supersede the channel's current release.");
    if (input.release.releaseNumber !== (sameCurrent?.releaseNumber ?? 0) + 1) throw new PublicationCommandError("PUBLICATION_RELEASE_NUMBER_INVALID", "Release numbers must advance from the channel pointer.");
    const stored = freezeDeep(clone(input.release));
    this.releases.set(stored.id, stored);
    channel.currentReleaseId = stored.id;
    return { release: clone(stored), created: true };
  }

  revokeRelease(input: { scope: PublicationScope; releaseId: string; revokedAt: string; reason: string }): PublicationRelease {
    const stored = this.releases.get(input.releaseId);
    if (!stored || stored.workspaceId !== input.scope.workspaceId || stored.eventId !== input.scope.eventId) {
      throw new PublicationCommandError("PUBLICATION_RELEASE_NOT_FOUND", "The release is not in the requested scope.");
    }
    if (input.reason.trim().length === 0 || input.reason.length > 240) throw new PublicationCommandError("REVOCATION_REASON_INVALID", "A revocation reason is required and must be 240 characters or fewer.");
    const next = freezeDeep({ ...clone(stored), revokedAt: input.revokedAt, revocationReason: input.reason.trim() });
    this.releases.set(stored.id, next);
    return clone(next);
  }
}
