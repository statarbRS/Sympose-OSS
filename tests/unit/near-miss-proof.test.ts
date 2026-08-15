import { describe, expect, it } from "vitest";

import {
  createNearMissConflictEvidence,
  createNearMissEligibilityEvidence,
  createNearMissPurposeAuthorization,
  createNearMissRetentionEvidence,
  hasNearMissAuthorityCarryForward,
  isNearMissProofQualified,
  nearMissFingerprintOf,
  proveNearMiss,
} from "../../src/server/services/near-miss-proof";

const evaluatedAt = "2026-08-13T12:00:00.000Z";
const evidenceExpiresAt = "2026-08-13T13:00:00.000Z";
const purpose = "PROGRAM_SELECTION";

const proposalLineage = {
  proposalId: "proposal-1",
  revisionId: "proposal-revision-1",
  lineageId: "lineage-1",
  fingerprint: "1".repeat(64),
} as const;

const targetCall = {
  callId: "call-1",
  versionId: "call-version-1",
  fingerprint: "2".repeat(64),
} as const;

const scope = {
  workspaceId: "workspace-1",
  eventId: "event-1",
  candidateId: "person-1",
  targetCallId: targetCall.callId,
  targetCallVersionId: targetCall.versionId,
  purpose,
} as const;

const purposeAuthorizationInput = {
  status: "AUTHORIZED" as const,
  purpose,
  scope,
  evaluatedAt,
  expiresAt: evidenceExpiresAt,
  withdrawnAt: null,
};

const retentionInput = {
  status: "CURRENT" as const,
  purpose,
  scope,
  evaluatedAt,
  expiresAt: evidenceExpiresAt,
  withdrawnAt: null,
};

const eligibilityInput = {
  status: "ELIGIBLE" as const,
  current: true,
  scope,
  evaluatedAt,
  expiresAt: evidenceExpiresAt,
};

const conflictsInput = {
  status: "CLEAR" as const,
  current: true,
  scope,
  evaluatedAt,
  expiresAt: evidenceExpiresAt,
  conflictIds: [] as const,
};

function purposeEvidence(overrides: Record<string, unknown> = {}) {
  return createNearMissPurposeAuthorization({ ...purposeAuthorizationInput, ...overrides });
}

function retentionEvidence(overrides: Record<string, unknown> = {}) {
  return createNearMissRetentionEvidence({ ...retentionInput, ...overrides });
}

function eligibilityEvidence(overrides: Record<string, unknown> = {}) {
  return createNearMissEligibilityEvidence({ ...eligibilityInput, ...overrides });
}

function conflictEvidence(overrides: Record<string, unknown> = {}) {
  return createNearMissConflictEvidence({ ...conflictsInput, ...overrides });
}

const purposeAuthorization = purposeEvidence();
const retention = retentionEvidence();
const capacity = {
  status: "CURRENT" as const,
  unitKind: "SEAT",
  poolId: "pool-1",
  versionId: "pool-version-1",
  ledgerFingerprint: "4".repeat(64),
};
const eligibility = eligibilityEvidence();
const conflicts = conflictEvidence();

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    type: "SELECTION_RECEIPT",
    receiptId: "receipt-1",
    candidateId: "person-1",
    disposition: "CAPACITY_DISPLACED",
    proposalLineage,
    targetCall,
    purpose,
    scope,
    purposeAuthorizationFingerprint: purposeAuthorization.fingerprint,
    retentionFingerprint: retention.fingerprint,
    capacity,
    eligibility,
    conflicts,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "person-1",
    purpose,
    scope,
    proposalLineage,
    targetCall,
    purposeAuthorization,
    retention,
    capacity,
    eligibility,
    conflicts,
    evaluatedAt,
    priorSelectionReceipts: [receipt()],
    ...overrides,
  };
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

describe("near-miss proof core", () => {
  it("qualifies only an explicit capacity-displaced receipt and binds all current evidence", () => {
    const proof = proveNearMiss(request());

    expect(proof.status).toBe("OBSERVED_NOT_RESERVED");
    expect(proof.qualified).toBe(true);
    expect(isNearMissProofQualified(proof)).toBe(true);
    expect(proof.blockers).toEqual([]);
    expect(proof.evidence).toMatchObject({
      receiptId: "receipt-1",
      purpose,
      evaluatedAt,
      scope,
      purposeAuthorizationFingerprint: purposeAuthorization.fingerprint,
      retentionFingerprint: retention.fingerprint,
      eligibilityFingerprint: eligibility.fingerprint,
      conflictFingerprint: conflicts.fingerprint,
    });
    expect(proof).not.toHaveProperty("reserved");
    expect(proof).not.toHaveProperty("selected");
    expect(proof).not.toHaveProperty("invited");
    expect(proof).not.toHaveProperty("contact");
  });

  it("rejects generic cohort and solver losers without explicit selection receipt evidence", () => {
    const generic = proveNearMiss(request({
      priorSelectionReceipts: [{
        ...receipt(),
        type: "COHORT_LOSER",
        disposition: "SOLVER_LOSER",
      }],
    }));

    expect(generic.qualified).toBe(false);
    expect(generic.blockers).toContain("EXPLICIT_SELECTION_RECEIPT_REQUIRED");
    expect(generic.blockers).toContain("DISPOSITION_NOT_CAPACITY_NEAR_MISS");

    const wrongDisposition = proveNearMiss(request({
      priorSelectionReceipts: [receipt({ disposition: "COHORT_LOSER" })],
    }));
    expect(wrongDisposition.qualified).toBe(false);
    expect(wrongDisposition.blockers).toContain("DISPOSITION_NOT_CAPACITY_NEAR_MISS");
  });

  it("fails closed for stale capacity, unit/pool/version mismatch, and target mismatch", () => {
    const staleLedger = proveNearMiss(request({
      capacity: { ...capacity, ledgerFingerprint: "9".repeat(64) },
    }));
    expect(staleLedger.qualified).toBe(false);
    expect(staleLedger.blockers).toContain("CAPACITY_REFERENCE_MISMATCH");

    const unitMismatch = proveNearMiss(request({
      capacity: { ...capacity, unitKind: "MINUTES" },
    }));
    expect(unitMismatch.blockers).toContain("CAPACITY_REFERENCE_MISMATCH");

    const staleStatus = proveNearMiss(request({
      capacity: { ...capacity, status: "STALE" },
    }));
    expect(staleStatus.blockers).toContain("CAPACITY_LEDGER_STALE");

    const targetMismatch = proveNearMiss(request({
      targetCall: { ...targetCall, callId: "call-other" },
    }));
    expect(targetMismatch.qualified).toBe(false);
    expect(targetMismatch.blockers).toContain("TARGET_CALL_MISMATCH");
    expect(targetMismatch.blockers).toContain("PROOF_SCOPE_TARGET_MISMATCH");
  });

  it("never synthesizes retention, target, capacity, eligibility, or conflict evidence", () => {
    const missingRetention = request();
    delete (missingRetention as Record<string, unknown>).retention;
    const noRetention = proveNearMiss(missingRetention);
    expect(noRetention.qualified).toBe(false);
    expect(noRetention.blockers).toContain("RETENTION_EVIDENCE_REQUIRED");

    const missingEvidenceCases = [
      {
        name: "unversioned target",
        overrides: { targetCall: "call-1" },
        blocker: "TARGET_CALL_UNAVAILABLE",
      },
      {
        name: "capacity without status",
        overrides: { capacity: { unitKind: "SEAT", poolId: "pool-1", versionId: "pool-version-1", ledgerFingerprint: "4".repeat(64) } },
        blocker: "CAPACITY_REFERENCE_UNKNOWN",
      },
      {
        name: "eligibility boolean",
        overrides: { eligibility: true },
        blocker: "ELIGIBILITY_UNVERIFIED",
      },
      {
        name: "conflict array",
        overrides: { conflicts: [] },
        blocker: "CONFLICTS_UNVERIFIED",
      },
      {
        name: "conflict object without fingerprint",
        overrides: { conflicts: { ...conflictsInput } },
        blocker: "CONFLICTS_UNVERIFIED",
      },
    ] as const;

    for (const testCase of missingEvidenceCases) {
      const proof = proveNearMiss(request(testCase.overrides));
      expect(proof.qualified, testCase.name).toBe(false);
      expect(proof.blockers, testCase.name).toContain(testCase.blocker);
    }

    const invalidReceipt = proveNearMiss(request({
      priorSelectionReceipts: [receipt({ conflicts: { ...conflictsInput } })],
    }));
    expect(invalidReceipt.qualified).toBe(false);
    expect(invalidReceipt.blockers).toContain("SELECTION_RECEIPT_INVALID");
  });

  it("requires current explicit eligibility and conflict evidence", () => {
    const ineligible = eligibilityEvidence({ status: "INELIGIBLE" });
    const ineligibleProof = proveNearMiss(request({ eligibility: ineligible }));
    expect(ineligibleProof.qualified).toBe(false);
    expect(ineligibleProof.blockers).toContain("CANDIDATE_NOT_ELIGIBLE");

    const conflicted = conflictEvidence({ status: "CONFLICTED", conflictIds: ["conflict-1"] });
    const conflictedProof = proveNearMiss(request({ conflicts: conflicted }));
    expect(conflictedProof.qualified).toBe(false);
    expect(conflictedProof.blockers).toContain("CURRENT_CONFLICTS_PRESENT");
  });

  it("fails closed for unknown, expired, withdrawn, or wrong-purpose authorization", () => {
    for (const authorization of [
      purposeEvidence({ status: "UNKNOWN" }),
      purposeEvidence({ status: "EXPIRED" }),
      purposeEvidence({ expiresAt: "2026-08-13T11:59:59.000Z" }),
      purposeEvidence({ status: "WITHDRAWN", withdrawnAt: "2026-08-13T11:00:00.000Z" }),
      purposeEvidence({ purpose: "PUBLIC_DIRECTORY" }),
    ]) {
      const proof = proveNearMiss(request({ purposeAuthorization: authorization }));
      expect(proof.status).toBe("OBSERVED_NOT_RESERVED");
      expect(proof.qualified).toBe(false);
    }
    expect(proveNearMiss(request({ purposeAuthorization: purposeEvidence({ status: "WITHDRAWN" }) })).blockers)
      .toContain("PURPOSE_AUTHORIZATION_WITHDRAWN");
    expect(proveNearMiss(request({ purposeAuthorization: purposeEvidence({ status: "EXPIRED" }) })).blockers)
      .toContain("PURPOSE_AUTHORIZATION_EXPIRED");
    expect(proveNearMiss(request({ purposeAuthorization: purposeEvidence({ purpose: "PUBLIC_DIRECTORY" }) })).blockers)
      .toContain("PURPOSE_AUTHORIZATION_PURPOSE_MISMATCH");
  });

  it("requires current, unexpired, exact-purpose retention evidence", () => {
    const expired = proveNearMiss(request({
      retention: retentionEvidence({ expiresAt: "2026-08-13T11:59:59.000Z" }),
    }));
    expect(expired.qualified).toBe(false);
    expect(expired.blockers).toContain("RETENTION_EXPIRED");

    const withdrawn = proveNearMiss(request({
      retention: retentionEvidence({ status: "WITHDRAWN", withdrawnAt: "2026-08-13T11:00:00.000Z" }),
    }));
    expect(withdrawn.blockers).toContain("RETENTION_WITHDRAWN");
    expect(withdrawn.blockers).toContain("RETENTION_NOT_CURRENT");

    const wrongPurpose = proveNearMiss(request({
      retention: retentionEvidence({ purpose: "PUBLIC_DIRECTORY" }),
    }));
    expect(wrongPurpose.blockers).toContain("RETENTION_PURPOSE_MISMATCH");
  });

  it("rejects non-current, stale-timestamp, expired, and cross-scope eligibility/conflict evidence", () => {
    const evidenceCases = [
      {
        name: "eligibility current false",
        overrides: { eligibility: eligibilityEvidence({ current: false }) },
        blocker: "ELIGIBILITY_NOT_CURRENT",
      },
      {
        name: "eligibility stale evaluation",
        overrides: { eligibility: eligibilityEvidence({ evaluatedAt: "2000-01-01T00:00:00.000Z" }) },
        blocker: "ELIGIBILITY_EVALUATION_TIME_MISMATCH",
      },
      {
        name: "eligibility expired",
        overrides: { eligibility: eligibilityEvidence({ expiresAt: "2026-08-13T11:59:59.000Z" }) },
        blocker: "ELIGIBILITY_EVIDENCE_EXPIRED",
      },
      {
        name: "eligibility wrong workspace",
        overrides: { eligibility: eligibilityEvidence({ scope: { ...scope, workspaceId: "workspace-2" } }) },
        blocker: "ELIGIBILITY_SCOPE_MISMATCH",
      },
      {
        name: "conflicts current false",
        overrides: { conflicts: conflictEvidence({ current: false }) },
        blocker: "CONFLICTS_NOT_CURRENT",
      },
      {
        name: "conflicts stale evaluation",
        overrides: { conflicts: conflictEvidence({ evaluatedAt: "2000-01-01T00:00:00.000Z" }) },
        blocker: "CONFLICT_EVALUATION_TIME_MISMATCH",
      },
      {
        name: "conflicts expired",
        overrides: { conflicts: conflictEvidence({ expiresAt: "2026-08-13T11:59:59.000Z" }) },
        blocker: "CONFLICT_EVIDENCE_EXPIRED",
      },
      {
        name: "conflicts wrong event",
        overrides: { conflicts: conflictEvidence({ scope: { ...scope, eventId: "event-2" } }) },
        blocker: "CONFLICT_SCOPE_MISMATCH",
      },
    ] as const;

    for (const testCase of evidenceCases) {
      const proof = proveNearMiss(request(testCase.overrides));
      expect(proof.qualified, testCase.name).toBe(false);
      expect(proof.blockers, testCase.name).toContain(testCase.blocker);
    }
  });

  it("binds purpose and evidence fingerprints into distinct immutable proofs", () => {
    const publicPurpose = "PUBLIC_DIRECTORY";
    const publicScope = { ...scope, purpose: publicPurpose };
    const publicAuthorization = createNearMissPurposeAuthorization({
      ...purposeAuthorizationInput,
      purpose: publicPurpose,
      scope: publicScope,
    });
    const publicRetention = createNearMissRetentionEvidence({
      ...retentionInput,
      purpose: publicPurpose,
      scope: publicScope,
    });
    const publicEligibility = createNearMissEligibilityEvidence({ ...eligibilityInput, scope: publicScope });
    const publicConflicts = createNearMissConflictEvidence({ ...conflictsInput, scope: publicScope });
    const publicReceipt = receipt({
      purpose: publicPurpose,
      scope: publicScope,
      purposeAuthorizationFingerprint: publicAuthorization.fingerprint,
      retentionFingerprint: publicRetention.fingerprint,
      eligibility: publicEligibility,
      conflicts: publicConflicts,
    });
    const publicProof = proveNearMiss(request({
      purpose: publicPurpose,
      scope: publicScope,
      purposeAuthorization: publicAuthorization,
      retention: publicRetention,
      eligibility: publicEligibility,
      conflicts: publicConflicts,
      priorSelectionReceipts: [publicReceipt],
    }));
    const programProof = proveNearMiss(request());

    expect(publicProof.qualified).toBe(true);
    expect(programProof.qualified).toBe(true);
    expect(publicProof.proofFingerprint).not.toBe(programProof.proofFingerprint);
    expect(publicProof.evidence.purpose).toBe(publicPurpose);

    const forgedAuthorization = { ...publicAuthorization, fingerprint: purposeAuthorization.fingerprint };
    const forged = proveNearMiss(request({
      purpose: publicPurpose,
      scope: publicScope,
      purposeAuthorization: forgedAuthorization,
      retention: publicRetention,
      eligibility: publicEligibility,
      conflicts: publicConflicts,
      priorSelectionReceipts: [publicReceipt],
    }));
    expect(forged.qualified).toBe(false);
    expect(forged.blockers).toContain("PURPOSE_AUTHORIZATION_UNKNOWN");

    const tamperedProof = {
      ...programProof,
      evidence: { ...programProof.evidence, purpose: publicPurpose },
    };
    expect(isNearMissProofQualified(tamperedProof)).toBe(false);
    expect(isNearMissProofQualified({
      ...programProof,
      evidence: {
        ...programProof.evidence,
        capacity: { ...programProof.evidence.capacity, authority: "organizer" },
      },
    })).toBe(false);
  });

  it("rejects getter-backed and Proxy evidence without invoking accessors or toJSON", () => {
    let getterReads = 0;
    const getterEligibility = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries(eligibility)) {
      Object.defineProperty(getterEligibility, key, {
        enumerable: true,
        get() {
          getterReads += 1;
          return value;
        },
      });
    }
    const getterProof = proveNearMiss(request({ eligibility: getterEligibility }));
    expect(getterProof.qualified).toBe(false);
    expect(getterProof.blockers).toContain("NEAR_MISS_INPUT_NOT_JSON");
    expect(getterReads).toBe(0);

    let toJsonCalls = 0;
    const proxyEligibility = new Proxy({ ...eligibility }, {
      get(source, property, receiver) {
        if (property === "toJSON") {
          return () => {
            toJsonCalls += 1;
            return { ...eligibility, status: "ELIGIBLE", current: true };
          };
        }
        return Reflect.get(source, property, receiver);
      },
    });
    const proxyProof = proveNearMiss(request({ eligibility: proxyEligibility }));
    expect(proxyProof.qualified).toBe(false);
    expect(proxyProof.blockers).toContain("NEAR_MISS_INPUT_PROXY_FORBIDDEN");
    expect(toJsonCalls).toBe(0);
  });

  it("requires own plain descriptors for requests and qualified proofs without inherited reads", () => {
    const validRequest = request();
    const inheritedRequest = probeInheritedGetters(validRequest, () => proveNearMiss({}));
    expect(inheritedRequest.error).toBeUndefined();
    expect(inheritedRequest.reads).toBe(0);
    expect(inheritedRequest.value?.qualified).toBe(false);
    expect(inheritedRequest.value?.blockers).toContain("CANDIDATE_REFERENCE_UNKNOWN");

    const validProof = proveNearMiss(validRequest);
    const inheritedProof = probeInheritedGetters(
      validProof as unknown as Readonly<Record<string, unknown>>,
      () => isNearMissProofQualified({}),
    );
    expect(inheritedProof.error).toBeUndefined();
    expect(inheritedProof.reads).toBe(0);
    expect(inheritedProof.value).toBe(false);

    const inheritedScope = { ...scope } as Record<string, unknown>;
    Reflect.deleteProperty(inheritedScope, "workspaceId");
    const nestedInheritedScope = probeInheritedGetters({ workspaceId: scope.workspaceId }, () =>
      proveNearMiss(request({ scope: inheritedScope })));
    expect(nestedInheritedScope.error).toBeUndefined();
    expect(nestedInheritedScope.reads).toBe(0);
    expect(nestedInheritedScope.value?.qualified).toBe(false);
    expect(nestedInheritedScope.value?.blockers).toContain("PROOF_SCOPE_UNKNOWN");

    let prototypeGetterReads = 0;
    const customScopePrototype = {};
    Object.defineProperty(customScopePrototype, "workspaceId", {
      get() {
        prototypeGetterReads += 1;
        return scope.workspaceId;
      },
    });
    const customScope = Object.assign(Object.create(customScopePrototype), {
      eventId: scope.eventId,
      candidateId: scope.candidateId,
      targetCallId: scope.targetCallId,
      targetCallVersionId: scope.targetCallVersionId,
      purpose: scope.purpose,
    });
    const customPrototypeProof = proveNearMiss(request({ scope: customScope }));
    expect(customPrototypeProof.qualified).toBe(false);
    expect(customPrototypeProof.blockers).toContain("NEAR_MISS_INPUT_NOT_JSON");
    expect(prototypeGetterReads).toBe(0);

    let proxyTrapCalls = 0;
    const proxyHandler: ProxyHandler<object> = {
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
    };
    const proxyRequestProof = proveNearMiss(new Proxy(validRequest, proxyHandler));
    expect(proxyRequestProof.qualified).toBe(false);
    expect(proxyRequestProof.blockers).toContain("NEAR_MISS_INPUT_PROXY_FORBIDDEN");
    expect(isNearMissProofQualified(new Proxy(validProof, proxyHandler))).toBe(false);
    expect(proxyTrapCalls).toBe(0);

    const alteredReceipts = [receipt()];
    Object.setPrototypeOf(alteredReceipts, Object.create(Array.prototype));
    const alteredArrayProof = proveNearMiss(request({ priorSelectionReceipts: alteredReceipts }));
    expect(alteredArrayProof.qualified).toBe(false);
    expect(alteredArrayProof.blockers).toContain("NEAR_MISS_INPUT_NOT_JSON");

    const sparseReceipts = new Array(1);
    const sparseArrayProof = proveNearMiss(request({ priorSelectionReceipts: sparseReceipts }));
    expect(sparseArrayProof.qualified).toBe(false);
    expect(sparseArrayProof.blockers).toContain("NEAR_MISS_INPUT_NOT_JSON");

    const cyclicRequest = request() as Record<string, unknown>;
    cyclicRequest.cycle = cyclicRequest;
    expect(proveNearMiss(cyclicRequest).blockers).toContain("NEAR_MISS_INPUT_CYCLE");
    expect(proveNearMiss(request({ eligibility: () => eligibility })).blockers)
      .toContain("NEAR_MISS_INPUT_NOT_JSON");

    const unchanged = proveNearMiss(request());
    expect(unchanged.qualified).toBe(true);
    expect(isNearMissProofQualified(unchanged)).toBe(true);
  });

  it("requires exact proposal lineage and never carries old authority or scores", () => {
    const mismatch = proveNearMiss(request({
      proposalLineage: { ...proposalLineage, lineageId: "lineage-other" },
    }));
    expect(mismatch.qualified).toBe(false);
    expect(mismatch.blockers).toContain("PROPOSAL_LINEAGE_MISMATCH");

    const oldEvidence = proveNearMiss(request({
      priorSelectionReceipts: [receipt({ score: 0.99, authority: { role: "organizer" } })],
    }));
    expect(oldEvidence.qualified).toBe(true);
    expect(oldEvidence).not.toHaveProperty("score");
    expect(oldEvidence).not.toHaveProperty("authority");
    expect(hasNearMissAuthorityCarryForward(oldEvidence)).toBe(false);
  });

  it("enforces receipt/conflict bounds and rejects array-token shape tricks", () => {
    const tooManyReceipts = proveNearMiss(request({
      priorSelectionReceipts: Array.from({ length: 129 }, (_, index) => receipt({ receiptId: `receipt-${index}` })),
    }));
    expect(tooManyReceipts.qualified).toBe(false);
    expect(tooManyReceipts.blockers).toContain("SELECTION_RECEIPT_LIMIT_EXCEEDED");

    expect(() => createNearMissConflictEvidence({
      ...conflictsInput,
      status: "CONFLICTED",
      conflictIds: Array.from({ length: 65 }, (_, index) => `conflict-${index}`),
    })).toThrow(/conflict evidence|invalid/i);

    const tokenArray = ["person-1"];
    Object.defineProperty(tokenArray, "authority", { enumerable: true, value: "organizer" });
    const shaped = proveNearMiss(request({ candidateId: tokenArray }));
    expect(shaped.qualified).toBe(false);
    expect(shaped.blockers).toContain("NEAR_MISS_INPUT_NOT_JSON");
  });

  it("keeps receipt permutations and every emitted evidence object deterministic and deeply immutable", () => {
    const first = proveNearMiss(request({
      priorSelectionReceipts: [receipt({ receiptId: "receipt-z" }), receipt({ receiptId: "receipt-a" })],
    }));
    const second = proveNearMiss(request({
      priorSelectionReceipts: [receipt({ receiptId: "receipt-a" }), receipt({ receiptId: "receipt-z" })],
    }));

    expect(first.proofFingerprint).toBe(second.proofFingerprint);
    expect(first.evidence.receiptId).toBe("receipt-a");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(Object.isFrozen(first.evidence.scope)).toBe(true);
    expect(Object.isFrozen(first.evidence.capacity)).toBe(true);
    expect(Object.isFrozen(first.blockers)).toBe(true);
    expect(() => nearMissFingerprintOf({ toJSON: "forbidden" } as never)).toThrow(/toJSON/i);
  });
});
