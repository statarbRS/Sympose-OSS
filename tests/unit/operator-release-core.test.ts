import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_RECORDS,
  createReleaseManifest,
  createReleaseTwin,
  createSourceVector,
  preflightAtomicTwin,
  selectAudienceSourceVector,
  compareReleaseSourceVectors,
  assessSourceVector,
  validateSupersessionLinks,
  verifyReleaseManifest,
  verifySourceVector,
  type FieldDecisionInput,
  type SourceRecordInput,
} from "@/server/services/operator-release-core";

const SCOPE = { workspaceId: "workspace-release-core", eventId: "event-release-core" } as const;

function corpus(options: {
  readonly time?: string;
  readonly timeVersion?: number;
  readonly cue?: string;
  readonly cueVersion?: number;
} = {}): SourceRecordInput[] {
  return [
    {
      sourceId: "event-time",
      scope: "COMMON",
      family: "TIME",
      version: options.timeVersion ?? 1,
      status: "AVAILABLE",
      fields: [{ field: "event.startsAt", family: "TIME", value: options.time ?? "2026-09-01T09:00:00-04:00" }],
    },
    {
      sourceId: "event-title",
      scope: "COMMON",
      family: "CONTENT",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "event.title", family: "CONTENT", value: "Operator release rehearsal" }],
    },
    {
      sourceId: "operator-cue",
      scope: "OPERATOR",
      family: "OPERATOR_CUE",
      version: options.cueVersion ?? 1,
      status: "AVAILABLE",
      fields: [{ field: "operator.cue", family: "OPERATOR_CUE", value: options.cue ?? "doors-open" }],
    },
    {
      sourceId: "operator-contact",
      scope: "OPERATOR",
      family: "CONTACT",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "contact.email", family: "CONTACT", value: "private@example.test" }],
    },
    {
      sourceId: "operator-artifact",
      scope: "OPERATOR",
      family: "PRIVATE_ARTIFACT",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "private.artifact", family: "PRIVATE_ARTIFACT", value: "artifact://internal-only" }],
    },
  ];
}

function publicDecisions(): FieldDecisionInput[] {
  return [
    { sourceId: "event-time", field: "event.startsAt", decision: "INCLUDE", reason: "Published schedule time." },
    { sourceId: "event-title", field: "event.title", decision: "INCLUDE", reason: "Published event title." },
  ];
}

function operatorDecisions(): FieldDecisionInput[] {
  return [
    ...publicDecisions(),
    { sourceId: "operator-artifact", field: "private.artifact", decision: "OMIT", reason: "Private artifacts are not an operator release field." },
    { sourceId: "operator-contact", field: "contact.email", decision: "REDACT", reason: "Contact data is withheld from this release." },
    { sourceId: "operator-cue", field: "operator.cue", decision: "INCLUDE", reason: "The event-day operator cue is allowlisted." },
  ];
}

function twin(options: Parameters<typeof corpus>[0] = {}) {
  return createReleaseTwin({
    ...SCOPE,
    version: options.timeVersion === 2 ? 2 : 1,
    sources: corpus(options),
    publicReleaseId: "public-release-1",
    operatorReleaseId: "operator-release-1",
    publicDecisions: publicDecisions(),
    operatorDecisions: operatorDecisions(),
  });
}

function exactPreflight(current: ReturnType<typeof twin>, baseline = current) {
  return preflightAtomicTwin({
    ...SCOPE,
    version: current.version,
    public: {
      current: current.public.sourceVector,
      baseline: baseline.public.sourceVector,
      manifest: current.public.manifest,
    },
    operator: {
      current: current.operator.sourceVector,
      baseline: baseline.operator.sourceVector,
      manifest: current.operator.manifest,
    },
  });
}

describe("operator release core", () => {
  it("keeps PUBLIC output free of operator cues, contact data, private artifacts, and forbidden fields", () => {
    const releaseTwin = twin();
    const publicJson = JSON.stringify(releaseTwin.public);
    const operatorJson = JSON.stringify(releaseTwin.operator);

    expect(publicJson).toContain("event.startsAt");
    expect(publicJson).not.toContain("operator.cue");
    expect(publicJson).not.toContain("private@example.test");
    expect(publicJson).not.toContain("artifact://internal-only");
    expect(publicJson).not.toMatch(/"(?:action|provider)"/u);
    expect(operatorJson).toContain("operator.cue");
    expect(operatorJson).toContain("doors-open");
    expect(releaseTwin.operator.manifest.includedFields.map((field) => field.field)).toContain("operator.cue");
  });

  it("requires an explicit reason for every redaction or omission", () => {
    expect(() => createReleaseManifest({
      ...SCOPE,
      audience: "OPERATOR",
      releaseId: "operator-release-reason",
      sourceVector: twin().operator.sourceVector,
      decisions: [
        ...publicDecisions(),
        { sourceId: "operator-artifact", field: "private.artifact", decision: "OMIT", reason: "" },
        { sourceId: "operator-contact", field: "contact.email", decision: "REDACT", reason: "Contact is private." },
        { sourceId: "operator-cue", field: "operator.cue", decision: "INCLUDE", reason: "Allowlisted cue." },
      ],
    })).toThrowError(expect.objectContaining({ code: "REDACTION_REASON_REQUIRED" }));
  });

  it("marks a common time change stale for both audiences", () => {
    const baseline = twin();
    const current = twin({ time: "2026-09-01T10:00:00-04:00", timeVersion: 2 });
    const result = exactPreflight(current, baseline);

    expect(result.ready).toBe(false);
    expect(result.public.status).toBe("STALE");
    expect(result.operator.status).toBe("STALE");
    expect(result.public.drift?.commonChanged).toBe(true);
    expect(result.operator.drift?.effects).toContain("COMMON");
  });

  it("marks an operator cue change stale only for OPERATOR", () => {
    const baseline = twin();
    const current = twin({ cue: "doors-closed", cueVersion: 2 });
    const result = exactPreflight(current, baseline);

    expect(result.public.status).toBe("EXACT_MATCH");
    expect(result.operator.status).toBe("STALE");
    expect(result.operator.drift?.families).toEqual(["OPERATOR_CUE"]);
    expect(result.operator.drift?.effects).toEqual(["OPERATOR_ONLY"]);
    expect("safe" in (result.operator.drift ?? {})).toBe(false);
  });

  it("reports an unavailable operator projection when its exact baseline is missing", () => {
    const current = twin();
    const result = preflightAtomicTwin({
      ...SCOPE,
      version: current.version,
      public: {
        current: current.public.sourceVector,
        baseline: current.public.sourceVector,
        manifest: current.public.manifest,
      },
      operator: {
        current: current.operator.sourceVector,
        baseline: null,
        manifest: current.operator.manifest,
      },
    });

    expect(result.ready).toBe(false);
    expect(result.operator.status).toBe("UNAVAILABLE");
    expect(result.blockers.map((entry) => entry.code)).toContain("OPERATOR_UNAVAILABLE");
  });

  it("returns a ready atomic twin only when both exact manifests and baselines are present", () => {
    const current = twin();
    const result = exactPreflight(current);

    expect(result.ready).toBe(true);
    expect(result.public.status).toBe("EXACT_MATCH");
    expect(result.operator.status).toBe("EXACT_MATCH");
    expect(result.blockers).toEqual([]);
    expect(result.commonFingerprint).toBe(current.commonFingerprint);
  });

  it("rejects cross-scope, cross-audience, and caller-selected authority inputs", () => {
    const releaseTwin = twin();
    expect(() => createReleaseManifest({
      ...SCOPE,
      audience: "OPERATOR",
      releaseId: "wrong-audience",
      sourceVector: releaseTwin.public.sourceVector,
      decisions: operatorDecisions(),
    })).toThrowError(expect.objectContaining({ code: "AUDIENCE_MISMATCH" }));

    expect(() => createSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: corpus(),
    })).toThrowError(expect.objectContaining({ code: "CROSS_AUDIENCE_LEAKAGE" }));

    expect(() => verifySourceVector({
      ...releaseTwin.public.sourceVector,
      authority: "caller-selected-authority",
    })).toThrowError(expect.objectContaining({ code: "CALLER_AUTHORITY_FORBIDDEN" }));

    expect(() => preflightAtomicTwin({
      ...SCOPE,
      version: 1,
      authority: "caller-selected-authority",
      public: { current: null, baseline: null, manifest: null },
      operator: { current: null, baseline: null, manifest: null },
    } as never)).toThrowError(expect.objectContaining({ code: "CALLER_AUTHORITY_FORBIDDEN" }));
  });

  it("rejects duplicate/conflicting fields, stale integrity, and non-allowlisted operator facts", () => {
    expect(() => createSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [{
        sourceId: "duplicate-fields",
        scope: "COMMON",
        family: "CONTENT",
        version: 1,
        status: "AVAILABLE",
        fields: [
          { field: "event.title", family: "CONTENT", value: "first" },
          { field: "event.title", family: "CONTENT", value: "second" },
        ],
      }],
    })).toThrowError(expect.objectContaining({ code: "DUPLICATE_FIELD" }));

    expect(() => createSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: [
        {
          sourceId: "conflict-a",
          scope: "COMMON",
          family: "CONTENT",
          version: 1,
          status: "AVAILABLE",
          fields: [{ field: "event.title", family: "CONTENT", value: "first" }],
        },
        {
          sourceId: "conflict-b",
          scope: "COMMON",
          family: "CONTENT",
          version: 1,
          status: "AVAILABLE",
          fields: [{ field: "event.title", family: "CONTENT", value: "second" }],
        },
      ],
    })).toThrowError(expect.objectContaining({ code: "CONFLICTING_FIELD" }));

    const publicVector = twin().public.sourceVector;
    expect(() => verifySourceVector({ ...publicVector, fingerprint: "0".repeat(64) })).toThrowError(expect.objectContaining({ code: "FINGERPRINT_MISMATCH" }));

    const operatorVector = selectAudienceSourceVector({ ...SCOPE, audience: "OPERATOR", version: 1, sources: [{
      sourceId: "operator-not-allowlisted",
      scope: "OPERATOR",
      family: "OPERATOR_CUE",
      version: 1,
      status: "AVAILABLE",
      fields: [{ field: "operator.unlistedCue", family: "OPERATOR_CUE", value: "do-not-include" }],
    }] });
    expect(() => createReleaseManifest({
      ...SCOPE,
      audience: "OPERATOR",
      releaseId: "operator-not-allowlisted-release",
      sourceVector: operatorVector,
      decisions: [{ sourceId: "operator-not-allowlisted", field: "operator.unlistedCue", decision: "INCLUDE", reason: "caller request" }],
    })).toThrowError(expect.objectContaining({ code: "FIELD_NOT_ALLOWLISTED" }));
  });

  it("rejects a supersession cycle in the bounded lineage graph", () => {
    expect(() => validateSupersessionLinks([
      { audience: "PUBLIC", releaseId: "release-a", supersedesReleaseId: "release-b" },
      { audience: "PUBLIC", releaseId: "release-b", supersedesReleaseId: "release-a" },
    ])).toThrowError(expect.objectContaining({ code: "SUPERSESSION_CYCLE" }));
  });

  it("rehydrates cloned exact artifacts and blocks orphaned candidate supersession links", () => {
    const base = twin();
    const clonedManifest = structuredClone(base.public.manifest);
    expect(verifyReleaseManifest(clonedManifest).fingerprint).toBe(base.public.manifest.fingerprint);

    const orphanedManifest = createReleaseManifest({
      ...SCOPE,
      audience: "PUBLIC",
      releaseId: "public-release-orphan",
      sourceVector: base.public.sourceVector,
      decisions: publicDecisions(),
      supersedes: { releaseId: "missing-release", fingerprint: "a".repeat(64) },
    });
    const result = preflightAtomicTwin({
      ...SCOPE,
      version: base.version,
      public: { current: base.public.sourceVector, baseline: base.public.sourceVector, manifest: orphanedManifest },
      operator: { current: base.operator.sourceVector, baseline: base.operator.sourceVector, manifest: base.operator.manifest },
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain("SUPERSESSION_INVALID");
  });

  it("produces order, locale, and timezone-independent fingerprints", () => {
    const first = selectAudienceSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: corpus(),
    });
    const second = selectAudienceSourceVector({
      ...SCOPE,
      audience: "PUBLIC",
      version: 1,
      sources: corpus().slice(0, 2).reverse().map((source) => ({
        ...source,
        fields: [...source.fields].reverse(),
      })),
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.commonFingerprint).toBe(second.commonFingerprint);
    expect(first.sources.map((source) => source.sourceId)).toEqual(["event-time", "event-title"]);
    expect(first.sources[0]?.fields[0]?.value).toBe("2026-09-01T13:00:00.000Z");
    const report = compareReleaseSourceVectors(first, second);
    expect(report.changed).toBe(false);
    expect(assessSourceVector(first, second).status).toBe("EXACT_MATCH");
  });

  it("deep-freezes every returned artifact and never writes an action/provider surface", () => {
    const releaseTwin = twin();
    expect(Object.isFrozen(releaseTwin)).toBe(true);
    expect(Object.isFrozen(releaseTwin.public)).toBe(true);
    expect(Object.isFrozen(releaseTwin.public.sourceVector.sources)).toBe(true);
    expect(Object.isFrozen(releaseTwin.public.manifest)).toBe(true);
    expect(Object.isFrozen(releaseTwin.operator.manifest.redactedFields)).toBe(true);
    expect(JSON.stringify(releaseTwin)).not.toMatch(/"(?:action|provider)"/u);
    expect(() => {
      (releaseTwin.public.manifest.includedFields as Array<unknown>).push({});
    }).toThrow();
  });

  it("enforces bounded source counts and unavailable unknown sources", () => {
    const tooMany = Array.from({ length: MAX_SOURCE_RECORDS + 1 }, (_, index) => ({
      sourceId: `source-${index}`,
      scope: "COMMON" as const,
      family: "CONTENT" as const,
      version: 1,
      status: "AVAILABLE" as const,
      fields: [{ field: `event.title.${index}`, family: "CONTENT" as const, value: "bounded" }],
    }));
    expect(() => selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: tooMany })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));

    expect(() => selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: [{
      sourceId: "unknown-source",
      scope: "COMMON",
      family: "UNKNOWN",
      version: 1,
      status: "UNAVAILABLE",
      fields: [],
      unavailableReason: "Source has not been resolved.",
    }] })).not.toThrow();
    const unavailable = selectAudienceSourceVector({ ...SCOPE, audience: "PUBLIC", version: 1, sources: [{
      sourceId: "unknown-source",
      scope: "COMMON",
      family: "UNKNOWN",
      version: 1,
      status: "UNAVAILABLE",
      fields: [],
      unavailableReason: "Source has not been resolved.",
    }] });
    expect(assessSourceVector(unavailable, unavailable).status).toBe("UNAVAILABLE");
  });
});
