import { describe, expect, it } from "vitest";

import {
  ProofGraphValidationError,
  evaluateReadinessProofGraph,
  readinessProofGraphFingerprint,
  validateReadinessProofGraph,
  type AudienceReference,
  type AuthorizedEvidence,
  type AuthorityReference,
  type NextActionKind,
  type ReadinessOutcome,
  type ReadinessProofGraphInput,
  type ReadinessRequirement,
  type SourceFamily,
  type ValidNextAction,
} from "../../src/server/services/readiness-proof-graph";

const scope = Object.freeze({
  workspaceId: "workspace-a",
  eventId: "event-a",
  subjectId: "person-a",
});

function audience(kind: AudienceReference["kind"] = "ORGANIZER"): AudienceReference {
  return {
    kind,
    id: `audience-${kind.toLowerCase()}`,
    version: "v1",
    fingerprint: `audience-fp-${kind.toLowerCase()}`,
  };
}

function authority(
  id: string,
  overrides: Partial<AuthorityReference> = {},
): AuthorityReference {
  return {
    scope,
    kind: "approval",
    id,
    version: "v1",
    fingerprint: `authority-fp-${id}`,
    current: true,
    superseded: false,
    audience: audience(),
    ...overrides,
  };
}

function evidence(
  id: string,
  family: SourceFamily,
  source: AuthorityReference,
  state: AuthorizedEvidence["state"] = "PROVEN",
): AuthorizedEvidence {
  return { id, scope, family, authority: source, state };
}

function action(
  id: string,
  kind: NextActionKind,
  targetRequirementId: string,
): ReadinessRequirement["nextActions"][number] {
  return { id, kind, label: `${kind.toLowerCase()} ${targetRequirementId}`, targetRequirementId };
}

function requirement(
  id: string,
  outcome: ReadinessOutcome,
  sourceFamily: SourceFamily,
  source: AuthorityReference,
  dependsOn: readonly string[] = [],
  nextActions: ReadinessRequirement["nextActions"] = [],
): ReadinessRequirement {
  return {
    id,
    scope,
    outcome,
    label: `Requirement ${id}`,
    sourceFamily,
    authority: source,
    dependsOn,
    nextActions,
  };
}

function graph(
  requirements: readonly ReadinessRequirement[],
  facts: readonly AuthorizedEvidence[] = [],
  limits?: ReadinessProofGraphInput["limits"],
): ReadinessProofGraphInput {
  return { scope, evidence: facts, requirements, ...(limits === undefined ? {} : { limits }) };
}

function expectValidation(code: ProofGraphValidationError["code"], input: ReadinessProofGraphInput): void {
  try {
    evaluateReadinessProofGraph(input);
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProofGraphValidationError);
    expect((error as ProofGraphValidationError).code).toBe(code);
  }
}

function byRequirement(result: ReturnType<typeof evaluateReadinessProofGraph>, id: string) {
  return result.requirements.find((candidate) => candidate.requirementId === id);
}

describe("readiness proof graph core", () => {
  it("evaluates the exact five-outcome chain without collapsing truth layers", () => {
    const offer = authority("approval-1", { kind: "plan-approval" });
    const offerTerms = authority("offer-1", { kind: "commitment-offer" });
    const confirmation = authority("confirmation-1", { kind: "confirmation" });
    const schedule = authority("schedule-1", { kind: "schedule" });
    const release = authority("release-1", { kind: "publication-release" });
    const operator = authority("operator-release-1", { kind: "operator-release" });
    const requirements = [
      requirement("offer", "OFFER", "PLAN_APPROVAL", offer, [], [action("offer-next", "RECORD_CURRENT_APPROVAL", "offer")]),
      requirement("confirmation", "CONFIRMATION", "CONFIRMATION", confirmation, ["offer"], [action("confirmation-next", "CONFIRM_EXACT_OFFER", "confirmation")]),
      requirement("scheduling", "SCHEDULING", "SCHEDULE", schedule, ["confirmation"], [action("schedule-next", "SCHEDULE_EXACT_COMMITMENT", "scheduling")]),
      requirement("publication", "PUBLICATION", "PUBLICATION_RELEASE", release, ["scheduling"], [action("publication-next", "PUBLISH_EXACT_RELEASE", "publication")]),
      requirement("operator-release", "OPERATOR_RELEASE", "OPERATOR_RELEASE", operator, ["publication"], [action("operator-next", "RELEASE_TO_OPERATOR", "operator-release")]),
    ];
    const result = evaluateReadinessProofGraph(
      graph(requirements, [
        evidence("e-offer", "PLAN_APPROVAL", offer),
        evidence("e-offer-terms", "OFFER", offerTerms),
        evidence("e-confirmation", "CONFIRMATION", confirmation),
        evidence("e-schedule", "SCHEDULE", schedule),
        evidence("e-release", "PUBLICATION_RELEASE", release),
        evidence("e-operator", "OPERATOR_RELEASE", operator),
      ]),
    );

    expect(result.status).toBe("READY");
    expect(result.outcomes.map((outcome) => [outcome.outcome, outcome.status])).toEqual([
      ["OFFER", "READY"],
      ["CONFIRMATION", "READY"],
      ["SCHEDULING", "READY"],
      ["PUBLICATION", "READY"],
      ["OPERATOR_RELEASE", "READY"],
    ]);
    expect(result.nextActions).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it("produces the same fingerprint and result for reordered graph input", () => {
    const first = authority("first", { kind: "plan-approval" });
    const second = authority("second", { kind: "schedule" });
    const third = authority("third", { kind: "publication-release" });
    const requirements = [
      requirement("r-first", "OFFER", "PLAN_APPROVAL", first, [], [action("a-first", "RECORD_CURRENT_APPROVAL", "r-first")]),
      requirement("r-second", "SCHEDULING", "SCHEDULE", second, ["r-first"]),
      requirement("r-third", "PUBLICATION", "PUBLICATION_RELEASE", third, ["r-second"]),
    ];
    const facts = [
      evidence("z-fact", "PUBLICATION_RELEASE", third),
      evidence("a-fact", "PLAN_APPROVAL", first),
      evidence("m-fact", "SCHEDULE", second),
    ];
    const original = graph(requirements, facts);
    const reordered = graph(
      [...requirements].reverse().map((candidate) => ({
        ...candidate,
        dependsOn: [...candidate.dependsOn].reverse(),
        nextActions: [...candidate.nextActions].reverse(),
      })),
      [...facts].reverse(),
    );

    expect(readinessProofGraphFingerprint(original)).toBe(readinessProofGraphFingerprint(reordered));
    expect(evaluateReadinessProofGraph(original)).toEqual(evaluateReadinessProofGraph(reordered));
  });

  it("rejects duplicate and conflicting evidence nodes before evaluation", () => {
    const source = authority("same-source", { kind: "plan-approval" });
    const req = requirement("r", "OFFER", "PLAN_APPROVAL", source);
    expectValidation(
      "DUPLICATE_NODE",
      graph([req], [evidence("one", "PLAN_APPROVAL", source), evidence("two", "PLAN_APPROVAL", source)]),
    );

    expectValidation(
      "CONFLICTING_NODE",
      graph(
        [req],
        [
          evidence("one", "PLAN_APPROVAL", source),
          evidence("two", "PLAN_APPROVAL", authority("same-source", { kind: "plan-approval", fingerprint: "different" })),
        ],
      ),
    );

    expectValidation("DUPLICATE_NODE", graph([req, { ...req, label: "different label" }], [evidence("one", "PLAN_APPROVAL", source)]));
  });

  it("requires normalized node IDs to be unique across evidence, requirements, and actions", () => {
    const source = authority("global-id-source", { kind: "plan-approval" });

    expectValidation(
      "DUPLICATE_NODE",
      graph(
        [requirement("é", "OFFER", "PLAN_APPROVAL", source)],
        [evidence("e\u0301", "PLAN_APPROVAL", source)],
      ),
    );

    expectValidation(
      "DUPLICATE_NODE",
      graph(
        [requirement("requirement", "OFFER", "PLAN_APPROVAL", source, [], [action("e\u0301", "RECORD_CURRENT_APPROVAL", "requirement")])],
        [evidence("é", "PLAN_APPROVAL", source)],
      ),
    );

    expectValidation(
      "DUPLICATE_NODE",
      graph([
        requirement("requirement", "OFFER", "PLAN_APPROVAL", source, [], [action("requirement", "RECORD_CURRENT_APPROVAL", "requirement")]),
      ]),
    );
  });

  it("counts next-action nodes against the global maxNodes bound", () => {
    const source = authority("action-node-limit", { kind: "plan-approval" });
    expectValidation(
      "SIZE_LIMIT_EXCEEDED",
      graph(
        [requirement("requirement", "OFFER", "PLAN_APPROVAL", source, [], [
          action("action", "RECORD_CURRENT_APPROVAL", "requirement"),
        ])],
        [],
        { maxNodes: 1 },
      ),
    );

    expect(evaluateReadinessProofGraph(
      graph(
        [requirement("requirement", "OFFER", "PLAN_APPROVAL", source, [], [
          action("action", "RECORD_CURRENT_APPROVAL", "requirement"),
        ])],
        [],
        { maxNodes: 2 },
      ),
    ).nextActions).toEqual([
      action("action", "RECORD_CURRENT_APPROVAL", "requirement"),
    ]);
  });

  it("rejects cyclic dependencies and unknown dependencies", () => {
    const first = authority("cycle-first", { kind: "plan-approval" });
    const second = authority("cycle-second", { kind: "confirmation" });
    const cyclic = [
      requirement("first", "OFFER", "PLAN_APPROVAL", first, ["second"]),
      requirement("second", "CONFIRMATION", "CONFIRMATION", second, ["first"]),
    ];
    expectValidation("CYCLE_DETECTED", graph(cyclic));
    expectValidation(
      "UNKNOWN_DEPENDENCY",
      graph([requirement("first", "OFFER", "PLAN_APPROVAL", first, ["missing"]) ]),
    );
  });

  it("rejects graphs that exceed size, edge, or depth bounds", () => {
    const first = authority("depth-1", { kind: "plan-approval" });
    const second = authority("depth-2", { kind: "confirmation" });
    const third = authority("depth-3", { kind: "schedule" });
    const chain = [
      requirement("one", "OFFER", "PLAN_APPROVAL", first),
      requirement("two", "CONFIRMATION", "CONFIRMATION", second, ["one"]),
      requirement("three", "SCHEDULING", "SCHEDULE", third, ["two"]),
    ];
    expectValidation("DEPTH_LIMIT_EXCEEDED", graph(chain, [], { maxDepth: 2 }));
    expectValidation("SIZE_LIMIT_EXCEEDED", graph(chain, [], { maxRequirementNodes: 2 }));
    expectValidation("SIZE_LIMIT_EXCEEDED", graph(chain, [], { maxEdges: 1 }));

    const actionSource = authority("action-edge", { kind: "plan-approval" });
    expectValidation(
      "SIZE_LIMIT_EXCEEDED",
      graph(
        [requirement("action-requirement", "OFFER", "PLAN_APPROVAL", actionSource, [], [
          action("action-edge-id", "RECORD_CURRENT_APPROVAL", "action-requirement"),
          action("action-edge-id-2", "RECORD_CURRENT_APPROVAL", "action-requirement"),
        ])],
        [],
        { maxEdges: 1 },
      ),
    );
  });

  it("blocks a historical or superseded approval even when the payload is otherwise proven", () => {
    const currentReference = authority("approval-stale", { kind: "plan-approval", version: "v4" });
    const staleReference = authority("approval-stale", {
      kind: "plan-approval",
      version: "v4",
      current: false,
      superseded: true,
    });
    const result = evaluateReadinessProofGraph(
      graph(
        [requirement("offer", "OFFER", "PLAN_APPROVAL", currentReference)],
        [evidence("stale-approval", "PLAN_APPROVAL", staleReference)],
      ),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["SUPERSEDED_AUTHORITY"]);
    expect(result.blockers[0]?.sourceEvidenceIds).toEqual(["stale-approval"]);
  });

  it("distinguishes a missing source family from unknown exact evidence", () => {
    const missing = authority("missing-schedule", { kind: "schedule" });
    const missingResult = evaluateReadinessProofGraph(
      graph([requirement("schedule", "SCHEDULING", "SCHEDULE", missing)]),
    );
    expect(missingResult.status).toBe("UNAVAILABLE");
    expect(missingResult.blockers.map((blocker) => blocker.code)).toEqual(["SOURCE_FAMILY_UNAVAILABLE"]);

    const unknown = authority("unknown-schedule", { kind: "schedule" });
    const unknownResult = evaluateReadinessProofGraph(
      graph(
        [requirement("schedule", "SCHEDULING", "SCHEDULE", unknown)],
        [evidence("unknown-schedule-evidence", "SCHEDULE", unknown, "UNKNOWN")],
      ),
    );
    expect(unknownResult.status).toBe("UNAVAILABLE");
    expect(unknownResult.blockers.map((blocker) => blocker.code)).toEqual(["UNKNOWN_EVIDENCE"]);
  });

  it("keeps missing exact evidence unavailable with unrelated same-family evidence", () => {
    const expected = authority("missing-exact", { kind: "schedule" });
    const unrelated = authority("unrelated-schedule", { kind: "schedule" });
    const result = evaluateReadinessProofGraph(
      graph(
        [requirement("schedule", "SCHEDULING", "SCHEDULE", expected)],
        [evidence("unrelated-schedule-evidence", "SCHEDULE", unrelated)],
      ),
    );

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["MISSING_EXACT_EVIDENCE"]);
    expect(byRequirement(result, "schedule")?.status).toBe("UNAVAILABLE");
  });

  it("rejects audience, version, and fingerprint near-misses instead of inferring equivalence", () => {
    const expected = authority("exact-source", { kind: "publication-release", version: "v7", fingerprint: "expected" });
    const audienceMismatch = authority("exact-source", {
      kind: "publication-release",
      version: "v7",
      fingerprint: "expected",
      audience: audience("PUBLIC"),
    });
    const audienceResult = evaluateReadinessProofGraph(
      graph([requirement("release", "PUBLICATION", "PUBLICATION_RELEASE", expected)], [evidence("wrong-audience", "PUBLICATION_RELEASE", audienceMismatch)]),
    );
    expect(audienceResult.status).toBe("BLOCKED");
    expect(audienceResult.blockers.map((blocker) => blocker.code)).toEqual(["AUDIENCE_MISMATCH"]);

    const versionMismatch = authority("exact-source", { kind: "publication-release", version: "v6", fingerprint: "expected" });
    const versionResult = evaluateReadinessProofGraph(
      graph([requirement("release", "PUBLICATION", "PUBLICATION_RELEASE", expected)], [evidence("wrong-version", "PUBLICATION_RELEASE", versionMismatch)]),
    );
    expect(versionResult.blockers.map((blocker) => blocker.code)).toEqual(["EXACT_VERSION_MISMATCH"]);

    const fingerprintMismatch = authority("exact-source", { kind: "publication-release", version: "v7", fingerprint: "other" });
    const fingerprintResult = evaluateReadinessProofGraph(
      graph([requirement("release", "PUBLICATION", "PUBLICATION_RELEASE", expected)], [evidence("wrong-fingerprint", "PUBLICATION_RELEASE", fingerprintMismatch)]),
    );
    expect(fingerprintResult.blockers.map((blocker) => blocker.code)).toEqual(["EXACT_FINGERPRINT_MISMATCH"]);
  });

  it("reports simultaneous audience, fingerprint, and version mismatch blockers", () => {
    const expected = authority("all-mismatches", {
      kind: "publication-release",
      version: "v7",
      fingerprint: "expected",
    });
    const audienceMismatch = authority("all-mismatches", {
      kind: "publication-release",
      version: "v7",
      fingerprint: "expected",
      audience: audience("PUBLIC"),
    });
    const fingerprintMismatch = authority("all-mismatches", {
      kind: "publication-release",
      version: "v7",
      fingerprint: "other",
    });
    const versionMismatch = authority("all-mismatches", {
      kind: "publication-release",
      version: "v6",
      fingerprint: "expected",
      current: false,
    });
    const result = evaluateReadinessProofGraph(
      graph(
        [requirement("release", "PUBLICATION", "PUBLICATION_RELEASE", expected)],
        [
          evidence("audience-mismatch", "PUBLICATION_RELEASE", audienceMismatch),
          evidence("fingerprint-mismatch", "PUBLICATION_RELEASE", fingerprintMismatch),
          evidence("version-mismatch", "PUBLICATION_RELEASE", versionMismatch),
        ],
      ),
    );

    expect(byRequirement(result, "release")?.status).toBe("BLOCKED");
    expect(byRequirement(result, "release")?.blockers.map((blocker) => blocker.code)).toEqual([
      "AUDIENCE_MISMATCH",
      "EXACT_FINGERPRINT_MISMATCH",
      "EXACT_VERSION_MISMATCH",
    ]);
    expect(byRequirement(result, "release")?.blockers.map((blocker) => blocker.sourceEvidenceIds)).toEqual([
      ["audience-mismatch"],
      ["fingerprint-mismatch"],
      ["version-mismatch"],
    ]);
  });

  it("lets current exact evidence clear only its target and declared dependents", () => {
    const targetAuthority = authority("target", { kind: "plan-input" });
    const dependentAuthority = authority("dependent", { kind: "confirmation" });
    const dependentChildAuthority = authority("dependent-child", { kind: "schedule" });
    const unrelatedAuthority = authority("unrelated", { kind: "plan-approval" });
    const unrelatedMissingAuthority = authority("unrelated-missing", { kind: "plan-approval" });
    const requirements = [
      requirement("target", "OFFER", "PLAN_INPUT", targetAuthority),
      requirement("dependent", "CONFIRMATION", "CONFIRMATION", dependentAuthority, ["target"]),
      requirement("dependent-child", "SCHEDULING", "SCHEDULE", dependentChildAuthority, ["dependent"]),
      requirement("unrelated-ready", "OFFER", "PLAN_APPROVAL", unrelatedAuthority),
      requirement("unrelated-missing", "OFFER", "PLAN_APPROVAL", unrelatedMissingAuthority),
    ];
    const existingEvidence = [
      evidence("dependent-evidence", "CONFIRMATION", dependentAuthority),
      evidence("dependent-child-evidence", "SCHEDULE", dependentChildAuthority),
      evidence("unrelated-evidence", "PLAN_APPROVAL", unrelatedAuthority),
    ];
    const before = evaluateReadinessProofGraph(graph(requirements, existingEvidence));
    const after = evaluateReadinessProofGraph(
      graph(requirements, [...existingEvidence, evidence("target-evidence", "PLAN_INPUT", targetAuthority)]),
    );

    expect(byRequirement(before, "target")?.status).toBe("UNAVAILABLE");
    expect(byRequirement(before, "dependent")?.status).toBe("UNAVAILABLE");
    expect(byRequirement(before, "dependent-child")?.status).toBe("UNAVAILABLE");
    expect(byRequirement(before, "unrelated-ready")?.status).toBe("READY");
    expect(byRequirement(before, "unrelated-missing")?.status).toBe("UNAVAILABLE");

    expect(byRequirement(after, "target")?.status).toBe("READY");
    expect(byRequirement(after, "dependent")?.status).toBe("READY");
    expect(byRequirement(after, "dependent-child")?.status).toBe("READY");
    expect(byRequirement(after, "unrelated-ready")?.status).toBe("READY");
    expect(byRequirement(after, "unrelated-missing")?.status).toBe("UNAVAILABLE");
    expect(byRequirement(after, "unrelated-missing")?.blockers.map((blocker) => blocker.code)).toEqual([
      "MISSING_EXACT_EVIDENCE",
    ]);
  });

  it("rejects next actions that cannot apply to the requirement outcome", () => {
    const source = authority("offer-action", { kind: "plan-approval" });
    expectValidation(
      "INVALID_NEXT_ACTION",
      graph([
        requirement("offer", "OFFER", "PLAN_APPROVAL", source, [], [
          action("bad-action", "PUBLISH_EXACT_RELEASE", "offer"),
        ]),
      ]),
    );
    expectValidation(
      "INVALID_NEXT_ACTION",
      graph([
        requirement("offer", "OFFER", "PLAN_APPROVAL", source, [], [
          action("wrong-target", "RECORD_CURRENT_APPROVAL", "different-requirement"),
        ]),
      ]),
    );
  });

  it("rejects cross-workspace evidence and authority references", () => {
    const source = authority("cross-scope", { kind: "plan-approval" });
    const foreignScope = { ...scope, workspaceId: "workspace-b" };
    expectValidation(
      "CROSS_SCOPE_REFERENCE",
      graph([
        requirement("offer", "OFFER", "PLAN_APPROVAL", source),
      ], [
        { ...evidence("foreign", "PLAN_APPROVAL", source), scope: foreignScope, authority: { ...source, scope: foreignScope } },
      ]),
    );

    expectValidation(
      "CROSS_SCOPE_REFERENCE",
      graph([
        requirement("offer", "OFFER", "PLAN_APPROVAL", { ...source, scope: foreignScope }),
      ]),
    );
  });

  it("returns every independent blocker while separately exposing minimal blockers", () => {
    const first = authority("missing-first", { kind: "plan-approval" });
    const second = authority("missing-second", { kind: "schedule" });
    const result = evaluateReadinessProofGraph(
      graph([
        requirement("first", "OFFER", "PLAN_APPROVAL", first),
        requirement("second", "SCHEDULING", "SCHEDULE", second),
      ]),
    );

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.blockers.map((blocker) => blocker.requirementId)).toEqual(["first", "second"]);
    expect(result.minimalBlockers.map((blocker) => blocker.requirementId)).toEqual(["first", "second"]);
    expect(result.requirements.every((candidate) => candidate.blockers.length > 0)).toBe(true);
  });

  it("keeps delimiter-bearing dependency blockers distinct with a canonical structured key", () => {
    const result = evaluateReadinessProofGraph(
      graph([
        requirement("b:c", "OFFER", "PLAN_APPROVAL", authority("authority-b-c", { kind: "plan-approval" })),
        requirement("c", "OFFER", "PLAN_APPROVAL", authority("authority-c", { kind: "plan-approval" })),
        requirement("a", "CONFIRMATION", "CONFIRMATION", authority("authority-a", { kind: "confirmation" }), ["b:c"]),
        requirement("a:b", "CONFIRMATION", "CONFIRMATION", authority("authority-a-b", { kind: "confirmation" }), ["c"]),
      ]),
    );
    const dependencyBlockers = result.blockers.filter((blocker) => blocker.code === "DEPENDENCY_UNAVAILABLE");

    expect(dependencyBlockers).toHaveLength(2);
    expect(new Set(dependencyBlockers.map((blocker) => blocker.id)).size).toBe(2);
    expect(new Set(dependencyBlockers.map((blocker) => blocker.dependencyRequirementId))).toEqual(new Set(["b:c", "c"]));
  });

  it("deduplicates inherited blocker evidence IDs without losing dependency receipts", () => {
    const expected = authority("root-expected", { kind: "schedule" });
    const unrelated = authority("root-unrelated", { kind: "schedule" });
    const requirements = [
      requirement("root", "SCHEDULING", "SCHEDULE", expected),
      requirement("branch-a", "CONFIRMATION", "CONFIRMATION", authority("branch-a-authority", { kind: "confirmation" }), ["root"]),
      requirement("branch-b", "CONFIRMATION", "CONFIRMATION", authority("branch-b-authority", { kind: "confirmation" }), ["root"]),
      requirement("join", "PUBLICATION", "PUBLICATION_RELEASE", authority("join-authority", { kind: "publication-release" }), ["branch-a", "branch-b"]),
    ];
    const result = evaluateReadinessProofGraph(
      graph(requirements, [evidence("root-unrelated-evidence", "SCHEDULE", unrelated)]),
    );
    const join = byRequirement(result, "join");

    const joinDependencyBlockers = join?.blockers.filter(
      (blocker) => blocker.code === "DEPENDENCY_UNAVAILABLE" &&
        (blocker.dependencyRequirementId === "branch-a" || blocker.dependencyRequirementId === "branch-b"),
    ) ?? [];
    expect(joinDependencyBlockers).toHaveLength(2);
    expect(join?.blockers.some((blocker) => blocker.requirementId === "root")).toBe(true);
    for (const blocker of result.blockers) {
      expect(new Set(blocker.sourceEvidenceIds).size).toBe(blocker.sourceEvidenceIds.length);
    }
    expect(joinDependencyBlockers.map((blocker) => blocker.sourceEvidenceIds)).toEqual([
      ["root-unrelated-evidence"],
      ["root-unrelated-evidence"],
    ]);

    const secondUnrelated = authority("root-second-unrelated", { kind: "schedule" });
    expectValidation(
      "SIZE_LIMIT_EXCEEDED",
      graph(
        [requirement("root", "SCHEDULING", "SCHEDULE", expected)],
        [
          evidence("root-unrelated-evidence", "SCHEDULE", unrelated),
          evidence("root-second-unrelated-evidence", "SCHEDULE", secondUnrelated),
        ],
        { maxEvidenceIdsPerBlocker: 1 },
      ),
    );
  });

  it("fails closed before emitting unbounded receipts for a depth-and-branching graph", () => {
    const width = 4;
    const depth = 10;
    const requirements: ReadinessRequirement[] = [];
    for (let level = 0; level < depth; level += 1) {
      for (let branch = 0; branch < width; branch += 1) {
        requirements.push(
          requirement(
            `level-${level}-${branch}`,
            "OFFER",
            "PLAN_APPROVAL",
            authority(`level-authority-${level}-${branch}`, { kind: "plan-approval" }),
            level === 0
              ? []
              : Array.from({ length: width }, (_, dependencyBranch) =>
                `level-${level - 1}-${dependencyBranch}`),
          ),
        );
      }
    }

    expectValidation(
      "SIZE_LIMIT_EXCEEDED",
      graph(requirements, [], { maxBlockerReceipts: 256 }),
    );
  });

  it("snapshots graph data before binding actions and rejects inaccessible input", () => {
    const source = authority("snapshot-source", { kind: "plan-approval" });
    const stableRequirement = requirement(
      "stable-requirement",
      "OFFER",
      "PLAN_APPROVAL",
      source,
      [],
      [action("stable-action", "RECORD_CURRENT_APPROVAL", "stable-requirement")],
    );
    let proxyIdReads = 0;
    const changingProxy = new Proxy(stableRequirement, {
      get(target, property, receiver) {
        if (property === "id") {
          proxyIdReads += 1;
          return proxyIdReads % 2 === 1 ? "stable-requirement" : "changed-requirement";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const changingInput = graph([changingProxy]);
    const validated = validateReadinessProofGraph(changingInput);
    const evaluated = evaluateReadinessProofGraph(changingInput);

    expect(proxyIdReads).toBe(0);
    expect(validated.requirements[0]?.id).toBe("stable-requirement");
    expect(validated.requirements[0]?.nextActions[0]?.targetRequirementId).toBe("stable-requirement");
    expect(evaluated.requirements[0]?.requirementId).toBe("stable-requirement");
    expect(evaluated.nextActions[0]?.targetRequirementId).toBe("stable-requirement");

    let getterReads = 0;
    const inaccessibleRequirement = requirement(
      "inaccessible-requirement",
      "OFFER",
      "PLAN_APPROVAL",
      source,
      [],
      [action("inaccessible-action", "RECORD_CURRENT_APPROVAL", "inaccessible-requirement")],
    );
    Object.defineProperty(inaccessibleRequirement, "id", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "getter-requirement";
      },
    });
    expectValidation("INVALID_REQUIREMENT", graph([inaccessibleRequirement]));
    expect(getterReads).toBe(0);

    const revoked = Proxy.revocable(graph([stableRequirement]), {});
    revoked.revoke();
    expectValidation("INVALID_INPUT", revoked.proxy as ReadinessProofGraphInput);
  });

  it("deep-freezes output and does not retain mutable input references", () => {
    const source = authority("freeze-source", { kind: "plan-approval" });
    const input = graph(
      [requirement("offer", "OFFER", "PLAN_APPROVAL", source, [], [action("supply", "SUPPLY_CURRENT_EVIDENCE", "offer")])],
      [evidence("freeze-evidence", "PLAN_APPROVAL", source, "UNKNOWN")],
    );
    const result = evaluateReadinessProofGraph(input);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scope)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence[0])).toBe(true);
    expect(Object.isFrozen(result.evidence[0]?.authority)).toBe(true);
    expect(Object.isFrozen(result.requirements)).toBe(true);
    expect(Object.isFrozen(result.requirements[0]?.blockers)).toBe(true);
    expect(Object.isFrozen(result.requirements[0]?.blockers[0]?.authority)).toBe(true);
    expect(Object.isFrozen(result.nextActions)).toBe(true);

    expect(() => {
      (result as { status: string }).status = "READY";
    }).toThrow();
    expect(() => {
      (result.nextActions as ValidNextAction[]).push(action("another", "SUPPLY_CURRENT_EVIDENCE", "offer"));
    }).toThrow();
    expect(result.evidence[0]?.authority.id).toBe("freeze-source");
  });
});
