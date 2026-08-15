import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, sha256Hex, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit } from "./audit";
import {
  createDurableContentOperationsRepository,
  evaluateContentPublicationGate,
} from "./content-operations";
import { getEvent } from "./events";
import { planState } from "./planning";
import { DenialError, roleHasCapability } from "../auth";
import { buildSealedScheduleProjection, type SealedScheduleProjection } from "./publication-schedule";
import {
  acceptedInventoryFingerprint,
  readCanonicalScheduleAuthorityAt,
} from "./scheduling/canonical";
import { readScheduleDraftAuthorityEvidence } from "./scheduling/persistence";
import { readScheduleApprovalEvidence } from "./scheduling/approval";
import { readCommittedSpeakerArtifactForSeal } from "./artifact-records";
import { readExactCommitmentOfferTerms } from "./commitment-offer-contract";

export const PORTAL_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface SealReleaseResult {
  releaseId: string;
  fingerprint: string;
  agendaCount: number;
  tokenCount: number;
  created: boolean;
  tokens: { personId: string; personName: string; rawToken: string }[];
}

export interface SealedReleaseContent {
  schema: "publication-release/v2";
  /** Absent only on retained releases sealed before explicit supersession lineage. */
  lineage?: {
    releaseNumber: number;
    supersedesReleaseId: string | null;
  };
  event: { id: string; name: string; timezone: string; startsAt: string; endsAt: string };
  plan: { id: string; versionNumber: number; fingerprint: string };
  audiencePolicyVersion: number;
  commitmentWatermark: number;
  accepted: {
    personId: string;
    personName: string;
    email: string;
    offerId: string;
    termsFingerprint: string;
    programUnitId: string;
    programUnitName: string;
    role: string;
    startsAt: string;
    endsAt: string;
  }[];
  agendas: {
    personId: string;
    personName: string;
    email: string;
    items: { programUnitId: string; programUnitName: string; role: string; startsAt: string; endsAt: string }[];
  }[];
  /** Absent only on retained legacy v2 releases. New seals bind every required publication artifact. */
  artifactBindings?: SealedPublicationArtifactBinding[];
  /** Absent only on retained legacy v2 releases. New seals always fingerprint this exact manifest. */
  speakerHeadshots?: SealedSpeakerHeadshot[];
  /** Absent only on retained releases sealed before the durable schedule seam. */
  schedule?: SealedScheduleProjection;
}

export interface SealedSpeakerHeadshot {
  personId: string;
  taskId: string;
  artifactId: string;
  contentVersionId: string;
  version: number;
  contentHash: string;
  sha256: string;
  mediaType: "image/png";
  byteSize: number;
  displayFilename: string;
}

export type PublicationArtifactIntent = "PUBLIC_SPEAKER_HEADSHOT" | "PRIVATE_OPERATOR_ARTIFACT";

export interface SealedPublicationArtifactBinding {
  assignmentId: string;
  personId: string;
  taskId: string;
  kind: "HEADSHOT" | "SLIDES";
  intent: PublicationArtifactIntent;
  artifactId: string;
  contentVersionId: string;
  version: number;
  contentHash: string;
  sha256: string;
  mediaType: "image/png" | "application/pdf";
  byteSize: number;
  displayFilename: string;
}

const MAX_RELEASE_JSON_BYTES = 1_000_000;
const MAX_ACCEPTED_ROWS = 500;
const MAX_HEADSHOT_BYTES = 8_388_608;
const MAX_ARTIFACT_BYTES = 26_214_400;
const MAX_ARTIFACT_BINDINGS = MAX_ACCEPTED_ROWS * 2;
const SEALED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PUBLIC_ID = SEALED_ID_PATTERN;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function boundedString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value);
}

function validTimestamp(value: unknown): value is string {
  return boundedString(value, 128) && Number.isFinite(Date.parse(value));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function releaseContentKeys(
  hasArtifactManifest: boolean,
  hasHeadshotManifest: boolean,
  hasSchedule: boolean,
  hasLineage: boolean,
): readonly string[] {
  const keys = ["schema", "event", "plan", "audiencePolicyVersion", "commitmentWatermark", "accepted", "agendas"];
  if (hasArtifactManifest) keys.push("artifactBindings");
  if (hasLineage) keys.push("lineage");
  if (hasHeadshotManifest) keys.push("speakerHeadshots");
  if (hasSchedule) keys.push("schedule");
  return keys;
}

function artifactIntent(kind: SealedPublicationArtifactBinding["kind"]): PublicationArtifactIntent {
  return kind === "HEADSHOT" ? "PUBLIC_SPEAKER_HEADSHOT" : "PRIVATE_OPERATOR_ARTIFACT";
}

function validSealedPublicationArtifactBinding(value: unknown): value is SealedPublicationArtifactBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "assignmentId", "personId", "taskId", "kind", "intent", "artifactId", "contentVersionId",
    "version", "contentHash", "sha256", "mediaType", "byteSize", "displayFilename",
  ])) return false;
  const displayFilename = value.displayFilename;
  if (!boundedString(displayFilename, 180) || displayFilename.includes("/") || displayFilename.includes("\\")) {
    return false;
  }
  const kind = value.kind;
  const validKindAndMedia = (kind === "HEADSHOT" && value.intent === "PUBLIC_SPEAKER_HEADSHOT" &&
      value.mediaType === "image/png" && Number.isSafeInteger(value.byteSize) &&
      (value.byteSize as number) >= 1 && (value.byteSize as number) <= MAX_HEADSHOT_BYTES &&
      displayFilename.toLowerCase().endsWith(".png")) ||
    (kind === "SLIDES" && value.intent === "PRIVATE_OPERATOR_ARTIFACT" &&
      value.mediaType === "application/pdf" && Number.isSafeInteger(value.byteSize) &&
      (value.byteSize as number) >= 1 && (value.byteSize as number) <= MAX_ARTIFACT_BYTES &&
      displayFilename.toLowerCase().endsWith(".pdf"));
  return validKindAndMedia &&
    boundedString(value.assignmentId) && SEALED_ID_PATTERN.test(value.assignmentId) &&
    boundedString(value.personId) && SEALED_ID_PATTERN.test(value.personId) &&
    boundedString(value.taskId) && SEALED_ID_PATTERN.test(value.taskId) &&
    boundedString(value.artifactId) && SHA256_PATTERN.test(value.artifactId) &&
    boundedString(value.contentVersionId) && SEALED_ID_PATTERN.test(value.contentVersionId) &&
    Number.isSafeInteger(value.version) && (value.version as number) >= 1 &&
    boundedString(value.contentHash) && SHA256_PATTERN.test(value.contentHash) &&
    boundedString(value.sha256) && SHA256_PATTERN.test(value.sha256);
}

function validArtifactBindingManifest(
  manifest: unknown,
  acceptedPeople: ReadonlySet<string>,
): manifest is SealedPublicationArtifactBinding[] {
  if (!Array.isArray(manifest) || manifest.length > MAX_ARTIFACT_BINDINGS) return false;
  const tasks = new Set<string>();
  const artifacts = new Set<string>();
  const versions = new Set<string>();
  const publicPeople = new Set<string>();
  let previousKey: string | null = null;
  for (const entry of manifest) {
    if (!validSealedPublicationArtifactBinding(entry) || !acceptedPeople.has(entry.personId) ||
        tasks.has(entry.taskId) || artifacts.has(entry.artifactId) || versions.has(entry.contentVersionId)) return false;
    const key = JSON.stringify([entry.assignmentId, entry.taskId]);
    if (previousKey !== null && previousKey >= key) return false;
    if (entry.intent === "PUBLIC_SPEAKER_HEADSHOT" && publicPeople.has(entry.personId)) return false;
    tasks.add(entry.taskId);
    artifacts.add(entry.artifactId);
    versions.add(entry.contentVersionId);
    if (entry.intent === "PUBLIC_SPEAKER_HEADSHOT") publicPeople.add(entry.personId);
    previousKey = key;
  }
  return true;
}

function headshotsFromArtifactBindings(
  bindings: readonly SealedPublicationArtifactBinding[],
): SealedSpeakerHeadshot[] {
  return bindings
    .filter((entry) => entry.intent === "PUBLIC_SPEAKER_HEADSHOT")
    .map((entry) => ({
      personId: entry.personId,
      taskId: entry.taskId,
      artifactId: entry.artifactId,
      contentVersionId: entry.contentVersionId,
      version: entry.version,
      contentHash: entry.contentHash,
      sha256: entry.sha256,
      mediaType: "image/png" as const,
      byteSize: entry.byteSize,
      displayFilename: entry.displayFilename,
    }))
    .sort((left, right) => left.personId.localeCompare(right.personId));
}

function validReleaseLineage(value: unknown): value is NonNullable<SealedReleaseContent["lineage"]> {
  return isRecord(value) && exactKeys(value, ["releaseNumber", "supersedesReleaseId"]) &&
    Number.isSafeInteger(value.releaseNumber) && (value.releaseNumber as number) >= 1 &&
    (value.supersedesReleaseId === null ||
      (boundedString(value.supersedesReleaseId) && SEALED_ID_PATTERN.test(value.supersedesReleaseId))) &&
    ((value.releaseNumber === 1) === (value.supersedesReleaseId === null));
}

function releaseMaterialFingerprint(content: SealedReleaseContent): string {
  const { lineage: _lineage, ...material } = content;
  return fingerprintOf(material);
}

function validSealedSpeakerHeadshot(value: unknown): value is SealedSpeakerHeadshot {
  if (!isRecord(value) || !exactKeys(value, [
    "personId", "taskId", "artifactId", "contentVersionId", "version",
    "contentHash", "sha256", "mediaType", "byteSize", "displayFilename",
  ])) return false;
  return boundedString(value.personId) && SEALED_ID_PATTERN.test(value.personId) &&
    boundedString(value.taskId) && SEALED_ID_PATTERN.test(value.taskId) &&
    boundedString(value.artifactId) && SHA256_PATTERN.test(value.artifactId) &&
    boundedString(value.contentVersionId) && SEALED_ID_PATTERN.test(value.contentVersionId) &&
    Number.isSafeInteger(value.version) && (value.version as number) >= 1 &&
    boundedString(value.contentHash) && SHA256_PATTERN.test(value.contentHash) &&
    boundedString(value.sha256) && SHA256_PATTERN.test(value.sha256) &&
    value.mediaType === "image/png" &&
    Number.isSafeInteger(value.byteSize) && (value.byteSize as number) >= 1 && (value.byteSize as number) <= MAX_HEADSHOT_BYTES &&
    boundedString(value.displayFilename, 180) && value.displayFilename.toLowerCase().endsWith(".png") &&
    !value.displayFilename.includes("/") && !value.displayFilename.includes("\\");
}

function validHeadshotManifest(
  manifest: unknown,
  acceptedPeople: ReadonlySet<string>,
): manifest is SealedSpeakerHeadshot[] {
  if (!Array.isArray(manifest) || manifest.length > acceptedPeople.size || manifest.length > MAX_ACCEPTED_ROWS) return false;
  const people = new Set<string>();
  const tasks = new Set<string>();
  const artifacts = new Set<string>();
  const versions = new Set<string>();
  let previousPersonId: string | null = null;
  for (const entry of manifest) {
    if (!validSealedSpeakerHeadshot(entry) || !acceptedPeople.has(entry.personId) ||
        people.has(entry.personId) || tasks.has(entry.taskId) || artifacts.has(entry.artifactId) ||
        versions.has(entry.contentVersionId) || (previousPersonId !== null && previousPersonId >= entry.personId)) {
      return false;
    }
    people.add(entry.personId);
    tasks.add(entry.taskId);
    artifacts.add(entry.artifactId);
    versions.add(entry.contentVersionId);
    previousPersonId = entry.personId;
  }
  return true;
}

function validSealedSchedule(
  value: unknown,
  accepted: readonly {
    readonly personId: string;
    readonly programUnitId: string;
    readonly programUnitName: string;
    readonly startsAt: string;
    readonly endsAt: string;
  }[],
  plan: { readonly id: string; readonly fingerprint: string },
): value is SealedScheduleProjection {
  if (!isRecord(value)) return false;
  const baseKeys = [
    "schema", "revision", "sourcePlanVersionId", "sourcePlanFingerprint", "sourceScheduleAuditId",
    "sourceSchedulePointerFingerprint", "acceptedInventoryFingerprint", "cfpSessionInventoryFingerprint",
    "cfpSessionAuthorities", "scheduleFingerprint", "contentGateFingerprint", "sessions",
  ];
  const isLegacy = value.schema === "publication-schedule/v1" && exactKeys(value, baseKeys);
  const hasApproval = value.schema === "publication-schedule/v2" && exactKeys(value, [
    ...baseKeys,
    "sourceScheduleApprovalId", "sourceScheduleApprovalAuditId", "sourceScheduleApprovalFingerprint",
  ]);
  if ((!isLegacy && !hasApproval) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      value.sourcePlanVersionId !== plan.id || value.sourcePlanFingerprint !== plan.fingerprint ||
      !boundedString(value.sourcePlanVersionId) || !SHA256_PATTERN.test(value.sourcePlanFingerprint as string) ||
      (value.sourceScheduleAuditId !== null &&
        (!boundedString(value.sourceScheduleAuditId) || !SEALED_ID_PATTERN.test(value.sourceScheduleAuditId))) ||
      (value.sourceSchedulePointerFingerprint !== null &&
        (!boundedString(value.sourceSchedulePointerFingerprint) || !SHA256_PATTERN.test(value.sourceSchedulePointerFingerprint))) ||
      (value.sourceScheduleAuditId === null) !== (value.sourceSchedulePointerFingerprint === null) ||
      !boundedString(value.acceptedInventoryFingerprint) || !SHA256_PATTERN.test(value.acceptedInventoryFingerprint as string) ||
      !boundedString(value.cfpSessionInventoryFingerprint) || !SHA256_PATTERN.test(value.cfpSessionInventoryFingerprint as string) ||
      !Array.isArray(value.cfpSessionAuthorities) || value.cfpSessionAuthorities.length > MAX_ACCEPTED_ROWS ||
      !boundedString(value.scheduleFingerprint, 160) ||
      (isLegacy
        ? !/^fnv1a-[0-9a-f]{8}$/u.test(value.scheduleFingerprint as string)
        : !SHA256_PATTERN.test(value.scheduleFingerprint as string)) ||
      !boundedString(value.contentGateFingerprint) || !SHA256_PATTERN.test(value.contentGateFingerprint as string) ||
      !Array.isArray(value.sessions) || value.sessions.length < 1 || value.sessions.length > MAX_ACCEPTED_ROWS) return false;
  if (hasApproval && (
    value.sourceScheduleAuditId === null || value.sourceSchedulePointerFingerprint === null ||
    !boundedString(value.sourceScheduleApprovalId) || !SEALED_ID_PATTERN.test(value.sourceScheduleApprovalId) ||
    !boundedString(value.sourceScheduleApprovalAuditId) || !SEALED_ID_PATTERN.test(value.sourceScheduleApprovalAuditId) ||
    !boundedString(value.sourceScheduleApprovalFingerprint) || !SHA256_PATTERN.test(value.sourceScheduleApprovalFingerprint)
  )) return false;
  const cfpUnits = new Set<string>();
  let previousAuthorityUnit: string | null = null;
  for (const authority of value.cfpSessionAuthorities) {
    if (!isRecord(authority) || !exactKeys(authority, ["programUnitId", "sessionFingerprint", "linkFingerprints"]) ||
        !boundedString(authority.programUnitId) || !SEALED_ID_PATTERN.test(authority.programUnitId) ||
        !boundedString(authority.sessionFingerprint) || !SHA256_PATTERN.test(authority.sessionFingerprint) ||
        !Array.isArray(authority.linkFingerprints) ||
        cfpUnits.has(authority.programUnitId) ||
        (previousAuthorityUnit !== null && previousAuthorityUnit >= authority.programUnitId)) return false;
    const linkFingerprints = authority.linkFingerprints;
    if (linkFingerprints.length < 1 || linkFingerprints.length > 24 ||
        linkFingerprints.some((entry) => typeof entry !== "string" || !SHA256_PATTERN.test(entry)) ||
        new Set(linkFingerprints).size !== linkFingerprints.length ||
        linkFingerprints.some((entry, index) => index > 0 && linkFingerprints[index - 1] >= entry)) return false;
    cfpUnits.add(authority.programUnitId);
    previousAuthorityUnit = authority.programUnitId;
  }
  if (fingerprintOf(value.cfpSessionAuthorities) !== value.cfpSessionInventoryFingerprint) return false;
  if (value.cfpSessionAuthorities.length > 0 && value.sourceScheduleAuditId === null) return false;
  const acceptedUnits = new Set(accepted.map((row) => row.programUnitId));
  const exactUnits = new Set([...acceptedUnits, ...cfpUnits]);
  if (exactUnits.size < 1 || exactUnits.size !== value.sessions.length) return false;
  const acceptedPeopleByUnit = new Map<string, Set<string>>();
  const acceptedNamesByUnit = new Map<string, string>();
  const acceptedTimesByUnit = new Map<string, { startsAt: string; endsAt: string }>();
  for (const row of accepted) {
    const people = acceptedPeopleByUnit.get(row.programUnitId) ?? new Set<string>();
    people.add(row.personId);
    acceptedPeopleByUnit.set(row.programUnitId, people);
    const priorName = acceptedNamesByUnit.get(row.programUnitId);
    if (priorName !== undefined && priorName !== row.programUnitName) return false;
    acceptedNamesByUnit.set(row.programUnitId, row.programUnitName);
    const priorTimes = acceptedTimesByUnit.get(row.programUnitId);
    if (priorTimes && (priorTimes.startsAt !== row.startsAt || priorTimes.endsAt !== row.endsAt)) return false;
    acceptedTimesByUnit.set(row.programUnitId, { startsAt: row.startsAt, endsAt: row.endsAt });
  }
  const units = new Set<string>();
  const slugs = new Set<string>();
  let previousUnit: string | null = null;
  for (const session of value.sessions) {
    if (!isRecord(session) || !exactKeys(session, [
      "programUnitId", "programUnitName", "slug", "title", "abstract", "titleVersionId", "titleContentHash",
      "abstractVersionId", "abstractContentHash", "durationMinutes", "capacity", "speakerPersonIds", "placement",
    ]) ||
        !boundedString(session.programUnitId) || !SEALED_ID_PATTERN.test(session.programUnitId) || !exactUnits.has(session.programUnitId) || units.has(session.programUnitId) ||
        !boundedString(session.programUnitName) ||
        (acceptedNamesByUnit.has(session.programUnitId) && acceptedNamesByUnit.get(session.programUnitId) !== session.programUnitName) ||
        !boundedString(session.slug) || !SEALED_ID_PATTERN.test(session.slug) || slugs.has(session.slug) ||
        !boundedString(session.title) || typeof session.abstract !== "string" || session.abstract.length > 12000 || /[\u0000-\u001F\u007F-\u009F]/u.test(session.abstract) ||
        !Number.isSafeInteger(session.durationMinutes) || (session.durationMinutes as number) < 1 ||
        !Number.isSafeInteger(session.capacity) || (session.capacity as number) < 1 ||
        !Array.isArray(session.speakerPersonIds) || session.speakerPersonIds.length < 1 || session.speakerPersonIds.length > 24 ||
        session.speakerPersonIds.some((personId) => typeof personId !== "string" || !SEALED_ID_PATTERN.test(personId)) ||
        new Set(session.speakerPersonIds as string[]).size !== session.speakerPersonIds.length ||
        (session.speakerPersonIds as string[]).some((personId, index) => index > 0 && (session.speakerPersonIds as string[])[index - 1]! >= personId) ||
        [...(acceptedPeopleByUnit.get(session.programUnitId) ?? [])].some((personId) => !(session.speakerPersonIds as string[]).includes(personId)) ||
        (!cfpUnits.has(session.programUnitId) &&
          (acceptedPeopleByUnit.get(session.programUnitId)?.size ?? 0) !== session.speakerPersonIds.length) ||
        (session.titleVersionId === null) !== (session.titleContentHash === null) ||
        (session.abstractVersionId === null) !== (session.abstractContentHash === null) ||
        (acceptedUnits.has(session.programUnitId) && (session.titleVersionId === null || session.abstractVersionId === null)) ||
        (!acceptedUnits.has(session.programUnitId) &&
          (session.titleVersionId !== null || session.titleContentHash !== null ||
            session.abstractVersionId !== null || session.abstractContentHash !== null)) ||
        (session.titleVersionId !== null && (!SEALED_ID_PATTERN.test(session.titleVersionId as string) || !SHA256_PATTERN.test(session.titleContentHash as string))) ||
        (session.abstractVersionId !== null && (!SEALED_ID_PATTERN.test(session.abstractVersionId as string) || !SHA256_PATTERN.test(session.abstractContentHash as string))) ||
        (previousUnit !== null && previousUnit >= session.programUnitId)) return false;
    if (!isRecord(session.placement) || !exactKeys(session.placement, ["dayId", "timeSlotId", "roomId", "roomName", "venue", "trackId", "trackName", "startsAt", "endsAt"])) return false;
    const placement = session.placement;
    if (
      !["dayId", "timeSlotId", "roomId", "roomName", "venue", "trackId", "trackName"].every((key) => boundedString(placement[key])) ||
      !["dayId", "timeSlotId", "roomId", "trackId"].every((key) => SEALED_ID_PATTERN.test(placement[key] as string)) ||
      !validTimestamp(placement.startsAt) || !validTimestamp(placement.endsAt) ||
      Date.parse(placement.startsAt as string) >= Date.parse(placement.endsAt as string) ||
      (acceptedTimesByUnit.has(session.programUnitId) &&
        (placement.startsAt !== acceptedTimesByUnit.get(session.programUnitId)?.startsAt ||
          placement.endsAt !== acceptedTimesByUnit.get(session.programUnitId)?.endsAt))
    ) return false;
    units.add(session.programUnitId);
    slugs.add(session.slug);
    previousUnit = session.programUnitId;
  }
  return units.size === exactUnits.size && [...cfpUnits].every((programUnitId) => units.has(programUnitId));
}

function strictSealedReleaseContent(raw: unknown): SealedReleaseContent | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RELEASE_JSON_BYTES) return null;
  let content: SealedReleaseContent;
  try {
    content = parseSealedReleaseContent(raw);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.event) || !isRecord(parsed.plan)) return null;
  const event = parsed.event;
  const plan = parsed.plan;
  const hasArtifactManifest = hasOwn(parsed, "artifactBindings");
  const hasHeadshotManifest = hasOwn(parsed, "speakerHeadshots");
  const hasSchedule = hasOwn(parsed, "schedule");
  const hasLineage = hasOwn(parsed, "lineage");
  if (!exactKeys(parsed, releaseContentKeys(hasArtifactManifest, hasHeadshotManifest, hasSchedule, hasLineage)) ||
      !exactKeys(event, ["id", "name", "timezone", "startsAt", "endsAt"]) ||
      !exactKeys(plan, ["id", "versionNumber", "fingerprint"]) ||
      !Number.isSafeInteger(parsed.audiencePolicyVersion) || (parsed.audiencePolicyVersion as number) < 1 ||
      !Number.isSafeInteger(parsed.commitmentWatermark) || (parsed.commitmentWatermark as number) < 0 ||
      content.accepted.length > MAX_ACCEPTED_ROWS) return null;
  if (![event.id, event.name, event.timezone, event.startsAt, event.endsAt, plan.id, plan.fingerprint]
    .every((field) => boundedString(field)) ||
      !SEALED_ID_PATTERN.test(event.id as string) || !SEALED_ID_PATTERN.test(plan.id as string) ||
      !/^[a-f0-9]{64}$/u.test(plan.fingerprint as string) ||
      !validTimestamp(event.startsAt) || !validTimestamp(event.endsAt) ||
      Date.parse(event.startsAt as string) >= Date.parse(event.endsAt as string)) return null;
  if (hasLineage && !validReleaseLineage(parsed.lineage)) return null;

  const people = new Set<string>();
  const offers = new Set<string>();
  const units = new Set<string>();
  for (const accepted of content.accepted) {
    const row = accepted as unknown as Record<string, unknown>;
    if (!exactKeys(row, ["personId", "personName", "email", "offerId", "termsFingerprint", "programUnitId", "programUnitName", "role", "startsAt", "endsAt"]) ||
        ![accepted.personId, accepted.personName, accepted.email, accepted.offerId, accepted.termsFingerprint, accepted.programUnitId, accepted.programUnitName, accepted.role]
          .every((field) => boundedString(field)) ||
        !SEALED_ID_PATTERN.test(accepted.personId) || !SEALED_ID_PATTERN.test(accepted.offerId) ||
        !SEALED_ID_PATTERN.test(accepted.programUnitId) || !/^[a-f0-9]{64}$/u.test(accepted.termsFingerprint) ||
        !validTimestamp(accepted.startsAt) || !validTimestamp(accepted.endsAt) ||
        Date.parse(accepted.startsAt) >= Date.parse(accepted.endsAt) ||
        people.has(accepted.personId) || offers.has(accepted.offerId) || units.has(`${accepted.personId}:${accepted.programUnitId}`)) return null;
    people.add(accepted.personId);
    offers.add(accepted.offerId);
    units.add(`${accepted.personId}:${accepted.programUnitId}`);
  }

  if (hasArtifactManifest && !validArtifactBindingManifest(parsed.artifactBindings, people)) return null;
  if (hasArtifactManifest && (!hasHeadshotManifest ||
      fingerprintOf(parsed.speakerHeadshots) !== fingerprintOf(headshotsFromArtifactBindings(parsed.artifactBindings as SealedPublicationArtifactBinding[])))) return null;
  if (hasHeadshotManifest && !validHeadshotManifest(parsed.speakerHeadshots, people)) return null;
  if (hasSchedule && !validSealedSchedule(parsed.schedule, content.accepted, content.plan)) return null;
  if (content.accepted.length === 0 && (!hasSchedule || content.schedule!.cfpSessionAuthorities.length === 0)) return null;

  if (content.agendas.length !== people.size) return null;
  const agendaPeople = new Set<string>();
  for (const agenda of content.agendas) {
    const record = agenda as unknown as Record<string, unknown>;
    if (!exactKeys(record, ["personId", "personName", "email", "items"]) ||
        ![agenda.personId, agenda.personName, agenda.email].every((field) => boundedString(field)) ||
        !SEALED_ID_PATTERN.test(agenda.personId) || !Array.isArray(agenda.items) || agendaPeople.has(agenda.personId)) return null;
    agendaPeople.add(agenda.personId);
    for (const item of agenda.items) {
      const itemRecord = item as unknown as Record<string, unknown>;
      if (!exactKeys(itemRecord, ["programUnitId", "programUnitName", "role", "startsAt", "endsAt"]) ||
          ![item.programUnitId, item.programUnitName, item.role].every((field) => boundedString(field)) ||
          !SEALED_ID_PATTERN.test(item.programUnitId) || !validTimestamp(item.startsAt) || !validTimestamp(item.endsAt) ||
          Date.parse(item.startsAt) >= Date.parse(item.endsAt)) return null;
    }
  }
  return agendaPeople.size === people.size && [...people].every((personId) => agendaPeople.has(personId)) ? content : null;
}

function identityProjectionFingerprint(release: SealedReleaseContent): string {
  return fingerprintOf(release.accepted.map((accepted) => ({
    personId: accepted.personId,
    personName: accepted.personName,
    email: accepted.email,
  })));
}

function materializationFingerprint(release: SealedReleaseContent): string {
  return fingerprintOf(release.agendas.map((agenda) => ({
    personId: agenda.personId,
    personName: agenda.personName,
    email: agenda.email,
    items: agenda.items,
  })));
}

function assignmentKey(row: { personId: string; programUnitId: string; assignmentType: string }): string {
  return JSON.stringify([row.personId, row.programUnitId, row.assignmentType]);
}

function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function sameMultiset(left: string[], right: string[]): boolean {
  const a = multiset(left);
  const b = multiset(right);
  if (a.size !== b.size) return false;
  return [...a].every(([key, count]) => b.get(key) === count);
}

export function assertCanonicalPlanVersionContent(
  plan: { id: string; runId: string; fingerprint: string; versionNumber: number; content: string; inputFingerprint: string },
  event: { id: string; name: string; timezone: string; startsAt: string; endsAt: string },
  authoritativeAssignments: { personId: string; programUnitId: string; assignmentType: string }[],
): void {
  let parsed: unknown;
  try { parsed = JSON.parse(plan.content) as unknown; } catch { throw new Error("PLAN_CONTENT_INVALID"); }
  if (isRecord(parsed) && parsed.versionNumber !== plan.versionNumber) {
    throw new Error("PLAN_VERSION_NUMBER_MISMATCH: the sealed plan content does not match its immutable version row.");
  }
  if (!isRecord(parsed) ||
      !exactKeys(parsed, ["schema", "eventId", "eventName", "timezone", "startsAt", "endsAt", "runId", "inputFingerprint", "snapshotFingerprint", "versionNumber", "assignments", "exclusions", "diagnostics"]) ||
      parsed.schema !== "plan-version/v1" || parsed.eventId !== event.id || parsed.eventName !== event.name ||
      parsed.timezone !== event.timezone || parsed.startsAt !== event.startsAt || parsed.endsAt !== event.endsAt ||
      parsed.versionNumber !== plan.versionNumber || parsed.runId !== plan.runId ||
      !boundedString(parsed.inputFingerprint) || parsed.inputFingerprint !== plan.inputFingerprint ||
      !boundedString(parsed.snapshotFingerprint) || !Array.isArray(parsed.assignments) ||
      !Array.isArray(parsed.exclusions) || !isRecord(parsed.diagnostics) ||
      fingerprintOf(parsed) !== plan.fingerprint) {
    throw new Error("PLAN_CONTENT_FINGERPRINT_INVALID: the sealed plan content is not the canonical immutable plan.");
  }
  for (const exclusion of parsed.exclusions) {
    if (!isRecord(exclusion) || !exactKeys(exclusion, ["personId", "reason"]) ||
        !boundedString(exclusion.personId) || typeof exclusion.reason !== "string") {
      throw new Error("PLAN_EXCLUSIONS_INVALID: the sealed plan exclusions are not canonical.");
    }
  }
  if (!exactKeys(parsed.diagnostics, ["messages", "unitCounts", "moderatorsWithoutUnit"]) ||
      !Array.isArray(parsed.diagnostics.messages) ||
      parsed.diagnostics.messages.some((message) => typeof message !== "string") ||
      !isRecord(parsed.diagnostics.unitCounts) ||
      Object.values(parsed.diagnostics.unitCounts).some((count) => !Number.isSafeInteger(count)) ||
      !Array.isArray(parsed.diagnostics.moderatorsWithoutUnit) ||
      parsed.diagnostics.moderatorsWithoutUnit.some((personId) => typeof personId !== "string")) {
    throw new Error("PLAN_DIAGNOSTICS_INVALID: the sealed plan diagnostics are not canonical.");
  }
  const contentAssignments: { personId: string; programUnitId: string; assignmentType: string }[] = [];
  for (const assignment of parsed.assignments) {
    if (!isRecord(assignment) || !exactKeys(assignment, ["personId", "programUnitId", "assignmentType", "explanation"]) ||
        !boundedString(assignment.personId) || !boundedString(assignment.programUnitId) || !boundedString(assignment.assignmentType) ||
        typeof assignment.explanation !== "string" || assignment.explanation.length > 4096) {
      throw new Error("PLAN_ASSIGNMENTS_INVALID: the sealed plan assignments are not canonical.");
    }
    contentAssignments.push({ personId: assignment.personId, programUnitId: assignment.programUnitId, assignmentType: assignment.assignmentType });
  }
  if (!sameMultiset(contentAssignments.map(assignmentKey), authoritativeAssignments.map(assignmentKey))) {
    throw new Error("PLAN_ASSIGNMENTS_MISMATCH: the sealed plan does not match its authoritative assignment rows.");
  }
}

export function parseSealedReleaseContent(raw: string): SealedReleaseContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release cannot be decoded safely by the current portal.",
      "publication-release",
    );
  }
  const hasArtifactManifest = isRecord(parsed) && hasOwn(parsed, "artifactBindings");
  const hasHeadshotManifest = isRecord(parsed) && hasOwn(parsed, "speakerHeadshots");
  const hasSchedule = isRecord(parsed) && hasOwn(parsed, "schedule");
  const hasLineage = isRecord(parsed) && hasOwn(parsed, "lineage");
  if (!isRecord(parsed) || parsed.schema !== "publication-release/v2" || !isRecord(parsed.event) || !isRecord(parsed.plan) || !Array.isArray(parsed.accepted) || !Array.isArray(parsed.agendas) ||
      !exactKeys(parsed, releaseContentKeys(hasArtifactManifest, hasHeadshotManifest, hasSchedule, hasLineage)) ||
      !exactKeys(parsed.event, ["id", "name", "timezone", "startsAt", "endsAt"]) ||
      !exactKeys(parsed.plan, ["id", "versionNumber", "fingerprint"]) ||
      !boundedString(parsed.event.id) || !boundedString(parsed.event.name) || !boundedString(parsed.event.timezone) ||
      !validTimestamp(parsed.event.startsAt) || !validTimestamp(parsed.event.endsAt) || Date.parse(parsed.event.startsAt) >= Date.parse(parsed.event.endsAt) ||
      !boundedString(parsed.plan.id) || !Number.isSafeInteger(parsed.plan.versionNumber) || (parsed.plan.versionNumber as number) < 1 || !boundedString(parsed.plan.fingerprint) ||
      !Number.isSafeInteger(parsed.audiencePolicyVersion) || (parsed.audiencePolicyVersion as number) < 0 || !Number.isSafeInteger(parsed.commitmentWatermark) || (parsed.commitmentWatermark as number) < 0 ||
      parsed.accepted.length > 500 || parsed.agendas.length !== parsed.accepted.length) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release predates the current identity-safe portal projection.",
      "publication-release",
    );
  }
  if (hasLineage && !validReleaseLineage(parsed.lineage)) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release contains invalid supersession lineage.",
      "publication-release",
    );
  }
  for (const agenda of parsed.agendas) {
    if (
      !isRecord(agenda) ||
      !exactKeys(agenda, ["personId", "personName", "email", "items"]) ||
      typeof agenda.personId !== "string" ||
      typeof agenda.personName !== "string" ||
      typeof agenda.email !== "string" ||
      !Array.isArray(agenda.items) ||
      agenda.items.some(
        (item) =>
          !isRecord(item) || !exactKeys(item, ["programUnitId", "programUnitName", "role", "startsAt", "endsAt"]) ||
          typeof item.programUnitId !== "string" ||
          typeof item.programUnitName !== "string" ||
          typeof item.role !== "string" ||
          typeof item.startsAt !== "string" ||
          typeof item.endsAt !== "string",
      )
    ) {
      throw new DenialError(
        "RELEASE_SCHEMA_UNSUPPORTED",
        "This sealed release is missing its materialized participant identity.",
        "publication-release",
      );
    }
  }
  const acceptedPeople = new Set<string>();
  for (const accepted of parsed.accepted) {
    if (
      !isRecord(accepted) ||
      !exactKeys(accepted, ["personId", "personName", "email", "offerId", "termsFingerprint", "programUnitId", "programUnitName", "role", "startsAt", "endsAt"]) ||
      typeof accepted.personId !== "string" ||
      typeof accepted.personName !== "string" ||
      typeof accepted.email !== "string" ||
      typeof accepted.offerId !== "string" ||
      typeof accepted.termsFingerprint !== "string"
      ) {
      throw new DenialError(
        "RELEASE_SCHEMA_UNSUPPORTED",
        "This sealed release is missing accepted-commitment identity or lineage.",
        "publication-release",
      );
    }
    acceptedPeople.add(accepted.personId);
    if (!validTimestamp(accepted.startsAt) || !validTimestamp(accepted.endsAt) || Date.parse(accepted.startsAt) >= Date.parse(accepted.endsAt)) {
      throw new DenialError("RELEASE_SCHEMA_UNSUPPORTED", "This sealed release contains an invalid commitment interval.", "publication-release");
    }
  }
  if (hasArtifactManifest && !validArtifactBindingManifest(parsed.artifactBindings, acceptedPeople)) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release contains an invalid publication-artifact binding manifest.",
      "publication-release",
    );
  }
  if (hasArtifactManifest && (!hasHeadshotManifest ||
      fingerprintOf(parsed.speakerHeadshots) !== fingerprintOf(headshotsFromArtifactBindings(parsed.artifactBindings as SealedPublicationArtifactBinding[])))) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release contains a divergent public artifact projection.",
      "publication-release",
    );
  }
  if (hasHeadshotManifest && !validHeadshotManifest(parsed.speakerHeadshots, acceptedPeople)) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release contains an invalid speaker-headshot manifest.",
      "publication-release",
    );
  }
  if (hasSchedule && !validSealedSchedule(parsed.schedule, parsed.accepted as Array<{
    personId: string;
    programUnitId: string;
    programUnitName: string;
    startsAt: string;
    endsAt: string;
  }>, parsed.plan as { id: string; fingerprint: string })) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release contains an invalid schedule projection.",
      "publication-release",
    );
  }
  if (parsed.accepted.length === 0 && (!hasSchedule || (parsed.schedule as SealedScheduleProjection).cfpSessionAuthorities.length === 0)) {
    throw new DenialError(
      "RELEASE_SCHEMA_UNSUPPORTED",
      "This sealed release has no accepted schedule authority.",
      "publication-release",
    );
  }
  return parsed as unknown as SealedReleaseContent;
}

interface RequiredPublicationArtifactTaskRow {
  readonly taskId: string;
  readonly taskWorkspaceId: string;
  readonly taskEventId: string;
  readonly taskPersonId: string;
  readonly taskAssignmentId: string;
  readonly taskKind: string;
  readonly contentKind: string;
  readonly required: number;
  readonly gate: string;
  readonly owner: string;
  readonly assignmentId: string;
  readonly assignmentPersonId: string;
}

interface SealArtifactCandidateRow {
  readonly assignmentId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: "HEADSHOT" | "SLIDES";
  readonly artifactId: string;
  readonly contentVersionId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly payloadJson: string;
  readonly payloadBytes: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly displayFilename: string;
  readonly storageId: string;
  readonly storageFilename: string;
  readonly authorityPayloadJson: string;
  readonly authorityPayloadFingerprint: string;
  readonly intentPayloadJson: string;
  readonly approvalDetailsJson: string;
  readonly reviewerRole: string;
}

function canonicalArtifactPayload(row: SealArtifactCandidateRow): Record<string, unknown> {
  return {
    kind: row.kind,
    asset: {
      assetId: row.artifactId,
      fileName: row.displayFilename,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      checksum: row.sha256,
      storageRef: `synthetic://artifact/${row.artifactId}`,
    },
  };
}

function canonicalArtifactAuthority(row: SealArtifactCandidateRow, workspaceId: string, eventId: string): Record<string, unknown> {
  return {
    schema: "speaker-artifact-submission/v1",
    artifactId: row.artifactId,
    workspaceId,
    eventId,
    personId: row.personId,
    taskId: row.taskId,
    kind: row.kind,
    version: row.version,
    storageId: row.storageId,
    storageFilename: row.storageFilename,
    sha256: row.sha256,
    byteSize: row.byteSize,
    mediaType: row.mediaType,
    displayFilename: row.displayFilename,
    contentVersionId: row.contentVersionId,
    contentVersionHash: row.contentHash,
  };
}

function exactApprovalAuthority(row: SealArtifactCandidateRow): boolean {
  let details: unknown;
  try { details = JSON.parse(row.approvalDetailsJson) as unknown; } catch { return false; }
  return isRecord(details) && exactKeys(details, [
    "schema", "assignmentId", "reviewState", "gate", "submissionVersionId",
    "submissionContentHash", "capability",
  ]) && details.schema === "speaker-content-approval-authority/v1" &&
    details.assignmentId === row.assignmentId && details.reviewState === "APPROVED" &&
    details.gate === "PUBLICATION" && details.submissionVersionId === row.contentVersionId &&
    details.submissionContentHash === row.contentHash && details.capability === "phase0.pipeline.manage";
}

function artifactCandidateIsCanonical(
  row: SealArtifactCandidateRow,
  workspaceId: string,
  eventId: string,
): boolean {
  const payload = canonicalArtifactPayload(row);
  const authority = canonicalArtifactAuthority(row, workspaceId, eventId);
  return canonicalJson(payload) === row.payloadJson && canonicalJson(payload) === row.intentPayloadJson &&
    fingerprintOf(payload) === row.contentHash && row.payloadBytes === Buffer.byteLength(row.payloadJson, "utf8") &&
    canonicalJson(authority) === row.authorityPayloadJson &&
    fingerprintOf(authority) === row.authorityPayloadFingerprint && exactApprovalAuthority(row);
}

/** Resolve every required publication artifact only while sealRelease owns its transaction lock. */
function selectPublicationArtifactsForSeal(
  db: Db,
  workspaceId: string,
  eventId: string,
  planVersionId: string,
  acceptedAssignments: readonly { readonly assignmentId: string; readonly personId: string }[],
  organizerActorId: string,
): SealedPublicationArtifactBinding[] {
  const acceptedByAssignment = new Map(acceptedAssignments.map((row) => [row.assignmentId, row.personId]));
  const tasks = (db.prepare(
    `SELECT task.id AS taskId, task.workspace_id AS taskWorkspaceId,
            task.event_id AS taskEventId, task.person_id AS taskPersonId,
            task.assignment_id AS taskAssignmentId, task.task_kind AS taskKind,
            task.content_kind AS contentKind, task.required, task.gate, task.owner,
            assignment.id AS assignmentId, assignment.person_id AS assignmentPersonId
       FROM speaker_tasks task
       JOIN plan_assignments assignment ON assignment.id = task.assignment_id
      WHERE assignment.workspace_id = ? AND assignment.plan_version_id = ?
        AND task.required = 1 AND task.gate = 'PUBLICATION'
      ORDER BY assignment.id, task.id`,
  ).all(workspaceId, planVersionId) as unknown as RequiredPublicationArtifactTaskRow[])
    .filter((task) => acceptedByAssignment.has(task.assignmentId));
  if (tasks.length > MAX_ARTIFACT_BINDINGS) {
    throw new Error("PUBLICATION_ARTIFACT_CARDINALITY_INVALID: too many required publication artifact tasks.");
  }
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.taskId) || task.taskAssignmentId !== task.assignmentId ||
        task.taskWorkspaceId !== workspaceId || task.taskEventId !== eventId ||
        task.taskPersonId !== task.assignmentPersonId || task.taskPersonId !== acceptedByAssignment.get(task.assignmentId) ||
        (task.taskKind !== "HEADSHOT" && task.taskKind !== "SLIDES") || task.contentKind !== task.taskKind ||
        task.required !== 1 || task.gate !== "PUBLICATION" || task.owner !== "SPEAKER") {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: a required artifact task has divergent assignment authority.");
    }
    taskIds.add(task.taskId);
  }
  if (tasks.length === 0) return [];

  const contentRepository = createDurableContentOperationsRepository(db);
  let gate: ReturnType<typeof evaluateContentPublicationGate>;
  try {
    gate = evaluateContentPublicationGate(
      contentRepository,
      { workspaceId, eventId, actorId: organizerActorId, actorKind: "organizer" },
      tasks.map((task) => ({
        id: `publication-artifact:${task.taskId}`,
        label: task.taskKind === "HEADSHOT" ? "Speaker headshot" : "Speaker slides",
        personId: task.taskPersonId,
        taskId: task.taskId,
        kind: task.taskKind as "HEADSHOT" | "SLIDES",
        required: true,
      })),
    );
  } catch {
    throw new Error("PUBLICATION_ARTIFACT_NOT_READY: required artifact publication evidence is unavailable or divergent.");
  }
  if (gate.state !== "READY" || gate.items.length !== tasks.length || gate.items.some((item) =>
    item.status !== "APPROVED" || item.currentVersionId === null || item.currentContentHash === null ||
    item.approvedVersionId !== item.currentVersionId || item.approvedContentHash !== item.currentContentHash)) {
    throw new Error("PUBLICATION_ARTIFACT_NOT_READY: every required publication artifact needs exact approval of its current committed version.");
  }

  const selectForTask = db.prepare(
    `SELECT task.assignment_id AS assignmentId, artifact.person_id AS personId,
            artifact.task_id AS taskId, artifact.kind,
            artifact.id AS artifactId, artifact.content_version_id AS contentVersionId,
            artifact.version, version.content_hash AS contentHash,
            version.payload_json AS payloadJson, version.payload_bytes AS payloadBytes,
            artifact.sha256,
            artifact.media_type AS mediaType, artifact.size_bytes AS byteSize,
            artifact.display_filename AS displayFilename, artifact.storage_id AS storageId,
            artifact.storage_filename AS storageFilename,
            authority.payload_json AS authorityPayloadJson,
            authority.payload_fingerprint AS authorityPayloadFingerprint,
            intent.content_payload_json AS intentPayloadJson,
            review_authority.details_json AS approvalDetailsJson,
            review_actor.role AS reviewerRole
       FROM speaker_tasks task
       JOIN plan_assignments assignment
         ON assignment.id = task.assignment_id
        AND assignment.workspace_id = task.workspace_id
        AND assignment.person_id = task.person_id
       JOIN artifact_records artifact
         ON artifact.workspace_id = task.workspace_id
        AND artifact.event_id = task.event_id
        AND artifact.person_id = task.person_id
        AND artifact.task_id = task.id
        AND artifact.kind = task.task_kind
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id
        AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id
        AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id
        AND version.kind = artifact.kind
        AND version.version = artifact.version
       JOIN speaker_content_reviews review
         ON review.workspace_id = version.workspace_id
        AND review.event_id = version.event_id
        AND review.person_id = version.person_id
        AND review.task_id = version.task_id
        AND review.submission_version_id = version.id
        AND review.submission_content_hash = version.content_hash
        AND review.review_state = 'APPROVED'
        AND review.gate = 'PUBLICATION'
       JOIN audit_events review_authority
         ON review_authority.workspace_id = review.workspace_id
        AND review_authority.actor_kind = 'account'
        AND review_authority.actor_ref = review.reviewed_by
        AND review_authority.action = 'speaker.content.approved'
        AND review_authority.target_type = 'speaker_content_review'
        AND review_authority.target_id = review.id
        AND json_extract(review_authority.details_json, '$.schema') = 'speaker-content-approval-authority/v1'
        AND json_extract(review_authority.details_json, '$.assignmentId') = task.assignment_id
        AND json_extract(review_authority.details_json, '$.reviewState') = 'APPROVED'
        AND json_extract(review_authority.details_json, '$.gate') = review.gate
        AND json_extract(review_authority.details_json, '$.submissionVersionId') = review.submission_version_id
        AND json_extract(review_authority.details_json, '$.submissionContentHash') = review.submission_content_hash
        AND json_extract(review_authority.details_json, '$.capability') = 'phase0.pipeline.manage'
       JOIN accounts review_actor
         ON review_actor.workspace_id = review.workspace_id
        AND review_actor.id = review.reviewed_by
       JOIN artifact_upload_intents intent
         ON intent.artifact_id = artifact.id
        AND intent.workspace_id = artifact.workspace_id
        AND intent.event_id = artifact.event_id
        AND intent.person_id = artifact.person_id
        AND intent.task_id = artifact.task_id
        AND intent.kind = artifact.kind
        AND intent.content_version_id = artifact.content_version_id
        AND intent.storage_id = artifact.storage_id
        AND intent.storage_filename = artifact.storage_filename
        AND intent.version = artifact.version
        AND COALESCE(intent.supersedes_record_id, '') = COALESCE(artifact.supersedes_record_id, '')
        AND intent.sha256 = artifact.sha256
        AND intent.size_bytes = artifact.size_bytes
        AND intent.media_type = artifact.media_type
        AND intent.display_filename = artifact.display_filename
        AND intent.status = 'COMMITTED'
        AND intent.committed_at IS NOT NULL
       JOIN domain_events authority
         ON authority.id = artifact.authority_event_id
        AND authority.workspace_id = artifact.workspace_id
        AND authority.event_type = 'speaker.artifact.submitted'
        AND authority.aggregate_type = 'speaker_task'
        AND authority.aggregate_id = artifact.task_id
      WHERE task.id = ? AND task.workspace_id = ? AND task.event_id = ?
        AND task.person_id = ? AND task.assignment_id = ?
        AND assignment.plan_version_id = ?
        AND task.required = 1 AND task.gate = 'PUBLICATION' AND task.owner = 'SPEAKER'
        AND task.task_kind = task.content_kind
        AND task.task_kind IN ('HEADSHOT', 'SLIDES')
        AND NOT EXISTS (
          SELECT 1 FROM speaker_content_versions later
           WHERE later.workspace_id = artifact.workspace_id
             AND later.event_id = artifact.event_id
             AND later.person_id = artifact.person_id
             AND later.task_id = artifact.task_id
             AND later.kind = artifact.kind
             AND later.version > artifact.version
        )
        AND NOT EXISTS (
          SELECT 1 FROM artifact_upload_intents pending
           WHERE pending.workspace_id = task.workspace_id AND pending.event_id = task.event_id
             AND pending.person_id = task.person_id AND pending.task_id = task.id
             AND pending.kind = task.task_kind AND pending.status = 'PREPARED'
        )
        AND (
          SELECT COUNT(*) FROM audit_events approval_evidence
           WHERE approval_evidence.workspace_id = review.workspace_id
             AND approval_evidence.action = 'speaker.content.approved'
             AND approval_evidence.target_type = 'speaker_content_review'
             AND approval_evidence.target_id = review.id
        ) = 1
      ORDER BY artifact.id`,
  );

  const manifest: SealedPublicationArtifactBinding[] = [];
  for (const task of tasks) {
    const rows = selectForTask.all(
      task.taskId,
      workspaceId,
      eventId,
      task.taskPersonId,
      task.assignmentId,
      planVersionId,
    ) as unknown as SealArtifactCandidateRow[];
    if (rows.length !== 1) {
      throw new Error("PUBLICATION_ARTIFACT_CARDINALITY_INVALID: a required artifact task does not have exactly one current committed approval candidate.");
    }
    const row = rows[0]!;
    if (!roleHasCapability(row.reviewerRole, "phase0.pipeline.manage")) {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the artifact approval actor is not organizer-capable.");
    }
    const gateItem = gate.items.find((item) => item.requirement.id === `publication-artifact:${task.taskId}`);
    const entry: SealedPublicationArtifactBinding = {
      assignmentId: row.assignmentId,
      personId: row.personId,
      taskId: row.taskId,
      kind: row.kind,
      intent: artifactIntent(row.kind),
      artifactId: row.artifactId,
      contentVersionId: row.contentVersionId,
      version: row.version,
      contentHash: row.contentHash,
      sha256: row.sha256,
      mediaType: row.mediaType as "image/png" | "application/pdf",
      byteSize: row.byteSize,
      displayFilename: row.displayFilename,
    };
    if (!validSealedPublicationArtifactBinding(entry) || entry.assignmentId !== task.assignmentId ||
        entry.personId !== task.taskPersonId || entry.taskId !== task.taskId || entry.kind !== task.taskKind ||
        gateItem?.currentVersionId !== entry.contentVersionId || gateItem.currentContentHash !== entry.contentHash ||
        gateItem.approvedVersionId !== entry.contentVersionId || gateItem.approvedContentHash !== entry.contentHash ||
        !artifactCandidateIsCanonical(row, workspaceId, eventId)) {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the approved artifact evidence is not canonical.");
    }
    let verified;
    try {
      verified = readCommittedSpeakerArtifactForSeal(db, {
        workspaceId,
        eventId,
        personId: entry.personId,
        taskId: entry.taskId,
        kind: entry.kind,
      }, entry.artifactId);
    } catch {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the committed artifact bytes failed verification.");
    }
    if (!verified || verified.record.version !== entry.version || verified.record.sha256 !== entry.sha256 ||
        verified.record.byteSize !== entry.byteSize || verified.record.mediaType !== entry.mediaType ||
        verified.record.displayFilename !== entry.displayFilename) {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the committed artifact bytes or metadata diverge.");
    }
    manifest.push(entry);
  }
  if (!validArtifactBindingManifest(manifest, new Set(acceptedAssignments.map((row) => row.personId)))) {
    throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the artifact binding manifest is not canonical.");
  }
  return manifest;
}

function insertSealedHeadshotBindings(
  db: Db,
  workspaceId: string,
  eventId: string,
  releaseId: string,
  manifest: readonly SealedSpeakerHeadshot[],
  boundAt: string,
): void {
  const insert = db.prepare(
    `INSERT INTO speaker_artifact_release_bindings
       (id, workspace_id, event_id, release_id, person_id, artifact_id, content_hash, bound_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of manifest) {
    const result = insert.run(
      deterministicUuid(`speaker-artifact-release-binding:${releaseId}:${entry.personId}:${entry.artifactId}`),
      workspaceId,
      eventId,
      releaseId,
      entry.personId,
      entry.artifactId,
      entry.contentHash,
      boundAt,
    );
    if (result.changes !== 1) throw new Error("HEADSHOT_RELEASE_BINDING_FAILED");
  }
}

interface SealedHeadshotBindingRow extends SealArtifactCandidateRow {
  readonly bindingWorkspaceId: string;
  readonly bindingEventId: string;
  readonly releaseId: string;
  readonly bindingPersonId: string;
  readonly bindingArtifactId: string;
  readonly bindingContentHash: string;
  readonly boundAt: string;
  readonly sealedAt: string;
}

/** Legacy releases have no manifest and therefore intentionally authorize no public headshots. */
function sealedHeadshotBindingsMatch(
  db: Db,
  workspaceId: string,
  eventId: string,
  releaseId: string,
  release: SealedReleaseContent,
): boolean {
  if (release.speakerHeadshots === undefined) return true;
  const manifest = release.speakerHeadshots;
  const count = db.prepare(
    `SELECT COUNT(*) AS count
       FROM speaker_artifact_release_bindings
      WHERE workspace_id = ? AND event_id = ? AND release_id = ?`,
  ).get(workspaceId, eventId, releaseId) as { count: number };
  if (count.count !== manifest.length) return false;
  const rows = db.prepare(
    `SELECT binding.workspace_id AS bindingWorkspaceId, binding.event_id AS bindingEventId,
            binding.release_id AS releaseId, binding.person_id AS bindingPersonId,
            binding.artifact_id AS bindingArtifactId, binding.content_hash AS bindingContentHash,
            binding.bound_at AS boundAt, release_row.sealed_at AS sealedAt,
            artifact.person_id AS personId, artifact.task_id AS taskId,
            artifact.id AS artifactId, artifact.content_version_id AS contentVersionId,
            artifact.version, version.content_hash AS contentHash, artifact.sha256,
            artifact.media_type AS mediaType, artifact.size_bytes AS byteSize,
            artifact.display_filename AS displayFilename, '' AS reviewerRole
       FROM speaker_artifact_release_bindings binding
       JOIN publication_releases release_row
         ON release_row.id = binding.release_id
        AND release_row.workspace_id = binding.workspace_id
        AND release_row.event_id = binding.event_id
       JOIN plan_assignments assignment
         ON assignment.workspace_id = release_row.workspace_id
        AND assignment.plan_version_id = release_row.plan_version_id
        AND assignment.person_id = binding.person_id
       JOIN artifact_records artifact
         ON artifact.id = binding.artifact_id
        AND artifact.workspace_id = binding.workspace_id
        AND artifact.event_id = binding.event_id
        AND artifact.person_id = binding.person_id
        AND artifact.kind = 'HEADSHOT'
        AND artifact.media_type = 'image/png'
       JOIN speaker_tasks task
         ON task.id = artifact.task_id
        AND task.workspace_id = artifact.workspace_id
        AND task.event_id = artifact.event_id
        AND task.person_id = artifact.person_id
        AND task.assignment_id = assignment.id
        AND task.task_kind = 'HEADSHOT'
        AND task.content_kind = 'HEADSHOT'
        AND task.gate = 'PUBLICATION'
        AND task.owner = 'SPEAKER'
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id
        AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id
        AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id
        AND version.kind = artifact.kind
        AND version.version = artifact.version
       JOIN speaker_content_reviews review
         ON review.workspace_id = version.workspace_id
        AND review.event_id = version.event_id
        AND review.person_id = version.person_id
        AND review.task_id = version.task_id
        AND review.submission_version_id = version.id
        AND review.submission_content_hash = version.content_hash
        AND review.review_state = 'APPROVED'
        AND review.gate = 'PUBLICATION'
       JOIN audit_events review_authority
         ON review_authority.workspace_id = review.workspace_id
        AND review_authority.actor_kind = 'account'
        AND review_authority.actor_ref = review.reviewed_by
        AND review_authority.action = 'speaker.content.approved'
        AND review_authority.target_type = 'speaker_content_review'
        AND review_authority.target_id = review.id
        AND json_extract(review_authority.details_json, '$.schema') = 'speaker-content-approval-authority/v1'
        AND json_extract(review_authority.details_json, '$.assignmentId') = task.assignment_id
        AND json_extract(review_authority.details_json, '$.reviewState') = 'APPROVED'
        AND json_extract(review_authority.details_json, '$.gate') = review.gate
        AND json_extract(review_authority.details_json, '$.submissionVersionId') = review.submission_version_id
        AND json_extract(review_authority.details_json, '$.submissionContentHash') = review.submission_content_hash
        AND json_extract(review_authority.details_json, '$.capability') = 'phase0.pipeline.manage'
       JOIN artifact_upload_intents intent
         ON intent.artifact_id = artifact.id
        AND intent.workspace_id = artifact.workspace_id
        AND intent.event_id = artifact.event_id
        AND intent.person_id = artifact.person_id
        AND intent.task_id = artifact.task_id
        AND intent.kind = artifact.kind
        AND intent.content_version_id = artifact.content_version_id
        AND intent.storage_id = artifact.storage_id
        AND intent.storage_filename = artifact.storage_filename
        AND intent.version = artifact.version
        AND COALESCE(intent.supersedes_record_id, '') = COALESCE(artifact.supersedes_record_id, '')
        AND intent.sha256 = artifact.sha256
        AND intent.size_bytes = artifact.size_bytes
        AND intent.media_type = artifact.media_type
        AND intent.display_filename = artifact.display_filename
        AND intent.status = 'COMMITTED'
        AND intent.committed_at IS NOT NULL
      WHERE binding.workspace_id = ? AND binding.event_id = ? AND binding.release_id = ?
        AND binding.content_hash = version.content_hash
        AND (
          SELECT COUNT(*) FROM audit_events approval_evidence
           WHERE approval_evidence.workspace_id = review.workspace_id
             AND approval_evidence.action = 'speaker.content.approved'
             AND approval_evidence.target_type = 'speaker_content_review'
             AND approval_evidence.target_id = review.id
        ) = 1
      ORDER BY binding.person_id, binding.artifact_id`,
  ).all(workspaceId, eventId, releaseId) as unknown as SealedHeadshotBindingRow[];
  if (rows.length !== manifest.length) return false;
  return rows.every((row, index) => {
    const expected = manifest[index];
    return expected !== undefined && row.bindingWorkspaceId === workspaceId && row.bindingEventId === eventId &&
      row.releaseId === releaseId && row.bindingPersonId === expected.personId && row.personId === expected.personId &&
      row.bindingArtifactId === expected.artifactId && row.artifactId === expected.artifactId &&
      row.bindingContentHash === expected.contentHash && row.contentHash === expected.contentHash &&
      row.taskId === expected.taskId && row.contentVersionId === expected.contentVersionId &&
      row.version === expected.version && row.sha256 === expected.sha256 && row.mediaType === expected.mediaType &&
      row.byteSize === expected.byteSize && row.displayFilename === expected.displayFilename &&
      validTimestamp(row.boundAt) && row.boundAt === row.sealedAt;
  });
}

/** Validate immutable generalized bindings without requiring artifacts to remain current later. */
function sealedArtifactBindingsMatch(
  db: Db,
  workspaceId: string,
  eventId: string,
  releaseId: string,
  release: SealedReleaseContent,
): boolean {
  if (release.artifactBindings === undefined) return true;
  const select = db.prepare(
    `SELECT task.assignment_id AS assignmentId, artifact.person_id AS personId,
            artifact.task_id AS taskId, artifact.kind,
            artifact.id AS artifactId, artifact.content_version_id AS contentVersionId,
            artifact.version, version.content_hash AS contentHash,
            version.payload_json AS payloadJson, version.payload_bytes AS payloadBytes,
            artifact.sha256, artifact.media_type AS mediaType,
            artifact.size_bytes AS byteSize, artifact.display_filename AS displayFilename,
            artifact.storage_id AS storageId, artifact.storage_filename AS storageFilename,
            authority.payload_json AS authorityPayloadJson,
            authority.payload_fingerprint AS authorityPayloadFingerprint,
            intent.content_payload_json AS intentPayloadJson,
            review_authority.details_json AS approvalDetailsJson,
            '' AS reviewerRole
       FROM publication_releases release_row
       JOIN plan_assignments assignment
         ON assignment.workspace_id = release_row.workspace_id
        AND assignment.plan_version_id = release_row.plan_version_id
       JOIN speaker_tasks task
         ON task.id = ? AND task.workspace_id = assignment.workspace_id
        AND task.event_id = release_row.event_id AND task.person_id = assignment.person_id
        AND task.assignment_id = assignment.id AND task.required = 1
        AND task.gate = 'PUBLICATION' AND task.owner = 'SPEAKER'
        AND task.task_kind = task.content_kind AND task.task_kind IN ('HEADSHOT', 'SLIDES')
       JOIN artifact_records artifact
         ON artifact.id = ? AND artifact.workspace_id = task.workspace_id
        AND artifact.event_id = task.event_id AND artifact.person_id = task.person_id
        AND artifact.task_id = task.id AND artifact.kind = task.task_kind
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id AND version.kind = artifact.kind
        AND version.version = artifact.version
       JOIN speaker_content_reviews review
         ON review.workspace_id = version.workspace_id AND review.event_id = version.event_id
        AND review.person_id = version.person_id AND review.task_id = version.task_id
        AND review.submission_version_id = version.id
        AND review.submission_content_hash = version.content_hash
        AND review.review_state = 'APPROVED' AND review.gate = 'PUBLICATION'
       JOIN audit_events review_authority
         ON review_authority.workspace_id = review.workspace_id
        AND review_authority.actor_kind = 'account' AND review_authority.actor_ref = review.reviewed_by
        AND review_authority.action = 'speaker.content.approved'
        AND review_authority.target_type = 'speaker_content_review'
        AND review_authority.target_id = review.id
       JOIN artifact_upload_intents intent
         ON intent.artifact_id = artifact.id AND intent.workspace_id = artifact.workspace_id
        AND intent.event_id = artifact.event_id AND intent.person_id = artifact.person_id
        AND intent.task_id = artifact.task_id AND intent.kind = artifact.kind
        AND intent.content_version_id = artifact.content_version_id
        AND intent.storage_id = artifact.storage_id AND intent.storage_filename = artifact.storage_filename
        AND intent.version = artifact.version
        AND COALESCE(intent.supersedes_record_id, '') = COALESCE(artifact.supersedes_record_id, '')
        AND intent.sha256 = artifact.sha256 AND intent.size_bytes = artifact.size_bytes
        AND intent.media_type = artifact.media_type AND intent.display_filename = artifact.display_filename
        AND intent.status = 'COMMITTED' AND intent.committed_at IS NOT NULL
       JOIN domain_events authority
         ON authority.id = artifact.authority_event_id AND authority.workspace_id = artifact.workspace_id
        AND authority.event_type = 'speaker.artifact.submitted'
        AND authority.aggregate_type = 'speaker_task' AND authority.aggregate_id = artifact.task_id
      WHERE release_row.id = ? AND release_row.workspace_id = ? AND release_row.event_id = ?
        AND release_row.sealed_at IS NOT NULL AND assignment.id = ? AND assignment.person_id = ?
        AND artifact.content_version_id = ? AND artifact.version = ?
        AND artifact.sha256 = ? AND artifact.media_type = ?
        AND artifact.size_bytes = ? AND artifact.display_filename = ?
        AND version.content_hash = ?
        AND (
          SELECT COUNT(*) FROM audit_events approval_evidence
           WHERE approval_evidence.workspace_id = review.workspace_id
             AND approval_evidence.action = 'speaker.content.approved'
             AND approval_evidence.target_type = 'speaker_content_review'
             AND approval_evidence.target_id = review.id
        ) = 1`,
  );
  for (const expected of release.artifactBindings) {
    const rows = select.all(
      expected.taskId,
      expected.artifactId,
      releaseId,
      workspaceId,
      eventId,
      expected.assignmentId,
      expected.personId,
      expected.contentVersionId,
      expected.version,
      expected.sha256,
      expected.mediaType,
      expected.byteSize,
      expected.displayFilename,
      expected.contentHash,
    ) as unknown as SealArtifactCandidateRow[];
    const actual = rows[0];
    if (rows.length !== 1 || !actual || !artifactCandidateIsCanonical(actual, workspaceId, eventId) ||
        actual.assignmentId !== expected.assignmentId || actual.personId !== expected.personId ||
        actual.taskId !== expected.taskId || actual.kind !== expected.kind ||
        artifactIntent(actual.kind) !== expected.intent || actual.artifactId !== expected.artifactId ||
        actual.contentVersionId !== expected.contentVersionId || actual.version !== expected.version ||
        actual.contentHash !== expected.contentHash || actual.sha256 !== expected.sha256 ||
        actual.mediaType !== expected.mediaType || actual.byteSize !== expected.byteSize ||
        actual.displayFilename !== expected.displayFilename) return false;
  }
  return true;
}

export function sealRelease(
  db: Db,
  workspaceId: string,
  eventId: string,
  actor: { kind: "account"; ref: string },
): SealReleaseResult {
  return withTransaction(db, () => {
    const event = getEvent(db, workspaceId, eventId);
    if (!event) {
      throw new Error("EVENT_NOT_FOUND");
    }
    const currentPlanVersionId = event.currentPlanVersionId;
    if (!currentPlanVersionId) {
      throw new Error("NO_PLAN: compile and approve a plan before sealing a release.");
    }
    const plan = db
      .prepare(
         `SELECT pv.id, pv.run_id AS runId, pv.fingerprint, pv.version_number AS versionNumber, pv.content_json AS content,
                 pr.input_fingerprint AS inputFingerprint
         FROM plan_versions pv
         JOIN plan_runs pr ON pr.id = pv.run_id AND pr.workspace_id = pv.workspace_id
         WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
      )
      .get(workspaceId, eventId, currentPlanVersionId) as
      | { id: string; runId: string; fingerprint: string; versionNumber: number; content: string; inputFingerprint: string }
      | undefined;
    if (!plan) {
      throw new Error("NO_PLAN: compile and approve a plan before sealing a release.");
    }
    const sealingActor = db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, actor.ref) as { role: string } | undefined;
    if (!sealingActor || !roleHasCapability(sealingActor.role, "phase0.pipeline.manage")) {
      throw new Error("PUBLICATION_SEAL_AUTHORITY_INVALID: the sealing actor is not organizer-capable.");
    }
    if (planState(db, workspaceId, plan.id) !== "approved") {
      throw new Error("PLAN_NOT_APPROVED: approve the plan before sealing a release.");
    }
    const assignmentRows = db
      .prepare(
        `SELECT id AS assignmentId, person_id AS personId, program_unit_id AS programUnitId, assignment_type AS assignmentType
         FROM plan_assignments
         WHERE workspace_id = ? AND plan_version_id = ?`,
      )
      .all(workspaceId, plan.id) as { assignmentId: string; personId: string; programUnitId: string; assignmentType: string }[];
    assertCanonicalPlanVersionContent(plan, event, assignmentRows);
    const newestApproved = db.prepare(
      `SELECT pv.id
       FROM plan_versions pv
       JOIN approvals a ON a.workspace_id = pv.workspace_id AND a.event_id = pv.event_id AND a.plan_version_id = pv.id AND a.decision = 'approved'
       WHERE pv.workspace_id = ? AND pv.event_id = ?
       ORDER BY pv.version_number DESC, pv.created_at DESC, pv.rowid DESC LIMIT 1`,
    ).get(workspaceId, eventId) as { id: string } | undefined;
    if (!newestApproved || newestApproved.id !== plan.id) {
      throw new Error("PLAN_POINTER_STALE: the selected plan is not the newest approved plan for this event.");
    }
    const approval = db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved,
                MAX(actor_account_id) AS actorAccountId
         FROM approvals
         WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
      )
      .get(workspaceId, eventId, plan.id) as { count: number; approved: number | null; actorAccountId: string | null };
    const approvalActor = approval.actorAccountId === null ? undefined : db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, approval.actorAccountId) as { role: string } | undefined;
    if (approval.count !== 1 || approval.approved !== 1 || !approvalActor ||
        !roleHasCapability(approvalActor.role, "phase0.pipeline.manage")) {
      throw new Error("PLAN_APPROVAL_EVIDENCE_INVALID: exactly one append-only approval for the source plan is required.");
    }
    const latestState = db
      .prepare(
        `SELECT state, actor_account_id AS actorAccountId FROM plan_states
         WHERE workspace_id = ? AND plan_version_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(workspaceId, plan.id) as { state: string; actorAccountId: string | null } | undefined;
    if (latestState?.state !== "approved") {
      throw new Error("PLAN_STATE_NOT_CURRENTLY_APPROVED: the source plan's latest state is not approved.");
    }
    if (latestState.actorAccountId !== approval.actorAccountId) {
      throw new Error("PLAN_APPROVAL_AUTHORITY_INVALID: approval and approved state actors do not match.");
    }

    const accepted = db
      .prepare(
        `SELECT o.id AS offerId, o.person_id AS personId, p.full_name AS personName,
                p.canonical_email AS email, o.terms_fingerprint AS termsFingerprint,
                o.terms_json AS termsJson
         FROM commitment_offers o
         JOIN commitment_responses cr
           ON cr.offer_id = o.id AND cr.workspace_id = o.workspace_id
         JOIN people p
           ON p.id = o.person_id AND p.workspace_id = o.workspace_id
         WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ? AND cr.response = 'accepted'
         ORDER BY o.created_at, o.rowid`,
      )
      .all(workspaceId, eventId, plan.id) as {
      offerId: string;
      personId: string;
      personName: string;
      email: string;
      termsFingerprint: string;
      termsJson: string;
    }[];

    const watermark = (db
      .prepare(
         `SELECT COUNT(*) AS n FROM commitment_offers o
         JOIN commitment_responses cr
           ON cr.offer_id = o.id AND cr.workspace_id = o.workspace_id
         WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?
           AND cr.response = 'accepted'`,
      )
      .get(workspaceId, eventId, plan.id) as { n: number }).n;

    const assignmentsByPerson = new Map<string, typeof assignmentRows>();
    for (const assignment of assignmentRows) {
      const rows = assignmentsByPerson.get(assignment.personId) ?? [];
      rows.push(assignment);
      assignmentsByPerson.set(assignment.personId, rows);
    }
    const acceptedPeople = new Set<string>();
    const termsByOffer = new Map<string, {
      assignmentId: string;
      programUnitId: string;
      programUnitName: string;
      role: string;
      startsAt: string;
      endsAt: string;
    }>();
    for (const row of accepted) {
      if (acceptedPeople.has(row.personId)) throw new Error("COMMITMENT_PERSON_CARDINALITY_INVALID");
      acceptedPeople.add(row.personId);
      const terms = readExactCommitmentOfferTerms(row);
      if (!terms || terms.planVersionId !== plan.id ||
          terms.planFingerprint !== plan.fingerprint || terms.eventId !== event.id ||
          terms.eventName !== event.name || terms.timezone !== event.timezone ||
          terms.startsAt >= terms.endsAt) {
        throw new Error("OFFER_TERMS_FINGERPRINT_INVALID: stored commitment terms are not canonical.");
      }
      const assignments = assignmentsByPerson.get(row.personId);
      if (!assignments || assignments.length !== 1 || assignments[0].programUnitId !== terms.programUnitId || assignments[0].assignmentType !== terms.role) {
        throw new Error("COMMITMENT_ASSIGNMENT_MISMATCH: accepted terms do not match the exact source assignment.");
      }
      termsByOffer.set(row.offerId, {
        assignmentId: assignments[0]!.assignmentId,
        programUnitId: terms.programUnitId,
        programUnitName: terms.programUnitName,
        role: terms.role,
        startsAt: terms.startsAt,
        endsAt: terms.endsAt,
      });
    }

    const acceptedRows = accepted.map((a) => {
      const terms = termsByOffer.get(a.offerId)!;
      return {
        personId: a.personId,
        personName: a.personName,
        email: a.email,
        offerId: a.offerId,
        termsFingerprint: a.termsFingerprint,
        programUnitId: terms.programUnitId,
        programUnitName: terms.programUnitName,
        role: terms.role,
        startsAt: terms.startsAt,
        endsAt: terms.endsAt,
      };
    });
    const scheduleAcceptedRows = acceptedRows.map((row) => ({
      ...row,
      assignmentId: termsByOffer.get(row.offerId)!.assignmentId,
    }));

    const schedule = buildSealedScheduleProjection(db, {
      workspaceId,
      eventId,
      planVersionId: plan.id,
      planFingerprint: plan.fingerprint,
      acceptedInventoryFingerprint: acceptedInventoryFingerprint(scheduleAcceptedRows),
      accepted: scheduleAcceptedRows.map((row) => ({
        offerId: row.offerId,
        assignmentId: row.assignmentId,
        personId: row.personId,
        programUnitId: row.programUnitId,
        programUnitName: row.programUnitName,
        role: row.role,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        termsFingerprint: row.termsFingerprint,
      })),
    });
    const artifactBindings = selectPublicationArtifactsForSeal(
      db,
      workspaceId,
      eventId,
      plan.id,
      scheduleAcceptedRows.map((row) => ({ assignmentId: row.assignmentId, personId: row.personId })),
      actor.ref,
    );
    const speakerHeadshots = headshotsFromArtifactBindings(artifactBindings);

    const baseContent: SealedReleaseContent = {
      schema: "publication-release/v2",
      event: { id: event.id, name: event.name, timezone: event.timezone, startsAt: event.startsAt, endsAt: event.endsAt },
      plan: { id: plan.id, versionNumber: plan.versionNumber, fingerprint: plan.fingerprint },
      audiencePolicyVersion: 1,
      commitmentWatermark: watermark,
      accepted: acceptedRows,
      agendas: acceptedRows.map((a) => ({
        personId: a.personId,
        personName: a.personName,
        email: a.email,
        items: [
          {
            programUnitId: a.programUnitId,
            programUnitName: a.programUnitName,
            role: a.role,
            startsAt: a.startsAt,
            endsAt: a.endsAt,
          },
        ],
      })),
      artifactBindings,
      speakerHeadshots,
      schedule,
    };
    const releaseCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
    ).get(workspaceId, eventId) as { count: number }).count;
    if (!Number.isSafeInteger(releaseCount) || releaseCount < 0) throw new Error("RELEASE_LINEAGE_INVALID");
    let content: SealedReleaseContent;
    if (event.currentReleaseId) {
      const current = validatePublicReleaseForRead(db, {
        workspaceId,
        eventId,
        releaseId: event.currentReleaseId,
        mode: "HISTORICAL",
      });
      if (!current || current.content.artifactBindings === undefined ||
          current.content.speakerHeadshots === undefined ||
          !sealedArtifactBindingsMatch(db, workspaceId, eventId, current.releaseId, current.content) ||
          !sealedHeadshotBindingsMatch(db, workspaceId, eventId, current.releaseId, current.content) ||
          (current.content.lineage !== undefined && current.content.lineage.releaseNumber !== releaseCount)) {
        throw new Error("RELEASE_SUPERSESSION_EVIDENCE_INVALID: the current release cannot anchor an atomic supersession.");
      }
      if (releaseMaterialFingerprint(current.content) === releaseMaterialFingerprint(baseContent)) {
        const replay = validatePublicReleaseForRead(db, {
          workspaceId,
          eventId,
          releaseId: current.releaseId,
          mode: "CURRENT",
        });
        if (!replay) throw new Error("RELEASE_REPLAY_EVIDENCE_INVALID: the current sealed release is incomplete or divergent.");
        const row = db.prepare(
          "SELECT fingerprint, (SELECT COUNT(*) FROM personal_agendas WHERE release_id = ?) AS agendaCount, (SELECT COUNT(*) FROM portal_tokens WHERE release_id = ?) AS tokenCount FROM publication_releases WHERE id = ?",
        ).get(current.releaseId, current.releaseId, current.releaseId) as { fingerprint: string; agendaCount: number; tokenCount: number };
        return {
          releaseId: current.releaseId,
          fingerprint: row.fingerprint,
          agendaCount: row.agendaCount,
          tokenCount: row.tokenCount,
          created: false,
          tokens: [],
        };
      }
      content = {
        ...baseContent,
        lineage: {
          releaseNumber: releaseCount + 1,
          supersedesReleaseId: current.releaseId,
        },
      };
    } else {
      if (releaseCount !== 0) {
        throw new Error("RELEASE_CURRENT_POINTER_MISSING: existing releases require an exact current supersession pointer.");
      }
      content = {
        ...baseContent,
        lineage: { releaseNumber: 1, supersedesReleaseId: null },
      };
    }

    const contentJson = JSON.stringify(content);
    if (strictSealedReleaseContent(contentJson) === null) {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the sealed release manifest is not canonical.");
    }
    const fingerprint = fingerprintOf(content);
    const duplicate = db.prepare(
      "SELECT id FROM publication_releases WHERE workspace_id = ? AND event_id = ? AND fingerprint = ? LIMIT 1",
    ).get(workspaceId, eventId, fingerprint) as { id: string } | undefined;
    if (duplicate) throw new Error("RELEASE_LINEAGE_CONFLICT: the exact candidate already exists outside the current pointer.");

    const releaseId = uuid();
    const sealedAt = nowIso();
    db.prepare(
      `INSERT INTO publication_releases
         (id, workspace_id, event_id, plan_version_id, audience_policy_version, commitment_watermark, fingerprint, content_json, sealed_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(releaseId, workspaceId, eventId, plan.id, watermark, fingerprint, contentJson, sealedAt);

    const insertAgenda = db.prepare(
      `INSERT INTO personal_agendas (id, workspace_id, release_id, person_id, agenda_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const agenda of content.agendas) {
      insertAgenda.run(
        uuid(),
        workspaceId,
        releaseId,
        agenda.personId,
        JSON.stringify({
          releaseId,
          fingerprint,
          personName: agenda.personName,
          email: agenda.email,
          items: agenda.items,
        }),
      );
    }

    insertSealedHeadshotBindings(db, workspaceId, eventId, releaseId, speakerHeadshots, sealedAt);
    if (!sealedHeadshotBindingsMatch(db, workspaceId, eventId, releaseId, content)) {
      throw new Error("HEADSHOT_RELEASE_BINDING_INVALID: the sealed headshot bindings do not match the release manifest.");
    }
    if (!sealedArtifactBindingsMatch(db, workspaceId, eventId, releaseId, content)) {
      throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: the sealed artifact bindings do not match the release manifest.");
    }
    for (const binding of artifactBindings) {
      let verified;
      try {
        verified = readCommittedSpeakerArtifactForSeal(db, {
          workspaceId,
          eventId,
          personId: binding.personId,
          taskId: binding.taskId,
          kind: binding.kind,
        }, binding.artifactId);
      } catch {
        throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: artifact bytes changed before release publication.");
      }
      if (!verified || verified.record.sha256 !== binding.sha256 || verified.record.byteSize !== binding.byteSize) {
        throw new Error("PUBLICATION_ARTIFACT_INTEGRITY_INVALID: artifact bytes changed before release publication.");
      }
    }

    db.prepare("UPDATE events SET current_release_id = ? WHERE id = ? AND workspace_id = ?").run(
      releaseId,
      eventId,
      workspaceId,
    );

    let tokenCount = 0;
    const tokens: { personId: string; personName: string; rawToken: string }[] = [];
    for (const acceptedRow of acceptedRows) {
      const token = generatePortalToken(db, workspaceId, releaseId, acceptedRow.personId, "agenda");
      if (token) {
        tokenCount += 1;
        tokens.push({ personId: acceptedRow.personId, personName: acceptedRow.personName, rawToken: token });
      }
    }

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "publication.release.sealed",
      targetType: "publication_release",
      targetId: releaseId,
      details: {
        fingerprint,
        sealedContentFingerprint: fingerprint,
        planVersionId: plan.id,
        audiencePolicyVersion: content.audiencePolicyVersion,
        commitmentWatermark: watermark,
        identityProjectionFingerprint: identityProjectionFingerprint(content),
        materializationFingerprint: materializationFingerprint(content),
        artifactBindingManifestFingerprint: fingerprintOf(artifactBindings),
        artifactBindingCount: artifactBindings.length,
        speakerHeadshotManifestFingerprint: fingerprintOf(speakerHeadshots),
        speakerHeadshotCount: speakerHeadshots.length,
        scheduleManifestFingerprint: fingerprintOf(schedule ?? null),
        scheduleRevision: schedule?.revision ?? null,
        releaseNumber: content.lineage?.releaseNumber ?? null,
        supersedesReleaseId: content.lineage?.supersedesReleaseId ?? null,
        agendaCount: content.agendas.length,
        sealedAt,
      },
    });

    const verified = validatePublicReleaseForRead(db, {
      workspaceId,
      eventId,
      releaseId,
      mode: "CURRENT",
    });
    if (!verified || verified.fingerprint !== fingerprint) {
      throw new Error("RELEASE_POST_SEAL_VALIDATION_FAILED: the exact sealed candidate did not pass its current authority gate.");
    }

    return { releaseId, fingerprint, agendaCount: content.agendas.length, tokenCount, created: true, tokens };
  });
}

interface ApprovedPlanEvidence {
  readonly id: string;
  readonly versionNumber: number;
}

function approvedPlanEvidence(db: Db, workspaceId: string, eventId: string): ApprovedPlanEvidence[] {
  const rows = db.prepare(
    `SELECT pv.id, pv.version_number AS versionNumber, a.actor_account_id AS actorAccountId
       FROM plan_versions pv
       JOIN approvals a
         ON a.workspace_id = pv.workspace_id
        AND a.event_id = pv.event_id
        AND a.plan_version_id = pv.id
        AND a.decision = 'approved'
      WHERE pv.workspace_id = ? AND pv.event_id = ?
      ORDER BY pv.version_number DESC, pv.id DESC`,
  ).all(workspaceId, eventId) as unknown as { id: string; versionNumber: number; actorAccountId: string }[];
  return rows.filter((row) => {
    const actor = db.prepare(
      "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, row.actorAccountId) as { role: string } | undefined;
    const state = db.prepare(
      `SELECT state, actor_account_id AS actorAccountId
         FROM plan_states
        WHERE workspace_id = ? AND plan_version_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(workspaceId, row.id) as { state: string; actorAccountId: string | null } | undefined;
    return Boolean(
      actor &&
      roleHasCapability(actor.role, "phase0.pipeline.manage") &&
      state?.state === "approved" &&
      state.actorAccountId === row.actorAccountId,
    );
  }).map((row) => ({ id: row.id, versionNumber: row.versionNumber }));
}

function validateSealedReleaseLineage(
  db: Db,
  workspaceId: string,
  release: SealedReleaseContent,
  validateLiveCommitments: boolean,
): void {
  const plan = db.prepare(
    `SELECT version_number AS versionNumber, fingerprint FROM plan_versions
     WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).get(workspaceId, release.event.id, release.plan.id) as { versionNumber: number; fingerprint: string } | undefined;
  if (!plan || plan.versionNumber !== release.plan.versionNumber || plan.fingerprint !== release.plan.fingerprint) {
    throw new DenialError("RELEASE_LINEAGE_INVALID", "This sealed release no longer matches its immutable source lineage.", "publication-release");
  }
  const approval = db.prepare(
    `SELECT COUNT(*) AS count, MAX(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved,
            MAX(actor_account_id) AS actorAccountId
     FROM approvals WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
  ).get(workspaceId, release.event.id, release.plan.id) as { count: number; approved: number | null; actorAccountId: string | null };
  const approvalActor = approval.actorAccountId === null ? undefined : db.prepare(
    "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, approval.actorAccountId) as { role: string } | undefined;
  const states = db.prepare(
    `SELECT state, actor_account_id AS actorAccountId
       FROM plan_states
      WHERE workspace_id = ? AND plan_version_id = ?
      ORDER BY created_at, rowid`,
  ).all(workspaceId, release.plan.id) as Array<{ state: string; actorAccountId: string | null }>;
  const approvedState = states.filter((candidate) =>
    candidate.state === "approved" && candidate.actorAccountId === approval.actorAccountId
  );
  const latestState = states.at(-1);
  if (approval.count !== 1 || approval.approved !== 1 || !approvalActor ||
      approvedState.length !== 1 ||
      (validateLiveCommitments && (!roleHasCapability(approvalActor.role, "phase0.pipeline.manage") ||
        latestState?.state !== "approved" || latestState.actorAccountId !== approval.actorAccountId))) {
    throw new DenialError("RELEASE_APPROVAL_INVALID", "This sealed release has invalid source approval evidence.", "publication-release");
  }
  if (validateLiveCommitments) {
    const event = db.prepare(
      "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, release.event.id) as { currentPlanVersionId: string | null } | undefined;
    const approvedPlans = approvedPlanEvidence(db, workspaceId, release.event.id);
    if (!event || event.currentPlanVersionId !== release.plan.id || approvedPlans[0]?.id !== release.plan.id) {
      throw new DenialError("RELEASE_PLAN_NOT_CURRENT", "This release is not the newest approved plan for the current public projection.", "publication-release");
    }
  }
  const offerIds = release.accepted.map((accepted) => accepted.offerId);
  const offerIdPredicate = validateLiveCommitments
    ? ""
    : ` AND o.id IN (${offerIds.map(() => "?").join(", ")})`;
  const offers = !validateLiveCommitments && offerIds.length === 0
    ? []
    : db.prepare(
      `SELECT o.id AS offerId, o.person_id AS personId, o.terms_fingerprint AS termsFingerprint, o.terms_json AS termsJson
         FROM commitment_offers o JOIN commitment_responses r ON r.workspace_id = o.workspace_id AND r.offer_id = o.id AND r.response = 'accepted'
        WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?${offerIdPredicate} ORDER BY o.id`,
    ).all(workspaceId, release.event.id, release.plan.id, ...(validateLiveCommitments ? [] : offerIds)) as { offerId: string; personId: string; termsFingerprint: string; termsJson: string }[];
  if (offers.length !== release.accepted.length || (validateLiveCommitments && release.commitmentWatermark !== offers.length)) {
    throw new DenialError("RELEASE_COMMITMENTS_INVALID", "This sealed release no longer matches its accepted commitments.", "publication-release");
  }
  const assignments = new Set((db.prepare(
    "SELECT person_id AS personId, program_unit_id AS programUnitId, assignment_type AS assignmentType FROM plan_assignments WHERE workspace_id = ? AND plan_version_id = ?",
  ).all(workspaceId, release.plan.id) as { personId: string; programUnitId: string; assignmentType: string }[]).map((a) => `${a.personId}:${a.programUnitId}:${a.assignmentType}`));
  const assignmentCountByPerson = new Map<string, number>();
  for (const assignment of db.prepare(
    "SELECT person_id AS personId FROM plan_assignments WHERE workspace_id = ? AND plan_version_id = ?",
  ).all(workspaceId, release.plan.id) as { personId: string }[]) {
    assignmentCountByPerson.set(assignment.personId, (assignmentCountByPerson.get(assignment.personId) ?? 0) + 1);
  }
  const expectedAgenda = new Map<string, string[]>();
  const offerPeople = new Set<string>();
  for (const offer of offers) {
    const terms = readExactCommitmentOfferTerms(offer);
    if (!terms || terms.planVersionId !== release.plan.id ||
        terms.planFingerprint !== release.plan.fingerprint || terms.eventId !== release.event.id ||
        terms.eventName !== release.event.name || terms.timezone !== release.event.timezone ||
        terms.startsAt >= terms.endsAt) {
      throw new DenialError("RELEASE_COMMITMENTS_INVALID", "This sealed release contains non-canonical commitment terms.", "publication-release");
    }
    const accepted = release.accepted.find((row) => row.offerId === offer.offerId);
    if (offerPeople.has(offer.personId) || !accepted || accepted.personId !== offer.personId || accepted.termsFingerprint !== offer.termsFingerprint || accepted.programUnitId !== terms.programUnitId || accepted.programUnitName !== terms.programUnitName || accepted.role !== terms.role || accepted.startsAt !== terms.startsAt || accepted.endsAt !== terms.endsAt || assignmentCountByPerson.get(accepted.personId) !== 1 || !assignments.has(`${accepted.personId}:${accepted.programUnitId}:${accepted.role}`)) {
      throw new DenialError("RELEASE_COMMITMENTS_INVALID", "This sealed release does not match its exact accepted assignment rows.", "publication-release");
    }
    offerPeople.add(offer.personId);
    const items = expectedAgenda.get(accepted.personId) ?? [];
    items.push(JSON.stringify([accepted.programUnitId, accepted.programUnitName, accepted.role, accepted.startsAt, accepted.endsAt]));
    expectedAgenda.set(accepted.personId, items);
  }
  if (release.agendas.length !== expectedAgenda.size || release.agendas.some((agenda) => {
    const expected = [...(expectedAgenda.get(agenda.personId) ?? [])].sort();
    const actual = agenda.items.map((item) => JSON.stringify([item.programUnitId, item.programUnitName, item.role, item.startsAt, item.endsAt])).sort();
    return expected.length !== actual.length || expected.some((item, index) => item !== actual[index]);
  })) {
    throw new DenialError("RELEASE_AGENDA_INVALID", "This sealed release contains an agenda that does not match its accepted assignments.", "publication-release");
  }
}

function agendaItemKey(item: { programUnitId: string; programUnitName: string; role: string; startsAt: string; endsAt: string }): string {
  return JSON.stringify([item.programUnitId, item.programUnitName, item.role, item.startsAt, item.endsAt]);
}

function validateReleaseSupersessionLineage(
  db: Db,
  workspaceId: string,
  eventId: string,
  releaseId: string,
  lineage: NonNullable<SealedReleaseContent["lineage"]>,
): void {
  const row = db.prepare(
    `SELECT rowid FROM publication_releases
      WHERE workspace_id = ? AND event_id = ? AND id = ? LIMIT 1`,
  ).get(workspaceId, eventId, releaseId) as { rowid: number } | undefined;
  if (!row || !Number.isSafeInteger(row.rowid) || row.rowid < 1) {
    throw new DenialError("RELEASE_LINEAGE_INVALID", "This sealed release has no exact supersession row.", "publication-release");
  }
  const ordinal = (db.prepare(
    `SELECT COUNT(*) AS count FROM publication_releases
      WHERE workspace_id = ? AND event_id = ? AND rowid <= ?`,
  ).get(workspaceId, eventId, row.rowid) as { count: number }).count;
  if (ordinal !== lineage.releaseNumber) {
    throw new DenialError("RELEASE_LINEAGE_INVALID", "This sealed release has non-contiguous supersession lineage.", "publication-release");
  }
  if (lineage.releaseNumber === 1) return;
  const prior = db.prepare(
    `SELECT id, content_json AS contentJson
       FROM publication_releases
      WHERE workspace_id = ? AND event_id = ? AND rowid < ?
      ORDER BY rowid DESC LIMIT 1`,
  ).get(workspaceId, eventId, row.rowid) as { id: string; contentJson: string } | undefined;
  const priorContent = prior ? strictSealedReleaseContent(prior.contentJson) : null;
  if (!prior || !priorContent || prior.id !== lineage.supersedesReleaseId ||
      (priorContent.lineage !== undefined && priorContent.lineage.releaseNumber !== lineage.releaseNumber - 1)) {
    throw new DenialError("RELEASE_LINEAGE_INVALID", "This sealed release does not supersede the exact prior release.", "publication-release");
  }
}

function validateSealedScheduleAuthority(
  db: Db,
  workspaceId: string,
  eventId: string,
  schedule: SealedScheduleProjection,
): void {
  if (schedule.sourceScheduleAuditId === null || schedule.sourceSchedulePointerFingerprint === null) {
    if (schedule.cfpSessionAuthorities.length === 0) return;
    throw new DenialError(
      "RELEASE_SCHEDULE_AUTHORITY_INVALID",
      "This CFP schedule release is missing its exact persisted schedule authority.",
      "publication-release",
    );
  }
  let evidence: ReturnType<typeof readScheduleDraftAuthorityEvidence>;
  let historical: ReturnType<typeof readCanonicalScheduleAuthorityAt>;
  try {
    evidence = readScheduleDraftAuthorityEvidence(
      db,
      { workspaceId, eventId },
      schedule.sourceScheduleAuditId,
    );
    historical = evidence
      ? readCanonicalScheduleAuthorityAt(db, { workspaceId, eventId }, {
          auditEventId: evidence.auditEventId,
          at: evidence.recordedAt,
        })
      : null;
  } catch {
    evidence = null;
    historical = null;
  }
  if (!evidence || !historical ||
      evidence.pointerFingerprint !== schedule.sourceSchedulePointerFingerprint ||
      evidence.pointer.revision !== schedule.revision ||
      evidence.pointer.planVersionId !== schedule.sourcePlanVersionId ||
      evidence.pointer.planFingerprint !== schedule.sourcePlanFingerprint ||
      evidence.pointer.acceptedInventoryFingerprint !== schedule.acceptedInventoryFingerprint ||
      evidence.pointer.cfpSessionInventoryFingerprint !== schedule.cfpSessionInventoryFingerprint ||
      canonicalJson(evidence.pointer.cfpSessionAuthorities) !== canonicalJson(schedule.cfpSessionAuthorities) ||
      historical.planVersionId !== schedule.sourcePlanVersionId ||
      historical.planFingerprint !== schedule.sourcePlanFingerprint ||
      historical.acceptedInventoryFingerprint !== schedule.acceptedInventoryFingerprint ||
      historical.cfpSessionInventoryFingerprint !== schedule.cfpSessionInventoryFingerprint ||
      canonicalJson(historical.cfpSessionAuthorities) !== canonicalJson(schedule.cfpSessionAuthorities)) {
    throw new DenialError(
      "RELEASE_SCHEDULE_AUTHORITY_INVALID",
      "This sealed release does not match its exact immutable schedule authority.",
      "publication-release",
    );
  }
  const pointer = evidence.pointer;
  if (!pointer.rooms || !pointer.tracks || pointer.placements.length !== schedule.sessions.length) {
    throw new DenialError(
      "RELEASE_SCHEDULE_AUTHORITY_INVALID",
      "This sealed release is missing its exact persisted schedule resources.",
      "publication-release",
    );
  }
  const rooms = new Map(pointer.rooms.map((room) => [room.id, room]));
  const tracks = new Map(pointer.tracks.map((track) => [track.id, track]));
  const placements = new Map(pointer.placements.map((entry) => [entry.sessionId, entry.placement]));
  if (rooms.size !== pointer.rooms.length || tracks.size !== pointer.tracks.length ||
      placements.size !== pointer.placements.length) {
    throw new DenialError(
      "RELEASE_SCHEDULE_AUTHORITY_INVALID",
      "This sealed release has ambiguous persisted schedule resources.",
      "publication-release",
    );
  }
  for (const session of schedule.sessions) {
    const placement = placements.get(session.programUnitId);
    const room = rooms.get(session.placement.roomId);
    const track = tracks.get(session.placement.trackId);
    if (!placement || !room || !track ||
        placement.dayId !== session.placement.dayId ||
        placement.timeSlotId !== session.placement.timeSlotId ||
        placement.roomId !== session.placement.roomId ||
        placement.trackId !== session.placement.trackId ||
        placement.startsAt !== session.placement.startsAt ||
        placement.endsAt !== session.placement.endsAt ||
        room.name !== session.placement.roomName || room.venue !== session.placement.venue ||
        track.name !== session.placement.trackName) {
      throw new DenialError(
        "RELEASE_SCHEDULE_AUTHORITY_INVALID",
        "This sealed release diverges from its exact persisted schedule placement.",
        "publication-release",
      );
    }
  }
  if (schedule.schema === "publication-schedule/v2") {
    let approval: ReturnType<typeof readScheduleApprovalEvidence> = null;
    try {
      approval = readScheduleApprovalEvidence(
        db,
        { workspaceId, eventId },
        schedule.sourceScheduleApprovalId,
      );
    } catch {
      approval = null;
    }
    if (!approval || approval.approvalAuditId !== schedule.sourceScheduleApprovalAuditId ||
        approval.approvalFingerprint !== schedule.sourceScheduleApprovalFingerprint ||
        approval.sourceScheduleAuditId !== schedule.sourceScheduleAuditId ||
        approval.sourceSchedulePointerFingerprint !== schedule.sourceSchedulePointerFingerprint ||
        approval.scheduleRevision !== schedule.revision ||
        approval.scheduleAuthorityFingerprint !== schedule.scheduleFingerprint ||
        approval.sourcePlanVersionId !== schedule.sourcePlanVersionId ||
        approval.sourcePlanFingerprint !== schedule.sourcePlanFingerprint ||
        approval.acceptedInventoryFingerprint !== schedule.acceptedInventoryFingerprint ||
        approval.cfpSessionInventoryFingerprint !== schedule.cfpSessionInventoryFingerprint ||
        canonicalJson(approval.cfpSessionAuthorities) !== canonicalJson(schedule.cfpSessionAuthorities)) {
      throw new DenialError(
        "RELEASE_SCHEDULE_APPROVAL_INVALID",
        "This sealed release does not match its exact immutable organizer schedule approval.",
        "publication-release",
      );
    }
  }
}

/** Validate only evidence sealed into the release and its immutable materializations. */
export function validateSealedReleaseEvidence(
  db: Db,
  workspaceId: string,
  releaseId: string,
  release: SealedReleaseContent,
  options: { readonly validateLiveCommitments?: boolean } = {},
): void {
  const expectedByPerson = new Map<string, SealedReleaseContent["agendas"][number]>();
  for (const accepted of release.accepted) {
    if (expectedByPerson.has(accepted.personId)) {
      throw new DenialError("RELEASE_IDENTITY_INVALID", "This sealed release contains duplicate accepted identities.", "publication-release");
    }
    expectedByPerson.set(accepted.personId, {
      personId: accepted.personId,
      personName: accepted.personName,
      email: accepted.email,
      items: [{
        programUnitId: accepted.programUnitId,
        programUnitName: accepted.programUnitName,
        role: accepted.role,
        startsAt: accepted.startsAt,
        endsAt: accepted.endsAt,
      }],
    });
  }
  validateSealedReleaseLineage(db, workspaceId, release, options.validateLiveCommitments ?? false);
  if (!sealedArtifactBindingsMatch(db, workspaceId, release.event.id, releaseId, release)) {
    throw new DenialError(
      "RELEASE_ARTIFACT_BINDING_INVALID",
      "This sealed release has incomplete or divergent publication-artifact evidence.",
      "publication-release",
    );
  }
  if (release.lineage) {
    validateReleaseSupersessionLineage(db, workspaceId, release.event.id, releaseId, release.lineage);
  }
  if (release.schedule) {
    validateSealedScheduleAuthority(db, workspaceId, release.event.id, release.schedule);
  }
  if (!sealedHeadshotBindingsMatch(db, workspaceId, release.event.id, releaseId, release)) {
    throw new DenialError(
      "RELEASE_HEADSHOT_BINDING_INVALID",
      "This sealed release has incomplete or divergent speaker-headshot evidence.",
      "publication-release",
    );
  }
  const releaseAgendaPeople = new Set<string>();
  if (release.agendas.length !== expectedByPerson.size ||
      release.agendas.some((agenda) => {
        if (releaseAgendaPeople.has(agenda.personId)) return true;
        releaseAgendaPeople.add(agenda.personId);
        const expected = expectedByPerson.get(agenda.personId);
        if (!expected || agenda.personName !== expected.personName || agenda.email !== expected.email) return true;
        return !sameMultiset(agenda.items.map(agendaItemKey), expected.items.map(agendaItemKey));
      })) {
    throw new DenialError("RELEASE_AGENDA_INVALID", "This sealed release does not contain an exact accepted-person agenda projection.", "publication-release");
  }

  const rows = db.prepare(
    `SELECT workspace_id AS workspaceId, release_id AS releaseId, person_id AS personId, agenda_json AS agendaJson
       FROM personal_agendas
      WHERE release_id = ?
      ORDER BY person_id, rowid`,
  ).all(releaseId) as { workspaceId: string; releaseId: string; personId: string; agendaJson: string }[];
  if (rows.length !== expectedByPerson.size) {
    throw new DenialError("AGENDA_MATERIALIZATION_INVALID", "This sealed release has incomplete personal agenda materialization.", "publication-release");
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.workspaceId !== workspaceId || row.releaseId !== releaseId || seen.has(row.personId)) {
      throw new DenialError("AGENDA_MATERIALIZATION_INVALID", "This sealed release has duplicate or cross-scope agenda materialization.", "publication-release");
    }
    seen.add(row.personId);
    let agenda: unknown;
    try { agenda = JSON.parse(row.agendaJson) as unknown; } catch { throw new DenialError("AGENDA_MATERIALIZATION_INVALID", "This personal agenda cannot be decoded safely.", "publication-release"); }
    const expected = expectedByPerson.get(row.personId);
    if (!isRecord(agenda) || !expected || !exactKeys(agenda, ["releaseId", "fingerprint", "personName", "email", "items"]) ||
        agenda.releaseId !== releaseId || agenda.fingerprint !== fingerprintOf(release) ||
        agenda.personName !== expected.personName || agenda.email !== expected.email || !Array.isArray(agenda.items) ||
        agenda.items.some((item) => !isRecord(item) || !exactKeys(item, ["programUnitId", "programUnitName", "role", "startsAt", "endsAt"])) ||
        !sameMultiset(agenda.items.map((item) => agendaItemKey(item as SealedReleaseContent["agendas"][number]["items"][number])), expected.items.map(agendaItemKey))) {
      throw new DenialError("AGENDA_MATERIALIZATION_INVALID", "This personal agenda is not the immutable release-bound projection.", "publication-release");
    }
  }
  if (seen.size !== expectedByPerson.size) {
    throw new DenialError("AGENDA_MATERIALIZATION_INVALID", "This sealed release is missing a personal agenda.", "publication-release");
  }
}

export type PublicReleaseReadMode = "HISTORICAL" | "CURRENT";

export interface ValidatedPublicRelease {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly releaseId: string;
  readonly planVersionId: string;
  readonly audiencePolicyVersion: number;
  readonly commitmentWatermark: number;
  readonly fingerprint: string;
  readonly sealedAt: string;
  readonly current: boolean;
  readonly content: SealedReleaseContent;
}

export interface ReleasedCfpSessionSchedule {
  readonly releaseId: string;
  readonly sealedAt: string;
  readonly releaseNumber: number;
  readonly placement: {
    readonly roomId: string;
    readonly roomName: string;
    readonly venue: string;
    readonly trackId: string;
    readonly trackName: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
}

interface StoredPublicReleaseRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly planVersionId: string;
  readonly audiencePolicyVersion: number;
  readonly commitmentWatermark: number;
  readonly fingerprint: string;
  readonly contentJson: string;
  readonly sealedAt: string;
  readonly currentReleaseId: string | null;
}

function releaseSealAnchorMatches(
  db: Db,
  row: StoredPublicReleaseRow,
  release: SealedReleaseContent,
  requireCurrentAuthority: boolean,
): boolean {
  const anchors = db.prepare(
    `SELECT details_json AS detailsJson, actor_kind AS actorKind, actor_ref AS actorRef
       FROM audit_events
      WHERE workspace_id = ?
        AND action = 'publication.release.sealed'
        AND target_type = 'publication_release'
        AND target_id = ?
      ORDER BY created_at, rowid`,
  ).all(row.workspaceId, row.id) as { detailsJson: string | null; actorKind: string; actorRef: string | null }[];
  const anchor = anchors[0];
  if (anchors.length !== 1 || anchor?.detailsJson === null || anchor.actorKind !== "account" || anchor.actorRef === null) return false;
  const actor = db.prepare(
    "SELECT role FROM accounts WHERE workspace_id = ? AND id = ?",
  ).get(row.workspaceId, anchor.actorRef) as { role: string } | undefined;
  if (!actor || (requireCurrentAuthority && !roleHasCapability(actor.role, "phase0.pipeline.manage"))) return false;
  let details: unknown;
  try { details = JSON.parse(anchor.detailsJson) as unknown; } catch { return false; }
  if (!isRecord(details) || details.fingerprint !== row.fingerprint ||
      details.commitmentWatermark !== row.commitmentWatermark || details.agendaCount !== release.agendas.length) return false;
  if (release.lineage &&
      (details.releaseNumber !== release.lineage.releaseNumber ||
        details.supersedesReleaseId !== release.lineage.supersedesReleaseId)) return false;

  const optionalEvidence: readonly [string, unknown][] = [
    ["sealedContentFingerprint", row.fingerprint],
    ["planVersionId", row.planVersionId],
    ["audiencePolicyVersion", row.audiencePolicyVersion],
    ["identityProjectionFingerprint", identityProjectionFingerprint(release)],
    ["materializationFingerprint", materializationFingerprint(release)],
    ["artifactBindingManifestFingerprint", fingerprintOf(release.artifactBindings ?? [])],
    ["artifactBindingCount", release.artifactBindings?.length ?? 0],
    ["speakerHeadshotManifestFingerprint", fingerprintOf(release.speakerHeadshots ?? [])],
    ["speakerHeadshotCount", release.speakerHeadshots?.length ?? 0],
    ["scheduleManifestFingerprint", fingerprintOf(release.schedule ?? null)],
    ["scheduleRevision", release.schedule?.revision ?? null],
    ["releaseNumber", release.lineage?.releaseNumber ?? null],
    ["supersedesReleaseId", release.lineage?.supersedesReleaseId ?? null],
    ["sealedAt", row.sealedAt],
  ];
  if (release.artifactBindings !== undefined && (
    details.artifactBindingManifestFingerprint !== fingerprintOf(release.artifactBindings) ||
    details.artifactBindingCount !== release.artifactBindings.length
  )) return false;
  return optionalEvidence.every(([key, expected]) => details[key] === undefined || details[key] === expected);
}

/**
 * Single public release read gate. It only selects and validates immutable evidence; it never
 * recovers uploads, creates bindings, updates pointers, or writes audit state.
 */
export function validatePublicReleaseForRead(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly releaseId: string;
    readonly mode: PublicReleaseReadMode;
  },
): ValidatedPublicRelease | null {
  if (![input.workspaceId, input.eventId, input.releaseId].every((value) => typeof value === "string" && SAFE_PUBLIC_ID.test(value))) {
    return null;
  }
  const row = db.prepare(
    `SELECT release_row.id,
            release_row.workspace_id AS workspaceId,
            release_row.event_id AS eventId,
            release_row.plan_version_id AS planVersionId,
            release_row.audience_policy_version AS audiencePolicyVersion,
            release_row.commitment_watermark AS commitmentWatermark,
            release_row.fingerprint,
            release_row.content_json AS contentJson,
            release_row.sealed_at AS sealedAt,
            event_row.current_release_id AS currentReleaseId
       FROM publication_releases release_row
       JOIN events event_row
         ON event_row.id = release_row.event_id
        AND event_row.workspace_id = release_row.workspace_id
      WHERE release_row.workspace_id = ?
        AND release_row.event_id = ?
        AND release_row.id = ?
        AND release_row.sealed_at IS NOT NULL
      LIMIT 1`,
  ).get(input.workspaceId, input.eventId, input.releaseId) as StoredPublicReleaseRow | undefined;
  if (!row || row.workspaceId !== input.workspaceId || row.eventId !== input.eventId ||
      row.id !== input.releaseId || !validTimestamp(row.sealedAt) ||
      !/^[a-f0-9]{64}$/u.test(row.fingerprint) ||
      !Number.isSafeInteger(row.audiencePolicyVersion) || row.audiencePolicyVersion < 1 ||
      !Number.isSafeInteger(row.commitmentWatermark) || row.commitmentWatermark < 0) return null;

  const content = strictSealedReleaseContent(row.contentJson);
  if (!content || fingerprintOf(content) !== row.fingerprint || content.event.id !== row.eventId ||
      content.plan.id !== row.planVersionId || content.audiencePolicyVersion !== row.audiencePolicyVersion ||
      content.commitmentWatermark !== row.commitmentWatermark ||
      !releaseSealAnchorMatches(db, row, content, input.mode === "CURRENT")) return null;
  if (input.mode === "CURRENT" && row.currentReleaseId !== row.id) return null;

  try {
    validateSealedReleaseEvidence(db, row.workspaceId, row.id, content, {
      validateLiveCommitments: input.mode === "CURRENT",
    });
  } catch {
    return null;
  }
  return Object.freeze({
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    releaseId: row.id,
    planVersionId: row.planVersionId,
    audiencePolicyVersion: row.audiencePolicyVersion,
    commitmentWatermark: row.commitmentWatermark,
    fingerprint: row.fingerprint,
    sealedAt: row.sealedAt,
    current: row.currentReleaseId === row.id,
    content,
  });
}

/** Authenticated applicant projection of current sealed schedule truth; draft allocations never pass this gate. */
export function readCurrentReleasedCfpSession(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly programUnitId: string;
    readonly speakerPersonId: string;
  },
): ReleasedCfpSessionSchedule | null {
  if (![input.workspaceId, input.eventId, input.programUnitId, input.speakerPersonId]
    .every((value) => typeof value === "string" && SAFE_PUBLIC_ID.test(value))) return null;
  const event = db.prepare(
    "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ? LIMIT 1",
  ).get(input.workspaceId, input.eventId) as { currentReleaseId: string | null } | undefined;
  if (!event?.currentReleaseId) return null;
  const release = validatePublicReleaseForRead(db, {
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    releaseId: event.currentReleaseId,
    mode: "CURRENT",
  });
  if (!release?.content.schedule) return null;
  const sessions = release.content.schedule.sessions.filter((session) =>
    session.programUnitId === input.programUnitId && session.speakerPersonIds.includes(input.speakerPersonId)
  );
  if (sessions.length !== 1) return null;
  const releaseOrder = db.prepare(
    `SELECT COUNT(*) AS releaseNumber
       FROM publication_releases candidate
      WHERE candidate.workspace_id = ? AND candidate.event_id = ?
        AND candidate.rowid <= (
          SELECT current.rowid FROM publication_releases current
           WHERE current.workspace_id = ? AND current.event_id = ? AND current.id = ?
        )`,
  ).get(
    input.workspaceId,
    input.eventId,
    input.workspaceId,
    input.eventId,
    release.releaseId,
  ) as { releaseNumber: number };
  if (!Number.isSafeInteger(releaseOrder.releaseNumber) || releaseOrder.releaseNumber < 1) return null;
  const placement = sessions[0]!.placement;
  return Object.freeze({
    releaseId: release.releaseId,
    sealedAt: release.sealedAt,
    releaseNumber: releaseOrder.releaseNumber,
    placement: Object.freeze({
      roomId: placement.roomId,
      roomName: placement.roomName,
      venue: placement.venue,
      trackId: placement.trackId,
      trackName: placement.trackName,
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
    }),
  });
}

export interface PortalTokenRow {
  id: string;
  releaseId: string;
  personId: string;
  personName: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

function generatePortalToken(
  db: Db,
  workspaceId: string,
  releaseId: string,
  personId: string,
  scope: string,
): string | null {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const id = uuid();
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO portal_tokens (id, workspace_id, release_id, person_id, token_hash, scope, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, releaseId, personId, tokenHash, scope, nowIso(), expiresAt);
  return token;
}

export function listPortalTokens(db: Db, workspaceId: string, releaseId?: string): PortalTokenRow[] {
  const rows = releaseId
    ? db
        .prepare(
          `SELECT t.id, t.release_id AS releaseId, t.person_id AS personId, p.full_name AS personName,
                  t.scope, t.created_at AS createdAt, t.expires_at AS expiresAt, t.revoked_at AS revokedAt, t.revoked_reason AS revokedReason
           FROM portal_tokens t
           JOIN people p ON p.id = t.person_id AND p.workspace_id = t.workspace_id
           WHERE t.workspace_id = ? AND t.release_id = ?
           ORDER BY t.created_at, t.rowid`,
        )
        .all(workspaceId, releaseId)
    : db
        .prepare(
          `SELECT t.id, t.release_id AS releaseId, t.person_id AS personId, p.full_name AS personName,
                  t.scope, t.created_at AS createdAt, t.expires_at AS expiresAt, t.revoked_at AS revokedAt, t.revoked_reason AS revokedReason
           FROM portal_tokens t
           JOIN people p ON p.id = t.person_id AND p.workspace_id = t.workspace_id
           WHERE t.workspace_id = ?
           ORDER BY t.created_at, t.rowid`,
        )
        .all(workspaceId);
  return rows as unknown as PortalTokenRow[];
}

export function revokePortalToken(
  db: Db,
  workspaceId: string,
  tokenId: string,
  actor: { kind: "account"; ref: string },
  reason: string,
): boolean {
  return withTransaction(db, () => {
    const token = db
      .prepare(
        `SELECT id, release_id AS releaseId, revoked_at AS revokedAt
         FROM portal_tokens WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, tokenId) as
      | { id: string; releaseId: string; revokedAt: string | null }
      | undefined;
    if (!token) {
      throw new Error("TOKEN_NOT_FOUND");
    }
    if (token.revokedAt) {
      return false;
    }
    db.prepare(
      `UPDATE portal_tokens
       SET revoked_at = ?, revoked_reason = ?, revoked_by = ?
       WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    ).run(
      nowIso(),
      reason,
      actor.ref,
      token.id,
      workspaceId,
    );
    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "portal.token.revoked",
      targetType: "portal_token",
      targetId: token.id,
      details: { releaseId: token.releaseId, reason },
    });
    return true;
  });
}

export interface PortalAccess {
  tokenId: string;
  personId: string;
  personName: string;
  email: string;
  releaseId: string;
  releaseFingerprint: string;
  sealedAt: string;
  agenda: { items: { programUnitId: string; programUnitName: string; role: string; startsAt: string; endsAt: string }[] };
  event: { name: string; timezone: string };
}

export function resolvePortalAccess(db: Db, rawToken: string): PortalAccess {
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    throw new DenialError("TOKEN_INVALID", "This agenda link is not recognized.", "portal-token");
  }
  const tokenHash = sha256Hex(rawToken);
  const row = db
    .prepare(
      `SELECT t.id, t.workspace_id AS workspaceId, t.release_id AS releaseId, t.person_id AS personId, t.scope,
              t.revoked_at AS revokedAt, t.expires_at AS expiresAt, r.event_id AS eventId
       FROM portal_tokens t
       JOIN publication_releases r
         ON r.id = t.release_id AND r.workspace_id = t.workspace_id
       WHERE t.token_hash = ?`,
    )
    .get(tokenHash) as
    | {
        id: string;
        workspaceId: string;
        releaseId: string;
        personId: string;
        eventId: string;
        scope: string;
        revokedAt: string | null;
        expiresAt: string;
      }
    | undefined;
  if (!row) {
    throw new DenialError("TOKEN_INVALID", "This agenda link is not recognized.", "portal-token");
  }
  if (row.revokedAt) {
    throw new DenialError("TOKEN_REVOKED", "Access to this agenda has been revoked by the organizer.", "portal-token");
  }
  if (row.expiresAt < nowIso()) {
    throw new DenialError("TOKEN_EXPIRED", "This agenda link has expired.", "portal-token");
  }
  if (row.scope !== "agenda") {
    throw new DenialError(
      "TOKEN_SCOPE_DENIED",
      "This link is not authorized to read a personal agenda.",
      "portal-token",
    );
  }

  const validated = validatePublicReleaseForRead(db, {
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    releaseId: row.releaseId,
    mode: "HISTORICAL",
  });
  if (!validated) {
    throw new DenialError(
      "RELEASE_INTEGRITY_FAILED",
      "This sealed release failed validation.",
      "publication-release",
    );
  }
  const release = validated.content;
  const agenda = release.agendas.find((a) => a.personId === row.personId);
  if (!agenda) {
    throw new DenialError("AGENDA_MISSING", "No personal agenda exists in this sealed release for this link.", "portal-token");
  }

  return {
    tokenId: row.id,
    personId: row.personId,
    personName: agenda.personName,
    email: agenda.email,
    releaseId: row.releaseId,
    releaseFingerprint: validated.fingerprint,
    sealedAt: validated.sealedAt,
    agenda,
    event: { name: release.event.name, timezone: release.event.timezone },
  };
}

export function latestRelease(db: Db, workspaceId: string, eventId: string): {
  id: string;
  fingerprint: string;
  sealedAt: string;
  planVersionId: string;
  commitmentWatermark: number;
} | null {
  const event = db
    .prepare(
      "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, eventId) as { currentReleaseId: string | null } | undefined;
  if (!event || event.currentReleaseId === null) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, fingerprint, sealed_at AS sealedAt, plan_version_id AS planVersionId, commitment_watermark AS commitmentWatermark
       FROM publication_releases WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    )
    .get(workspaceId, eventId, event.currentReleaseId) as
    | { id: string; fingerprint: string; sealedAt: string; planVersionId: string; commitmentWatermark: number }
    | undefined;
  if (!row) {
    throw new Error("EVENT_CURRENT_RELEASE_POINTER_INVALID");
  }
  return row ?? null;
}
