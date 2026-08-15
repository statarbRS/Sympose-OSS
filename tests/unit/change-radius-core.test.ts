import { describe, expect, it } from "vitest";

import {
  CHANGE_RADIUS_LIMITS,
  ChangeRadiusError,
  compareMaterialTerms,
  fingerprintImpactGraph,
  fingerprintSourceRecord,
  fingerprintSourceVector,
  preflightChangeRadius,
  type ChangeRadiusScope,
  type ExactBeforeSourceVector,
  type MaterialTerms,
  type MaterialTermKind,
  type ProposedChangeCommandEnvelope,
} from "../../src/server/services/change-radius";

const scope: ChangeRadiusScope = { workspaceId: "workspace-1", eventId: "event-1" };

const scheduleTerms: MaterialTerms = {
  time: { start: "2026-09-18T10:00:00Z", end: "2026-09-18T11:00:00Z" },
  duration: { minutes: 60 },
  role: "MODERATOR",
  venue: { venueId: "venue-1", roomId: "room-a" },
  recording: { enabled: false },
};

const materialLeafCases = [
  ["TIME", { time: { start: "2026-09-18T10:00:00.123Z" } }],
  ["DURATION", { duration: { minutes: 30 } }],
  ["ROLE", { role: { keys: ["MODERATOR"] } }],
  ["VENUE", { venue: { venueId: "venue-1", roomId: "room-a" } }],
  ["RECORDING", { recording: { enabled: true, settings: { quality: "high" } } }],
  ["UNKNOWN", { opaque: { nested: { value: "before" } } }],
] as const satisfies readonly (readonly [MaterialTermKind, MaterialTerms])[];

function sourceVector(overrides: Partial<ExactBeforeSourceVector> = {}): ExactBeforeSourceVector {
  return {
    vectorId: "vector-1",
    scope,
    revision: 4,
    records: [
      {
        family: "SCHEDULE",
        recordId: "schedule-1",
        scope,
        revision: 4,
        terms: scheduleTerms,
        dependents: [
          { family: "COMMITMENT", recordId: "commitment-1" },
          { family: "PUBLIC_RELEASE", recordId: "public-release-1" },
        ],
      },
      {
        family: "COMMITMENT",
        recordId: "commitment-1",
        scope,
        revision: 4,
        terms: { time: scheduleTerms.time, role: scheduleTerms.role, venue: scheduleTerms.venue },
      },
      {
        family: "PUBLIC_RELEASE",
        recordId: "public-release-1",
        scope,
        revision: 4,
        payload: { releaseNumber: 1, sealed: true },
      },
      {
        family: "ARTIFACT",
        recordId: "headshot-1",
        scope,
        revision: 4,
        kind: "HEADSHOT",
        payload: { contentHash: "headshot-hash-1" },
      },
    ],
    ...overrides,
  };
}

function moveScheduleCommand(vector = sourceVector()): ProposedChangeCommandEnvelope {
  return {
    commandId: "command-1",
    scope,
    beforeSourceVector: vector,
    proposedChanges: [
      {
        family: "SCHEDULE",
        recordId: "schedule-1",
        before: scheduleTerms,
        after: {
          ...scheduleTerms,
          time: { start: "2026-09-18T10:30:00Z", end: "2026-09-18T11:30:00Z" },
        },
      },
    ],
  };
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ChangeRadiusError) return error.code;
    throw error;
  }
  throw new Error("Expected ChangeRadiusError.");
}

describe("Change-Radius material terms", () => {
  it("compares each named term exactly and normalizes equivalent instants", () => {
    expect(compareMaterialTerms(
      { time: { start: "2026-09-18T10:00:00+00:00" } },
      { time: { start: "2026-09-18T10:00:00Z" } },
    ).equal).toBe(true);

    const time = compareMaterialTerms(
      { time: { start: "2026-09-18T10:00:00Z" } },
      { time: { start: "2026-09-18T10:30:00Z" } },
    );
    expect(time.changes.map((change) => change.kind)).toEqual(["TIME"]);
    expect(time.materiality).toBe("RECONFIRMATION");

    expect(compareMaterialTerms({ durationMinutes: 60 }, { durationMinutes: 90 }).changes[0]?.kind).toBe("DURATION");
    expect(compareMaterialTerms({ role: "SPEAKER" }, { role: "MODERATOR" }).changes[0]?.kind).toBe("ROLE");
    expect(compareMaterialTerms({ recording: false }, { recording: true }).changes[0]?.kind).toBe("RECORDING");
    expect(compareMaterialTerms({ opaque: "before" }, { opaque: "after" }).materiality).toBe("UNKNOWN");
  });

  it("honors a room-only policy without treating a room change as absent", () => {
    const defaultResult = compareMaterialTerms(
      { venue: { venueId: "venue-1", roomId: "room-a" } },
      { venue: { venueId: "venue-1", roomId: "room-b" } },
    );
    const reconfirmationResult = compareMaterialTerms(
      { venue: { venueId: "venue-1", roomId: "room-a" } },
      { venue: { venueId: "venue-1", roomId: "room-b" } },
      { venue: { roomOnly: "RECONFIRMATION" } },
    );
    expect(defaultResult.changes[0]?.kind).toBe("VENUE");
    expect(defaultResult.materiality).toBe("REVIEW");
    expect(reconfirmationResult.materiality).toBe("RECONFIRMATION");
  });

  it.each(materialLeafCases)("handles %s additions and removals without undefined fingerprints", (kind, leaf) => {
    const added = compareMaterialTerms({}, leaf);
    expect(added.changes).toHaveLength(1);
    expect(added.changes[0]?.kind).toBe(kind);
    expect(added.changes[0]?.before).toBeUndefined();
    expect(added.changes[0]?.after).toBeDefined();
    expect(added.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const removed = compareMaterialTerms(leaf, {});
    expect(removed.changes).toHaveLength(1);
    expect(removed.changes[0]?.kind).toBe(kind);
    expect(removed.changes[0]?.before).toBeDefined();
    expect(removed.changes[0]?.after).toBeUndefined();
    expect(removed.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const addedResult = preflightChangeRadius({
      commandId: `add-${kind}`,
      scope,
      beforeSourceVector: sourceVector({
        records: [{ family: "SCHEDULE", recordId: "schedule-1", scope, revision: 4, terms: {} }],
      }),
      proposedChanges: [{ family: "SCHEDULE", recordId: "schedule-1", before: {}, after: leaf }],
    });
    const removedResult = preflightChangeRadius({
      commandId: `remove-${kind}`,
      scope,
      beforeSourceVector: sourceVector({
        records: [{ family: "SCHEDULE", recordId: "schedule-1", scope, revision: 4, terms: leaf }],
      }),
      proposedChanges: [{ family: "SCHEDULE", recordId: "schedule-1", before: leaf, after: {} }],
    });
    expect(addedResult.graph.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(removedResult.graph.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(addedResult.affectedRecords[0]?.changedTerms[0]?.before).toBeUndefined();
    expect(removedResult.affectedRecords[0]?.changedTerms[0]?.after).toBeUndefined();
  });

  it("preserves nested material values and rejects unsupported sub-millisecond instants", () => {
    const before: MaterialTerms = {
      venue: {
        venueId: "venue-1",
        roomId: "room-a",
        metadata: { floor: 1, labels: ["north", "quiet"] },
      },
      recording: {
        enabled: true,
        settings: { quality: "high", captions: { required: true } },
      },
    };
    const after: MaterialTerms = {
      venue: {
        venueId: "venue-1",
        roomId: "room-b",
        metadata: { floor: 2, labels: ["north", "quiet"] },
      },
      recording: {
        enabled: true,
        settings: { quality: "lossless", captions: { required: true } },
      },
    };
    const comparison = compareMaterialTerms(before, after);
    expect(comparison.changes.find((change) => change.kind === "VENUE")?.before).toEqual(before.venue);
    expect(comparison.changes.find((change) => change.kind === "VENUE")?.after).toEqual(after.venue);
    expect(comparison.changes.find((change) => change.kind === "RECORDING")?.before).toEqual(before.recording);
    expect(comparison.changes.find((change) => change.kind === "RECORDING")?.after).toEqual(after.recording);

    const timestamp = compareMaterialTerms(
      { time: { start: "2026-09-18T10:00:00.123Z" } },
      { time: { start: "2026-09-18T10:00:00.124Z" } },
    );
    expect(timestamp.changes[0]?.before).toEqual({ start: "2026-09-18T10:00:00.123Z" });
    expect(timestamp.changes[0]?.after).toEqual({ start: "2026-09-18T10:00:00.124Z" });
    expect(errorCode(() => compareMaterialTerms(
      { time: { start: "2026-09-18T10:00:00.1234Z" } },
      { time: { start: "2026-09-18T10:00:00.1235Z" } },
    ))).toBe("INVALID_MATERIAL_TERM");
  });
});

describe("Change-Radius preflight", () => {
  it("produces exact schedule, public-release, and reconfirmation impact families for a 30-minute move", () => {
    const result = preflightChangeRadius(moveScheduleCommand());
    expect(result.authoritative).toBe(false);
    expect(result.canApply).toBe(false);
    expect(result.canSend).toBe(false);
    expect(result.mutatesState).toBe(false);
    expect(result.status).toBe("PREVIEW_ONLY");
    expect(result.affectedRecords.map((record) => record.family)).toEqual([
      "COMMITMENT",
      "PUBLIC_RELEASE",
      "SCHEDULE",
    ]);
    expect(result.affectedRecords.find((record) => record.family === "COMMITMENT")?.materiality).toBe("RECONFIRMATION");
    expect(result.affectedRecords.find((record) => record.family === "PUBLIC_RELEASE")?.materiality).toBe("REVIEW");
    expect(result.graph.edges).toHaveLength(2);
    expect(result.materiality).toBe("RECONFIRMATION");
  });

  it("keeps an unchanged headshot out of affected records", () => {
    const vector = sourceVector();
    const result = preflightChangeRadius({
      commandId: "headshot-noop",
      scope,
      beforeSourceVector: vector,
      proposedChanges: [{
        family: "ARTIFACT",
        recordId: "headshot-1",
        before: { contentHash: "headshot-hash-1" },
        after: { contentHash: "headshot-hash-1" },
      }],
    });
    expect(result.affectedRecords.some((record) => record.recordId === "headshot-1")).toBe(false);
    expect(result.graph.unaffected).toContainEqual({ family: "ARTIFACT", recordId: "headshot-1", scope });
  });

  it("keeps an unavailable operator baseline UNKNOWN", () => {
    const result = preflightChangeRadius({
      ...moveScheduleCommand(),
      commandId: "operator-unknown",
      operatorBaselineAvailable: false,
    });
    const operator = result.affectedRecords.find((record) => record.family === "OPERATOR_RELEASE");
    expect(operator?.materiality).toBe("UNKNOWN");
    expect(result.materiality).toBe("UNKNOWN");
    expect(result.requiresReview).toBe(true);
  });

  it("keeps an unknown family UNKNOWN even when its values are otherwise comparable", () => {
    const vector = sourceVector({
      records: [
        ...sourceVector().records,
        { family: "FUTURE_RELEASE_FAMILY", recordId: "future-1", scope, payload: { value: 1 } },
      ],
    });
    const result = preflightChangeRadius({
      commandId: "unknown-family",
      scope,
      beforeSourceVector: vector,
      proposedChanges: [{
        family: "FUTURE_RELEASE_FAMILY",
        recordId: "future-1",
        before: { value: 1 },
        after: { value: 1 },
      }],
    });
    const unknown = result.affectedRecords.find((record) => record.recordId === "future-1");
    expect(unknown?.family).toBe("UNKNOWN");
    expect(unknown?.sourceFamily).toBe("FUTURE_RELEASE_FAMILY");
    expect(unknown?.materiality).toBe("UNKNOWN");
    expect(errorCode(() => preflightChangeRadius({
      commandId: "unknown-family-suppression",
      scope,
      beforeSourceVector: vector,
      proposedChanges: [{
        family: "FUTURE_RELEASE_FAMILY",
        recordId: "future-1",
        before: { value: 1 },
        after: { value: 1 },
        affected: false,
      }],
    }))).toBe("CONTRADICTORY_IMPACTS");
  });

  it("does not suppress an unrelated changed family", () => {
    const vector = sourceVector();
    const result = preflightChangeRadius({
      commandId: "two-roots",
      scope,
      beforeSourceVector: vector,
      proposedChanges: [
        {
          family: "SCHEDULE",
          recordId: "schedule-1",
          before: scheduleTerms,
          after: { ...scheduleTerms, time: { start: "2026-09-18T10:30:00Z", end: "2026-09-18T11:30:00Z" } },
        },
        {
          family: "ARTIFACT",
          recordId: "headshot-1",
          before: { contentHash: "headshot-hash-1" },
          after: { contentHash: "headshot-hash-2" },
        },
      ],
    });
    expect(result.affectedRecords.some((record) => record.family === "SCHEDULE")).toBe(true);
    expect(result.affectedRecords.some((record) => record.family === "ARTIFACT")).toBe(true);
  });

  it("rejects stale, duplicate, conflict, cycle, cross-scope, and authority-injected proposals", () => {
    const vector = sourceVector();
    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(vector),
      expectedSourceVector: { vectorId: vector.vectorId, revision: vector.revision + 1 },
    }))).toBe("STALE_SOURCE_VECTOR");

    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      proposedChanges: [...(moveScheduleCommand().proposedChanges ?? []), ...(moveScheduleCommand().proposedChanges ?? [])],
    }))).toBe("DUPLICATE_CHANGE");

    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      proposedChanges: [{
        family: "SCHEDULE",
        recordId: "schedule-1",
        before: { ...scheduleTerms, duration: { minutes: 1 } },
        after: scheduleTerms,
      }],
    }))).toBe("CONTRADICTORY_BEFORE");

    const cyclic = sourceVector({
      records: [
        { family: "SCHEDULE", recordId: "a", scope, dependents: [{ family: "SCHEDULE", recordId: "b" }], terms: { durationMinutes: 1 } },
        { family: "SCHEDULE", recordId: "b", scope, dependents: [{ family: "SCHEDULE", recordId: "a" }], terms: { durationMinutes: 1 } },
      ],
    });
    expect(errorCode(() => preflightChangeRadius({
      commandId: "cycle",
      scope,
      beforeSourceVector: cyclic,
      proposedChanges: [{ family: "SCHEDULE", recordId: "a", before: { durationMinutes: 1 }, after: { durationMinutes: 2 } }],
    }))).toBe("IMPACT_CYCLE");

    const crossScope = sourceVector({
      records: [{ family: "SCHEDULE", recordId: "schedule-1", scope: { workspaceId: "other", eventId: "event-1" }, terms: scheduleTerms }],
    });
    expect(errorCode(() => preflightChangeRadius(moveScheduleCommand(crossScope)))).toBe("SCOPE_MISMATCH");

    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      authority: { approved: true },
    } as ProposedChangeCommandEnvelope))).toBe("CALLER_INJECTED_AUTHORITY");

    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      sourceVector: vector,
    }))).toBe("DUPLICATE_SOURCE_VECTOR");

    expect(errorCode(() => preflightChangeRadius({
      commandId: "duplicate-record",
      scope,
      beforeSourceVector: sourceVector({ records: [...sourceVector().records, sourceVector().records[0]!] }),
      proposedChanges: [],
    }))).toBe("DUPLICATE_SOURCE_RECORD");

    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      impactAssertions: [{ family: "SCHEDULE", recordId: "schedule-1", affected: false }],
    }))).toBe("CONTRADICTORY_IMPACTS");

    const crossScopeReference = sourceVector({
      records: [{
        family: "SCHEDULE",
        recordId: "schedule-1",
        scope,
        terms: scheduleTerms,
        dependents: [{ family: "COMMITMENT", recordId: "commitment-1", scope: { workspaceId: "other", eventId: "event-1" } }],
      }],
    });
    expect(errorCode(() => preflightChangeRadius({
      commandId: "cross-scope-reference",
      scope,
      beforeSourceVector: crossScopeReference,
      proposedChanges: [{ family: "SCHEDULE", recordId: "schedule-1", before: scheduleTerms, after: { ...scheduleTerms, durationMinutes: 61 } }],
    }))).toBe("SCOPE_MISMATCH");
  });

  it("binds caller-claimed source fingerprints to canonical before content", () => {
    const vector = sourceVector();
    const canonical = fingerprintSourceVector(vector);
    expect(fingerprintSourceVector({ ...vector, fingerprint: canonical, sourceFingerprint: canonical })).toBe(canonical);
    expect(preflightChangeRadius(moveScheduleCommand({ ...vector, fingerprint: canonical })).sourceVectorFingerprint).toBe(canonical);

    expect(errorCode(() => preflightChangeRadius(moveScheduleCommand({ ...vector, fingerprint: "stale-before" })))).toBe(
      "SOURCE_VECTOR_FINGERPRINT_MISMATCH",
    );
    expect(errorCode(() => fingerprintSourceVector({
      ...vector,
      records: vector.records.map((record, index) => index === 0 ? { ...record, fingerprint: "misbound-record" } : record),
    }))).toBe("SOURCE_RECORD_FINGERPRINT_MISMATCH");
    expect(errorCode(() => fingerprintSourceRecord({ ...vector.records[0]!, fingerprint: "misbound-record" }, scope, 4))).toBe(
      "SOURCE_RECORD_FINGERPRINT_MISMATCH",
    );
  });

  it("rejects malformed freshness aliases instead of silently falling back", () => {
    const vector = sourceVector();
    const malformed: readonly ProposedChangeCommandEnvelope[] = [
      {
        ...moveScheduleCommand(),
        beforeSourceVector: { ...vector, vectorId: null } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: { ...vector, revision: 4, sourceRevision: "4" } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: { ...vector, fingerprint: "" } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: { ...vector, currentFingerprint: null } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: { ...vector, currentRevision: "4" } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: {
          ...vector,
          records: vector.records.map((record, index) => index === 0
            ? { ...record, family: "SCHEDULE", recordType: "OTHER" }
            : record),
        },
      },
      {
        ...moveScheduleCommand(),
        beforeSourceVector: {
          ...vector,
          records: vector.records.map((record, index) => index === 0
            ? { ...record, revision: 4, version: "4" }
            : record),
        } as unknown as ExactBeforeSourceVector,
      },
      {
        ...moveScheduleCommand(),
        expectedBefore: { fingerprint: "" },
      },
      {
        ...moveScheduleCommand(),
        expectedSourceVector: { revision: "4" },
      } as unknown as ProposedChangeCommandEnvelope,
      {
        ...moveScheduleCommand(),
        expectedBefore: { fingerprint: fingerprintSourceVector(vector), unexpected: true },
      } as unknown as ProposedChangeCommandEnvelope,
      {
        ...moveScheduleCommand(),
        currentSourceVectorFingerprint: null,
      } as unknown as ProposedChangeCommandEnvelope,
      {
        ...moveScheduleCommand(),
        currentSourceVectorRevision: "4",
      } as unknown as ProposedChangeCommandEnvelope,
    ];

    for (const command of malformed) {
      expect(errorCode(() => preflightChangeRadius(command))).toBe("INVALID_COMMAND");
    }

    expect(errorCode(() => fingerprintSourceVector({ ...vector, sourceVectorId: null } as unknown as ExactBeforeSourceVector))).toBe(
      "INVALID_COMMAND",
    );
  });

  it("rejects a self-consistent nested expectation that shadows a stale top-level claim", () => {
    const vector = sourceVector();
    const canonical = fingerprintSourceVector(vector);
    const stale = "f".repeat(64);
    const command = {
      ...moveScheduleCommand(),
      expectedBefore: { fingerprint: canonical, sourceFingerprint: canonical },
      expectedSourceFingerprint: stale,
    } as unknown as ProposedChangeCommandEnvelope;

    expect(errorCode(() => preflightChangeRadius(command))).toBe("STALE_SOURCE_VECTOR");
  });

  it("rejects accessors, executable values, toJSON hooks, and cyclic input without evaluating getters", () => {
    let getterReads = 0;
    const getterVector = sourceVector();
    Object.defineProperty(getterVector, "vectorId", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return "vector-1";
      },
    });

    expect(errorCode(() => preflightChangeRadius(moveScheduleCommand(getterVector)))).toBe("INVALID_COMMAND");
    expect(errorCode(() => fingerprintSourceVector(getterVector))).toBe("INVALID_COMMAND");
    expect(getterReads).toBe(0);
    expect(errorCode(() => preflightChangeRadius({ ...moveScheduleCommand(), toJSON: "hook" }))).toBe("INVALID_COMMAND");
    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      metadata: { evaluate: () => true },
    }))).toBe("INVALID_COMMAND");

    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    expect(errorCode(() => preflightChangeRadius({
      ...moveScheduleCommand(),
      metadata: cyclicMetadata,
    }))).toBe("UNBOUNDED_GRAPH");
  });

  it("rejects inherited command fields and optional aliases without evaluating getters", () => {
    const command = moveScheduleCommand();
    const inheritedCases = [
      ["policy", false],
      ["requiredFamilies", true],
      ["expectedBefore", false],
      ["sourceVector", true],
      ["beforeTerms", false],
      ["impactEdges", true],
      ["purpose", false],
      ["authority", true],
    ] as const;

    for (const [key, enumerable] of inheritedCases) {
      let getterReads = 0;
      let result = "";
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        enumerable,
        get() {
          getterReads += 1;
          return key === "policy" ? {} : undefined;
        },
      });
      try {
        result = errorCode(() => preflightChangeRadius(command));
      } finally {
        Reflect.deleteProperty(Object.prototype, key);
      }
      expect(result).toBe("INVALID_COMMAND");
      expect(getterReads).toBe(0);
    }

    let customPrototypeReads = 0;
    const customPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(customPrototype, "policy", {
      configurable: true,
      enumerable: false,
      get() {
        customPrototypeReads += 1;
        return {};
      },
    });
    const inheritedCommand = Object.create(
      customPrototype,
      Object.getOwnPropertyDescriptors(command),
    ) as ProposedChangeCommandEnvelope;

    expect(errorCode(() => preflightChangeRadius(inheritedCommand))).toBe("INVALID_COMMAND");
    expect(customPrototypeReads).toBe(0);
  });

  it("rejects transparent proxies before invoking any proxy trap", () => {
    let trapCalls = 0;
    const vector = new Proxy(sourceVector(), {
      get(target, property, receiver) {
        trapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      has(target, property) {
        trapCalls += 1;
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });

    expect(errorCode(() => preflightChangeRadius(moveScheduleCommand(vector)))).toBe("INVALID_COMMAND");
    expect(errorCode(() => fingerprintSourceVector(vector))).toBe("INVALID_COMMAND");
    expect(trapCalls).toBe(0);
  });

  it("rejects graph bounds and unsafe unknown policies", () => {
    const records = Array.from({ length: CHANGE_RADIUS_LIMITS.maxSourceRecords + 1 }, (_, index) => ({
      family: "ARTIFACT",
      recordId: `artifact-${index}`,
      scope,
      payload: { index },
    }));
    expect(errorCode(() => preflightChangeRadius({
      commandId: "too-many-records",
      scope,
      beforeSourceVector: sourceVector({ records }),
      proposedChanges: [],
    }))).toBe("UNBOUNDED_GRAPH");

    expect(errorCode(() => compareMaterialTerms({ opaque: "a" }, { opaque: "b" }, { unknown: "REVIEW" }))).toBe("UNSAFE_UNKNOWN_POLICY");

    const chain = Array.from({ length: CHANGE_RADIUS_LIMITS.maxGraphDepth + 2 }, (_, index) => ({
      family: "SCHEDULE",
      recordId: `chain-${index}`,
      scope,
      terms: { durationMinutes: 1 },
      ...(index === CHANGE_RADIUS_LIMITS.maxGraphDepth + 1
        ? {}
        : { dependents: [{ family: "SCHEDULE", recordId: `chain-${index + 1}` }] }),
    }));
    expect(errorCode(() => preflightChangeRadius({
      commandId: "too-deep",
      scope,
      beforeSourceVector: sourceVector({ records: chain }),
      proposedChanges: [{ family: "SCHEDULE", recordId: "chain-0", before: { durationMinutes: 1 }, after: { durationMinutes: 2 } }],
    }))).toBe("UNBOUNDED_GRAPH");
  });

  it("is deterministic across input order and freezes its output", () => {
    const first = preflightChangeRadius(moveScheduleCommand());
    const vector = sourceVector({
      records: [...sourceVector().records].reverse().map((record) => ({
        ...record,
        dependents: record.dependents === undefined ? undefined : [...record.dependents].reverse(),
      })),
    });
    const second = preflightChangeRadius({
      ...moveScheduleCommand(vector),
      commandId: "command-1",
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.graph.fingerprint).toBe(first.graph.fingerprint);
    expect(fingerprintSourceVector(sourceVector())).toBe(fingerprintSourceVector(vector));
    expect(fingerprintSourceVector(sourceVector({
      records: [{
        family: "SCHEDULE",
        recordId: "schedule-1",
        scope,
        terms: { time: { start: "2026-09-18T10:00:00+00:00", end: "2026-09-18T11:00:00+00:00" } },
      }],
    }))).toBe(fingerprintSourceVector(sourceVector({
      records: [{
        family: "SCHEDULE",
        recordId: "schedule-1",
        scope,
        terms: { time: { start: "2026-09-18T10:00:00Z", end: "2026-09-18T11:00:00Z" } },
      }],
    })));
    expect(fingerprintImpactGraph(second.graph)).toBe(second.graph.fingerprint);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.graph)).toBe(true);
    expect(Object.isFrozen(second.graph.nodes)).toBe(true);
    expect(Object.isFrozen(second.graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(second.graph.nodes[0]?.reasonDetail)).toBe(true);
    expect(() => (second.graph.nodes as unknown as unknown[]).push({})).toThrow();
  });

  it("keeps unknown-family graph fingerprints stable when source families tie", () => {
    const records = [
      { family: "FUTURE_Z", recordId: "same-id", scope, revision: 4, terms: { opaque: "z" } },
      { family: "FUTURE_A", recordId: "same-id", scope, revision: 4, terms: { opaque: "a" } },
    ] as const;
    const changes = [
      { family: "FUTURE_Z", recordId: "same-id", before: { opaque: "z" }, after: { opaque: "z2" } },
      { family: "FUTURE_A", recordId: "same-id", before: { opaque: "a" }, after: { opaque: "a2" } },
    ] as const;
    const first = preflightChangeRadius({
      commandId: "unknown-order",
      scope,
      beforeSourceVector: sourceVector({ records }),
      proposedChanges: changes,
    });
    const second = preflightChangeRadius({
      commandId: "unknown-order",
      scope,
      beforeSourceVector: sourceVector({ records: [...records].reverse() }),
      proposedChanges: [...changes].reverse(),
    });

    expect(first.graph.fingerprint).toBe(second.graph.fingerprint);
    expect(fingerprintImpactGraph(first.graph)).toBe(first.graph.fingerprint);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.graph.nodes.map((node) => node.sourceFamily)).toEqual(["FUTURE_A", "FUTURE_Z"]);
    expect(first.graph.roots.map((root) => root.sourceFamily)).toEqual(["FUTURE_A", "FUTURE_Z"]);
  });
});
