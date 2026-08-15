import { deterministicUuid } from "../canonical";

/**
 * Server-only audience references. The seed is deliberately kept inside this module so public
 * callers receive only a domain-separated opaque value, never the release or source identifier
 * used to derive it.
 */
export interface AudienceReferenceScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
}

const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SEED_PART_LENGTH = 512;

function seedPart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SEED_PART_LENGTH || value.includes("\u0000")) {
    throw new Error(`AUDIENCE_REFERENCE_${label.toUpperCase()}_INVALID`);
  }
  return value;
}

function reference(kind: string, scope: AudienceReferenceScope, sourceId?: string): string {
  const parts = [
    "sympose",
    "audience-reference",
    "v1",
    seedPart(kind, "kind"),
    seedPart(scope.workspaceId, "workspace"),
    seedPart(scope.eventId, "event"),
    seedPart(scope.releaseId, "release"),
  ];
  if (sourceId !== undefined) parts.push(seedPart(sourceId, "source"));
  return `aud1-${deterministicUuid(parts.join("\u0000"))}`;
}

export function publicReleaseReference(scope: AudienceReferenceScope): string {
  return reference("release", scope);
}

export function publicProgramUnitReference(scope: AudienceReferenceScope, programUnitId: string): string {
  return reference("program-unit", scope, programUnitId);
}

export function publicPersonReference(scope: AudienceReferenceScope, personId: string): string {
  return reference("person", scope, personId);
}

export function publicArtifactReference(scope: AudienceReferenceScope, artifactId: string): string {
  return reference("artifact", scope, artifactId);
}

export function isAudienceReference(value: unknown): value is string {
  return typeof value === "string" && AUDIENCE_REFERENCE_PATTERN.test(value);
}
