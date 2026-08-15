import { describe, expect, it, vi } from "vitest";
import {
  HARD_BOUNDS,
  PROGRAM_SELECTION_SOLVER_VERSION,
  ProgramSelectionSolverError,
  compareDeterministicTieKeys,
  solveProgramSelection,
  type ProgramSelectionSolverInput,
} from "../../src/server/adapters/program-selection-solver";

const base = (): ProgramSelectionSolverInput => {
  const pools = [
    { poolId: "A", poolVersionId: "A-after-transfer", unitKind: "talk", remaining: 2 },
    { poolId: "B", poolVersionId: "B-after-transfer", unitKind: "talk", remaining: 2 },
  ];
  const eligibleRevisions = Array.from({ length: 8 }, (_, index) => ({
    submissionId: `S${index + 1}`,
    submissionRevisionId: `P${index + 1}`,
    tags: [index % 2 ? "odd" : "even"],
    allocationOptions: [{ poolId: index < 4 ? "A" : "B", poolVersionId: index < 4 ? "A-after-transfer" : "B-after-transfer", unitKind: "talk", quantity: 1 }],
  }));
  const facts = (offset: number) => eligibleRevisions.map((revision, index) => ({ submissionRevisionId: revision.submissionRevisionId, value: offset + index }));
  return {
    eligibleRevisions,
    evaluationFacts: facts(10), advocacyFacts: facts(20), capacityFacts: facts(1), programObjectiveFacts: facts(3), historicalFacts: facts(30),
    constraints: [], pools, targetCount: 4, deterministicSeed: "seed-1",
    configuration: { maxCandidateSlates: 2, objectives: [
      { name: "evaluation_quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 2 },
      { name: "advocacy_support", sourceFamily: "ADVOCACY", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 },
      { name: "capacity_fit", sourceFamily: "CAPACITY", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 },
      { name: "program_balance", sourceFamily: "PROGRAM", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 },
    ] },
  };
};

const selectedIds = (input: ProgramSelectionSolverInput) => solveProgramSelection(input).slates[0].entries.filter(entry => entry.disposition === "PROPOSED_SELECTED").map(entry => entry.submissionRevisionId);
const invalid = (input: unknown) => expect(() => solveProgramSelection(input as ProgramSelectionSolverInput)).toThrow(ProgramSelectionSolverError);

describe("pure PD-01 P4 deterministic selection solver", () => {
  it("generates complete 8/4/2-after-transfer alternatives with exact allocations and separate families", () => {
    const output = solveProgramSelection(base());
    expect(output.status).toBe("SUCCEEDED");
    expect(output.slates).toHaveLength(2);
    for (const slate of output.slates) {
      expect(slate.entries).toHaveLength(8);
      const selected = slate.entries.filter(entry => entry.disposition === "PROPOSED_SELECTED");
      expect(selected).toHaveLength(4);
      expect(new Set(slate.entries.map(entry => entry.submissionRevisionId)).size).toBe(8);
      const totals = new Map<string, number>();
      for (const entry of selected) totals.set(entry.allocation!.poolId, (totals.get(entry.allocation!.poolId) ?? 0) + entry.allocation!.quantity);
      expect(totals.get("A")).toBeLessThanOrEqual(2);
      expect(totals.get("B")).toBeLessThanOrEqual(2);
      expect(new Set(slate.objectiveContributions.map(value => value.sourceFamily))).toEqual(new Set(["EVALUATION", "ADVOCACY", "CAPACITY", "PROGRAM"]));
      expect(slate).not.toHaveProperty("score");
      expect(slate.rankingBasis.explanation).toContain("No blended score");
    }
  });

  it("backtracks across allocation options instead of reporting a feasible target infeasible", () => {
    const input = base();
    const small: ProgramSelectionSolverInput = {
      ...input, eligibleRevisions: [
        { submissionId: "S1", submissionRevisionId: "R1", allocationOptions: [
          { poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 },
          { poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 },
        ] },
        { submissionId: "S2", submissionRevisionId: "R2", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], evaluationFacts: [], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], constraints: [],
      pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }],
      targetCount: 2, configuration: { maxCandidateSlates: 1, objectives: [] },
    };
    const output = solveProgramSelection(small);
    expect(output.status).toBe("SUCCEEDED");
    expect(Object.fromEntries(output.slates[0].entries.filter(entry => entry.allocation).map(entry => [entry.submissionRevisionId, entry.allocation!.poolId]))).toEqual({ R1: "B", R2: "A" });
  });

  it("continues allocation enumeration through hard allocation-dependent constraints", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [{ submissionId: "S1", submissionRevisionId: "R1", allocationOptions: [
        { poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 2 },
        { poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 },
      ] }],
      pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 2 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }],
      evaluationFacts: [], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], targetCount: 1,
      constraints: [{ id: "unit-limit", kind: "MAX_TOTAL_UNITS", hard: true, limit: 1 }], configuration: { objectives: [] },
    };
    const output = solveProgramSelection(input);
    expect(output.status).toBe("SUCCEEDED");
    expect(output.slates[0].entries[0].allocation).toMatchObject({ poolId: "B", quantity: 1 });
    expect(output.diagnostics.allocationConstraintEvaluations).toBe(2);
  });

  it("retains the best soft-feasible allocation, not the first hard-feasible allocation", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [{ submissionId: "S1", submissionRevisionId: "R1", allocationOptions: [
        { poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 2 },
        { poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 },
      ] }],
      pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 2 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }],
      evaluationFacts: [], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], targetCount: 1,
      constraints: [{ id: "unit-preference", kind: "MAX_TOTAL_UNITS", hard: false, limit: 1 }], configuration: { objectives: [] },
    };
    const output = solveProgramSelection(input);
    expect(output.slates[0].entries[0].allocation).toMatchObject({ poolId: "B", quantity: 1 });
    expect(output.slates[0].rankingBasis.softViolationCount).toBe(0);
    expect(output.diagnostics.hardFeasibleAllocationsFound).toBe(2);
  });

  it("conserves durable submission identity and rejects duplicate revisions", () => {
    const input = base();
    invalid({ ...input, eligibleRevisions: [input.eligibleRevisions[0], { ...input.eligibleRevisions[1], submissionId: input.eligibleRevisions[0].submissionId }] });
    invalid({ ...input, eligibleRevisions: [input.eligibleRevisions[0], { ...input.eligibleRevisions[1], submissionRevisionId: input.eligibleRevisions[0].submissionRevisionId }] });
  });

  it("fails closed before touching changing-length proxy and accessor arrays", () => {
    const input = base();
    const descriptorSpy = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      let proxyLengthReads = 0;
      let proxyIndexReads = 0;
      const changingLength = new Proxy([...input.eligibleRevisions], {
        get(target, property, receiver) {
          if (property === "length") {
            proxyLengthReads += 1;
            return proxyLengthReads === 1 ? target.length : HARD_BOUNDS.maxEligibleRevisions + 1;
          }
          if (property === "0") proxyIndexReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(() => solveProgramSelection({ ...input, eligibleRevisions: changingLength })).toThrow(ProgramSelectionSolverError);
      expect(proxyLengthReads).toBe(0);
      expect(proxyIndexReads).toBe(0);

      const accessorArray = [...input.eligibleRevisions];
      let accessorReads = 0;
      Object.defineProperty(accessorArray, "0", {
        configurable: true,
        enumerable: true,
        get() {
          accessorReads += 1;
          accessorArray.length = HARD_BOUNDS.maxEligibleRevisions + 1;
          return input.eligibleRevisions[0];
        },
      });
      expect(() => solveProgramSelection({ ...input, eligibleRevisions: accessorArray })).toThrow(ProgramSelectionSolverError);
      expect(accessorReads).toBe(0);
      expect(accessorArray.length).toBe(input.eligibleRevisions.length);

      const nestedTags = [...(input.eligibleRevisions[0].tags ?? [])];
      let nestedAccessorReads = 0;
      Object.defineProperty(nestedTags, "0", {
        configurable: true,
        enumerable: true,
        get() {
          nestedAccessorReads += 1;
          nestedTags.length = HARD_BOUNDS.maxTagsPerRevision + 1;
          return "even";
        },
      });
      const nestedRevision = { ...input.eligibleRevisions[0], tags: nestedTags };
      expect(() => solveProgramSelection({ ...input, eligibleRevisions: [nestedRevision, ...input.eligibleRevisions.slice(1)] })).toThrow(ProgramSelectionSolverError);
      expect(nestedAccessorReads).toBe(0);
      expect(nestedTags.length).toBe(1);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === accessorArray).length).toBeLessThanOrEqual(accessorArray.length + 1);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === nestedTags).length).toBeLessThanOrEqual(nestedTags.length + 1);
    } finally {
      descriptorSpy.mockRestore();
    }
  });

  it("rejects noncanonical bounded-array own properties after inspecting only the own length descriptor", () => {
    const input = base();
    const topLevelHostile = [...input.eligibleRevisions];
    let topLevelMapReads = 0;
    Object.defineProperty(topLevelHostile, "map", {
      configurable: true,
      get() {
        topLevelMapReads += 1;
        return Array.prototype.map;
      },
    });
    Object.defineProperty(topLevelHostile, "custom", { configurable: true, enumerable: true, value: "extra" });

    const nestedHostile = [...input.eligibleRevisions[0].allocationOptions];
    let nestedMapReads = 0;
    Object.defineProperty(nestedHostile, "map", {
      configurable: true,
      get() {
        nestedMapReads += 1;
        return Array.prototype.map;
      },
    });
    Object.defineProperty(nestedHostile, "custom", { configurable: true, enumerable: true, value: "extra" });

    const descriptorSpy = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      invalid({ ...input, eligibleRevisions: topLevelHostile });
      expect(topLevelMapReads).toBe(0);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === topLevelHostile).map(([, key]) => key)).toEqual(["length"]);

      descriptorSpy.mockClear();
      const nestedRevisions = [{ ...input.eligibleRevisions[0], allocationOptions: nestedHostile }, ...input.eligibleRevisions.slice(1)];
      invalid({ ...input, eligibleRevisions: nestedRevisions });
      expect(nestedMapReads).toBe(0);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === nestedHostile).map(([, key]) => key)).toEqual(["length"]);
    } finally {
      descriptorSpy.mockRestore();
    }
  });

  it("rejects genuine arrays with hostile proxy prototypes before any prototype trap", () => {
    const input = base();
    let prototypeTrapCalls = 0;
    const hostilePrototype = new Proxy({}, {
      ownKeys() {
        prototypeTrapCalls += 1;
        return Array.from({ length: 50_000 }, (_, index) => `attacker-${index}`);
      },
      getOwnPropertyDescriptor(target, property) {
        prototypeTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        prototypeTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        prototypeTrapCalls += 1;
        return Reflect.has(target, property);
      },
      getPrototypeOf(target) {
        prototypeTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const hostileArray = [...input.eligibleRevisions];
    Object.setPrototypeOf(hostileArray, hostilePrototype);
    expect(Array.isArray(hostileArray)).toBe(true);

    const rejection = () => {
      try {
        solveProgramSelection({ ...input, eligibleRevisions: hostileArray });
      } catch (error) {
        if (!(error instanceof ProgramSelectionSolverError)) throw error;
        return { name: error.name, code: error.code, message: error.message };
      }
      throw new Error("Expected hostile array prototype rejection.");
    };
    const first = rejection();
    const second = rejection();
    expect(first).toEqual({
      name: "ProgramSelectionSolverError",
      code: "INVALID_SELECTION_SOLVER_INPUT",
      message: "The selection solver input is invalid or exceeds its safety bounds.",
    });
    expect(second).toEqual(first);
    expect(prototypeTrapCalls).toBe(0);

    class NonIntrinsicArray<T> extends Array<T> {}
    const subclassArray = NonIntrinsicArray.from(input.eligibleRevisions);
    expect(Array.isArray(subclassArray)).toBe(true);
    invalid({ ...input, eligibleRevisions: subclassArray });
  });

  it("rejects excess root and nested plain-record keys before unbounded descriptor reads", () => {
    const input = base();
    const extras = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`extra-${index}`, index]));
    const rootWithExtras = { ...input, ...extras };
    const nestedConfiguration = { ...input.configuration, ...extras };
    const nestedWithExtras = { ...input, configuration: nestedConfiguration };
    const descriptorSpy = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      invalid(rootWithExtras);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === rootWithExtras)).toHaveLength(0);

      descriptorSpy.mockClear();
      invalid(nestedWithExtras);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === nestedConfiguration)).toHaveLength(0);
      expect(descriptorSpy.mock.calls.filter(([target]) => target === nestedWithExtras).length).toBeLessThanOrEqual(11);
    } finally {
      descriptorSpy.mockRestore();
    }
  });

  it("rejects 50,000 enumerable record and array properties before materializing own keys", () => {
    const input = base();
    const extras = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [`extra-${index}`, index]));
    const rootWithExtras = { ...input, ...extras };
    const arrayWithExtras = Object.assign([...input.eligibleRevisions], extras);
    const ownKeysSpy = vi.spyOn(Reflect, "ownKeys");
    try {
      invalid(rootWithExtras);
      expect(ownKeysSpy.mock.calls.filter(([target]) => target === rootWithExtras)).toHaveLength(0);

      ownKeysSpy.mockClear();
      invalid({ ...input, eligibleRevisions: arrayWithExtras });
      expect(ownKeysSpy.mock.calls.filter(([target]) => target === arrayWithExtras)).toHaveLength(0);
    } finally {
      ownKeysSpy.mockRestore();
    }
  });

  it("retains full own-key rejection for bounded symbol and non-enumerable excess properties", () => {
    const input = base();
    const recordWithHidden = { ...input };
    Object.defineProperty(recordWithHidden, "hidden", { value: true });
    const recordWithSymbol = { ...input, [Symbol("hidden")]: true };
    const arrayWithHidden = [...input.eligibleRevisions];
    Object.defineProperty(arrayWithHidden, "hidden", { value: true });
    const arrayWithSymbol = Object.assign([...input.eligibleRevisions], { [Symbol("hidden")]: true });

    invalid(recordWithHidden);
    invalid(recordWithSymbol);
    invalid({ ...input, eligibleRevisions: arrayWithHidden });
    invalid({ ...input, eligibleRevisions: arrayWithSymbol });
  });

  it("aggregates and compares exact rational objective values mathematically", () => {
    const input = base();
    const rational: ProgramSelectionSolverInput = {
      ...input, eligibleRevisions: [
        { submissionId: "S1", submissionRevisionId: "five", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "S2", submissionRevisionId: "one", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }], targetCount: 1,
      evaluationFacts: [{ submissionRevisionId: "five", value: 5 }, { submissionRevisionId: "one", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], constraints: [],
      configuration: { maxCandidateSlates: 2, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 100 }] },
    };
    const output = solveProgramSelection(rational);
    expect(output.slates[0].entries.find(entry => entry.disposition === "PROPOSED_SELECTED")!.submissionRevisionId).toBe("five");
    expect(output.slates[0].objectiveTotals[0].value).toEqual({ numerator: "1", denominator: "20" });
    expect(output.slates[1].objectiveTotals[0].value).toEqual({ numerator: "1", denominator: "100" });
  });

  it("emits a complete reproducibility manifest, fingerprint, bounds, configuration, version, and diagnostics", () => {
    const first = solveProgramSelection(base());
    const second = solveProgramSelection(base());
    expect(first.solverVersion).toBe(PROGRAM_SELECTION_SOLVER_VERSION);
    expect(first.bounds).toEqual(HARD_BOUNDS);
    expect(first.inputManifest.deterministicSeed).toBe("seed-1");
    expect(first.fingerprintAlgorithm).toBe("sha256-canonical-json-v1");
    expect(first.configuration.objectives).toHaveLength(4);
    expect(first.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(solveProgramSelection({ ...base(), deterministicSeed: "changed" }).inputFingerprint).not.toBe(first.inputFingerprint);
    expect(first.diagnostics.selectionNodesVisited).toBeGreaterThan(0);
    expect(first.diagnostics.feasibleSelectionsFound).toBeGreaterThanOrEqual(first.slates.length);
    expect(first.diagnostics.rankingSemantics).toContain("NAMED_OBJECTIVES");
  });

  it("rejects unknown enums and missing objective facts rather than inventing scoring semantics", () => {
    const input = base();
    invalid({ ...input, configuration: { objectives: [{ name: "bad", sourceFamily: "OTHER", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] } });
    invalid({ ...input, configuration: { objectives: [{ name: "bad", sourceFamily: "EVALUATION", direction: "SIDEWAYS", weightNumerator: 1, weightDenominator: 1 }] } });
    invalid({ ...input, evaluationFacts: input.evaluationFacts.slice(1) });
    invalid({ ...input, evaluationFacts: [...input.evaluationFacts, { submissionRevisionId: "unknown", value: 1 }] });
    invalid({ ...input, eligibleRevisions: [{ ...input.eligibleRevisions[0], allocationOptions: [{ poolId: "unknown", poolVersionId: "unknown", unitKind: "talk", quantity: 1 }] }] });
    invalid({ ...input, constraints: [{ id: "bad", kind: "UNKNOWN", hard: true }] });
  });

  it("bounds and rejects hostile input before generic cloning or search", () => {
    const input = base();
    invalid({ ...input, configuration: { maxSearchNodes: 1.5 } });
    invalid({ ...input, configuration: { maxCandidateSlates: HARD_BOUNDS.maxCandidateSlates + 1 } });
    invalid({ ...input, pools: Array.from({ length: HARD_BOUNDS.maxPools + 1 }, () => input.pools[0]) });
    invalid({ ...input, pools: [{ ...input.pools[0], remaining: HARD_BOUNDS.maxPoolBalance + 1 }] });
    invalid({ ...input, eligibleRevisions: [{ ...input.eligibleRevisions[0], tags: Array.from({ length: HARD_BOUNDS.maxTagsPerRevision + 1 }, (_, i) => `t${i}`) }] });
    invalid({ ...input, eligibleRevisions: [{ ...input.eligibleRevisions[0], allocationOptions: Array.from({ length: HARD_BOUNDS.maxAllocationOptionsPerRevision + 1 }, () => input.eligibleRevisions[0].allocationOptions[0]) }] });
    invalid({ ...input, eligibleRevisions: [{ ...input.eligibleRevisions[0], allocationOptions: [{ ...input.eligibleRevisions[0].allocationOptions[0], quantity: HARD_BOUNDS.maxAllocationQuantity + 1 }] }] });
    const getter = Object.defineProperty({}, "configuration", { enumerable: true, get: () => { throw new Error("hostile"); } });
    invalid(getter);
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } });
    invalid(proxy);
  });

  it("uses explicit revision identity for contributions, including suffix-collision IDs", () => {
    const input = base();
    const collision: ProgramSelectionSolverInput = {
      ...input, eligibleRevisions: [
        { submissionId: "S1", submissionRevisionId: "P1", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "S2", submissionRevisionId: "XP1", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 2 }], targetCount: 2,
      evaluationFacts: [{ submissionRevisionId: "P1", value: 1 }, { submissionRevisionId: "XP1", value: 2 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], constraints: [],
      configuration: { objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] },
    };
    const entries = solveProgramSelection(collision).slates[0].entries;
    expect(entries.find(entry => entry.submissionRevisionId === "P1")!.objectiveContributions.map(value => value.submissionRevisionId)).toEqual(["P1"]);
    expect(entries.find(entry => entry.submissionRevisionId === "XP1")!.objectiveContributions.map(value => value.submissionRevisionId)).toEqual(["XP1"]);
  });

  it("derives displacement causes from one-for-one alternatives without fabricating replacements", () => {
    const objectiveOutput = solveProgramSelection({ ...base(), configuration: { ...base().configuration, maxCandidateSlates: 1 } });
    expect(objectiveOutput.slates[0].displacedAlternatives.every(value => value.reasonCode === "OBJECTIVE_ORDER" || value.reasonCode === "DETERMINISTIC_TIEBREAK")).toBe(true);
    expect(objectiveOutput.slates[0].displacedAlternatives.every(value => value.includedInsteadSubmissionRevisionId !== null)).toBe(true);
    const hard = base();
    const hardOutput = solveProgramSelection({ ...hard, constraints: [{ id: "exclude-odd", kind: "EXCLUDE_TAG", hard: true, tag: "odd" }], configuration: { ...hard.configuration, maxCandidateSlates: 1 } });
    const odd = hardOutput.slates[0].displacedAlternatives.filter(value => Number(value.displacedSubmissionRevisionId.slice(1)) % 2 === 0);
    expect(odd.every(value => (value.reasonCode === "HARD_CONSTRAINT" || value.reasonCode === "NO_CAUSAL_DISPLACEMENT") && value.includedInsteadSubmissionRevisionId === null)).toBe(true);
    const capacity: ProgramSelectionSolverInput = {
      ...hard, eligibleRevisions: [
        { submissionId: "S1", submissionRevisionId: "blocked", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "S2", submissionRevisionId: "fits", allocationOptions: [{ poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 0 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }], targetCount: 1,
      evaluationFacts: [], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], constraints: [], configuration: { objectives: [] },
    };
    expect(solveProgramSelection(capacity).slates[0].displacedAlternatives[0]).toMatchObject({ displacedSubmissionRevisionId: "blocked", includedInsteadSubmissionRevisionId: null, reasonCode: "CAPACITY" });
  });

  it("claims causality only for better included proposals and handles reversed directions", () => {
    const ranked: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [
        { submissionId: "SA", submissionRevisionId: "A", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SB", submissionRevisionId: "B", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SC", submissionRevisionId: "C", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }], targetCount: 1,
      evaluationFacts: [{ submissionRevisionId: "A", value: 3 }, { submissionRevisionId: "B", value: 2 }, { submissionRevisionId: "C", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [], constraints: [],
      configuration: { maxCandidateSlates: 3, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] },
    };
    const output = solveProgramSelection(ranked);
    expect(output.slates[0].entries.find(entry => entry.disposition === "PROPOSED_SELECTED")!.submissionRevisionId).toBe("A");
    expect(output.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "B")).toMatchObject({ reasonCode: "OBJECTIVE_ORDER", includedInsteadSubmissionRevisionId: "A", relatedObjectiveNames: ["quality"] });
    expect(output.slates[2].entries.find(entry => entry.disposition === "PROPOSED_SELECTED")!.submissionRevisionId).toBe("C");
    expect(output.slates[2].displacedAlternatives.filter(value => value.displacedSubmissionRevisionId !== "C").every(value => value.reasonCode === "NO_CAUSAL_DISPLACEMENT" && value.includedInsteadSubmissionRevisionId === null)).toBe(true);
    const reversed = solveProgramSelection({ ...ranked, evaluationFacts: [{ submissionRevisionId: "A", value: 1 }, { submissionRevisionId: "B", value: 2 }, { submissionRevisionId: "C", value: 3 }], configuration: { ...ranked.configuration, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MINIMIZE", weightNumerator: 1, weightDenominator: 1 }] } });
    expect(reversed.slates[0].entries.find(entry => entry.disposition === "PROPOSED_SELECTED")!.submissionRevisionId).toBe("A");
    expect(reversed.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "B")).toMatchObject({ reasonCode: "OBJECTIVE_ORDER", relatedObjectiveNames: ["quality"] });
  });

  it("reports only the decisive soft constraint or first named objective", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [
        { submissionId: "SA", submissionRevisionId: "A", tags: [], allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SB", submissionRevisionId: "B", tags: ["bad1", "bad2"], allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }], targetCount: 1,
      evaluationFacts: [{ submissionRevisionId: "A", value: 2 }, { submissionRevisionId: "B", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [],
      constraints: [
        { id: "soft-first", kind: "MAX_TAG_COUNT", hard: false, tag: "bad1", limit: 0 },
        { id: "soft-later", kind: "MAX_TAG_COUNT", hard: false, tag: "bad2", limit: 0 },
      ], configuration: { maxCandidateSlates: 1, objectives: [
        { name: "first", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 },
        { name: "later", sourceFamily: "EVALUATION", direction: "MINIMIZE", weightNumerator: 1, weightDenominator: 1 },
      ] },
    };
    const output = solveProgramSelection(input);
    const displacement = output.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "B")!;
    expect(displacement.reasonCode).toBe("SOFT_CONSTRAINT");
    expect(displacement.relatedConstraintIds).toEqual(["soft-first"]);
    expect(displacement.relatedObjectiveNames).toEqual([]);
    const equalSoft = solveProgramSelection({ ...input, eligibleRevisions: input.eligibleRevisions.map(revision => ({ ...revision, tags: ["same"] })), constraints: [{ id: "equal-soft", kind: "MAX_TAG_COUNT", hard: false, tag: "same", limit: 0 }] });
    const equalDisplacement = equalSoft.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "B")!;
    expect(equalDisplacement.reasonCode).toBe("OBJECTIVE_ORDER");
    expect(equalDisplacement.relatedConstraintIds).toEqual([]);
    expect(equalDisplacement.relatedObjectiveNames).toEqual(["first"]);
  });

  it("does not aggregate mixed hard-constraint and capacity failures into a fabricated cause", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [
        { submissionId: "SI1", submissionRevisionId: "I1", allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SI2", submissionRevisionId: "I2", allocationOptions: [{ poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SX", submissionRevisionId: "X", tags: ["excluded"], allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }], targetCount: 2,
      evaluationFacts: [{ submissionRevisionId: "I1", value: 3 }, { submissionRevisionId: "I2", value: 2 }, { submissionRevisionId: "X", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [],
      constraints: [{ id: "exclude-x", kind: "EXCLUDE_TAG", hard: true, tag: "excluded" }], configuration: { maxCandidateSlates: 1, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] },
    };
    const output = solveProgramSelection(input);
    const displacement = output.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "X")!;
    expect(displacement).toMatchObject({ reasonCode: "NO_CAUSAL_DISPLACEMENT", includedInsteadSubmissionRevisionId: null, relatedConstraintIds: [], relatedObjectiveNames: [] });
    expect(displacement.explanation).toContain("mixed hard-constraint and allocation/capacity paths");
    const permuted = solveProgramSelection({ ...input, eligibleRevisions: [...input.eligibleRevisions].reverse(), pools: [...input.pools].reverse() });
    expect(permuted.slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "X")).toEqual(displacement);
  });

  it("reaches HARD_CONSTRAINT only when every existing allocation shares the hard cause", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [
        { submissionId: "SG", submissionRevisionId: "good", allocationOptions: [{ poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SX", submissionRevisionId: "bad", tags: ["excluded"], allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 1 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 1 }], targetCount: 1,
      evaluationFacts: [{ submissionRevisionId: "good", value: 2 }, { submissionRevisionId: "bad", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [],
      constraints: [{ id: "exclude-bad", kind: "EXCLUDE_TAG", hard: true, tag: "excluded" }], configuration: { maxCandidateSlates: 1, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] },
    };
    const displacement = solveProgramSelection(input).slates[0].displacedAlternatives.find(value => value.displacedSubmissionRevisionId === "bad")!;
    expect(displacement).toMatchObject({ reasonCode: "HARD_CONSTRAINT", includedInsteadSubmissionRevisionId: null, relatedConstraintIds: ["exclude-bad"] });
  });

  it("does not collapse distinct hard causes, including under input permutations", () => {
    const input: ProgramSelectionSolverInput = {
      ...base(), eligibleRevisions: [
        { submissionId: "SI1", submissionRevisionId: "I1", tags: ["a"], allocationOptions: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SI2", submissionRevisionId: "I2", tags: ["b"], allocationOptions: [{ poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 }] },
        { submissionId: "SX", submissionRevisionId: "X", tags: ["x"], allocationOptions: [
          { poolId: "A", poolVersionId: "A1", unitKind: "talk", quantity: 1 },
          { poolId: "B", poolVersionId: "B1", unitKind: "talk", quantity: 1 },
        ] },
      ], pools: [{ poolId: "A", poolVersionId: "A1", unitKind: "talk", remaining: 2 }, { poolId: "B", poolVersionId: "B1", unitKind: "talk", remaining: 2 }], targetCount: 2,
      evaluationFacts: [{ submissionRevisionId: "I1", value: 3 }, { submissionRevisionId: "I2", value: 2 }, { submissionRevisionId: "X", value: 1 }], advocacyFacts: [], capacityFacts: [], programObjectiveFacts: [], historicalFacts: [],
      constraints: [
        { id: "x-with-a", kind: "MUTUALLY_EXCLUSIVE_TAGS", hard: true, tags: ["x", "a"] },
        { id: "x-with-b", kind: "MUTUALLY_EXCLUSIVE_TAGS", hard: true, tags: ["x", "b"] },
      ], configuration: { maxCandidateSlates: 1, objectives: [{ name: "quality", sourceFamily: "EVALUATION", direction: "MAXIMIZE", weightNumerator: 1, weightDenominator: 1 }] },
    };
    const solve = (value: ProgramSelectionSolverInput) => solveProgramSelection(value).slates[0].displacedAlternatives.find(displacement => displacement.displacedSubmissionRevisionId === "X")!;
    const displacement = solve(input);
    expect(displacement).toMatchObject({ reasonCode: "NO_CAUSAL_DISPLACEMENT", includedInsteadSubmissionRevisionId: null, relatedConstraintIds: [] });
    expect(displacement.explanation).toContain("distinct hard constraints");
    expect(solve({ ...input, eligibleRevisions: [...input.eligibleRevisions].reverse(), constraints: [...input.constraints].reverse(), pools: [...input.pools].reverse() })).toEqual(displacement);
  });

  it("rejects duplicate constraints and ranks soft violations before named objectives with measured evidence", () => {
    const input = base();
    invalid({ ...input, constraints: [{ id: "same", kind: "REQUIRE_TAG", hard: false, tag: "odd" }, { id: "same", kind: "REQUIRE_TAG", hard: false, tag: "even" }] });
    invalid({ ...input, constraints: [{ id: "irrelevant", kind: "REQUIRE_TAG", hard: false, tag: "odd", limit: 1 }] });
    const output = solveProgramSelection({ ...input, constraints: [{ id: "prefer-even", kind: "MAX_TAG_COUNT", hard: false, tag: "odd", limit: 0 }], configuration: { ...input.configuration, maxCandidateSlates: 1 } });
    expect(output.slates[0].constraintResults[0]).toMatchObject({ constraintId: "prefer-even", hardness: "SOFT", result: "SATISFIED", measuredValue: "0", limitValue: "0" });
    expect(output.slates[0].rankingBasis.softViolationCount).toBe(0);
  });

  it("canonicalizes nested ordering and object property order for byte-identical output", () => {
    const input = base();
    const first = solveProgramSelection(input);
    const reordered: ProgramSelectionSolverInput = {
      ...input,
      pools: [...input.pools].reverse().map(pool => ({ remaining: pool.remaining, unitKind: pool.unitKind, poolVersionId: pool.poolVersionId, poolId: pool.poolId })),
      eligibleRevisions: [...input.eligibleRevisions].reverse().map(revision => ({ allocationOptions: [...revision.allocationOptions].reverse().map(option => ({ quantity: option.quantity, unitKind: option.unitKind, poolVersionId: option.poolVersionId, poolId: option.poolId })), tags: [...(revision.tags ?? [])].reverse(), submissionRevisionId: revision.submissionRevisionId, submissionId: revision.submissionId })),
      evaluationFacts: [...input.evaluationFacts].reverse(), advocacyFacts: [...input.advocacyFacts].reverse(), capacityFacts: [...input.capacityFacts].reverse(), programObjectiveFacts: [...input.programObjectiveFacts].reverse(), historicalFacts: [...(input.historicalFacts ?? [])].reverse(),
      configuration: { ...input.configuration, objectives: [...(input.configuration.objectives ?? [])].reverse() },
    };
    expect(JSON.stringify(solveProgramSelection(reordered))).toBe(JSON.stringify(first));
  });

  it("uses canonical fallback for digest collisions and seed-stable ordering otherwise", () => {
    expect(compareDeterministicTieKeys("same", "a", "same", "b")).toBeLessThan(0);
    expect(compareDeterministicTieKeys("same", "b", "same", "a")).toBeGreaterThan(0);
    const input = base();
    const first = solveProgramSelection({ ...input, configuration: { maxCandidateSlates: 1, objectives: [] } });
    const repeated = solveProgramSelection({ ...input, configuration: { maxCandidateSlates: 1, objectives: [] } });
    const changed = solveProgramSelection({ ...input, deterministicSeed: "seed-2", configuration: { maxCandidateSlates: 1, objectives: [] } });
    expect(JSON.stringify(first)).toBe(JSON.stringify(repeated));
    expect(first.slates[0].content).not.toBe(changed.slates[0].content);
  });

  it("returns typed infeasibility, fails safely on budget exhaustion, and deeply freezes detached output", () => {
    const input = base();
    expect(solveProgramSelection({ ...input, constraints: [{ id: "missing", kind: "REQUIRE_TAG", hard: true, tag: "absent" }] }).status).toBe("INFEASIBLE");
    let primaryBudgetError: unknown;
    try { solveProgramSelection({ ...input, configuration: { ...input.configuration, maxSearchNodes: 1 } }); } catch (error) { primaryBudgetError = error; }
    expect(primaryBudgetError).toMatchObject({ code: "SELECTION_SOLVER_WORK_BUDGET_EXCEEDED" });
    const primaryDiagnostics = (primaryBudgetError as ProgramSelectionSolverError).diagnostics!;
    expect(primaryDiagnostics.primarySearchWorkUnits).toBe(primaryDiagnostics.totalWorkUnits);
    expect(primaryDiagnostics.explanationWorkUnits).toBe(0);
    expect(primaryDiagnostics.totalWorkUnits).toBe(Object.values(primaryDiagnostics.workUnitsByCategory!).reduce((sum, value) => sum + value, 0));
    expect(primaryDiagnostics.primarySearchWorkUnits).toBe(Object.values(primaryDiagnostics.primaryWorkUnitsByCategory!).reduce((sum, value) => sum + value, 0));
    expect(primaryDiagnostics.explanationWorkUnits).toBe(Object.values(primaryDiagnostics.explanationWorkUnitsByCategory!).reduce((sum, value) => sum + value, 0));
    const output = solveProgramSelection(input);
    (input.eligibleRevisions as EligibleRevisionMutable[]).reverse();
    expect(output.inputManifest.input.eligibleRevisions[0].submissionRevisionId).toBe("P1");
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.slates[0].entries)).toBe(true);
  });

  it("meters displacement explanation work globally and fails with diagnostics when explanation cannot finish", () => {
    const baseline = solveProgramSelection(base());
    expect(baseline.diagnostics.explanationWorkUnits).toBeGreaterThan(0);
    expect(baseline.diagnostics.totalWorkUnits).toBe(baseline.diagnostics.primarySearchWorkUnits + baseline.diagnostics.explanationWorkUnits);
    const maxSearchNodes = baseline.diagnostics.totalWorkUnits - 1;
    let caught: unknown;
    try {
      solveProgramSelection({ ...base(), configuration: { ...base().configuration, maxSearchNodes } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProgramSelectionSolverError);
    expect(caught).toMatchObject({ code: "SELECTION_SOLVER_WORK_BUDGET_EXCEEDED" });
    expect((caught as ProgramSelectionSolverError).diagnostics).toMatchObject({ maxSearchNodes, primarySearchWorkUnits: baseline.diagnostics.primarySearchWorkUnits });
    expect((caught as ProgramSelectionSolverError).diagnostics!.explanationWorkUnits).toBeGreaterThan(0);
    expect((caught as ProgramSelectionSolverError).diagnostics!.totalWorkUnits).toBe(maxSearchNodes + 1);
    const explanationDiagnostics = (caught as ProgramSelectionSolverError).diagnostics!;
    expect(explanationDiagnostics.totalWorkUnits).toBe(explanationDiagnostics.primarySearchWorkUnits! + explanationDiagnostics.explanationWorkUnits!);
    expect(explanationDiagnostics.totalWorkUnits).toBe(Object.values(explanationDiagnostics.workUnitsByCategory!).reduce((sum, value) => sum + value, 0));
    expect(explanationDiagnostics.primarySearchWorkUnits).toBe(Object.values(explanationDiagnostics.primaryWorkUnitsByCategory!).reduce((sum, value) => sum + value, 0));
    expect(explanationDiagnostics.explanationWorkUnits).toBe(Object.values(explanationDiagnostics.explanationWorkUnitsByCategory!).reduce((sum, value) => sum + value, 0));
  });
});

type EligibleRevisionMutable = { submissionId: string; submissionRevisionId: string; allocationOptions: SolverAllocationMutable[] };
type SolverAllocationMutable = { poolId: string; poolVersionId: string; unitKind: string; quantity: number };
