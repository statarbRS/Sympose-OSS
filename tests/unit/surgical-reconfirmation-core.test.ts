import { describe, expect, it } from "vitest";

import {
  SurgicalReconfirmationError,
  deriveSurgicalReconfirmation,
  fingerprintAuthorityEvidence,
  fingerprintPurposeEvidence,
  fingerprintRetentionEvidence,
  fingerprintStakeholderRevision,
  type MaterialTermPolicyInput,
  type ReconfirmationScope,
  type StakeholderBindingInput,
  type SurgicalReconfirmationCommand,
} from "../../src/server/services/surgical-reconfirmation";

const scope: ReconfirmationScope = { workspaceId: "workspace-1", eventId: "event-1" };
const asOf = "2026-08-13T12:00:00Z";
const sourceFamily = "PLAN_ASSIGNMENT" as const;

const policy: MaterialTermPolicyInput = {
  family: sourceFamily,
  version: 1,
  rules: [
    { path: "time", kind: "TIME", materiality: "MATERIAL" },
    { path: "role", kind: "ROLE", materiality: "MATERIAL" },
    { path: "notes", kind: "OTHER", materiality: "NON_MATERIAL" },
  ],
};

type Terms = { readonly time: string; readonly role: string; readonly notes: string };

const beforeTerms: Terms = {
  time: "2026-09-18T10:00:00Z",
  role: "MODERATOR",
  notes: "Room opens at 09:45.",
};

const movedTerms: Terms = {
  time: "2026-09-18T10:30:00Z",
  role: "MODERATOR",
  notes: "Room opens at 09:45.",
};

const editedNotesTerms: Terms = {
  time: beforeTerms.time,
  role: beforeTerms.role,
  notes: "Room opens at 09:30.",
};

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof SurgicalReconfirmationError) return error.code;
    throw error;
  }
  throw new Error("Expected SurgicalReconfirmationError.");
}

function evidenceFor(
  id: string,
  kind: "COMMITMENT" | "APPROVAL" = "COMMITMENT",
  actor: { readonly id: string; readonly role: string } = { id: "person-1", role: "MODERATOR" },
  terms: Terms = beforeTerms,
  status: "CURRENT" | "STALE" | "BLOCKED" | "UNAVAILABLE" = "CURRENT",
): Pick<StakeholderBindingInput, "authority" | "purpose" | "retention"> {
  const beforeFingerprint = fingerprintStakeholderRevision({
    kind,
    actor,
    id,
    scope,
    revision: 1,
    terms,
  });
  const authority = {
    evidenceId: `authority-${id}`,
    version: 1,
    scope,
    status,
    subject: actor,
    record: { family: kind, id, scope, revision: 1, fingerprint: beforeFingerprint },
    issuedAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-12-31T00:00:00Z",
  } as const;
  const purpose = {
    evidenceId: `purpose-${id}`,
    version: 1,
    scope,
    status,
    subject: actor,
    purpose: "commitment-reconfirmation",
    effectiveAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-12-31T00:00:00Z",
  } as const;
  const retention = {
    evidenceId: `retention-${id}`,
    version: 1,
    scope,
    status,
    subject: actor,
    retentionUntil: "2027-12-31T00:00:00Z",
    policy: "participant-commitment",
  } as const;
  return {
    authority: { ...authority, fingerprint: fingerprintAuthorityEvidence(authority) },
    purpose: { ...purpose, fingerprint: fingerprintPurposeEvidence(purpose) },
    retention: { ...retention, fingerprint: fingerprintRetentionEvidence(retention) },
  };
}

function stakeholder(
  id: string,
  before: Terms,
  after: Terms,
  options: {
    readonly kind?: "COMMITMENT" | "APPROVAL";
    readonly actor?: { readonly id: string; readonly role: string };
    readonly evidenceStatus?: "CURRENT" | "STALE" | "BLOCKED" | "UNAVAILABLE";
    readonly includeEvidence?: boolean;
  } = {},
): StakeholderBindingInput {
  const kind = options.kind ?? "COMMITMENT";
  const actor = options.actor ?? { id: `person-${id}`, role: "MODERATOR" };
  const evidence = options.includeEvidence === false
    ? {}
    : evidenceFor(id, kind, actor, before, options.evidenceStatus ?? "CURRENT");
  return {
    id,
    actor,
    kind,
    source: { family: sourceFamily, id: "assignment-1", scope },
    before: { id, scope, revision: 1, terms: before },
    after: { id, scope, revision: 2, terms: after },
    ...evidence,
  };
}

function command(
  sourceBefore: Terms = beforeTerms,
  sourceAfter: Terms = movedTerms,
  stakeholders: readonly StakeholderBindingInput[] = [stakeholder("commitment-1", beforeTerms, movedTerms)],
  overrides: Partial<SurgicalReconfirmationCommand> = {},
): SurgicalReconfirmationCommand {
  return {
    schema: "sympose-surgical-reconfirmation/v1",
    commandType: "DERIVE_SURGICAL_RECONFIRMATION",
    commandId: "command-1",
    idempotencyKey: "idempotency-1",
    scope,
    asOf,
    purpose: "commitment-reconfirmation",
    beforeArtifact: { family: sourceFamily, id: "assignment-1", scope, revision: 10, content: sourceBefore },
    afterArtifact: { family: sourceFamily, id: "assignment-1", scope, revision: 11, content: sourceAfter },
    materialPolicy: policy,
    stakeholders,
    ...overrides,
  };
}

describe("surgical reconfirmation core", () => {
  it("requests only the affected stakeholder and exact changed material path", () => {
    const result = deriveSurgicalReconfirmation(command());
    expect(result.status).toBe("REQUIRED");
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      stakeholderId: "commitment-1",
      targetActorId: "person-commitment-1",
      targetRole: "MODERATOR",
      status: "REQUIRED",
      reasonCode: "MATERIAL_TERM_CHANGED",
    });
    expect(result.receipts[0]?.materialTerms).toEqual([expect.objectContaining({
      path: "time",
      kind: "TIME",
      before: beforeTerms.time,
      after: movedTerms.time,
      beforePresent: true,
      afterPresent: true,
    })]);
    expect(result.receipts[0]?.source.beforeFingerprint).not.toBe(result.receipts[0]?.source.afterFingerprint);
    expect(result.receipts[0]?.prior.fingerprint).toBe(fingerprintStakeholderRevision({
      kind: "COMMITMENT",
      actor: { id: "person-commitment-1", role: "MODERATOR" },
      id: "commitment-1",
      scope,
      revision: 1,
      terms: beforeTerms,
    }));
  });

  it("handles multiple stakeholders surgically instead of requesting blanket reacceptance", () => {
    const first = stakeholder("commitment-1", beforeTerms, movedTerms);
    const second = stakeholder("commitment-2", beforeTerms, beforeTerms, { actor: { id: "person-2", role: "ATTENDEE" } });
    const result = deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [first, second]));
    expect(result.receipts.map((receipt) => [receipt.stakeholderId, receipt.status])).toEqual([
      ["commitment-1", "REQUIRED"],
      ["commitment-2", "UNAFFECTED"],
    ]);
    expect(result.receipts[1]?.materialTerms).toEqual([]);
  });

  it("does not request reconfirmation for unchanged or explicitly non-material edits", () => {
    const unchanged = deriveSurgicalReconfirmation(command(beforeTerms, beforeTerms, [stakeholder("commitment-1", beforeTerms, beforeTerms, { includeEvidence: false })]));
    expect(unchanged.status).toBe("UNAFFECTED");
    expect(unchanged.receipts[0]?.status).toBe("UNAFFECTED");
    expect(unchanged.receipts[0]?.reasonCode).toBe("NO_MATERIAL_TERM_CHANGE");

    const nonMaterial = deriveSurgicalReconfirmation(command(beforeTerms, editedNotesTerms, [stakeholder("commitment-1", beforeTerms, editedNotesTerms, { includeEvidence: false })]));
    expect(nonMaterial.status).toBe("UNAFFECTED");
    expect(nonMaterial.receipts[0]?.status).toBe("UNAFFECTED");
    expect(nonMaterial.receipts[0]?.reasonCode).toBe("NON_MATERIAL_CHANGE");
    expect(nonMaterial.receipts[0]?.materialTerms).toEqual([]);
  });

  it("distinguishes unavailable evidence from stale or blocked evidence", () => {
    const unavailable = deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [stakeholder("commitment-1", beforeTerms, movedTerms, { includeEvidence: false })]));
    expect(unavailable.status).toBe("UNAVAILABLE");
    expect(unavailable.receipts[0]?.status).toBe("UNAVAILABLE");
    expect(unavailable.receipts[0]?.authority).toBeNull();

    const stale = deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [stakeholder("commitment-1", beforeTerms, movedTerms, { evidenceStatus: "STALE" })]));
    expect(stale.status).toBe("BLOCKED");
    expect(stale.receipts[0]?.status).toBe("BLOCKED");
    expect(stale.receipts[0]?.reasonCode).toBe("EVIDENCE_BLOCKED");
  });

  it("rejects forged evidence, scope crossings, unknown families, and unknown material paths", () => {
    const forged = command();
    const forgedStakeholder = forged.stakeholders[0]!;
    const forgedAuthority = { ...forgedStakeholder.authority!, fingerprint: "f".repeat(64) };
    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...forged,
      stakeholders: [{ ...forgedStakeholder, authority: forgedAuthority }],
    }))).toBe("FORGED_EVIDENCE");

    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...forged,
      afterArtifact: { ...forged.afterArtifact, scope: { workspaceId: "other-workspace", eventId: "event-1" } },
    }))).toBe("SCOPE_MISMATCH");

    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...forged,
      beforeArtifact: { ...forged.beforeArtifact, family: "FUTURE_FAMILY" },
    } as unknown as SurgicalReconfirmationCommand))).toBe("UNKNOWN_FAMILY");

    expect(errorCode(() => deriveSurgicalReconfirmation(command(
      { ...beforeTerms, extra: "before" } as Terms & { readonly extra: string },
      { ...movedTerms, extra: "after" } as Terms & { readonly extra: string },
    )))).toBe("UNKNOWN_MATERIAL_POLICY");

    const forgedTerms = { ...movedTerms, role: "SPEAKER" };
    expect(errorCode(() => deriveSurgicalReconfirmation(command(
      beforeTerms,
      movedTerms,
      [stakeholder("commitment-1", beforeTerms, forgedTerms)],
    )))).toBe("SOURCE_BINDING_MISMATCH");
  });

  it("rejects conflicting aliases, ambiguous dates, cycles, and graph bounds", () => {
    const base = command();
    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...base,
      beforeSource: { ...base.beforeArtifact, content: movedTerms },
    } as unknown as SurgicalReconfirmationCommand))).toBe("CONFLICTING_ALIAS");

    expect(errorCode(() => deriveSurgicalReconfirmation({ ...base, asOf: "2026-08-13" } as unknown as SurgicalReconfirmationCommand))).toBe("INVALID_DATE");

    const root = { family: sourceFamily, id: "assignment-1", scope };
    const middle = { family: "ARTIFACT", id: "artifact-1", scope };
    const target = { family: "COMMITMENT", id: "commitment-1", scope };
    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...base,
      dependencyGraph: [
        { from: root, to: middle, relation: "DERIVED_FROM" },
        { from: middle, to: root, relation: "REFERENCES" },
      ],
    }))).toBe("GRAPH_CYCLE");

    expect(errorCode(() => deriveSurgicalReconfirmation({
      ...base,
      dependencyGraph: [
        { from: root, to: middle, relation: "DERIVED_FROM" },
        { from: middle, to: target, relation: "INVALIDATES" },
      ],
      limits: { maxGraphEdges: 1 },
    }))).toBe("BOUNDS_EXCEEDED");

    expect(errorCode(() => deriveSurgicalReconfirmation(command(
      beforeTerms,
      movedTerms,
      [
        stakeholder("commitment-1", beforeTerms, movedTerms),
        stakeholder("commitment-2", beforeTerms, movedTerms, { actor: { id: "person-2", role: "MODERATOR" } }),
      ],
      { limits: { maxReceipts: 1 } },
    )))).toBe("BOUNDS_EXCEEDED");

    expect(errorCode(() => deriveSurgicalReconfirmation(command(
      { ...beforeTerms, time: "2026-09-18T10:00:00" },
      { ...movedTerms, time: "2026-09-18T10:30:00" },
      [stakeholder("commitment-1", { ...beforeTerms, time: "2026-09-18T10:00:00" }, { ...movedTerms, time: "2026-09-18T10:30:00" }, { includeEvidence: false })],
    )))).toBe("INVALID_DATE");
  });

  it("snapshots without accessors, serializers, cycles, or caller mutation", () => {
    const getterCommand = command() as unknown as Record<string, unknown>;
    Object.defineProperty(getterCommand, "commandId", { enumerable: true, get: () => "should-not-run" });
    expect(errorCode(() => deriveSurgicalReconfirmation(getterCommand as unknown as SurgicalReconfirmationCommand))).toBe("HOSTILE_DESCRIPTOR");

    const serializingCommand = command() as unknown as Record<string, unknown>;
    serializingCommand.toJSON = () => "unsafe";
    expect(errorCode(() => deriveSurgicalReconfirmation(serializingCommand as unknown as SurgicalReconfirmationCommand))).toBe("UNSUPPORTED_VALUE");

    const cyclic = command();
    const cyclicTerms = { ...beforeTerms } as { time: string; role: string; notes: string; cycle?: unknown };
    cyclicTerms.cycle = cyclicTerms;
    expect(errorCode(() => deriveSurgicalReconfirmation(command(cyclicTerms as Terms, movedTerms)))).toBe("CYCLE_INPUT");

    const proxy = new Proxy(command(), {
      ownKeys: () => { throw new Error("trap"); },
    });
    expect(errorCode(() => deriveSurgicalReconfirmation(proxy))).toBe("PROXY_INPUT");

    const original = command(
      { ...beforeTerms },
      { ...movedTerms },
      [stakeholder("commitment-1", { ...beforeTerms }, { ...movedTerms })],
    );
    const result = deriveSurgicalReconfirmation(original);
    const expectedBeforeTime = result.receipts[0]?.materialTerms[0]?.before;
    (original.beforeArtifact.content as unknown as Record<string, string>).time = "2099-01-01T00:00:00Z";
    expect(result.receipts[0]?.materialTerms[0]?.before).toBe(expectedBeforeTime);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts)).toBe(true);
    expect(Object.isFrozen(result.receipts[0])).toBe(true);
    expect(() => (result.receipts as unknown as unknown[]).push(result.receipts[0])).toThrow();
  });

  it("is deterministic across object and stakeholder order, with no action surface", () => {
    const first = command();
    const second = {
      ...first,
      stakeholders: [first.stakeholders[0]!].map((value) => ({
        ...value,
        before: { ...value.before, terms: { notes: beforeTerms.notes, role: beforeTerms.role, time: beforeTerms.time } },
        after: { ...value.after, terms: { notes: movedTerms.notes, role: movedTerms.role, time: movedTerms.time } },
      })),
      beforeArtifact: { ...first.beforeArtifact, content: { notes: beforeTerms.notes, role: beforeTerms.role, time: beforeTerms.time } },
      afterArtifact: { ...first.afterArtifact, content: { notes: movedTerms.notes, role: movedTerms.role, time: movedTerms.time } },
      materialPolicy: { ...policy, rules: [...policy.rules].reverse() },
    };
    const firstResult = deriveSurgicalReconfirmation(first);
    const secondResult = deriveSurgicalReconfirmation(second);
    expect(secondResult.fingerprint).toBe(firstResult.fingerprint);
    expect(secondResult.graph.fingerprint).toBe(firstResult.graph.fingerprint);
    expect(Object.keys(secondResult).some((key) => ["apply", "send", "execute", "callback", "mutate"].includes(key))).toBe(false);
    expect((secondResult as unknown as { apply?: unknown }).apply).toBeUndefined();

    const equivalentTimezone = deriveSurgicalReconfirmation(command(
      { ...beforeTerms, time: "2026-09-18T10:00:00+00:00" },
      { ...movedTerms, time: "2026-09-18T10:30:00+00:00" },
      [stakeholder("commitment-1", { ...beforeTerms, time: "2026-09-18T10:00:00+00:00" }, { ...movedTerms, time: "2026-09-18T10:30:00+00:00" })],
    ));
    expect(equivalentTimezone.status).toBe("REQUIRED");
    expect(equivalentTimezone.receipts[0]?.materialTerms[0]?.before).toBe("2026-09-18T10:00:00+00:00");
  });

  it("rejects same-path stakeholder values that are not the exact canonical source transition", () => {
    const stakeholderBefore = { ...beforeTerms, time: "2026-09-18T09:00:00Z" };
    const stakeholderAfter = { ...movedTerms, time: "2026-09-18T11:00:00Z" };
    expect(errorCode(() => deriveSurgicalReconfirmation(command(
      beforeTerms,
      movedTerms,
      [stakeholder("commitment-1", stakeholderBefore, stakeholderAfter, { includeEvidence: false })],
    )))).toBe("SOURCE_BINDING_MISMATCH");

    const valid = deriveSurgicalReconfirmation(command());
    expect(valid.receipts[0]?.materialTerms[0]?.sourceBindingFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects transparent proxies and non-ordinary records before traps at every depth", () => {
    expect(errorCode(() => deriveSurgicalReconfirmation(new Proxy(command(), {})))).toBe("PROXY_INPUT");

    let trapCalls = 0;
    const trapped = new Proxy(command(), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error("getPrototypeOf trap must not run");
      },
      ownKeys: () => {
        trapCalls += 1;
        throw new Error("ownKeys trap must not run");
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        throw new Error("descriptor trap must not run");
      },
    });
    expect(errorCode(() => deriveSurgicalReconfirmation(trapped))).toBe("PROXY_INPUT");
    expect(trapCalls).toBe(0);

    const nestedProxy = new Proxy({ ...beforeTerms }, {});
    expect(errorCode(() => deriveSurgicalReconfirmation(command(nestedProxy, movedTerms)))).toBe("PROXY_INPUT");

    const nullPrototype = Object.assign(Object.create(null) as object, beforeTerms) as Terms;
    expect(errorCode(() => deriveSurgicalReconfirmation(command(nullPrototype, movedTerms)))).toBe("UNSUPPORTED_VALUE");

    class CustomTerms {
      readonly time = beforeTerms.time;
      readonly role = beforeTerms.role;
      readonly notes = beforeTerms.notes;
    }
    expect(errorCode(() => deriveSurgicalReconfirmation(command(new CustomTerms(), movedTerms)))).toBe("UNSUPPORTED_VALUE");

    const hiddenDescriptor = { ...beforeTerms } as Terms & { readonly hidden?: string };
    Object.defineProperty(hiddenDescriptor, "hidden", { value: "not plain JSON data", enumerable: false });
    expect(errorCode(() => deriveSurgicalReconfirmation(command(hiddenDescriptor, movedTerms)))).toBe("HOSTILE_DESCRIPTOR");
  });

  it("validates supplied unavailable evidence bindings before interpreting availability", () => {
    const unavailable = stakeholder("commitment-1", beforeTerms, movedTerms, { evidenceStatus: "UNAVAILABLE" });
    expect(deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [unavailable])).status).toBe("UNAVAILABLE");

    const { fingerprint: _authorityFingerprint, ...authorityBase } = unavailable.authority!;
    const authoritySubjectPayload = { ...authorityBase, subject: { id: "other-person", role: unavailable.actor.role } };
    const authorityRecordPayload = { ...authorityBase, record: { ...authorityBase.record, id: "other-commitment" } };
    const authoritySubject = { ...authoritySubjectPayload, fingerprint: fingerprintAuthorityEvidence(authoritySubjectPayload) };
    const authorityRecord = { ...authorityRecordPayload, fingerprint: fingerprintAuthorityEvidence(authorityRecordPayload) };

    const { fingerprint: _purposeFingerprint, ...purposeBase } = unavailable.purpose!;
    const purposePayload = { ...purposeBase, purpose: "different-purpose" };
    const misboundPurpose = { ...purposePayload, fingerprint: fingerprintPurposeEvidence(purposePayload) };

    const { fingerprint: _retentionFingerprint, ...retentionBase } = unavailable.retention!;
    const retentionPayload = { ...retentionBase, retentionUntil: "2026-08-13T11:59:59Z" };
    const misboundRetention = { ...retentionPayload, fingerprint: fingerprintRetentionEvidence(retentionPayload) };

    const misbound = [
      { label: "authority subject", value: { ...unavailable, authority: authoritySubject } },
      { label: "authority record", value: { ...unavailable, authority: authorityRecord } },
      { label: "purpose", value: { ...unavailable, purpose: misboundPurpose } },
      { label: "retention", value: { ...unavailable, retention: misboundRetention } },
    ] as const;
    for (const testCase of misbound) {
      const result = deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [testCase.value]));
      expect(result.status, testCase.label).toBe("BLOCKED");
      expect(result.receipts[0]?.reasonCode, testCase.label).toBe("EVIDENCE_BLOCKED");
    }

    const foreignScope = { workspaceId: "other-workspace", eventId: scope.eventId };
    const foreignScopePayload = { ...authorityBase, scope: foreignScope };
    const foreignScopeAuthority = {
      ...foreignScopePayload,
      fingerprint: fingerprintAuthorityEvidence(foreignScopePayload),
    };
    expect(errorCode(() => deriveSurgicalReconfirmation(command(beforeTerms, movedTerms, [
      { ...unavailable, authority: foreignScopeAuthority },
    ])))).toBe("SCOPE_MISMATCH");
  });
});
