import {
  MAX_PREFLIGHT_INPUT_BYTES,
  type AssessmentBlocker,
  type AssessmentStatus,
  type DriftEffect,
  type DriftEntry,
  type DriftFamily,
  type DriftReport,
  type ReleaseAudience,
  type ReleaseSourceRecord,
  type ReleaseSourceVector,
  type SourceVectorExpectation,
  type SourceAvailability,
  type ReleaseScope,
  type SourceAssessment,
} from "./contracts";
import { cloneAndFreeze, compareStrings, snapshotPlainData, sortCodePoints } from "./canonical";
import { fail } from "./errors";
import { assertSameAudience, assertSameScope, assertVectorExpectation, releaseAudience, verifySourceVector } from "./loader";

function effectFor(source: ReleaseSourceRecord, audience: ReleaseAudience): DriftEffect {
  if (source.scope === "COMMON") return "COMMON";
  return audience === "PUBLIC" ? "PUBLIC_ONLY" : "OPERATOR_ONLY";
}

function familyFor(source: ReleaseSourceRecord | undefined): DriftFamily {
  return source?.family ?? "UNKNOWN";
}

function sourceMap(vector: ReleaseSourceVector): Map<string, ReleaseSourceRecord> {
  return new Map(vector.sources.map((source) => [source.sourceId, source]));
}

function uniqueSorted<T>(values: readonly T[], selector: (value: T) => string): T[] {
  const sorted = sortCodePoints(values, selector);
  const result: T[] = [];
  let previous: string | null = null;
  for (const value of sorted) {
    const key = selector(value);
    if (key !== previous) result.push(value);
    previous = key;
  }
  return result;
}

function emptyAssessment(audience: ReleaseAudience, blockers: readonly AssessmentBlocker[], expected: ReleaseSourceVector | null, current: ReleaseSourceVector | null): SourceAssessment {
  return cloneAndFreeze({
    status: "UNAVAILABLE" as const,
    audience,
    expectedVersion: expected?.version ?? null,
    actualVersion: current?.version ?? null,
    expectedFingerprint: expected?.fingerprint ?? null,
    actualFingerprint: current?.fingerprint ?? null,
    drift: null,
    blockers,
  });
}

export function compareReleaseSourceVectors(
  previousInput: ReleaseSourceVector,
  currentInput: ReleaseSourceVector,
): DriftReport {
  const previous = verifySourceVector(previousInput);
  const current = verifySourceVector(currentInput);
  assertSameScope(previous, current);
  assertSameAudience(previous, current);
  const previousSources = sourceMap(previous);
  const currentSources = sourceMap(current);
  const sourceIds = [...new Set([...previousSources.keys(), ...currentSources.keys()])].sort(compareStrings);
  const entries: DriftEntry[] = [];
  for (const sourceId of sourceIds) {
    const prior = previousSources.get(sourceId);
    const next = currentSources.get(sourceId);
    if (prior?.fingerprint === next?.fingerprint) continue;
    const source = next ?? prior;
    if (!source) continue;
    entries.push({
      sourceId,
      family: familyFor(source),
      effect: effectFor(source, current.audience),
      materiality: "MATERIAL",
      previousFingerprint: prior?.fingerprint ?? null,
      currentFingerprint: next?.fingerprint ?? null,
    });
  }
  if (previous.version !== current.version && entries.length === 0) {
    entries.push({
      sourceId: "vector.version",
      family: "UNKNOWN",
      effect: "COMMON",
      materiality: "MATERIAL",
      previousFingerprint: `${previous.version}`,
      currentFingerprint: `${current.version}`,
    });
  }
  const sortedEntries = sortCodePoints(entries, (entry) => entry.sourceId);
  const effects = uniqueSorted(sortedEntries.map((entry) => entry.effect), (effect) => effect);
  const families = uniqueSorted(sortedEntries.map((entry) => entry.family), (family) => family);
  const commonChanged = sortedEntries.some((entry) => entry.effect === "COMMON");
  const audienceOnlyChanged = sortedEntries.some((entry) => entry.effect !== "COMMON");
  return cloneAndFreeze({
    schema: "operator-release-drift/v1" as const,
    audience: current.audience,
    changed: sortedEntries.length > 0,
    commonChanged,
    audienceOnlyChanged,
    materiality: sortedEntries.length > 0 ? "MATERIAL" as const : "NONE" as const,
    effects,
    families,
    entries: sortedEntries,
  });
}

export const compareSourceVectors = compareReleaseSourceVectors;
export const classifySourceDrift = compareReleaseSourceVectors;

function assessmentBlocker(
  code: AssessmentBlocker["code"],
  audience: ReleaseAudience,
  message: string,
): AssessmentBlocker {
  return { code, audience, message };
}

function missingSourceIds(previous: ReleaseSourceVector, current: ReleaseSourceVector): string[] {
  const currentIds = new Set(current.sources.map((source) => source.sourceId));
  return previous.sources.filter((source) => !currentIds.has(source.sourceId)).map((source) => source.sourceId).sort(compareStrings);
}

export interface SourceAssessmentInput {
  readonly audience: ReleaseAudience;
  readonly current: ReleaseSourceVector | null;
  readonly baseline: ReleaseSourceVector | null;
  readonly expected?: SourceVectorExpectation;
}

function normalizeAssessmentInput(
  inputOrCurrent: SourceAssessmentInput | ReleaseSourceVector | null,
  baselineArgument?: ReleaseSourceVector | null,
): SourceAssessmentInput {
  const snapshot = snapshotPlainData(inputOrCurrent, { maxBytes: MAX_PREFLIGHT_INPUT_BYTES });
  if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot) && Object.prototype.hasOwnProperty.call(snapshot, "current")) {
    const keys = Object.keys(snapshot);
    if (keys.some((key) => !["audience", "current", "baseline", "expected"].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(snapshot, "audience") ||
        !Object.prototype.hasOwnProperty.call(snapshot, "baseline")) {
      fail("NON_CANONICAL_INPUT", "The source assessment input has unsupported or missing fields.");
    }
    const audience = releaseAudience(snapshot.audience);
    const current = snapshot.current === null ? null : verifySourceVector(snapshot.current);
    const baseline = snapshot.baseline === null ? null : verifySourceVector(snapshot.baseline);
    const expected = snapshot.expected as unknown as SourceVectorExpectation | undefined;
    return { audience, current, baseline, ...(expected === undefined ? {} : { expected }) };
  }
  const current = snapshot === null ? null : verifySourceVector(snapshot);
  const baseline = baselineArgument == null ? null : verifySourceVector(baselineArgument);
  const audience = current?.audience ?? baseline?.audience;
  if (!audience) fail("SOURCE_UNAVAILABLE", "An assessment needs an exact audience even when sources are unavailable.");
  return { audience, current, baseline };
}

export function assessSourceVector(input: SourceAssessmentInput): SourceAssessment;
export function assessSourceVector(current: ReleaseSourceVector | null, baseline: ReleaseSourceVector | null): SourceAssessment;
export function assessSourceVector(
  inputOrCurrent: SourceAssessmentInput | ReleaseSourceVector | null,
  baselineArgument?: ReleaseSourceVector | null,
): SourceAssessment {
  const input = normalizeAssessmentInput(inputOrCurrent, baselineArgument);
  const audience = input.audience;
  const baseline = input.baseline ? verifySourceVector(input.baseline) : null;
  const current = input.current ? verifySourceVector(input.current) : null;
  if (baseline) {
    if (baseline.audience !== audience) fail("AUDIENCE_MISMATCH", "The baseline has a different exact audience.");
    if (current) assertSameScope(baseline, current);
  }
  if (current && current.audience !== audience) fail("AUDIENCE_MISMATCH", "The current source has a different exact audience.");
  if (input.expected && current) assertVectorExpectation(current, input.expected);
  if (!baseline) {
    return emptyAssessment(audience, [assessmentBlocker("BASELINE_UNAVAILABLE", audience, "The exact baseline source vector is unavailable.")], null, current);
  }
  if (!current) {
    return emptyAssessment(audience, [assessmentBlocker("SOURCE_UNAVAILABLE", audience, "The current source vector is unavailable.")], baseline, null);
  }
  if (baseline.availability !== "AVAILABLE" || current.availability !== "AVAILABLE") {
    return emptyAssessment(audience, [assessmentBlocker("SOURCE_UNAVAILABLE", audience, "A source in the exact vector is unavailable.")], baseline, current);
  }
  const missing = missingSourceIds(baseline, current);
  if (missing.length > 0) {
    return emptyAssessment(audience, [assessmentBlocker("SOURCE_MISSING", audience, "The current vector is missing a required source.")], baseline, current);
  }
  const drift = compareReleaseSourceVectors(baseline, current);
  if (!drift.changed && baseline.version === current.version && baseline.fingerprint === current.fingerprint) {
    return cloneAndFreeze({
      status: "EXACT_MATCH" as const,
      audience,
      expectedVersion: baseline.version,
      actualVersion: current.version,
      expectedFingerprint: baseline.fingerprint,
      actualFingerprint: current.fingerprint,
      drift,
      blockers: [],
    });
  }
  const blockers: AssessmentBlocker[] = [assessmentBlocker("SOURCE_STALE", audience, "The current source vector is not the exact baseline vector.")];
  if (baseline.version !== current.version) blockers.push(assessmentBlocker("VERSION_MISMATCH", audience, "The current source version is not the exact baseline version."));
  if (baseline.fingerprint !== current.fingerprint) blockers.push(assessmentBlocker("FINGERPRINT_MISMATCH", audience, "The current source fingerprint is not the exact baseline fingerprint."));
  return cloneAndFreeze({
    status: "STALE" as const,
    audience,
    expectedVersion: baseline.version,
    actualVersion: current.version,
    expectedFingerprint: baseline.fingerprint,
    actualFingerprint: current.fingerprint,
    drift,
    blockers,
  });
}

export const assessReleaseSource = assessSourceVector;
export const assessExactSource = assessSourceVector;

export function assessmentIsExact(status: AssessmentStatus): boolean {
  return status === "EXACT_MATCH";
}

export function assessmentIsAvailable(status: AssessmentStatus): boolean {
  return status !== "UNAVAILABLE";
}
