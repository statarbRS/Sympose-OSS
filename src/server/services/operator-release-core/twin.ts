import {
  MAX_RELEASE_TWIN_BYTES,
  MAX_SOURCE_RECORDS,
  RELEASE_TWIN_SCHEMA,
  type FieldDecisionInput,
  type ReleaseManifest,
  type ReleaseTwin,
  type ReleaseTwinInput,
  type SourceRecordInput,
} from "./contracts";
import { byteLength, cloneAndFreeze, snapshotPlainData } from "./canonical";
import { fail } from "./errors";
import { releaseIdentifier, releaseVersion, selectAudienceSourceVector } from "./loader";
import { createReleaseManifest } from "./manifest";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControlPlaneFields(value: RecordValue): void {
  if (hasOwn(value, "authority") || hasOwn(value, "sourceAuthority")) fail("CALLER_AUTHORITY_FORBIDDEN", "Authority is fixed by the trusted persistence loader.");
  if (hasOwn(value, "action") || hasOwn(value, "provider")) fail("FORBIDDEN_FIELD", "Action and provider fields are outside this pure release core.");
}

function exactKeys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) fail("NON_CANONICAL_INPUT", "The release twin input has an unsupported field.");
  for (const key of required) if (!hasOwn(value, key)) fail("NON_CANONICAL_INPUT", "The release twin input is incomplete.");
}

function decisions(value: unknown, label: string): readonly FieldDecisionInput[] {
  if (!Array.isArray(value) || value.length === 0) fail("NON_CANONICAL_INPUT", `${label} must be a non-empty array.`);
  return value as unknown as readonly FieldDecisionInput[];
}

export function createReleaseTwin(input: ReleaseTwinInput): ReleaseTwin {
  const snapshot = snapshotPlainData(input, { maxBytes: MAX_RELEASE_TWIN_BYTES * 2 });
  if (!isRecord(snapshot)) fail("NON_CANONICAL_INPUT", "The release twin input must be a plain object.");
  const value = snapshot;
  rejectControlPlaneFields(value);
  exactKeys(value, [
    "workspaceId", "eventId", "version", "sources", "publicReleaseId", "operatorReleaseId",
    "publicDecisions", "operatorDecisions",
  ], ["publicSupersedes", "operatorSupersedes"]);
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const version = releaseVersion(value.version, "twin version");
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCE_RECORDS) {
    fail("LIMIT_EXCEEDED", "The release twin requires a bounded non-empty source corpus.");
  }
  const sources = value.sources as unknown as readonly SourceRecordInput[];
  const publicSourceVector = selectAudienceSourceVector({ workspaceId, eventId, audience: "PUBLIC", version, sources });
  const operatorSourceVector = selectAudienceSourceVector({ workspaceId, eventId, audience: "OPERATOR", version, sources });
  const publicManifest = createReleaseManifest({
    workspaceId,
    eventId,
    audience: "PUBLIC",
    releaseId: releaseIdentifier(value.publicReleaseId, "public releaseId"),
    sourceVector: publicSourceVector,
    decisions: decisions(value.publicDecisions, "publicDecisions"),
    ...(hasOwn(value, "publicSupersedes") ? { supersedes: value.publicSupersedes as ReleaseManifest["supersedes"] } : {}),
  });
  const operatorManifest = createReleaseManifest({
    workspaceId,
    eventId,
    audience: "OPERATOR",
    releaseId: releaseIdentifier(value.operatorReleaseId, "operator releaseId"),
    sourceVector: operatorSourceVector,
    decisions: decisions(value.operatorDecisions, "operatorDecisions"),
    ...(hasOwn(value, "operatorSupersedes") ? { supersedes: value.operatorSupersedes as ReleaseManifest["supersedes"] } : {}),
  });
  if (publicSourceVector.commonFingerprint !== operatorSourceVector.commonFingerprint) {
    fail("COMMON_FINGERPRINT_MISMATCH", "The release twin does not share one exact common source fingerprint.");
  }
  const twin = {
    schema: RELEASE_TWIN_SCHEMA,
    workspaceId,
    eventId,
    version,
    commonFingerprint: publicSourceVector.commonFingerprint,
    public: { sourceVector: publicSourceVector, manifest: publicManifest },
    operator: { sourceVector: operatorSourceVector, manifest: operatorManifest },
  } satisfies ReleaseTwin;
  if (byteLength(twin) > MAX_RELEASE_TWIN_BYTES) fail("LIMIT_EXCEEDED", "The release twin exceeds its bounded size.");
  return cloneAndFreeze(twin);
}

export const buildReleaseTwin = createReleaseTwin;
export const createOperatorReleaseTwin = createReleaseTwin;
