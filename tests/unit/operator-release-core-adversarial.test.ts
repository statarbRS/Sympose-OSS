import { describe, expect, it } from "vitest";
import {
  MAX_FIELDS_PER_SOURCE,
  MAX_SOURCE_RECORDS,
  MAX_SUPERSESSION_HISTORY,
  assessSourceVector,
  canonicalJson,
  createReleaseManifest,
  createReleaseTwin,
  createSourceVector,
  fingerprintOf,
  loadPersistedSourceVector,
  loadTrustedReleaseManifest,
  preflightAtomicTwin,
  selectAudienceSourceVector,
  validateSupersessionChain,
  verifyReleaseManifest,
  verifySourceVector,
  type FieldDecisionInput,
  type ReleaseManifest,
  type ReleaseTwin,
  type SourceRecordInput,
  type SupersessionLink,
} from "@/server/services/operator-release-core";

const SCOPE = { workspaceId: "workspace-release-adversarial", eventId: "event-release-adversarial" } as const;

function sources(options: { readonly time?: string; readonly title?: string } = {}): SourceRecordInput[] {
  return [
    {
      sourceId: "event-time",
      scope: "COMMON",
      family: "TIME",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "event.startsAt", family: "TIME", value: options.time ?? "2026-09-01T09:00:00-04:00" }],
    },
    {
      sourceId: "event-title",
      scope: "COMMON",
      family: "CONTENT",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "event.title", family: "CONTENT", value: options.title ?? "Adversarial release rehearsal" }],
    },
    {
      sourceId: "operator-cue",
      scope: "OPERATOR",
      family: "OPERATOR_CUE",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "operator.cue", family: "OPERATOR_CUE", value: "doors-open" }],
    },
  ];
}

function publicDecisions(): FieldDecisionInput[] {
  return [
    { sourceId: "event-time", field: "event.startsAt", decision: "INCLUDE", reason: "Published time." },
    { sourceId: "event-title", field: "event.title", decision: "INCLUDE", reason: "Published title." },
  ];
}

function operatorDecisions(): FieldDecisionInput[] {
  return [
    ...publicDecisions(),
    { sourceId: "operator-cue", field: "operator.cue", decision: "INCLUDE", reason: "Allowlisted operator cue." },
  ];
}

function releaseTwin(options: {
  readonly version?: number;
  readonly suffix?: string;
  readonly publicSupersedes?: SupersessionLink;
  readonly operatorSupersedes?: SupersessionLink;
  readonly time?: string;
} = {}): ReleaseTwin {
  const version = options.version ?? 1;
  const suffix = options.suffix ?? `${version}`;
  return createReleaseTwin({
    ...SCOPE,
    version,
    sources: sources({ time: options.time }),
    publicReleaseId: `public-release-${suffix}`,
    operatorReleaseId: `operator-release-${suffix}`,
    publicDecisions: publicDecisions(),
    operatorDecisions: operatorDecisions(),
    ...(options.publicSupersedes ? { publicSupersedes: options.publicSupersedes } : {}),
    ...(options.operatorSupersedes ? { operatorSupersedes: options.operatorSupersedes } : {}),
  });
}

function supersedes(manifest: ReleaseManifest): SupersessionLink {
  return { releaseId: manifest.releaseId, fingerprint: manifest.fingerprint };
}

function preflight(twin: ReleaseTwin, history: readonly ReleaseManifest[] = []) {
  return preflightAtomicTwin({
    ...SCOPE,
    version: twin.version,
    public: {
      current: twin.public.sourceVector,
      baseline: twin.public.sourceVector,
      manifest: twin.public.manifest,
    },
    operator: {
      current: twin.operator.sourceVector,
      baseline: twin.operator.sourceVector,
      manifest: twin.operator.manifest,
    },
    ...(history.length > 0 ? { supersessionHistory: history } : {}),
  });
}

function withoutFingerprint<T extends { readonly fingerprint: string }>(value: T): Omit<T, "fingerprint"> {
  const { fingerprint: _fingerprint, ...basis } = value;
  return basis;
}

describe("operator release core adversarial persistence and bounds", () => {
  it("round-trips exact JSON through deterministic vector and manifest rehydration", () => {
    const original = releaseTwin();
    const persisted = JSON.parse(JSON.stringify(original)) as ReleaseTwin;
    const publicVector = loadPersistedSourceVector(persisted.public.sourceVector, {
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      fingerprint: original.public.sourceVector.fingerprint,
      commonFingerprint: original.commonFingerprint,
    });
    const operatorVector = loadPersistedSourceVector(persisted.operator.sourceVector, {
      ...SCOPE,
      audience: "OPERATOR",
      version: 1,
      fingerprint: original.operator.sourceVector.fingerprint,
      commonFingerprint: original.commonFingerprint,
    });
    const publicManifest = loadTrustedReleaseManifest(persisted.public.manifest, publicVector);
    const operatorManifest = loadTrustedReleaseManifest(persisted.operator.manifest, operatorVector);

    expect(verifySourceVector(JSON.parse(JSON.stringify(publicVector))).fingerprint).toBe(publicVector.fingerprint);
    expect(verifyReleaseManifest(JSON.parse(JSON.stringify(publicManifest))).fingerprint).toBe(publicManifest.fingerprint);
    expect(Object.isFrozen(publicManifest.includedFields[0]?.value as object)).toBe(true);
    expect(preflightAtomicTwin({
      ...SCOPE,
      version: 1,
      public: { current: publicVector, baseline: publicVector, manifest: publicManifest },
      operator: { current: operatorVector, baseline: operatorVector, manifest: operatorManifest },
    }).ready).toBe(true);
    expect(preflightAtomicTwin({
      ...SCOPE,
      version: 1,
      public: { current: persisted.public.sourceVector, baseline: persisted.public.sourceVector, manifest: persisted.public.manifest },
      operator: { current: persisted.operator.sourceVector, baseline: persisted.operator.sourceVector, manifest: persisted.operator.manifest },
    }).ready).toBe(true);
  });

  it("rejects tampering even when an attacker rehashes only the enclosing artifact", () => {
    const original = releaseTwin();
    const forgedVector = JSON.parse(JSON.stringify(original.public.sourceVector)) as unknown as Record<string, unknown>;
    const forgedSources = forgedVector.sources as Array<Record<string, unknown>>;
    const forgedFields = forgedSources[0]!.fields as Array<Record<string, unknown>>;
    forgedFields[0]!.value = "2030-01-01T00:00:00Z";
    forgedVector.fingerprint = fingerprintOf(withoutFingerprint(forgedVector as { fingerprint: string }));
    expect(() => loadPersistedSourceVector(forgedVector)).toThrowError(expect.objectContaining({ code: "FINGERPRINT_MISMATCH" }));

    const forgedManifest = JSON.parse(JSON.stringify(original.public.manifest)) as unknown as Record<string, unknown>;
    const included = forgedManifest.includedFields as Array<Record<string, unknown>>;
    included[0]!.value = "2030-01-01T00:00:00.000Z";
    forgedManifest.fingerprint = fingerprintOf(withoutFingerprint(forgedManifest as { fingerprint: string }));
    expect(() => loadTrustedReleaseManifest(forgedManifest, original.public.sourceVector)).toThrowError(
      expect.objectContaining({ code: "FINGERPRINT_MISMATCH" }),
    );
    expect(() => loadTrustedReleaseManifest(forgedManifest, {
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      releaseId: original.public.manifest.releaseId,
      fingerprint: original.public.manifest.fingerprint,
      sourceVectorFingerprint: original.public.sourceVector.fingerprint,
      commonFingerprint: original.commonFingerprint,
    })).toThrowError(expect.objectContaining({ code: "FINGERPRINT_MISMATCH" }));
  });

  it("binds rehydration to exact workspace, event, audience, version, and fingerprint expectations", () => {
    const original = releaseTwin();
    expect(() => loadPersistedSourceVector(JSON.parse(JSON.stringify(original.public.sourceVector)), {
      ...SCOPE,
      workspaceId: "workspace-other",
      audience: "PUBLIC",
      version: 1,
      fingerprint: original.public.sourceVector.fingerprint,
    })).toThrowError(expect.objectContaining({ code: "SCOPE_MISMATCH" }));
    expect(() => loadPersistedSourceVector(JSON.parse(JSON.stringify(original.public.sourceVector)), {
      ...SCOPE,
      audience: "OPERATOR",
      version: 1,
      fingerprint: original.public.sourceVector.fingerprint,
    })).toThrowError(expect.objectContaining({ code: "AUDIENCE_MISMATCH" }));
  });

  it("takes one descriptor snapshot so live getters and proxies cannot hide source or field overflows", () => {
    let getterReads = 0;
    const getterInput = { ...SCOPE, audience: "PUBLIC" as const, version: 1 } as Record<string, unknown>;
    Object.defineProperty(getterInput, "sources", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? sources().slice(0, 1) : Array.from({ length: MAX_SOURCE_RECORDS + 1 });
      },
    });
    expect(() => createSourceVector(getterInput as never)).toThrowError(expect.objectContaining({ code: "NON_CANONICAL_INPUT" }));
    expect(getterReads).toBe(0);

    const tooManySources = Array.from({ length: MAX_SOURCE_RECORDS + 1 }, (_, index) => ({
      sourceId: `source-${index}`,
      scope: "COMMON" as const,
      family: "CONTENT" as const,
      version: 1,
      status: "AVAILABLE" as const,
      fields: [{ field: `event.field.${index}`, family: "CONTENT" as const, value: "bounded" }],
    }));
    let sourceGets = 0;
    const sourceProxy = new Proxy({ ...SCOPE, audience: "PUBLIC" as const, version: 1, sources: tooManySources }, {
      get(target, property, receiver) {
        sourceGets += 1;
        if (property === "sources") return [];
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createSourceVector(sourceProxy)).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(sourceGets).toBe(0);

    const tooManyFields = Array.from({ length: MAX_FIELDS_PER_SOURCE + 1 }, (_, index) => ({
      field: `event.field.${index}`,
      family: "CONTENT" as const,
      value: "bounded",
    }));
    let fieldGets = 0;
    const recordProxy = new Proxy({
      sourceId: "field-overflow",
      scope: "COMMON" as const,
      family: "CONTENT" as const,
      version: 1,
      status: "AVAILABLE" as const,
      fields: tooManyFields,
    }, {
      get(target, property, receiver) {
        fieldGets += 1;
        if (property === "fields") return [];
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => createSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: [recordProxy] })).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
    expect(fieldGets).toBe(0);
  });

  it("rejects array subclasses, toJSON behavior, accessors, symbols, and hidden fields", () => {
    class JsonHidingArray<T> extends Array<T> {
      toJSON(): unknown[] {
        return [];
      }
    }
    const subclass = new JsonHidingArray<SourceRecordInput>(...sources().slice(0, 2));
    expect(() => createSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: subclass })).toThrowError(
      expect.objectContaining({ code: "NON_CANONICAL_INPUT" }),
    );

    const hidden = { ...SCOPE, audience: "PUBLIC" as const, version: 1, sources: sources().slice(0, 2) };
    Object.defineProperty(hidden, "shadow", { enumerable: false, value: "ignored-by-json" });
    expect(() => createSourceVector(hidden)).toThrowError(expect.objectContaining({ code: "NON_CANONICAL_INPUT" }));

    const symbolInput = { ...SCOPE, audience: "PUBLIC" as const, version: 1, sources: sources().slice(0, 2), [Symbol("hidden")]: true };
    expect(() => createSourceVector(symbolInput)).toThrowError(expect.objectContaining({ code: "NON_CANONICAL_INPUT" }));
  });

  it("enforces the 128-entry supplied history cap before deduplication", () => {
    const current = releaseTwin();
    const repeated = Array.from({ length: MAX_SUPERSESSION_HISTORY + 1 }, () => current.public.manifest);
    expect(() => preflight(current, repeated)).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });

  it("rejects deeply nested values with a bounded error instead of a RangeError", () => {
    let nested: Record<string, unknown> = { leaf: "value" };
    for (let depth = 0; depth < 2_000; depth += 1) nested = { child: nested };
    expect(() => createSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [{
        sourceId: "deep-source",
        scope: "COMMON",
        family: "CONTENT",
        version: 1,
        status: "AVAILABLE",
        fields: [{ field: "event.deep", family: "CONTENT", value: nested as never }],
      }],
    })).toThrowError(expect.objectContaining({ code: "NON_CANONICAL_INPUT" }));
  });

  it("rejects empty available sources and empty release projections", () => {
    expect(() => createSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [{
        sourceId: "empty-source",
        scope: "COMMON",
        family: "CONTENT",
        version: 1,
        status: "AVAILABLE",
        fields: [],
      }],
    })).toThrowError(expect.objectContaining({ code: "SOURCE_UNAVAILABLE" }));

    const vector = selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: sources().slice(0, 2) });
    expect(() => createReleaseManifest({
      ...SCOPE,
      audience: "PUBLIC",
      releaseId: "empty-projection",
      sourceVector: vector,
      decisions: [],
    })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(preflightAtomicTwin({
      ...SCOPE,
      version: 1,
      public: { current: null, baseline: null, manifest: null },
      operator: { current: null, baseline: null, manifest: null },
    }).ready).toBe(false);
  });
});

describe("operator release core adversarial policy and determinism", () => {
  it.each([
    "oauthClientSecret",
    "clientsecret",
    "secretvalue",
    "accessToken",
    "apiKey",
    "privateKey",
    "authorizationHeader",
  ])("rejects sensitive public field naming form %s", (field) => {
    expect(() => selectAudienceSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [{
        sourceId: "sensitive-source",
        scope: "COMMON",
        family: "CONTENT",
        version: 1,
        status: "AVAILABLE",
        fields: [{ field, family: "CONTENT", value: "must-not-project" }],
      }],
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));
  });

  it("rejects camelCase sensitive keys nested inside otherwise public values", () => {
    expect(() => selectAudienceSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [{
        sourceId: "nested-sensitive-source",
        scope: "COMMON",
        family: "CONTENT",
        version: 1,
        status: "AVAILABLE",
        fields: [{ field: "event.metadata", family: "CONTENT", value: { safe: { clientSecret: "must-not-project" } } }],
      }],
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));

    const original = releaseTwin();
    const forgedManifest = JSON.parse(JSON.stringify(original.public.manifest)) as unknown as Record<string, unknown>;
    const included = forgedManifest.includedFields as Array<Record<string, unknown>>;
    included[0]!.value = { clientSecret: "must-not-rehydrate" };
    forgedManifest.fingerprint = fingerprintOf(withoutFingerprint(forgedManifest as { fingerprint: string }));
    expect(() => loadTrustedReleaseManifest(forgedManifest)).toThrowError(expect.objectContaining({ code: "FORBIDDEN_FIELD" }));
  });

  it("rejects invalid calendar dates and offsets instead of Date normalization", () => {
    for (const time of ["2026-02-30T09:00:00Z", "2025-02-29T09:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T09:00:00+24:00"]) {
      expect(() => selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: sources({ time }).slice(0, 2) })).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });

  it("uses RFC 8785 UTF-16 key ordering and timezone/order-independent fingerprints", () => {
    expect(canonicalJson({ "\uE000": 1, "😀": 2 })).toBe("{\"😀\":2,\"\":1}");
    const offset = selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: sources().slice(0, 2).reverse() });
    const utc = selectAudienceSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: sources({ time: "2026-09-01T13:00:00Z" }).slice(0, 2).map((source) => ({
        ...source,
        fields: [...source.fields].reverse(),
      })),
    });
    expect(offset.fingerprint).toBe(utc.fingerprint);
    expect(offset.sources[0]?.fields[0]?.value).toBe("2026-09-01T13:00:00.000Z");
  });

  it("returns detached deeply frozen output after caller-owned values mutate", () => {
    const metadata = { label: "before", nested: ["one"] };
    const inputSources: SourceRecordInput[] = [{
      sourceId: "metadata-source",
      scope: "COMMON",
      family: "CONTENT",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "event.metadata", family: "CONTENT", value: metadata }],
    }];
    const vector = selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: inputSources });
    metadata.label = "after";
    metadata.nested.push("two");
    expect(vector.sources[0]?.fields[0]?.value).toEqual({ label: "before", nested: ["one"] });
    expect(Object.isFrozen(vector.sources[0]?.fields[0]?.value as object)).toBe(true);
    expect(Object.isFrozen((vector.sources[0]?.fields[0]?.value as { nested: unknown[] }).nested)).toBe(true);
  });

  it("fails closed on projection scope and audience swaps", () => {
    const current = releaseTwin();
    expect(() => preflightAtomicTwin({
      ...SCOPE,
      version: 1,
      public: { current: current.operator.sourceVector, baseline: current.operator.sourceVector, manifest: current.public.manifest },
      operator: { current: current.public.sourceVector, baseline: current.public.sourceVector, manifest: current.operator.manifest },
    } as never)).toThrowError(expect.objectContaining({ code: "AUDIENCE_MISMATCH" }));
  });
});

describe("operator release core monotonic linear supersession", () => {
  it("blocks a lower-version candidate from superseding a higher current release", () => {
    const current = releaseTwin({ version: 2, suffix: "current-v2" });
    const candidate = releaseTwin({
      version: 1,
      suffix: "candidate-v1",
      publicSupersedes: supersedes(current.public.manifest),
      operatorSupersedes: supersedes(current.operator.manifest),
    });
    const result = preflight(candidate, [current.public.manifest, current.operator.manifest]);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain("SUPERSESSION_INVALID");
  });

  it("binds candidates to the exact current head and rejects a stale predecessor branch", () => {
    const root = releaseTwin({ version: 1, suffix: "root" });
    const head = releaseTwin({
      version: 2,
      suffix: "head",
      publicSupersedes: supersedes(root.public.manifest),
      operatorSupersedes: supersedes(root.operator.manifest),
    });
    const staleBranch = releaseTwin({
      version: 3,
      suffix: "stale-branch",
      publicSupersedes: supersedes(root.public.manifest),
      operatorSupersedes: supersedes(root.operator.manifest),
    });
    const history = [root.public.manifest, root.operator.manifest, head.public.manifest, head.operator.manifest];
    const result = preflight(staleBranch, history);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain("SUPERSESSION_INVALID");
  });

  it("rejects an already-branching history even when every link and fingerprint is exact", () => {
    const root = releaseTwin({ version: 1, suffix: "branch-root" });
    const branchA = releaseTwin({
      version: 2,
      suffix: "branch-a",
      publicSupersedes: supersedes(root.public.manifest),
      operatorSupersedes: supersedes(root.operator.manifest),
    });
    const branchB = releaseTwin({
      version: 3,
      suffix: "branch-b",
      publicSupersedes: supersedes(root.public.manifest),
      operatorSupersedes: supersedes(root.operator.manifest),
    });
    expect(() => validateSupersessionChain([
      root.public.manifest,
      branchA.public.manifest,
      branchB.public.manifest,
    ])).toThrowError(expect.objectContaining({ code: "SUPERSESSION_INVALID" }));
  });

  it("accepts one exact increasing twin lineage and preserves atomic readiness", () => {
    const root = releaseTwin({ version: 1, suffix: "linear-root" });
    const candidate = releaseTwin({
      version: 2,
      suffix: "linear-head",
      publicSupersedes: supersedes(root.public.manifest),
      operatorSupersedes: supersedes(root.operator.manifest),
    });
    const result = preflight(candidate, [root.public.manifest, root.operator.manifest]);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(assessSourceVector(candidate.public.sourceVector, candidate.public.sourceVector).status).toBe("EXACT_MATCH");
  });
});
