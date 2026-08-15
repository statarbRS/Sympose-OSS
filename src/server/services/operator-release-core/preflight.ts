import {
  ATOMIC_TWIN_PREFLIGHT_SCHEMA,
  MAX_PREFLIGHT_INPUT_BYTES,
  MAX_SUPERSESSION_HISTORY,
  type AtomicTwinPreflightInput,
  type AtomicTwinPreflightResult,
  type ProjectionPreflightInput,
  type ReleaseAudience,
  type ReleaseManifest,
  type ReleaseSourceVector,
  type SourceAssessment,
  type SupersessionNode,
  type TwinBlocker,
} from "./contracts";
import { cloneAndFreeze, snapshotPlainData } from "./canonical";
import { fail } from "./errors";
import {
  assertSameScope,
  releaseAudience,
  releaseIdentifier,
  releaseVersion,
  verifySourceVector,
} from "./loader";
import { assertManifestMatchesVector, verifyReleaseManifest } from "./manifest";
import { assessSourceVector } from "./drift";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotRecord(value: unknown, label: string): RecordValue {
  const snapshot = snapshotPlainData(value, { maxBytes: MAX_PREFLIGHT_INPUT_BYTES });
  if (!isRecord(snapshot)) fail("NON_CANONICAL_INPUT", `${label} must be a plain object.`);
  return snapshot;
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
  if (keys.some((key) => !allowed.has(key))) fail("NON_CANONICAL_INPUT", "The preflight input has an unsupported object field.");
  for (const key of required) if (!hasOwn(value, key)) fail("NON_CANONICAL_INPUT", "The preflight input is missing a required object field.");
}

function normalizeProjection(value: unknown): ProjectionPreflightInput {
  if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A projection preflight input must be an object.");
  rejectControlPlaneFields(value);
  exactKeys(value, ["current", "baseline", "manifest"]);
  if (value.current !== null && !isRecord(value.current)) fail("NON_CANONICAL_INPUT", "The current source vector is invalid.");
  if (value.baseline !== null && !isRecord(value.baseline)) fail("NON_CANONICAL_INPUT", "The baseline source vector is invalid.");
  if (value.manifest !== null && !isRecord(value.manifest)) fail("NON_CANONICAL_INPUT", "The release manifest is invalid.");
  return {
    current: value.current === null ? null : verifySourceVector(value.current),
    baseline: value.baseline === null ? null : verifySourceVector(value.baseline),
    manifest: value.manifest === null ? null : verifyReleaseManifest(value.manifest),
  };
}

function blocker(code: TwinBlocker["code"], audienceValue: TwinBlocker["audience"], message: string): TwinBlocker {
  return { code, audience: audienceValue, message };
}

function addBlocker(blockers: TwinBlocker[], value: TwinBlocker): void {
  const key = `${value.code}:${value.audience}`;
  if (!blockers.some((existing) => `${existing.code}:${existing.audience}` === key)) blockers.push(value);
}

function manifestHasExactVector(
  manifest: ReleaseManifest | null,
  vector: ReleaseSourceVector | null,
  workspaceId: string,
  eventId: string,
  audienceValue: ReleaseAudience,
  versionValue: number,
): boolean {
  if (!manifest || !vector || manifest.includedFields.length === 0 || manifest.decisions.length === 0) return false;
  if (vector.sources.length === 0 || vector.sources.every((source) => source.fields.length === 0)) return false;
  if (manifest.workspaceId !== workspaceId || manifest.eventId !== eventId || manifest.audience !== audienceValue || manifest.version !== versionValue) return false;
  if (vector.workspaceId !== workspaceId || vector.eventId !== eventId || vector.audience !== audienceValue || vector.version !== versionValue) return false;
  if (manifest.sourceVectorFingerprint !== vector.fingerprint || manifest.commonFingerprint !== vector.commonFingerprint) return false;
  try {
    assertManifestMatchesVector(manifest, vector, { workspaceId, eventId, audience: audienceValue, version: versionValue });
    return true;
  } catch {
    return false;
  }
}

function linkKey(audienceValue: ReleaseAudience, releaseId: string): string {
  return `${audienceValue}:${releaseId}`;
}

interface ValidatedLineage {
  readonly byKey: ReadonlyMap<string, ReleaseManifest>;
  readonly heads: ReadonlyMap<ReleaseAudience, ReleaseManifest>;
}

function validateSupersessionHistory(
  historyInput: readonly ReleaseManifest[],
  workspaceId: string,
  eventId: string,
): ValidatedLineage {
  if (historyInput.length > MAX_SUPERSESSION_HISTORY) fail("LIMIT_EXCEEDED", "The supersession history exceeds its bounded size.");
  const history = historyInput.map(verifyReleaseManifest);
  if (history.length > MAX_SUPERSESSION_HISTORY) fail("LIMIT_EXCEEDED", "The normalized supersession history exceeds its bounded size.");
  const byKey = new Map<string, ReleaseManifest>();
  for (const manifest of history) {
    if (manifest.workspaceId !== workspaceId || manifest.eventId !== eventId) fail("SUPERSESSION_INVALID", "Supersession history crosses the exact workspace/event scope.");
    const key = linkKey(manifest.audience, manifest.releaseId);
    if (byKey.has(key)) fail("SUPERSESSION_INVALID", "Supersession history contains a duplicate release identity.");
    byKey.set(key, manifest);
  }

  const successorByKey = new Map<string, ReleaseManifest>();
  for (const manifest of history) {
    const link = manifest.supersedes;
    if (!link) continue;
    const targetKey = linkKey(manifest.audience, link.releaseId);
    const target = byKey.get(targetKey);
    if (!target || target.fingerprint !== link.fingerprint) fail("SUPERSESSION_INVALID", "A supersession link does not bind to an exact same-audience release.");
    if (manifest.version <= target.version) fail("SUPERSESSION_INVALID", "A superseding release version must increase monotonically.");
    if (successorByKey.has(targetKey)) fail("SUPERSESSION_INVALID", "Supersession history branches from a stale predecessor.");
    successorByKey.set(targetKey, manifest);
  }

  const globallyVisited = new Set<string>();
  for (const manifest of history) {
    const path = new Set<string>();
    let current: ReleaseManifest | undefined = manifest;
    while (current) {
      const key = linkKey(current.audience, current.releaseId);
      if (path.has(key)) fail("SUPERSESSION_CYCLE", "Supersession history contains a cycle.");
      if (globallyVisited.has(key)) break;
      path.add(key);
      globallyVisited.add(key);
      current = current.supersedes ? byKey.get(linkKey(current.audience, current.supersedes.releaseId)) : undefined;
    }
  }

  const heads = new Map<ReleaseAudience, ReleaseManifest>();
  for (const audienceValue of ["PUBLIC", "OPERATOR"] as const) {
    const audienceHistory = history.filter((manifest) => manifest.audience === audienceValue);
    if (audienceHistory.length === 0) continue;
    const roots = audienceHistory.filter((manifest) => manifest.supersedes === null);
    const audienceHeads = audienceHistory.filter((manifest) => !successorByKey.has(linkKey(audienceValue, manifest.releaseId)));
    if (roots.length !== 1 || audienceHeads.length !== 1) {
      fail("SUPERSESSION_INVALID", "Each audience must have one complete linear supersession chain.");
    }
    let visited = 0;
    let current: ReleaseManifest | undefined = roots[0];
    while (current) {
      visited += 1;
      current = successorByKey.get(linkKey(audienceValue, current.releaseId));
    }
    if (visited !== audienceHistory.length) fail("SUPERSESSION_INVALID", "Supersession history contains a disconnected or branching chain.");
    heads.set(audienceValue, audienceHeads[0]!);
  }
  return { byKey, heads };
}

function dedupeLineage(manifests: readonly ReleaseManifest[]): ReleaseManifest[] {
  const byKey = new Map<string, ReleaseManifest>();
  for (const manifest of manifests) {
    const key = linkKey(manifest.audience, manifest.releaseId);
    const prior = byKey.get(key);
    if (prior && prior.fingerprint !== manifest.fingerprint) fail("SUPERSESSION_INVALID", "A supersession lineage identity has conflicting fingerprints.");
    if (!prior) byKey.set(key, manifest);
  }
  const result = [...byKey.values()];
  if (result.length > MAX_SUPERSESSION_HISTORY) fail("LIMIT_EXCEEDED", "The normalized supersession lineage exceeds its bounded size.");
  return result;
}

function bindCandidateToCurrentHead(candidate: ReleaseManifest, history: ValidatedLineage): void {
  const key = linkKey(candidate.audience, candidate.releaseId);
  const existing = history.byKey.get(key);
  const head = history.heads.get(candidate.audience);
  if (existing) {
    if (existing.fingerprint !== candidate.fingerprint || head?.releaseId !== candidate.releaseId) {
      fail("SUPERSESSION_INVALID", "The candidate must be the exact current head when it already exists in history.");
    }
    return;
  }
  if (!head) {
    if (candidate.supersedes !== null) fail("SUPERSESSION_INVALID", "A first release cannot point to an absent predecessor.");
    return;
  }
  if (
    !candidate.supersedes || candidate.supersedes.releaseId !== head.releaseId ||
    candidate.supersedes.fingerprint !== head.fingerprint
  ) {
    fail("SUPERSESSION_INVALID", "A candidate must supersede the exact current same-audience head.");
  }
  if (candidate.version <= head.version) fail("SUPERSESSION_INVALID", "A candidate release version must increase monotonically from the current head.");
}

function ensureExactScopeAndAudience(
  vector: ReleaseSourceVector | null,
  workspaceId: string,
  eventId: string,
  audienceValue: ReleaseAudience,
): void {
  if (!vector) return;
  assertSameScope(vector, { workspaceId, eventId });
  if (vector.audience !== audienceValue) fail("AUDIENCE_MISMATCH", "A twin projection has the wrong exact audience.");
}

function ensureManifestScopeAndAudience(
  manifest: ReleaseManifest | null,
  workspaceId: string,
  eventId: string,
  audienceValue: ReleaseAudience,
): void {
  if (!manifest) return;
  if (manifest.workspaceId !== workspaceId || manifest.eventId !== eventId) fail("SCOPE_MISMATCH", "A twin manifest crosses the exact workspace/event scope.");
  if (manifest.audience !== audienceValue) fail("AUDIENCE_MISMATCH", "A twin manifest has the wrong exact audience.");
}

function preflightProjection(audienceValue: ReleaseAudience, projection: ProjectionPreflightInput): SourceAssessment {
  return assessSourceVector({ audience: audienceValue, current: projection.current, baseline: projection.baseline });
}

export function preflightAtomicTwin(input: AtomicTwinPreflightInput): AtomicTwinPreflightResult {
  const value = snapshotRecord(input, "An atomic twin preflight input");
  rejectControlPlaneFields(value);
  exactKeys(value, ["workspaceId", "eventId", "version", "public", "operator"], ["supersessionHistory"]);
  const workspaceId = releaseIdentifier(value.workspaceId, "workspaceId");
  const eventId = releaseIdentifier(value.eventId, "eventId");
  const versionValue = releaseVersion(value.version, "preflight version");
  const publicProjection = normalizeProjection(value.public);
  const operatorProjection = normalizeProjection(value.operator);
  ensureManifestScopeAndAudience(publicProjection.manifest, workspaceId, eventId, "PUBLIC");
  ensureManifestScopeAndAudience(operatorProjection.manifest, workspaceId, eventId, "OPERATOR");
  ensureExactScopeAndAudience(publicProjection.current, workspaceId, eventId, "PUBLIC");
  ensureExactScopeAndAudience(publicProjection.baseline, workspaceId, eventId, "PUBLIC");
  ensureExactScopeAndAudience(operatorProjection.current, workspaceId, eventId, "OPERATOR");
  ensureExactScopeAndAudience(operatorProjection.baseline, workspaceId, eventId, "OPERATOR");

  const publicAssessment = preflightProjection("PUBLIC", publicProjection);
  const operatorAssessment = preflightProjection("OPERATOR", operatorProjection);
  const blockers: TwinBlocker[] = [];
  if (publicAssessment.status === "UNAVAILABLE") addBlocker(blockers, blocker("PUBLIC_UNAVAILABLE", "PUBLIC", "The public release projection is unavailable."));
  if (operatorAssessment.status === "UNAVAILABLE") addBlocker(blockers, blocker("OPERATOR_UNAVAILABLE", "OPERATOR", "The operator release projection is unavailable."));
  if (publicAssessment.status === "STALE") addBlocker(blockers, blocker("PUBLIC_STALE", "PUBLIC", "The public release projection is stale."));
  if (operatorAssessment.status === "STALE") addBlocker(blockers, blocker("OPERATOR_STALE", "OPERATOR", "The operator release projection is stale."));
  if (!manifestHasExactVector(publicProjection.manifest, publicProjection.current, workspaceId, eventId, "PUBLIC", versionValue)) {
    addBlocker(blockers, blocker("PUBLIC_INCOMPLETE", "PUBLIC", "The public release manifest is empty, missing, or not exact for its source vector."));
  }
  if (!manifestHasExactVector(operatorProjection.manifest, operatorProjection.current, workspaceId, eventId, "OPERATOR", versionValue)) {
    addBlocker(blockers, blocker("OPERATOR_INCOMPLETE", "OPERATOR", "The operator release manifest is empty, missing, or not exact for its source vector."));
  }
  const allVectors = [publicProjection.current, publicProjection.baseline, operatorProjection.current, operatorProjection.baseline];
  const availableVectors = allVectors.filter((vector): vector is ReleaseSourceVector => vector !== null && vector.availability === "AVAILABLE");
  const commonFingerprints = new Set(availableVectors.map((vector) => vector.commonFingerprint));
  if (commonFingerprints.size > 1) addBlocker(blockers, blocker("COMMON_VECTOR_MISMATCH", "BOTH", "PUBLIC and OPERATOR do not share one exact common source fingerprint."));

  const historyValue = value.supersessionHistory;
  if (historyValue !== undefined && !Array.isArray(historyValue)) fail("NON_CANONICAL_INPUT", "Supersession history must be an array.");
  if (Array.isArray(historyValue) && historyValue.length > MAX_SUPERSESSION_HISTORY) {
    fail("LIMIT_EXCEEDED", "The supplied supersession history exceeds its bounded size before normalization.");
  }
  const suppliedHistory = historyValue === undefined
    ? []
    : historyValue.map(verifyReleaseManifest);
  let lineageValid = true;
  try {
    const prior = validateSupersessionHistory(suppliedHistory, workspaceId, eventId);
    const candidates = [publicProjection.manifest, operatorProjection.manifest].filter((manifest): manifest is ReleaseManifest => manifest !== null);
    for (const candidate of candidates) bindCandidateToCurrentHead(candidate, prior);
    const lineage = dedupeLineage([...suppliedHistory, ...candidates]);
    validateSupersessionHistory(lineage, workspaceId, eventId);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SUPERSESSION_CYCLE") throw error;
    if (error instanceof Error && (error as { code?: string }).code === "LIMIT_EXCEEDED") throw error;
    lineageValid = false;
    addBlocker(blockers, blocker("SUPERSESSION_INVALID", "BOTH", "Supersession history is not an exact monotonic linear lineage bound to the current head."));
  }

  const ready = publicAssessment.status === "EXACT_MATCH" &&
    operatorAssessment.status === "EXACT_MATCH" &&
    publicProjection.current?.version === versionValue &&
    operatorProjection.current?.version === versionValue &&
    publicProjection.baseline?.version === versionValue &&
    operatorProjection.baseline?.version === versionValue &&
    manifestHasExactVector(publicProjection.manifest, publicProjection.current, workspaceId, eventId, "PUBLIC", versionValue) &&
    manifestHasExactVector(operatorProjection.manifest, operatorProjection.current, workspaceId, eventId, "OPERATOR", versionValue) &&
    commonFingerprints.size === 1 &&
    lineageValid &&
    blockers.length === 0;
  const commonFingerprint = commonFingerprints.size === 1 ? [...commonFingerprints][0]! : null;
  return cloneAndFreeze({
    schema: ATOMIC_TWIN_PREFLIGHT_SCHEMA,
    workspaceId,
    eventId,
    version: versionValue,
    ready,
    public: publicAssessment,
    operator: operatorAssessment,
    commonFingerprint,
    blockers,
  });
}

export const preflightReleaseTwin = preflightAtomicTwin;
export const buildAtomicTwinPreflight = preflightAtomicTwin;

export function validateSupersessionChain(manifestsInput: readonly ReleaseManifest[]): void {
  const snapshot = snapshotPlainData(manifestsInput, { maxBytes: MAX_PREFLIGHT_INPUT_BYTES });
  if (!Array.isArray(snapshot)) fail("NON_CANONICAL_INPUT", "Supersession history must be an array.");
  if (snapshot.length === 0) return;
  if (snapshot.length > MAX_SUPERSESSION_HISTORY) fail("LIMIT_EXCEEDED", "The supersession history exceeds its bounded size before normalization.");
  const manifests = snapshot.map(verifyReleaseManifest);
  const first = manifests[0]!;
  validateSupersessionHistory(manifests, first.workspaceId, first.eventId);
}

export function validateSupersessionLinks(nodesInput: readonly SupersessionNode[]): void {
  const snapshot = snapshotPlainData(nodesInput, { maxBytes: MAX_PREFLIGHT_INPUT_BYTES });
  if (!Array.isArray(snapshot)) fail("NON_CANONICAL_INPUT", "The supersession graph must be an array.");
  if (snapshot.length > MAX_SUPERSESSION_HISTORY) fail("LIMIT_EXCEEDED", "The supersession graph exceeds its bounded size before normalization.");
  const byKey = new Map<string, SupersessionNode>();
  const successorKeys = new Set<string>();
  for (const value of snapshot) {
    if (!isRecord(value)) fail("NON_CANONICAL_INPUT", "A supersession node must be an object.");
    rejectControlPlaneFields(value);
    exactKeys(value, ["audience", "releaseId", "supersedesReleaseId"]);
    const audienceValue = releaseAudience(value.audience);
    const releaseId = releaseIdentifier(value.releaseId, "releaseId");
    const supersedesReleaseId = value.supersedesReleaseId === null ? null : releaseIdentifier(value.supersedesReleaseId, "supersedesReleaseId");
    const key = linkKey(audienceValue, releaseId);
    if (byKey.has(key)) fail("SUPERSESSION_INVALID", "The supersession graph contains a duplicate release identity.");
    byKey.set(key, { audience: audienceValue, releaseId, supersedesReleaseId });
  }
  for (const node of byKey.values()) {
    if (node.supersedesReleaseId === null) continue;
    const targetKey = linkKey(node.audience, node.supersedesReleaseId);
    if (!byKey.has(targetKey)) fail("SUPERSESSION_INVALID", "Supersession graph has an orphaned link.");
    if (successorKeys.has(targetKey)) fail("SUPERSESSION_INVALID", "Supersession graph branches from one predecessor.");
    successorKeys.add(targetKey);
  }
  for (const audienceValue of ["PUBLIC", "OPERATOR"] as const) {
    const nodes = [...byKey.values()].filter((node) => node.audience === audienceValue);
    if (nodes.length === 0) continue;
    const roots = nodes.filter((node) => node.supersedesReleaseId === null);
    const heads = nodes.filter((node) => !successorKeys.has(linkKey(audienceValue, node.releaseId)));
    if (roots.length !== 1 || heads.length !== 1) {
      const cycleOnly = roots.length === 0 && heads.length === 0;
      fail(cycleOnly ? "SUPERSESSION_CYCLE" : "SUPERSESSION_INVALID", "The supersession graph must be one complete linear chain per audience.");
    }
    const visited = new Set<string>();
    let current: SupersessionNode | undefined = heads[0];
    while (current) {
      const key = linkKey(audienceValue, current.releaseId);
      if (visited.has(key)) fail("SUPERSESSION_CYCLE", "Supersession graph contains a cycle.");
      visited.add(key);
      current = current.supersedesReleaseId === null ? undefined : byKey.get(linkKey(audienceValue, current.supersedesReleaseId));
    }
    if (visited.size !== nodes.length) fail("SUPERSESSION_INVALID", "The supersession graph is disconnected.");
  }
}
