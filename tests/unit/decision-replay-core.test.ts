import { describe, expect, it } from "vitest";

import {
  canonicalReplayDiff,
  createDecisionReplayExecutionEvidence,
  createDecisionReplayManifest,
  hasReplayApplyField,
  replayDecision,
  replayEffectiveInputFingerprintOf,
  replayFingerprintOf,
  type DecisionReplayExecutionEvidence,
  type DecisionReplayManifest,
  type ReplayJsonValue,
} from "../../src/server/services/decision-replay-core";

const ENGINE_ID = "sympose-roundtable";
const ENGINE_VERSION = "2026.08.13";
const ENGINE_FINGERPRINT = "1".repeat(64);

const inputArtifact = {
  sourceFamilies: {
    cohort: { snapshotId: "snapshot-1", people: ["person-a", "person-b"] },
    capacity: { unitId: "unit-1", limit: 2 },
  },
} as const;

const outputArtifact = {
  sourceFamilies: {
    assignments: [{ personId: "person-a", unitId: "unit-1" }],
    diagnostics: { infeasible: false },
  },
} as const;

function reproduceManifest(overrides: Record<string, unknown> = {}) {
  return createDecisionReplayManifest({
    schema: "decision-replay-manifest/v1",
    label: "SIMULATION_ONLY",
    mode: "REPRODUCE",
    engine: { id: ENGINE_ID, version: ENGINE_VERSION, fingerprint: ENGINE_FINGERPRINT },
    input: { fingerprint: replayFingerprintOf(inputArtifact), artifact: inputArtifact },
    expectedOutput: { fingerprint: replayFingerprintOf(outputArtifact), artifact: outputArtifact },
    patches: [],
    ...overrides,
  });
}

function executionEvidence(
  manifest: DecisionReplayManifest = reproduceManifest(),
  result: { readonly status: "FEASIBLE"; readonly output: ReplayJsonValue; readonly outputFingerprint?: string } |
    { readonly status: "INFEASIBLE" } = { status: "FEASIBLE", output: outputArtifact },
  overrides: Record<string, unknown> = {},
): DecisionReplayExecutionEvidence {
  return createDecisionReplayExecutionEvidence({
    engine: manifest.engine,
    mode: manifest.mode,
    inputFingerprint: manifest.input.fingerprint,
    effectiveInputFingerprint: replayEffectiveInputFingerprintOf(manifest),
    ...result,
    ...overrides,
  });
}

function probeInheritedGetters<T>(
  values: Readonly<Record<string, unknown>>,
  action: () => T,
): { readonly reads: number; readonly value: T | undefined; readonly error: unknown } {
  const entries = Object.entries(values);
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  let reads = 0;
  for (const [key, value] of entries) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        reads += 1;
        return value;
      },
    });
  }

  let result: T | undefined;
  let error: unknown;
  try {
    result = action();
  } catch (caught) {
    error = caught;
  } finally {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
  return { reads, value: result, error };
}

describe("decision replay core", () => {
  it("freezes a reproduce manifest, plain execution evidence, and simulation result", () => {
    const manifest = reproduceManifest();
    const evidence = executionEvidence(manifest);
    const result = replayDecision(manifest, [evidence]);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.input.artifact)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.output)).toBe(true);
    expect(evidence).not.toHaveProperty("run");
    expect(result.status).toBe("MATCH");
    expect(result.label).toBe("SIMULATION_ONLY");
    expect(result.output).toEqual(outputArtifact);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(hasReplayApplyField(result)).toBe(false);
    expect(result).not.toHaveProperty("apply");
  });

  it("keeps the result deterministic when source-family and object key order changes", () => {
    const expected = {
      sourceFamilies: {
        zeta: { b: 2, a: 1 },
        alpha: [{ id: "b", value: 2 }, { id: "a", value: 1 }],
      },
    } as const;
    const actual = {
      sourceFamilies: {
        alpha: [{ id: "b", value: 3 }, { id: "a", value: 1 }],
        zeta: { a: 1, b: 2 },
      },
    } as const;
    const first = canonicalReplayDiff(expected, actual);
    const second = canonicalReplayDiff(
      {
        sourceFamilies: {
          zeta: { a: 1, b: 2 },
          alpha: [{ id: "b", value: 3 }, { id: "a", value: 1 }],
        },
      },
      {
        sourceFamilies: {
          alpha: [{ id: "b", value: 2 }, { id: "a", value: 1 }],
          zeta: { b: 2, a: 1 },
        },
      },
    );

    expect(first).toEqual(second.map((group) => ({
      ...group,
      changes: group.changes.map((change) => ({
        ...change,
        expected: change.actual,
        actual: change.expected,
      })),
    })));
    expect(first.map((group) => group.sourceFamily)).toEqual(["alpha"]);
    expect(first[0]?.changes[0]?.path).toBe("/0/value");
  });

  it("rejects tampered input and expected output fingerprints before consuming evidence", () => {
    const manifest = reproduceManifest();
    const evidence = executionEvidence(manifest);
    const tampered = { ...manifest, input: { ...manifest.input, artifact: { ...inputArtifact, tampered: true } } };
    const result = replayDecision(tampered, [evidence]);

    expect(result.status).toBe("NON_REPRODUCIBLE");
    expect(result.blockers).toContain("INPUT_FINGERPRINT_MISMATCH");

    const outputTampered = reproduceManifest({
      expectedOutput: { ...manifest.expectedOutput, fingerprint: "2".repeat(64) },
    });
    expect(replayDecision(outputTampered, [executionEvidence(outputTampered)]).blockers)
      .toContain("EXPECTED_OUTPUT_FINGERPRINT_MISMATCH");
  });

  it("requires the exact engine version and fingerprint, with no latest fallback", () => {
    const manifest = reproduceManifest();
    const newer = executionEvidence(manifest, { status: "FEASIBLE", output: outputArtifact }, {
      engine: { ...manifest.engine, version: "2026.08.14" },
    });
    expect(replayDecision(manifest, [newer]).status).toBe("ENGINE_UNAVAILABLE");

    const wrongBuild = executionEvidence(manifest, { status: "FEASIBLE", output: outputArtifact }, {
      engine: { ...manifest.engine, fingerprint: "2".repeat(64) },
    });
    const result = replayDecision(manifest, [wrongBuild]);
    expect(result.status).toBe("NON_REPRODUCIBLE");
    expect(result.blockers).toContain("ENGINE_FINGERPRINT_MISMATCH");
  });

  it("requires engine and execution-evidence fingerprints", () => {
    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    })).toThrow(/engine\.fingerprint|fingerprint/i);

    expect(() => createDecisionReplayExecutionEvidence({
      engine: { id: ENGINE_ID, version: ENGINE_VERSION },
      mode: "REPRODUCE",
      inputFingerprint: "2".repeat(64),
      effectiveInputFingerprint: "3".repeat(64),
      status: "INFEASIBLE",
    })).toThrow(/fingerprint/i);

    const evidence = executionEvidence();
    expect(() => replayDecision(reproduceManifest(), [{
      ...evidence,
      evidenceFingerprint: undefined,
    }])).toThrow(/evidenceFingerprint|fingerprint/i);
  });

  it("rejects callbacks and getter-backed catalogs without executing ambient capability", () => {
    const manifest = reproduceManifest();
    let sideEffects = 0;
    const callbackCatalog = [{
      id: ENGINE_ID,
      version: ENGINE_VERSION,
      fingerprint: ENGINE_FINGERPRINT,
      run: () => {
        sideEffects += 1;
        return outputArtifact;
      },
    }];
    expect(() => replayDecision(manifest, callbackCatalog as unknown)).toThrow(/plain|JSON|evidence/i);
    expect(sideEffects).toBe(0);

    let getterReads = 0;
    const getterEntry = { id: ENGINE_ID, version: ENGINE_VERSION } as Record<string, unknown>;
    Object.defineProperty(getterEntry, "fingerprint", {
      enumerable: true,
      get() {
        getterReads += 1;
        return ENGINE_FINGERPRINT;
      },
    });
    Object.defineProperty(getterEntry, "run", {
      enumerable: true,
      get() {
        getterReads += 1;
        return () => {
          sideEffects += 1;
          return outputArtifact;
        };
      },
    });
    expect(() => replayDecision(manifest, [getterEntry])).toThrow(/accessor|plain|JSON/i);
    expect(getterReads).toBe(0);
    expect(sideEffects).toBe(0);
  });

  it("descriptor-snapshots data and rejects Proxy or toJSON mutation", () => {
    let toJsonCalls = 0;
    const target = { safe: true };
    const artifact = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "toJSON") {
          return () => {
            toJsonCalls += 1;
            return { apply: true };
          };
        }
        return Reflect.get(source, property, receiver);
      },
    });

    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      input: { fingerprint: replayFingerprintOf(target), artifact },
    })).toThrow(/Proxy|proxy/i);
    expect(toJsonCalls).toBe(0);
    expect(target).toEqual({ safe: true });

    let getterCalls = 0;
    const output = {} as Record<string, unknown>;
    Object.defineProperty(output, "toJSON", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => ({ apply: true });
      },
    });
    expect(() => createDecisionReplayExecutionEvidence({
      engine: reproduceManifest().engine,
      mode: "REPRODUCE",
      inputFingerprint: replayFingerprintOf(inputArtifact),
      effectiveInputFingerprint: replayEffectiveInputFingerprintOf(reproduceManifest()),
      status: "FEASIBLE",
      output,
    })).toThrow(/accessor|toJSON|JSON/i);
    expect(getterCalls).toBe(0);
  });

  it("requires own plain descriptors at every replay boundary without consulting inherited fields", () => {
    const manifest = reproduceManifest();
    const inheritedManifest = probeInheritedGetters({
      schema: manifest.schema,
      label: manifest.label,
      mode: manifest.mode,
      engine: manifest.engine,
      input: manifest.input,
      expectedOutput: manifest.expectedOutput,
      patches: manifest.patches,
      limits: manifest.limits,
    }, () => createDecisionReplayManifest({}));
    expect(inheritedManifest.reads).toBe(0);
    expect(inheritedManifest.value).toBeUndefined();
    expect(inheritedManifest.error).toMatchObject({ code: "REPLAY_LABEL_REQUIRED" });

    const nestedInheritedEngine = probeInheritedGetters({ id: ENGINE_ID }, () =>
      createDecisionReplayManifest({
        ...manifest,
        engine: { version: ENGINE_VERSION, fingerprint: ENGINE_FINGERPRINT },
      }));
    expect(nestedInheritedEngine.reads).toBe(0);
    expect(nestedInheritedEngine.value).toBeUndefined();
    expect(nestedInheritedEngine.error).toMatchObject({ code: "REPLAY_TOKEN_INVALID" });

    let prototypeGetterReads = 0;
    const customEnginePrototype = {};
    Object.defineProperty(customEnginePrototype, "id", {
      get() {
        prototypeGetterReads += 1;
        return ENGINE_ID;
      },
    });
    const customEngine = Object.assign(Object.create(customEnginePrototype), {
      version: ENGINE_VERSION,
      fingerprint: ENGINE_FINGERPRINT,
    });
    expect(() => createDecisionReplayManifest({ ...manifest, engine: customEngine }))
      .toThrow(/plain JSON objects|JSON/i);
    expect(prototypeGetterReads).toBe(0);

    let proxyTrapCalls = 0;
    const proxyManifest = new Proxy({ ...manifest }, {
      get(target, property, receiver) {
        proxyTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      getPrototypeOf(target) {
        proxyTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        proxyTrapCalls += 1;
        return Reflect.has(target, property);
      },
    });
    expect(() => createDecisionReplayManifest(proxyManifest)).toThrow(/Proxy|proxy/i);
    expect(proxyTrapCalls).toBe(0);

    const alteredPatches: unknown[] = [];
    Object.setPrototypeOf(alteredPatches, Object.create(Array.prototype));
    expect(() => createDecisionReplayManifest({ ...manifest, patches: alteredPatches }))
      .toThrow(/plain JSON arrays|JSON/i);

    const sparsePatches = new Array(1);
    expect(() => createDecisionReplayManifest({
      ...manifest,
      mode: "COUNTERFACTUAL",
      patches: sparsePatches,
    })).toThrow(/sparse arrays|JSON/i);

    const cyclicArtifact: Record<string, unknown> = {};
    cyclicArtifact.self = cyclicArtifact;
    expect(() => createDecisionReplayManifest({
      ...manifest,
      input: { fingerprint: "0".repeat(64), artifact: cyclicArtifact },
    })).toThrow(/cyclic|cycle/i);
    expect(() => createDecisionReplayManifest({
      ...manifest,
      input: { fingerprint: "0".repeat(64), artifact: () => inputArtifact },
    })).toThrow(/JSON/i);

    expect(replayDecision(manifest, [executionEvidence(manifest)]).status).toBe("MATCH");
  });

  it("uses exact safe allowlists and cannot disable protected constraint families", () => {
    const safe = createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: [{ type: "CONSTRAINT_TOGGLE", constraintKey: "SOFT_RELATIONSHIP_NOVELTY", enabled: false }],
    });
    expect(safe.patches).toEqual([
      { type: "CONSTRAINT_TOGGLE", constraintKey: "SOFT_RELATIONSHIP_NOVELTY", enabled: false },
    ]);

    for (const constraintKey of [
      "PERSON_NO_OVERLAP",
      "CONFLICT_CHECK",
      "PERSON_ELIGIBLE_FOR_UNIT",
      "IDENTITY_MATCH",
      "WORKSPACE_TENANCY",
      "ACTOR_AUTHORITY",
      "RETENTION_POLICY",
      "PUBLICATION_READY",
      "HARD_CAPACITY",
      "purpose-selection",
    ]) {
      expect(() => createDecisionReplayManifest({
        ...reproduceManifest(),
        mode: "COUNTERFACTUAL",
        patches: [{ type: "CONSTRAINT_TOGGLE", constraintKey, enabled: false }],
      } as unknown), constraintKey).toThrow(/allowlist|injection|forbidden|purpose|state-changing/i);
    }

    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: [{ type: "OBJECTIVE_WEIGHT", objectiveKey: "HARD_CAPACITY", weight: 0 }],
    } as unknown)).toThrow(/allowlist|injection|forbidden|state-changing/i);
  });

  it("rejects forbidden patch families and unbounded patch work", () => {
    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: [{ type: "IDENTITY_OVERRIDE", targetId: "person-a", value: "person-b" }],
    })).toThrow(/scenario patch family|forbidden/i);

    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: Array.from({ length: 33 }, (_, index) => ({ type: "CAPACITY_LIMIT", targetId: `unit-${index}`, limit: 1 })),
    })).toThrow(/patch count|fixed bound/i);

    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      limits: { maxPatches: 33 },
    })).toThrow(/fixed replay work bound/i);
  });

  it("rejects nested action semantics and shape tricks in manifests and patches", () => {
    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      input: {
        fingerprint: replayFingerprintOf({ nested: [{ action: "apply" }, "PROMOTION_REQUIRED"] }),
        artifact: { nested: [{ action: "apply" }, "PROMOTION_REQUIRED"] },
      },
    })).toThrow(/state-changing action|action/i);

    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: [{
        type: "CAPACITY_LIMIT",
        targetId: "unit-1",
        limit: 1,
        nested: { operation: "promote" },
      }],
    } as unknown)).toThrow(/state-changing|injection|promot/i);

    const arrayWithProperty = [{ type: "CAPACITY_LIMIT", targetId: "unit-1", limit: 1 }];
    Object.defineProperty(arrayWithProperty, "authority", { enumerable: true, value: "bypass" });
    expect(() => createDecisionReplayManifest({
      ...reproduceManifest(),
      mode: "COUNTERFACTUAL",
      patches: arrayWithProperty,
    })).toThrow(/plain JSON arrays|JSON arrays/i);
  });

  it("bounds changed, added, and removed leaves rather than only changed parents", () => {
    const expected = { sourceFamilies: { assignments: { first: 1, second: 2 } } } as const;
    const actual = { sourceFamilies: { assignments: {} } } as const;
    expect(() => canonicalReplayDiff(expected, actual, 1)).toThrow(/diff exceeds|entry bound/i);
    expect(() => canonicalReplayDiff({}, { sourceFamilies: { assignments: { first: 1 } } }, 0)).toThrow(/diff exceeds|entry bound/i);
    expect(() => canonicalReplayDiff({ sourceFamilies: { removed: { first: 1, second: 2 } } }, { sourceFamilies: {} }, 1)).toThrow(/diff exceeds|entry bound/i);

    for (let leafCount = 0; leafCount < 8; leafCount += 1) {
      const generatedExpected = { sourceFamilies: { assignments: Object.fromEntries(Array.from({ length: leafCount }, (_, index) => [`p${index}`, index])) } };
      const generatedActual = { sourceFamilies: { assignments: {} } };
      if (leafCount === 0) {
        expect(canonicalReplayDiff(generatedExpected, generatedActual, 0)).toEqual([]);
      } else {
        expect(() => canonicalReplayDiff(generatedExpected, generatedActual, leafCount - 1)).toThrow(/diff exceeds|entry bound/i);
        expect(canonicalReplayDiff(generatedExpected, generatedActual, leafCount)).toHaveLength(1);
      }
    }

    const expectedArtifact = { sourceFamilies: { assignments: {} } } as const;
    const actualArtifact = { sourceFamilies: { assignments: { first: 1, second: 2 } } } as const;
    const boundedManifest = reproduceManifest({
      expectedOutput: { fingerprint: replayFingerprintOf(expectedArtifact), artifact: expectedArtifact },
      limits: { maxDiffEntries: 1 },
    });
    const boundedResult = replayDecision(boundedManifest, [executionEvidence(
      boundedManifest,
      { status: "FEASIBLE", output: actualArtifact },
    )]);
    expect(boundedResult.status).toBe("NON_REPRODUCIBLE");
    expect(boundedResult.blockers).toContain("REPLAY_DIFF_LIMIT_EXCEEDED");
  });

  it("returns infeasible evidence without manufacturing output or applying anything", () => {
    const manifest = createDecisionReplayManifest({
      ...reproduceManifest(),
      expectedOutput: { fingerprint: replayFingerprintOf(outputArtifact) },
    });
    const result = replayDecision(manifest, [executionEvidence(manifest, { status: "INFEASIBLE" })]);

    expect(result.status).toBe("INFEASIBLE");
    expect(result.output).toBeUndefined();
    expect(result).not.toHaveProperty("apply");
    expect(result).not.toHaveProperty("promotion");
  });

  it("rejects simulated output that smuggles an action or exceeds the work bound", () => {
    const manifest = reproduceManifest();
    const actionEvidence = executionEvidence(manifest, {
      status: "FEASIBLE",
      output: { assignments: [], apply: true },
    });
    const actionOutput = replayDecision(manifest, [actionEvidence]);
    expect(actionOutput.status).toBe("NON_REPRODUCIBLE");
    expect(actionOutput.blockers).toContain("ENGINE_OUTPUT_ACTION_FIELD_FORBIDDEN");

    const oversizedEvidence = executionEvidence(manifest, {
      status: "FEASIBLE",
      output: { blob: "x".repeat(256 * 1024 + 1) },
    });
    const oversized = replayDecision(manifest, [oversizedEvidence]);
    expect(oversized.status).toBe("NON_REPRODUCIBLE");
    expect(oversized.blockers).toContain("ENGINE_OUTPUT_TOO_LARGE");
  });

  it("binds evidence to its exact mode, input, effective input, output, and descriptor snapshot", () => {
    const manifest = reproduceManifest();
    const wrongMode = executionEvidence(manifest, { status: "FEASIBLE", output: outputArtifact }, {
      mode: "COUNTERFACTUAL",
    });
    expect(replayDecision(manifest, [wrongMode]).blockers).toContain("EXECUTION_EVIDENCE_MODE_MISMATCH");

    const wrongEffectiveInput = executionEvidence(manifest, { status: "FEASIBLE", output: outputArtifact }, {
      effectiveInputFingerprint: "8".repeat(64),
    });
    expect(replayDecision(manifest, [wrongEffectiveInput]).blockers)
      .toContain("EXECUTION_EVIDENCE_EFFECTIVE_INPUT_FINGERPRINT_MISMATCH");

    const wrongOutputFingerprint = executionEvidence(manifest, {
      status: "FEASIBLE",
      output: outputArtifact,
      outputFingerprint: "9".repeat(64),
    });
    expect(replayDecision(manifest, [wrongOutputFingerprint]).blockers)
      .toContain("ENGINE_OUTPUT_FINGERPRINT_MISMATCH");

    const evidence = executionEvidence(manifest);
    expect(() => replayDecision(manifest, [{
      ...evidence,
      output: { sourceFamilies: { assignments: [] } },
    }])).toThrow(/evidenceFingerprint|bind the exact evidence/i);

    class NonCanonicalOutput {
      readonly assignments = [];
    }
    expect(() => executionEvidence(manifest, {
      status: "FEASIBLE",
      output: new NonCanonicalOutput() as unknown as ReplayJsonValue,
    })).toThrow(/plain JSON objects|JSON/i);
  });
});
