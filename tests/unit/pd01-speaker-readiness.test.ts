import { describe, expect, it } from "vitest";

import { evaluateSpeakerReadiness, SpeakerReadinessInputError } from "../../src/server/adapters/speaker-readiness";

const at = "2026-08-10T00:00:00.000Z";
const fp = (n: string) => n.repeat(64);
const ref = (type: string, id: string, fingerprint: string) => ({ type, id, fingerprint });
const source = (type: string, id: string, fingerprint: string, extra: Record<string, unknown> = {}) => ({ ...ref(type, id, fingerprint), current: true, supersededById: null, quarantined: false, occurredAt: at, supersededAt: null, ...extra });
const bare = (item: { readonly id: string; readonly fingerprint: string }) => ({ id: item.id, fingerprint: item.fingerprint });

function base(): any {
  const selection = ref("SELECTION", "decision-1", fp("a"));
  const role = ref("ROLE", "role-1", fp("b"));
  const offer = ref("OFFER", "offer-1", fp("c"));
  const commitment = ref("COMMITMENT", "commitment-1", fp("d"));
  const requirement = ref("REQUIREMENT", "requirement-1", fp("e"));
  const submission = ref("SUBMISSION", "submission-1", fp("f"));
  const artifact = ref("ARTIFACT", "artifact-1", fp("1"));
  const decision = ref("REQUIREMENT_DECISION", "approval-1", fp("2"));
  const authority = ref("AUTHORITY", "authority-1", fp("5"));
  const schedule = ref("SCHEDULE", "schedule-1", fp("3"));
  const publication = ref("PUBLICATION", "publication-1", fp("4"));
  const sources = [selection, role, offer, commitment, requirement, submission, artifact, decision, schedule, publication, authority]
    .map((item) => source(item.type, item.id, item.fingerprint));
  return {
    workspaceId: "workspace-1", eventId: "event-1", asOf: at, locale: "en-US",
    selection: { ...bare(selection), status: "SELECTED", current: true, supersededById: null, supersededAt: null, occurredAt: at },
    selectedSpeakerRoles: [{ ...bare(role), personId: "person-1", applicable: true, sourceRecords: [role], occurredAt: at }],
    applicableRequirements: [requirement],
    conditions: [],
    offers: [{ ...bare(offer), selectionDecisionId: selection.id, selectionDecisionFingerprint: selection.fingerprint, personId: "person-1", speakerRoleId: role.id, termsFingerprint: fp("5"), current: true, sourceRecords: [offer], occurredAt: at, supersededById: null, supersededAt: null }],
    commitments: [{ ...bare(commitment), offerId: offer.id, offerFingerprint: offer.fingerprint, state: "ACCEPTED", current: true, sourceRecords: [commitment], occurredAt: at, supersededById: null, supersededAt: null }],
    requirements: [{ ...bare(requirement), gateTargets: ["CONFIRMATION", "SCHEDULING", "PUBLICATION", "OPERATOR_RELEASE"], required: true, waivable: true,
      submissions: [{ ...bare(submission), requirementId: requirement.id, version: 1, supersedesSubmissionId: null, kind: "ARTIFACT", sourceRecords: [artifact], current: true, quarantined: false, occurredAt: at }],
      decisions: [{ ...bare(decision), requirementId: requirement.id, kind: "APPROVE_VERSION", submissionId: submission.id, current: true, sourceRecords: [decision], occurredAt: at, decidedByAccountId: "account-1", authorityRecords: [authority] }], waivers: [], sourceRecords: [requirement], occurredAt: at }],
    findings: [],
    schedules: [{ ...bare(schedule), speakerRoleId: role.id, state: "APPROVED", current: true, sourceRecords: [schedule], occurredAt: at, supersededById: null, supersededAt: null }],
    publications: [{ ...bare(publication), speakerRoleId: role.id, state: "APPROVED", current: true, sourceRecords: [publication], occurredAt: at, supersededById: null, supersededAt: null }],
    sourceRecords: sources,
    authorities: [{ ...bare(authority), accountId: "account-1", allowedActions: ["APPROVE_REQUIREMENT"], subjectKind: "DECISION", subjectId: decision.id, subjectFingerprint: decision.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [authority] }],
  };
}

function addSatisfiedVerification(facts: any, options: any = {}): { condition: any; verification: any; authority: any } {
  const condition = ref("CONDITION", "condition-1", fp("6"));
  const verification = ref("VERIFICATION", "verification-1", fp("7"));
  const authority = ref("AUTHORITY", "authority-verification", fp("8"));
  const factOccurredAt = options.factOccurredAt ?? at;
  const sourceOccurredAt = options.sourceOccurredAt ?? factOccurredAt;
  const transitionOccurredAt = options.transitionOccurredAt ?? sourceOccurredAt;
  const sourceCurrent = options.sourceCurrent ?? true;
  const factCurrent = options.factCurrent ?? sourceCurrent;
  const supersededById = options.supersededById ?? null;
  const supersededAt = options.supersededAt ?? null;
  facts.conditions = [{ ...bare(condition), gateTargets: ["OFFER"], waivable: false, waiverScope: [], transitions: [
    { id: "condition-open", sequence: 1, toState: "OPEN", verificationId: null, sourceRecords: [], occurredAt: at },
    { id: "condition-satisfied", sequence: 2, toState: "SATISFIED", verificationId: verification.id, sourceRecords: [], occurredAt: transitionOccurredAt },
  ], verifications: [{ ...bare(verification), conditionId: condition.id, evidenceRecords: [], result: "SATISFIES", current: factCurrent, occurredAt: factOccurredAt, verifiedByAccountId: "account-1", authorityRecords: [authority] }], waivers: [] }];
  facts.sourceRecords.push(
    source(condition.type, condition.id, condition.fingerprint),
    source(verification.type, verification.id, verification.fingerprint, { current: sourceCurrent, occurredAt: sourceOccurredAt, supersededById, supersededAt }),
    source(authority.type, authority.id, authority.fingerprint),
  );
  facts.authorities.push({ ...bare(authority), accountId: "account-1", allowedActions: ["VERIFY_CONDITION"], subjectKind: "VERIFICATION", subjectId: verification.id, subjectFingerprint: verification.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: options.validFrom ?? at, validTo: options.validTo ?? null, current: true, supersededById: null, supersededAt: null, sourceRecords: [authority] });
  return { condition, verification, authority };
}

describe("PD-01 pure speaker operations readiness", () => {
  it("evaluates five conjunctive gates and emits eligibility only", () => {
    const result = evaluateSpeakerReadiness(base());
    expect(result.gates.map((gate) => [gate.gate, gate.eligible])).toEqual([
      ["OFFER", true], ["CONFIRMATION", true], ["SCHEDULING", true], ["PUBLICATION", true], ["OPERATOR_RELEASE", true],
    ]);
    expect(result).not.toHaveProperty("release");
    expect(result).not.toHaveProperty("readinessTable");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.gates[4].sourceRecords.map((item) => item.type)).toEqual(expect.arrayContaining(["OFFER", "COMMITMENT", "REQUIREMENT_DECISION", "SUBMISSION", "SCHEDULE", "PUBLICATION"]));
  });

  it("evaluates only required inventory requirements targeted to the current gate", () => {
    const empty = base();
    empty.applicableRequirements = [];
    expect(evaluateSpeakerReadiness(empty).eligible).toBe(true);

    const nonTargeted = base();
    nonTargeted.requirements[0].gateTargets = ["SCHEDULING"];
    nonTargeted.requirements[0].submissions = [];
    nonTargeted.requirements[0].decisions = [];
    const nonTargetedResult = evaluateSpeakerReadiness(nonTargeted);
    expect(nonTargetedResult.gates.map((gate: any) => [gate.gate, gate.eligible])).toEqual([
      ["OFFER", true], ["CONFIRMATION", true], ["SCHEDULING", false], ["PUBLICATION", true], ["OPERATOR_RELEASE", true],
    ]);
    expect(nonTargetedResult.gates.find((gate: any) => gate.gate === "CONFIRMATION")?.eligible).toBe(true);
    expect(nonTargetedResult.gates.find((gate: any) => gate.gate === "SCHEDULING")?.eligible).toBe(false);

    const optional = base();
    optional.requirements[0].required = false;
    optional.requirements[0].submissions = [];
    optional.requirements[0].decisions = [];
    expect(evaluateSpeakerReadiness(optional).eligible).toBe(true);

    const targetedRequired = base();
    targetedRequired.requirements[0].submissions = [];
    targetedRequired.requirements[0].decisions = [];
    const targetedResult = evaluateSpeakerReadiness(targetedRequired);
    const confirmation = targetedResult.gates.find((gate: any) => gate.gate === "CONFIRMATION");
    expect(confirmation?.eligible).toBe(false);
    expect(confirmation?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REQUIREMENT_NOT_READY" })]));

    const offerTargetedRequired = base();
    offerTargetedRequired.requirements[0].gateTargets = ["OFFER"];
    offerTargetedRequired.requirements[0].submissions = [];
    offerTargetedRequired.requirements[0].decisions = [];
    const offerTargetedResult = evaluateSpeakerReadiness(offerTargetedRequired);
    const offer = offerTargetedResult.gates.find((gate: any) => gate.gate === "OFFER");
    expect(offer?.eligible).toBe(false);
    expect(offer?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REQUIREMENT_NOT_READY" })]));

    const offerMissingApproval = base();
    offerMissingApproval.requirements[0].gateTargets = ["OFFER"];
    offerMissingApproval.requirements[0].decisions = [];
    expect(evaluateSpeakerReadiness(offerMissingApproval).gates.find((gate: any) => gate.gate === "OFFER")?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CURRENT_VERSION_NOT_APPROVED" })]));

    const offerWaived = base();
    const waiver = ref("REQUIREMENT_WAIVER", "offer-waiver-1", fp("6"));
    const waiverAuthority = ref("AUTHORITY", "authority-offer-waiver", fp("7"));
    offerWaived.requirements[0].gateTargets = ["OFFER"];
    offerWaived.requirements[0].submissions = [];
    offerWaived.requirements[0].decisions = [];
    offerWaived.requirements[0].waivers = [{ ...bare(waiver), requirementId: "requirement-1", scope: ["OFFER"], reason: "Approved exception", actorId: "account-1", current: true, sourceRecords: [waiver], occurredAt: at, authorityRecords: [waiverAuthority] }];
    offerWaived.sourceRecords.push(source(waiver.type, waiver.id, waiver.fingerprint), source(waiverAuthority.type, waiverAuthority.id, waiverAuthority.fingerprint));
    offerWaived.authorities.push({ ...bare(waiverAuthority), accountId: "account-1", allowedActions: ["WAIVE_REQUIREMENT"], subjectKind: "WAIVER", subjectId: waiver.id, subjectFingerprint: waiver.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [waiverAuthority] });
    expect(evaluateSpeakerReadiness(offerWaived).gates.find((gate: any) => gate.gate === "OFFER")?.eligible).toBe(true);

    const nonCurrentOfferWaived = base();
    nonCurrentOfferWaived.requirements[0].gateTargets = ["OFFER"];
    nonCurrentOfferWaived.requirements[0].submissions = [];
    nonCurrentOfferWaived.requirements[0].decisions = [];
    nonCurrentOfferWaived.requirements[0].waivers = [{ ...bare(waiver), requirementId: "requirement-1", scope: ["OFFER"], reason: "Expired exception", actorId: "account-1", current: false, sourceRecords: [waiver], occurredAt: at, authorityRecords: [waiverAuthority] }];
    nonCurrentOfferWaived.sourceRecords.push(source(waiver.type, waiver.id, waiver.fingerprint), source(waiverAuthority.type, waiverAuthority.id, waiverAuthority.fingerprint));
    nonCurrentOfferWaived.authorities.push({ ...bare(waiverAuthority), accountId: "account-1", allowedActions: ["WAIVE_REQUIREMENT"], subjectKind: "WAIVER", subjectId: waiver.id, subjectFingerprint: waiver.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [waiverAuthority] });
    const nonCurrentOffer = evaluateSpeakerReadiness(nonCurrentOfferWaived).gates.find((gate: any) => gate.gate === "OFFER");
    expect(nonCurrentOffer?.eligible).toBe(false);
    expect(nonCurrentOffer?.waivers).not.toContainEqual(waiver);

    const malformedTargeted = base();
    malformedTargeted.requirements[0].gateTargets = ["CONFIRMATION", "INVALID_GATE"];
    expect(() => evaluateSpeakerReadiness(malformedTargeted)).toThrow();
  });

  it("requires every applicable selected role commitment, not any one role", () => {
    const facts = base();
    const secondRole = { ...facts.selectedSpeakerRoles[0], id: "role-2", fingerprint: fp("6"), sourceRecords: [ref("ROLE", "role-2", fp("6"))] };
    facts.selectedSpeakerRoles.push(secondRole);
    expect(evaluateSpeakerReadiness(facts).gates.find((gate: any) => gate.gate === "PUBLICATION")?.eligible).toBe(false);
  });

  it("rejects every authoritative binding when its source is missing or forged", () => {
    for (const kind of ["SELECTION", "OFFER", "COMMITMENT", "REQUIREMENT", "REQUIREMENT_DECISION", "SUBMISSION", "SCHEDULE", "PUBLICATION"]) {
      const facts = base(); facts.sourceRecords = facts.sourceRecords.filter((item: any) => item.type !== kind);
      expect(evaluateSpeakerReadiness(facts).eligible).toBe(false);
    }
    const forged = base(); forged.sourceRecords = forged.sourceRecords.map((item: any) => item.type === "REQUIREMENT_DECISION" ? { ...item, fingerprint: fp("9") } : item);
    expect(evaluateSpeakerReadiness(forged).eligible).toBe(false);
  });

  it("uses collision-safe tuple keys and rejects conflicting decisions, invalid waivers, findings, and histories", () => {
    const facts = base(); facts.sourceRecords.push(source("A:B", "C", fp("7")), source("A", "B:C", fp("8")));
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
    facts.requirements[0].decisions.push({ ...facts.requirements[0].decisions[0], id: "approval-2", fingerprint: fp("0"), sourceRecords: [ref("REQUIREMENT_DECISION", "approval-2", fp("0"))] });
    facts.sourceRecords.push(source("REQUIREMENT_DECISION", "approval-2", fp("0")));
    expect(() => evaluateSpeakerReadiness(facts)).toThrow();
    const gap = base(); gap.conditions = [{ id: "condition-1", fingerprint: fp("6"), gateTargets: ["OFFER"], waivable: false, waiverScope: [], transitions: [{ id: "t", sequence: 2, toState: "OPEN", verificationId: null, sourceRecords: [], occurredAt: at }], verifications: [], waivers: [] }];
    expect(() => evaluateSpeakerReadiness(gap)).toThrow();
  });

  it("requires verified satisfaction, exact approval/version roots, scoped waivers, and exact finding submissions", () => {
    const facts = base();
    facts.conditions = [{ id: "condition-1", fingerprint: fp("6"), gateTargets: ["OFFER"], waivable: false, waiverScope: [], transitions: [{ id: "t", sequence: 1, toState: "SATISFIED", verificationId: null, sourceRecords: [], occurredAt: at }], verifications: [], waivers: [] }];
    expect(() => evaluateSpeakerReadiness(facts)).toThrow();
    const version = base(); version.requirements[0].submissions = [{ ...version.requirements[0].submissions[0], id: "submission-2", version: 2, supersedesSubmissionId: "missing", current: true }];
    expect(() => evaluateSpeakerReadiness(version)).toThrow();
    const finding = base(); finding.findings = [{ id: "finding-1", fingerprint: fp("7"), requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("9"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: true, supersededById: null, supersededAt: null, sourceRecords: [ref("EDITORIAL", "finding-1", fp("7"))], occurredAt: at }]; finding.sourceRecords.push(source("EDITORIAL", "finding-1", fp("7")));
    expect(() => evaluateSpeakerReadiness(finding)).toThrow();
  });

  it("binds condition verification identity, occurrence, and derived currency to its authoritative source", () => {
    const valid = base();
    addSatisfiedVerification(valid);
    expect(evaluateSpeakerReadiness(valid).gates.find((gate: any) => gate.gate === "OFFER")?.eligible).toBe(true);

    const missingSource = base();
    addSatisfiedVerification(missingSource);
    missingSource.sourceRecords = missingSource.sourceRecords.filter((item: any) => item.type !== "VERIFICATION");
    expect(() => evaluateSpeakerReadiness(missingSource)).toThrow(/authoritative VERIFICATION source/iu);

    const nonCurrent = base();
    addSatisfiedVerification(nonCurrent, { factCurrent: false, sourceCurrent: false, supersededById: "verification-2", supersededAt: "2026-08-10T12:00:00.000Z" });
    nonCurrent.asOf = "2026-08-11T00:00:00.000Z";
    const nonCurrentOffer = evaluateSpeakerReadiness(nonCurrent).gates.find((gate: any) => gate.gate === "OFFER");
    expect(nonCurrentOffer?.eligible).toBe(false);
    expect(nonCurrentOffer?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONDITION_NOT_SATISFIED" })]));

    const currencyMismatch = base();
    addSatisfiedVerification(currencyMismatch, { factCurrent: false, sourceCurrent: true });
    expect(() => evaluateSpeakerReadiness(currencyMismatch)).toThrow(/currency/iu);

    const backdated = base();
    addSatisfiedVerification(backdated, { factOccurredAt: at, sourceOccurredAt: "2026-08-10T01:00:00.000Z", transitionOccurredAt: "2026-08-10T01:00:00.000Z", validTo: "2026-08-10T00:30:00.000Z" });
    backdated.asOf = "2026-08-10T02:00:00.000Z";
    expect(() => evaluateSpeakerReadiness(backdated)).toThrow(/occurredAt/iu);
  });

  it("keeps a verification current at a historical asOf until authoritative supersession", () => {
    const facts = base();
    const supersededAt = "2026-08-11T00:00:00.000Z";
    addSatisfiedVerification(facts, { factCurrent: false, sourceCurrent: false, supersededById: "verification-2", supersededAt });
    facts.asOf = "2026-08-10T12:00:00.000Z";
    expect(evaluateSpeakerReadiness(facts).gates.find((gate: any) => gate.gate === "OFFER")?.eligible).toBe(true);
    facts.asOf = supersededAt;
    const staleOffer = evaluateSpeakerReadiness(facts).gates.find((gate: any) => gate.gate === "OFFER");
    expect(staleOffer?.eligible).toBe(false);
    expect(staleOffer?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONDITION_NOT_SATISFIED" })]));
  });

  it("accepts a legally replaced verification after v2 while authenticating v1 at its occurrence", () => {
    const facts = base();
    const condition = ref("CONDITION", "condition-replacement", fp("6"));
    const verificationV1 = ref("VERIFICATION", "verification-v1", fp("7"));
    const verificationV2 = ref("VERIFICATION", "verification-v2", fp("8"));
    const authorityV1 = ref("AUTHORITY", "authority-verification-v1", fp("9"));
    const authorityV2 = ref("AUTHORITY", "authority-verification-v2", fp("0"));
    const verificationV1At = "2026-08-10T01:00:00.000Z";
    const evidenceSubmittedAt = "2026-08-10T02:00:00.000Z";
    const verificationV2At = "2026-08-10T03:00:00.000Z";
    facts.conditions = [{ ...bare(condition), gateTargets: ["OFFER"], waivable: false, waiverScope: [], transitions: [
      { id: "condition-open", sequence: 1, toState: "OPEN", verificationId: null, sourceRecords: [], occurredAt: at },
      { id: "condition-satisfied-v1", sequence: 2, toState: "SATISFIED", verificationId: verificationV1.id, sourceRecords: [], occurredAt: verificationV1At },
      { id: "condition-evidence-submitted", sequence: 3, toState: "EVIDENCE_SUBMITTED", verificationId: null, sourceRecords: [], occurredAt: evidenceSubmittedAt },
      { id: "condition-satisfied-v2", sequence: 4, toState: "SATISFIED", verificationId: verificationV2.id, sourceRecords: [], occurredAt: verificationV2At },
    ], verifications: [
      { ...bare(verificationV1), conditionId: condition.id, evidenceRecords: [], result: "SATISFIES", current: false, occurredAt: verificationV1At, verifiedByAccountId: "account-1", authorityRecords: [authorityV1] },
      { ...bare(verificationV2), conditionId: condition.id, evidenceRecords: [], result: "SATISFIES", current: true, occurredAt: verificationV2At, verifiedByAccountId: "account-1", authorityRecords: [authorityV2] },
    ], waivers: [] }];
    facts.sourceRecords.push(
      source(condition.type, condition.id, condition.fingerprint),
      source(verificationV1.type, verificationV1.id, verificationV1.fingerprint, { current: false, occurredAt: verificationV1At, supersededById: verificationV2.id, supersededAt: verificationV2At }),
      source(verificationV2.type, verificationV2.id, verificationV2.fingerprint, { occurredAt: verificationV2At }),
      source(authorityV1.type, authorityV1.id, authorityV1.fingerprint, { current: false, occurredAt: verificationV1At, supersededById: authorityV2.id, supersededAt: verificationV2At }),
      source(authorityV2.type, authorityV2.id, authorityV2.fingerprint, { occurredAt: verificationV2At }),
    );
    facts.authorities.push(
      { ...bare(authorityV1), accountId: "account-1", allowedActions: ["VERIFY_CONDITION"], subjectKind: "VERIFICATION", subjectId: verificationV1.id, subjectFingerprint: verificationV1.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: verificationV1At, validTo: null, current: false, supersededById: authorityV2.id, supersededAt: verificationV2At, sourceRecords: [authorityV1] },
      { ...bare(authorityV2), accountId: "account-1", allowedActions: ["VERIFY_CONDITION"], subjectKind: "VERIFICATION", subjectId: verificationV2.id, subjectFingerprint: verificationV2.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: verificationV2At, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [authorityV2] },
    );
    facts.asOf = "2026-08-10T04:00:00.000Z";
    const result = evaluateSpeakerReadiness(facts);
    expect(result.gates.find((gate: any) => gate.gate === "OFFER")?.eligible).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it("applies blocker findings only to explicitly named target gates", () => {
    const facts = base();
    const findingRef = ref("EDITORIAL", "finding-1", fp("7"));
    facts.findings = [{ id: findingRef.id, fingerprint: findingRef.fingerprint, requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: true, supersededById: null, supersededAt: null, sourceRecords: [findingRef], occurredAt: at }];
    facts.sourceRecords.push(source(findingRef.type, findingRef.id, findingRef.fingerprint));
    expect(evaluateSpeakerReadiness(facts).gates.map((gate: any) => [gate.gate, gate.eligible])).toEqual([
      ["OFFER", true], ["CONFIRMATION", true], ["SCHEDULING", true], ["PUBLICATION", false], ["OPERATOR_RELEASE", true],
    ]);
  });

  it("preflights proxies, accessors, custom prototypes, cycles, depth, nodes, bytes, and nested rows", () => {
    const getter = base(); Object.defineProperty(getter, "eventId", { get: () => { throw new Error("getter"); } }); expect(() => evaluateSpeakerReadiness(getter)).toThrow();
    const custom = base(); Object.setPrototypeOf(custom, { hostile: true }); expect(() => evaluateSpeakerReadiness(custom)).toThrow();
    const cycle = base(); cycle.cycle = cycle; expect(() => evaluateSpeakerReadiness(cycle)).toThrow();
    const deep = base(); let cursor = deep as any; for (let i = 0; i < 33; i += 1) { cursor.next = {}; cursor = cursor.next; } expect(() => evaluateSpeakerReadiness(deep)).toThrow();
    expect(() => evaluateSpeakerReadiness({ ...base(), workspaceId: "é".repeat(300) })).toThrow();
    expect(() => evaluateSpeakerReadiness({ ...base(), requirements: Array.from({ length: 4097 }, () => base().requirements[0]) })).toThrow();
    expect(() => evaluateSpeakerReadiness({ ...base(), selectedSpeakerRoles: Array.from({ length: 12001 }, () => base().selectedSpeakerRoles[0]) })).toThrow();
  });

  it("rejects a transparent proxy at the root input boundary", () => {
    expect(() => evaluateSpeakerReadiness(new Proxy(base(), {}))).toThrow(SpeakerReadinessInputError);
  });

  it("rejects a transparent proxy nested in otherwise valid facts", () => {
    const facts = base();
    facts.requirements[0].submissions[0] = new Proxy(facts.requirements[0].submissions[0], {});
    expect(() => evaluateSpeakerReadiness(facts)).toThrow(SpeakerReadinessInputError);
  });

  it("rejects a revoked proxy with the stable input-boundary error", () => {
    const revocable = Proxy.revocable(base(), {});
    revocable.revoke();
    expect(() => evaluateSpeakerReadiness(revocable.proxy)).toThrowError(new SpeakerReadinessInputError());
  });

  it("does not leak hostile proxy trap details", () => {
    const hostileDetail = "hostile-proxy-detail-must-not-leak";
    let trapCalls = 0;
    const hostile = new Proxy(base(), {
      getOwnPropertyDescriptor: () => { trapCalls += 1; throw new Error(hostileDetail); },
      getPrototypeOf: () => { trapCalls += 1; throw new Error(hostileDetail); },
      ownKeys: () => { trapCalls += 1; throw new Error(hostileDetail); },
    });
    let thrown: unknown;
    try { evaluateSpeakerReadiness(hostile); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(SpeakerReadinessInputError);
    expect((thrown as Error).message).toBe("Speaker readiness facts are invalid.");
    expect(String(thrown)).not.toContain(hostileDetail);
    expect(trapCalls).toBe(0);
  });

  it("preserves readiness behavior for plain data", () => {
    const result = evaluateSpeakerReadiness(base());
    expect(result.eligible).toBe(true);
    expect(result.gates.map((gate) => gate.eligible)).toEqual([true, true, true, true, true]);
  });

  it("applies asOf chronology and changes fingerprints when successful evidence changes", () => {
    const facts = base(); const first = evaluateSpeakerReadiness(facts); facts.asOf = "2026-08-09T00:00:00.000Z"; expect(evaluateSpeakerReadiness(facts).eligible).toBe(false);
    const changed = base(); changed.requirements[0].decisions[0].fingerprint = fp("8"); changed.requirements[0].decisions[0].sourceRecords = [ref("REQUIREMENT_DECISION", "approval-1", fp("8"))]; changed.sourceRecords.find((item: any) => item.type === "REQUIREMENT_DECISION").fingerprint = fp("8"); changed.authorities[0].subjectFingerprint = fp("8");
    expect(evaluateSpeakerReadiness(changed).computationFingerprint).not.toBe(first.computationFingerprint);
  });

  it("rejects non-REQUIREMENT inventory bypasses and binds approval authority", () => {
    const bypass = base(); bypass.applicableRequirements = [ref("ROLE", "role-1", fp("b"))];
    expect(() => evaluateSpeakerReadiness(bypass)).toThrow();
    const unsigned = base(); unsigned.requirements[0].decisions[0].decidedByAccountId = "unbound-account";
    expect(() => evaluateSpeakerReadiness(unsigned)).toThrow();
  });

  it("derives historical latest submission state at asOf instead of trusting current flags", () => {
    const facts = base();
    const later = "2026-08-11T00:00:00.000Z";
    const oldSubmission = facts.requirements[0].submissions[0];
    oldSubmission.current = false;
    const oldSource = facts.sourceRecords.find((item: any) => item.type === "SUBMISSION"); oldSource.current = false; oldSource.supersededAt = later; oldSource.supersededById = "submission-2";
    const nextSubmission = { ...oldSubmission, id: "submission-2", fingerprint: fp("6"), version: 2, supersedesSubmissionId: oldSubmission.id, current: true, occurredAt: later, sourceRecords: [ref("SUBMISSION", "submission-2", fp("6"))] };
    facts.requirements[0].submissions = [oldSubmission, nextSubmission];
    facts.sourceRecords.push(source("SUBMISSION", "submission-2", fp("6")));
    facts.asOf = at;
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
  });

  it("reconstructs finding currency at asOf from supersession evidence and honors the exact boundary", () => {
    const facts = base();
    const historicalAsOf = "2026-08-10T12:00:00.000Z";
    const supersededAt = "2026-08-11T00:00:00.000Z";
    const findingRef = ref("EDITORIAL", "finding-1", fp("7"));
    facts.findings = [{ id: findingRef.id, fingerprint: findingRef.fingerprint, requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: false, supersededById: "finding-2", supersededAt, sourceRecords: [findingRef], occurredAt: at }];
    facts.sourceRecords.push(source(findingRef.type, findingRef.id, findingRef.fingerprint, { current: false, supersededById: "finding-2", supersededAt }));
    facts.asOf = historicalAsOf;
    const historical = evaluateSpeakerReadiness(facts);
    expect(historical.gates.find((gate: any) => gate.gate === "PUBLICATION")?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CURRENT_BLOCKER_FINDING" })]));
    facts.asOf = supersededAt;
    expect(evaluateSpeakerReadiness(facts).gates.find((gate: any) => gate.gate === "PUBLICATION")?.eligible).toBe(true);
  });

  it("rejects a finding whose fact-level retraction disagrees with its authoritative editorial source", () => {
    const facts = base();
    const supersededAt = "2026-08-11T00:00:00.000Z";
    const findingRef = ref("EDITORIAL", "finding-1", fp("7"));
    facts.findings = [{ id: findingRef.id, fingerprint: findingRef.fingerprint, requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: false, supersededById: "finding-2", supersededAt, sourceRecords: [findingRef], occurredAt: at }];
    facts.sourceRecords.push(source(findingRef.type, findingRef.id, findingRef.fingerprint));
    facts.asOf = "2026-08-12T00:00:00.000Z";
    expect(() => evaluateSpeakerReadiness(facts)).toThrow(/currency|authoritative editorial source/iu);
  });

  it("does not accept a non-current condition waiver even when its source and authority are otherwise exact", () => {
    const facts = base();
    const condition = ref("CONDITION", "condition-1", fp("6"));
    const waiver = ref("REQUIREMENT_WAIVER", "condition-waiver-1", fp("7"));
    const waiverAuthority = ref("AUTHORITY", "authority-condition-waiver", fp("8"));
    facts.conditions = [{ id: condition.id, fingerprint: condition.fingerprint, gateTargets: ["OFFER"], waivable: true, waiverScope: ["OFFER"], transitions: [
      { id: "condition-open", sequence: 1, toState: "OPEN", verificationId: null, sourceRecords: [], occurredAt: at },
      { id: "condition-waived", sequence: 2, toState: "WAIVED", verificationId: null, sourceRecords: [], occurredAt: at },
    ], verifications: [], waivers: [{ ...bare(waiver), conditionId: condition.id, scope: ["OFFER"], reason: "Expired exception", actorId: "account-1", current: false, sourceRecords: [waiver], occurredAt: at, authorityRecords: [waiverAuthority] }] }];
    facts.sourceRecords.push(source(condition.type, condition.id, condition.fingerprint), source(waiver.type, waiver.id, waiver.fingerprint), source(waiverAuthority.type, waiverAuthority.id, waiverAuthority.fingerprint));
    facts.authorities.push({ ...bare(waiverAuthority), accountId: "account-1", allowedActions: ["WAIVE_CONDITION"], subjectKind: "WAIVER", subjectId: waiver.id, subjectFingerprint: waiver.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [waiverAuthority] });
    const offer = evaluateSpeakerReadiness(facts).gates.find((gate: any) => gate.gate === "OFFER");
    expect(offer?.eligible).toBe(false);
    expect(offer?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONDITION_NOT_SATISFIED" })]));
    expect(offer?.waivers).not.toContainEqual(waiver);
  });

  it("rejects one-sided, flag-inconsistent, or non-chronological finding supersession metadata", () => {
    for (const mutate of [
      (finding: any) => { finding.supersededById = "finding-2"; },
      (finding: any) => { finding.supersededAt = "2026-08-11T00:00:00.000Z"; },
      (finding: any) => { finding.supersededById = "finding-2"; finding.supersededAt = at; },
    ]) {
      const facts = base();
      const findingRef = ref("EDITORIAL", "finding-1", fp("7"));
      const finding = { id: findingRef.id, fingerprint: findingRef.fingerprint, requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: true, supersededById: null, supersededAt: null, sourceRecords: [findingRef], occurredAt: at };
      mutate(finding);
      facts.findings = [finding];
      facts.sourceRecords.push(source(findingRef.type, findingRef.id, findingRef.fingerprint));
      expect(() => evaluateSpeakerReadiness(facts)).toThrow();
    }
    expect(evaluateSpeakerReadiness(base()).eligible).toBe(true);
  });

  it("rejects a non-current finding without supersession and a current finding with supersession", () => {
    const withoutSupersession = base();
    withoutSupersession.findings = [{ id: "finding-1", fingerprint: fp("7"), requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: false, supersededById: null, supersededAt: null, sourceRecords: [ref("EDITORIAL", "finding-1", fp("7"))], occurredAt: at }];
    withoutSupersession.sourceRecords.push(source("EDITORIAL", "finding-1", fp("7")));
    expect(() => evaluateSpeakerReadiness(withoutSupersession)).toThrow();

    const currentWithSupersession = base();
    currentWithSupersession.findings = [{ id: "finding-1", fingerprint: fp("7"), requirementId: "requirement-1", submissionId: "submission-1", submissionFingerprint: fp("f"), severity: "BLOCKER", blocksGateTargets: ["PUBLICATION"], current: true, supersededById: "finding-2", supersededAt: "2026-08-11T00:00:00.000Z", sourceRecords: [ref("EDITORIAL", "finding-1", fp("7"))], occurredAt: at }];
    currentWithSupersession.sourceRecords.push(source("EDITORIAL", "finding-1", fp("7")));
    expect(() => evaluateSpeakerReadiness(currentWithSupersession)).toThrow();
  });

  it("accepts facts that were current at asOf despite later supersession links", () => {
    const facts = base(); const later = "2026-08-11T00:00:00.000Z";
    for (const item of [facts.selection, ...facts.offers, ...facts.commitments, ...facts.schedules, ...facts.publications, ...facts.authorities]) { item.current = false; item.supersededById = `later-${item.id}`; item.supersededAt = later; }
    for (const item of facts.sourceRecords) { item.current = false; item.supersededById = `later-${item.id}`; item.supersededAt = later; }
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
  });

  it("derives approve-revoke-reapprove from the legal chronological decision chain", () => {
    const facts = base(); const requirement = facts.requirements[0];
    const revoke = ref("REQUIREMENT_DECISION", "revoke-1", fp("7")); const revokeAuthority = ref("AUTHORITY", "authority-revoke", fp("8"));
    const reapprove = ref("REQUIREMENT_DECISION", "approval-2", fp("9")); const reapproveAuthority = ref("AUTHORITY", "authority-reapprove", fp("0"));
    requirement.decisions.push(
      { ...bare(revoke), requirementId: requirement.id, kind: "REVOKE_DECISION", submissionId: "submission-1", supersedesDecisionId: "approval-1", current: false, sourceRecords: [revoke], occurredAt: "2026-08-10T01:00:00.000Z", decidedByAccountId: "account-1", authorityRecords: [revokeAuthority] },
      { ...bare(reapprove), requirementId: requirement.id, kind: "APPROVE_VERSION", submissionId: "submission-1", supersedesDecisionId: "revoke-1", current: true, sourceRecords: [reapprove], occurredAt: "2026-08-10T02:00:00.000Z", decidedByAccountId: "account-1", authorityRecords: [reapproveAuthority] },
    );
    facts.sourceRecords.push(source(revoke.type, revoke.id, revoke.fingerprint), source(reapprove.type, reapprove.id, reapprove.fingerprint), source(revokeAuthority.type, revokeAuthority.id, revokeAuthority.fingerprint), source(reapproveAuthority.type, reapproveAuthority.id, reapproveAuthority.fingerprint));
    facts.authorities.push(
      { ...bare(revokeAuthority), accountId: "account-1", allowedActions: ["REVOKE_REQUIREMENT"], subjectKind: "DECISION", subjectId: revoke.id, subjectFingerprint: revoke.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [revokeAuthority] },
      { ...bare(reapproveAuthority), accountId: "account-1", allowedActions: ["APPROVE_REQUIREMENT"], subjectKind: "DECISION", subjectId: reapprove.id, subjectFingerprint: reapprove.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [reapproveAuthority] },
    );
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
  });

  it("rejects forged signer and authority scope bindings", () => {
    const signer = base(); signer.requirements[0].decisions[0].decidedByAccountId = "forged-account";
    expect(() => evaluateSpeakerReadiness(signer)).toThrow();
    const scope = base(); scope.authorities[0].allowedActions = ["REVOKE_REQUIREMENT"];
    expect(() => evaluateSpeakerReadiness(scope)).toThrow();
  });

  it("isolates malformed future decision links until asOf reaches them", () => {
    const future = "2026-08-11T00:00:00.000Z";
    const addDecision = (facts: any, idValue: string, digit: string, kind: string, supersedesDecisionId: string | null, action: string, occurredAt: string) => {
      const decision = ref("REQUIREMENT_DECISION", idValue, fp(digit));
      const authority = ref("AUTHORITY", `authority-${idValue}`, fp("a"));
      facts.requirements[0].decisions.push({ ...bare(decision), requirementId: "requirement-1", kind, submissionId: "submission-1", supersedesDecisionId, current: true, sourceRecords: [decision], occurredAt, decidedByAccountId: "account-1", authorityRecords: [authority] });
      facts.sourceRecords.push(source(decision.type, decision.id, decision.fingerprint, { occurredAt }), source(authority.type, authority.id, authority.fingerprint));
      facts.authorities.push({ ...bare(authority), accountId: "account-1", allowedActions: [action], subjectKind: "DECISION", subjectId: decision.id, subjectFingerprint: decision.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [authority] });
    };
    for (const setup of [
      (facts: any) => addDecision(facts, "future-foreign", "6", "APPROVE_VERSION", "missing-decision", "APPROVE_REQUIREMENT", future),
      (facts: any) => { addDecision(facts, "future-revoke", "6", "REVOKE_DECISION", "approval-1", "REVOKE_REQUIREMENT", future); addDecision(facts, "future-reapprove", "7", "APPROVE_VERSION", "approval-1", "APPROVE_REQUIREMENT", "2026-08-12T00:00:00.000Z"); },
      (facts: any) => { addDecision(facts, "future-revoke", "6", "REVOKE_DECISION", "future-reapprove", "REVOKE_REQUIREMENT", future); addDecision(facts, "future-reapprove", "7", "APPROVE_VERSION", "future-revoke", "APPROVE_REQUIREMENT", "2026-08-12T00:00:00.000Z"); },
    ]) {
      const facts = base(); setup(facts);
      expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
      facts.asOf = "2026-08-13T00:00:00.000Z";
      expect(() => evaluateSpeakerReadiness(facts)).toThrow();
    }
  });

  it("activates a structurally valid future decision chain only after asOf advances", () => {
    const facts = base(); const future = "2026-08-11T00:00:00.000Z";
    const revoke = ref("REQUIREMENT_DECISION", "future-revoke", fp("6")); const revokeAuthority = ref("AUTHORITY", "authority-future-revoke", fp("7"));
    const reapprove = ref("REQUIREMENT_DECISION", "future-reapprove", fp("8")); const reapproveAuthority = ref("AUTHORITY", "authority-future-reapprove", fp("9"));
    facts.requirements[0].decisions.push(
      { ...bare(revoke), requirementId: "requirement-1", kind: "REVOKE_DECISION", submissionId: "submission-1", supersedesDecisionId: "approval-1", current: false, sourceRecords: [revoke], occurredAt: future, decidedByAccountId: "account-1", authorityRecords: [revokeAuthority] },
      { ...bare(reapprove), requirementId: "requirement-1", kind: "APPROVE_VERSION", submissionId: "submission-1", supersedesDecisionId: "future-revoke", current: true, sourceRecords: [reapprove], occurredAt: "2026-08-12T00:00:00.000Z", decidedByAccountId: "account-1", authorityRecords: [reapproveAuthority] },
    );
    facts.sourceRecords.push(source(revoke.type, revoke.id, revoke.fingerprint, { occurredAt: future }), source(reapprove.type, reapprove.id, reapprove.fingerprint, { occurredAt: "2026-08-12T00:00:00.000Z" }), source(revokeAuthority.type, revokeAuthority.id, revokeAuthority.fingerprint), source(reapproveAuthority.type, reapproveAuthority.id, reapproveAuthority.fingerprint));
    facts.authorities.push(
      { ...bare(revokeAuthority), accountId: "account-1", allowedActions: ["REVOKE_REQUIREMENT"], subjectKind: "DECISION", subjectId: revoke.id, subjectFingerprint: revoke.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [revokeAuthority] },
      { ...bare(reapproveAuthority), accountId: "account-1", allowedActions: ["APPROVE_REQUIREMENT"], subjectKind: "DECISION", subjectId: reapprove.id, subjectFingerprint: reapprove.fingerprint, workspaceId: "workspace-1", eventId: "event-1", validFrom: at, validTo: null, current: true, supersededById: null, supersededAt: null, sourceRecords: [reapproveAuthority] },
    );
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
    facts.asOf = "2026-08-12T00:00:00.000Z";
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
  });

  it("scopes duplicate decision timestamps to the requested asOf", () => {
    const facts = base(); const future = "2026-08-11T00:00:00.000Z";
    facts.requirements[0].decisions.push(
      { ...facts.requirements[0].decisions[0], id: "future-duplicate-1", fingerprint: fp("6"), occurredAt: future, supersedesDecisionId: "approval-1", sourceRecords: [], authorityRecords: [] },
      { ...facts.requirements[0].decisions[0], id: "future-duplicate-2", fingerprint: fp("7"), occurredAt: future, supersedesDecisionId: "future-duplicate-1", sourceRecords: [], authorityRecords: [] },
    );
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
    facts.asOf = future;
    expect(() => evaluateSpeakerReadiness(facts)).toThrow();
  });

  it("accepts authority valid at action time despite later read-time supersession", () => {
    const facts = base(); const later = "2026-08-11T00:00:00.000Z";
    facts.authorities[0].current = false; facts.authorities[0].supersededById = "authority-replacement"; facts.authorities[0].supersededAt = later;
    const authoritySource = facts.sourceRecords.find((item: any) => item.type === "AUTHORITY"); authoritySource.current = false; authoritySource.supersededById = "authority-replacement"; authoritySource.supersededAt = later;
    facts.asOf = later;
    expect(evaluateSpeakerReadiness(facts).eligible).toBe(true);
  });

  it("rejects authority invalid before signing or expired at signing", () => {
    const before = base(); before.authorities[0].validFrom = "2026-08-11T00:00:00.000Z";
    expect(() => evaluateSpeakerReadiness(before)).toThrow();
    const expired = base(); expired.authorities[0].validTo = at;
    expect(() => evaluateSpeakerReadiness(expired)).toThrow();
  });

  it("rejects an unpaired supersession timestamp even when the record claims current", () => {
    const facts = base(); const sourceRecord = facts.sourceRecords.find((item: any) => item.type === "AUTHORITY");
    sourceRecord.current = true; sourceRecord.supersededAt = "2026-08-09T00:00:00.000Z"; sourceRecord.supersededById = null;
    expect(() => evaluateSpeakerReadiness(facts)).toThrow();
  });

  it("accepts paired authority evidence before supersession but rejects the exact boundary", () => {
    const facts = base(); const boundary = at; const later = "2026-08-11T00:00:00.000Z";
    facts.authorities[0].current = true; facts.authorities[0].supersededAt = boundary; facts.authorities[0].supersededById = "authority-replacement";
    const sourceRecord = facts.sourceRecords.find((item: any) => item.type === "AUTHORITY"); sourceRecord.current = true; sourceRecord.supersededAt = boundary; sourceRecord.supersededById = "authority-replacement";
    facts.asOf = boundary;
    expect(() => evaluateSpeakerReadiness(facts)).toThrow();
    const before = base(); before.authorities[0].current = true; before.authorities[0].supersededAt = later; before.authorities[0].supersededById = "authority-replacement";
    const beforeSource = before.sourceRecords.find((item: any) => item.type === "AUTHORITY"); beforeSource.current = true; beforeSource.supersededAt = later; beforeSource.supersededById = "authority-replacement";
    before.asOf = at;
    expect(evaluateSpeakerReadiness(before).eligible).toBe(true);
  });

  it("rejects either one-sided supersession form for generic sources and authorities", () => {
    for (const oneSided of [
      (facts: any) => { const row = facts.sourceRecords.find((item: any) => item.type === "ARTIFACT"); row.supersededById = "replacement"; },
      (facts: any) => { const row = facts.sourceRecords.find((item: any) => item.type === "ARTIFACT"); row.supersededAt = "2026-08-11T00:00:00.000Z"; },
      (facts: any) => { facts.authorities[0].supersededById = "replacement"; },
      (facts: any) => { facts.authorities[0].supersededAt = "2026-08-11T00:00:00.000Z"; },
    ]) expect(() => evaluateSpeakerReadiness((() => { const facts = base(); oneSided(facts); return facts; })())).toThrow();
    expect(evaluateSpeakerReadiness(base()).eligible).toBe(true);
  });

  it("includes locale, workspace, event, and asOf in computation identity", () => {
    const first = evaluateSpeakerReadiness(base());
    for (const field of ["locale", "workspaceId", "eventId", "asOf"] as const) {
      const changed = base(); changed[field] = field === "asOf" ? "2026-08-11T00:00:00.000Z" : `${changed[field]}-changed`;
      if (field === "workspaceId") changed.authorities[0].workspaceId = changed.workspaceId;
      if (field === "eventId") changed.authorities[0].eventId = changed.eventId;
      expect(evaluateSpeakerReadiness(changed).computationFingerprint).not.toBe(first.computationFingerprint);
    }
  });
});
