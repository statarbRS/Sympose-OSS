import { describe, expect, it } from "vitest";

import {
  ACTOR_EVIDENCE_SCHEMA,
  AUTHORITY_EVIDENCE_SCHEMA,
  COMMAND_ENVELOPE_SCHEMA,
  COMMAND_IDENTITY_SCHEMA,
  MAX_ARRAY_ITEMS,
  MAX_BYTES,
  MAX_CANONICAL_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  PURPOSE_EVIDENCE_SCHEMA,
  RETENTION_EVIDENCE_SCHEMA,
  AuthorityPurposeKernelInputError,
  canonicalJson,
  createActorEvidence,
  createAuthorityEvidence,
  createCommandEnvelope,
  createCommandIdentityEvidence,
  createPurposeAuthorizationEvidence,
  createRetentionEvidence,
  fingerprintActorEvidence,
  fingerprintOf,
  fingerprintPurposeAuthorizationEvidence,
  fingerprintRetentionEvidence,
  preflight,
  type ActorEvidence,
  type AuthorityEvidence,
  type CommandEnvelopeInput,
  type CommandIdentityEvidence,
  type PurposeAuthorizationEvidence,
  type RetentionEvidence,
} from "../../src/server/services/authority-purpose-kernel";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T13:00:00.000Z";
const TOMORROW = "2026-08-13T12:00:00.000Z";
const SUBJECT = { kind: "PERSON", id: "person-001" } as const;
const WORKSPACE_ID = "workspace-001";
const EVENT_ID = "event-001";
const ACTOR_ID = "actor-evidence-001";
const PURPOSE_ID = "purpose-001";
const RETENTION_ID = "retention-001";
const AUTHORITY_FINGERPRINT = fingerprintOf({ authority: "v1" });

function actorContent(): Omit<ActorEvidence, "schema" | "fingerprint"> {
  return {
    evidenceId: ACTOR_ID,
    version: 1,
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    subject: SUBJECT,
    actorId: "account-001",
  };
}

function purposeContent(): Omit<PurposeAuthorizationEvidence, "schema" | "fingerprint"> {
  return {
    purposeId: PURPOSE_ID,
    version: 1,
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    subject: SUBJECT,
    allowedActionFamilies: ["AUDIENCE_RELEASE", "CURATORIAL_SEPARATION"],
    allowedFactFamilies: ["COMMITMENT", "DECISION"],
    validFrom: NOW,
    expiresAt: TOMORROW,
    revoked: false,
  };
}

function retentionContent(): Omit<RetentionEvidence, "schema" | "fingerprint"> {
  return {
    policyId: RETENTION_ID,
    version: 1,
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    subject: SUBJECT,
    allowedFactFamilies: ["COMMITMENT", "DECISION"],
    retainUntil: TOMORROW,
    deleted: false,
    withdrawn: false,
  };
}

function authorityContent(): Omit<AuthorityEvidence, "schema"> {
  return {
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    vector: [{ family: "AUTHORITY_KERNEL", version: 1, fingerprint: AUTHORITY_FINGERPRINT }],
  };
}

function actor(): Readonly<ActorEvidence> {
  const content = actorContent();
  return createActorEvidence({ ...content, fingerprint: fingerprintActorEvidence(content) });
}

function purpose(overrides: Partial<PurposeAuthorizationEvidence> = {}): Readonly<PurposeAuthorizationEvidence> {
  const content = { ...purposeContent(), ...overrides };
  const { schema: _schema, fingerprint: _fingerprint, ...withoutFingerprint } = content as Partial<PurposeAuthorizationEvidence> & { schema?: string };
  return createPurposeAuthorizationEvidence({
    ...withoutFingerprint,
    fingerprint: fingerprintPurposeAuthorizationEvidence(withoutFingerprint),
  });
}

function retention(overrides: Partial<RetentionEvidence> = {}): Readonly<RetentionEvidence> {
  const content = { ...retentionContent(), ...overrides };
  const { schema: _schema, fingerprint: _fingerprint, ...withoutFingerprint } = content as Partial<RetentionEvidence> & { schema?: string };
  return createRetentionEvidence({
    ...withoutFingerprint,
    fingerprint: fingerprintRetentionEvidence(withoutFingerprint),
  });
}

function authority(overrides: Partial<AuthorityEvidence> = {}): Readonly<AuthorityEvidence> {
  return createAuthorityEvidence({ ...authorityContent(), ...overrides });
}

function command(overrides: Partial<CommandEnvelopeInput> = {}): ReturnType<typeof createCommandEnvelope> {
  const actorEvidence = actor();
  const purposeEvidence = purpose();
  const retentionEvidence = retention();
  return createCommandEnvelope({
    workspaceId: WORKSPACE_ID,
    eventId: EVENT_ID,
    subject: SUBJECT,
    actionFamily: "AUDIENCE_RELEASE",
    factFamilies: ["DECISION", "COMMITMENT"],
    commandId: "command-001",
    idempotencyKey: "idem-001",
    actorEvidenceRef: {
      id: actorEvidence.evidenceId,
      version: actorEvidence.version,
      fingerprint: actorEvidence.fingerprint,
    },
    purposeAuthorizationRef: {
      id: purposeEvidence.purposeId,
      version: purposeEvidence.version,
      fingerprint: purposeEvidence.fingerprint,
    },
    retentionAuthorizationRef: {
      id: retentionEvidence.policyId,
      version: retentionEvidence.version,
      fingerprint: retentionEvidence.fingerprint,
    },
    expectedAuthorityVector: [{ family: "AUTHORITY_KERNEL", version: 1, fingerprint: AUTHORITY_FINGERPRINT }],
    issuedAt: NOW,
    payloadFingerprint: fingerprintOf({ bounded: "opaque-payload" }),
    ...overrides,
  });
}

function identity(
  currentCommand: ReturnType<typeof command> = command(),
  actorEvidence: Readonly<ActorEvidence> = actor(),
  overrides: Partial<CommandIdentityEvidence> = {},
): Readonly<CommandIdentityEvidence> {
  return createCommandIdentityEvidence({
    workspaceId: currentCommand.workspaceId,
    eventId: currentCommand.eventId,
    state: "UNSEEN",
    commandId: currentCommand.commandId,
    idempotencyKey: currentCommand.idempotencyKey,
    actorId: actorEvidence.actorId,
    subject: currentCommand.subject,
    actionFamily: currentCommand.actionFamily,
    actorEvidenceRef: currentCommand.actorEvidenceRef,
    purposeAuthorizationRef: currentCommand.purposeAuthorizationRef,
    retentionAuthorizationRef: currentCommand.retentionAuthorizationRef,
    expectedAuthorityVector: currentCommand.expectedAuthorityVector,
    payloadFingerprint: currentCommand.payloadFingerprint,
    commandFingerprint: fingerprintOf(currentCommand),
    ...overrides,
  });
}

function matchedIdentity(
  currentCommand: ReturnType<typeof command>,
  actorEvidence: Readonly<ActorEvidence> = actor(),
  overrides: Partial<CommandIdentityEvidence> = {},
): Readonly<CommandIdentityEvidence> {
  return identity(currentCommand, actorEvidence, {
    state: "MATCHED",
    ...overrides,
  });
}

function readyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: command(),
    now: NOW,
    actorEvidence: actor(),
    purposeEvidence: purpose(),
    retentionEvidence: retention(),
    authorityEvidence: authority(),
    idempotencyEvidence: identity(),
    ...overrides,
  };
}

function scopedReadyInput(options: {
  workspaceId?: string;
  eventId?: string;
  subject?: { readonly kind: string; readonly id: string };
  actorId?: string;
  actionFamily?: string;
  purposeId?: string;
  retentionId?: string;
  authorityVector?: AuthorityEvidence["vector"];
  payloadFingerprint?: string;
  issuedAt?: string;
  now?: string;
} = {}) {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const eventId = options.eventId ?? EVENT_ID;
  const subject = options.subject ?? SUBJECT;
  const actionFamily = options.actionFamily ?? "AUDIENCE_RELEASE";
  const actorBody = {
    ...actorContent(),
    workspaceId,
    eventId,
    subject,
    actorId: options.actorId ?? actorContent().actorId,
  };
  const actorEvidence = createActorEvidence({
    ...actorBody,
    fingerprint: fingerprintActorEvidence(actorBody),
  });
  const purposeBody = {
    ...purposeContent(),
    purposeId: options.purposeId ?? PURPOSE_ID,
    workspaceId,
    eventId,
    subject,
    allowedActionFamilies: [actionFamily],
  };
  const purposeEvidence = createPurposeAuthorizationEvidence({
    ...purposeBody,
    fingerprint: fingerprintPurposeAuthorizationEvidence(purposeBody),
  });
  const retentionBody = {
    ...retentionContent(),
    policyId: options.retentionId ?? RETENTION_ID,
    workspaceId,
    eventId,
    subject,
  };
  const retentionEvidence = createRetentionEvidence({
    ...retentionBody,
    fingerprint: fingerprintRetentionEvidence(retentionBody),
  });
  const expectedAuthorityVector = options.authorityVector ?? authorityContent().vector;
  const currentCommand = createCommandEnvelope({
    workspaceId,
    eventId,
    subject,
    actionFamily,
    factFamilies: ["DECISION", "COMMITMENT"],
    commandId: "command-001",
    idempotencyKey: "idem-001",
    actorEvidenceRef: {
      id: actorEvidence.evidenceId,
      version: actorEvidence.version,
      fingerprint: actorEvidence.fingerprint,
    },
    purposeAuthorizationRef: {
      id: purposeEvidence.purposeId,
      version: purposeEvidence.version,
      fingerprint: purposeEvidence.fingerprint,
    },
    retentionAuthorizationRef: {
      id: retentionEvidence.policyId,
      version: retentionEvidence.version,
      fingerprint: retentionEvidence.fingerprint,
    },
    expectedAuthorityVector,
    issuedAt: options.issuedAt ?? NOW,
    payloadFingerprint: options.payloadFingerprint ?? fingerprintOf({ bounded: "opaque-payload" }),
  });
  return {
    command: currentCommand,
    now: options.now ?? NOW,
    actorEvidence,
    purposeEvidence,
    retentionEvidence,
    authorityEvidence: createAuthorityEvidence({ workspaceId, eventId, vector: expectedAuthorityVector }),
    idempotencyEvidence: identity(currentCommand, actorEvidence),
  };
}

function codes(result: ReturnType<typeof preflight>): string[] {
  return result.receipts.map((receipt) => receipt.code);
}

function expectInputError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected input error");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorityPurposeKernelInputError);
    expect((error as AuthorityPurposeKernelInputError).code).toBe(code);
  }
}

describe("authority-purpose-kernel", () => {
  it("creates an exact detached immutable command envelope without executable payload", () => {
    const raw = {
      workspaceId: WORKSPACE_ID,
      eventId: EVENT_ID,
      subject: { ...SUBJECT },
      actionFamily: " audience_release ",
      factFamilies: ["COMMITMENT", "DECISION"],
      commandId: "command-001",
      idempotencyKey: "idem-001",
      actorEvidenceRef: { id: ACTOR_ID, version: 1, fingerprint: fingerprintOf("actor") },
      purposeAuthorizationRef: { id: PURPOSE_ID, version: 1, fingerprint: fingerprintOf("purpose") },
      retentionAuthorizationRef: { id: RETENTION_ID, version: 1, fingerprint: fingerprintOf("retention") },
      expectedAuthorityVector: [{ family: "AUTHORITY_KERNEL", version: 1, fingerprint: AUTHORITY_FINGERPRINT }],
      issuedAt: NOW,
      payloadFingerprint: fingerprintOf("opaque"),
    };
    const envelope = createCommandEnvelope(raw);

    expect(envelope.schema).toBe(COMMAND_ENVELOPE_SCHEMA);
    expect(envelope.actionFamily).toBe("AUDIENCE_RELEASE");
    expect(envelope.factFamilies).toEqual(["COMMITMENT", "DECISION"]);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.subject)).toBe(true);
    expect(Object.isFrozen(envelope.factFamilies)).toBe(true);
    expect(Object.isFrozen(envelope.expectedAuthorityVector)).toBe(true);

    raw.factFamilies[0] = "MUTATED";
    (raw.subject as { id: string }).id = "mutated";
    expect(envelope.factFamilies).toEqual(["COMMITMENT", "DECISION"]);
    expect(envelope.subject.id).toBe(SUBJECT.id);
    expect(Object.keys(envelope).sort()).toEqual([
      "actionFamily",
      "actorEvidenceRef",
      "commandId",
      "eventId",
      "expectedAuthorityVector",
      "factFamilies",
      "idempotencyKey",
      "issuedAt",
      "payloadFingerprint",
      "purposeAuthorizationRef",
      "retentionAuthorizationRef",
      "schema",
      "subject",
      "workspaceId",
    ].sort());
  });

  it("is deterministic across object-key, family, and authority-vector permutations", () => {
    const first = command({
      factFamilies: ["COMMITMENT", "DECISION"],
      expectedAuthorityVector: [
        { family: "ZETA", version: 2, fingerprint: fingerprintOf("zeta") },
        { family: "ALPHA", version: 1, fingerprint: fingerprintOf("alpha") },
      ],
    });
    const second = createCommandEnvelope({
      payloadFingerprint: first.payloadFingerprint,
      issuedAt: first.issuedAt,
      expectedAuthorityVector: [
        { fingerprint: fingerprintOf("alpha"), version: 1, family: "ALPHA" },
        { fingerprint: fingerprintOf("zeta"), family: "ZETA", version: 2 },
      ],
      retentionAuthorizationRef: first.retentionAuthorizationRef,
      purposeAuthorizationRef: first.purposeAuthorizationRef,
      actorEvidenceRef: first.actorEvidenceRef,
      idempotencyKey: first.idempotencyKey,
      commandId: first.commandId,
      factFamilies: ["DECISION", "COMMITMENT"],
      actionFamily: first.actionFamily,
      subject: { id: first.subject.id, kind: first.subject.kind },
      eventId: first.eventId,
      workspaceId: first.workspaceId,
    });

    expect(first).toEqual(second);
    expect(fingerprintOf(first)).toBe(fingerprintOf(second));
  });

  it("returns READY only when current actor, purpose, retention, authority, and idempotency evidence all match", () => {
    const result = preflight(readyInput());

    expect(result.state).toBe("READY");
    expect(result.receipts).toEqual([]);
    expect(result.commandFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts)).toBe(true);
  });

  it("recomputes every declared evidence fingerprint and blocks altered bodies that retain old hashes", () => {
    const currentActor = actor();
    const currentPurpose = purpose();
    const currentRetention = retention();
    const alteredActor = { ...currentActor, actorId: "account-evil" };
    const alteredPurpose = {
      ...currentPurpose,
      allowedActionFamilies: [...currentPurpose.allowedActionFamilies, "UNRELATED_ACTION"],
    };
    const alteredRetention = {
      ...currentRetention,
      retainUntil: "2026-08-14T12:00:00.000Z",
    };

    expectInputError(() => createActorEvidence(alteredActor), "INVALID_VALUE");
    expectInputError(() => createPurposeAuthorizationEvidence(alteredPurpose), "INVALID_VALUE");
    expectInputError(() => createRetentionEvidence(alteredRetention), "INVALID_VALUE");

    const result = preflight(readyInput({
      actorEvidence: alteredActor,
      purposeEvidence: alteredPurpose,
      retentionEvidence: alteredRetention,
    }));

    expect(result.state).toBe("BLOCKED");
    expect(codes(result)).toEqual(expect.arrayContaining([
      "ACTOR_FINGERPRINT_STALE",
      "PURPOSE_FINGERPRINT_STALE",
      "RETENTION_FINGERPRINT_STALE",
    ]));
    expect(result.receipts.map((item) => item.path)).toEqual(expect.arrayContaining([
      "actorEvidence.fingerprint",
      "purposeEvidence.fingerprint",
      "retentionEvidence.fingerprint",
    ]));
  });

  it("distinguishes unavailable evidence from present-but-blocked evidence", () => {
    const unavailable = preflight({ command: command(), now: NOW });
    expect(unavailable.state).toBe("UNAVAILABLE");
    expect(codes(unavailable)).toEqual([
      "ACTOR_EVIDENCE_MISSING",
      "AUTHORITY_EVIDENCE_MISSING",
      "IDEMPOTENCY_EVIDENCE_MISSING",
      "PURPOSE_EVIDENCE_MISSING",
      "RETENTION_EVIDENCE_MISSING",
    ]);

    const blocked = preflight(
      readyInput({
        purposeEvidence: purpose({ revoked: true }),
        retentionEvidence: { available: false, reason: "retention-source-not-loaded" },
      }),
    );
    expect(blocked.state).toBe("BLOCKED");
    expect(codes(blocked)).toContain("PURPOSE_REVOKED");
    expect(codes(blocked)).toContain("RETENTION_EVIDENCE_UNAVAILABLE");
  });

  it("fails closed for scope, stale reference, authority, and command identity mismatches", () => {
    const currentPurpose = purpose();
    const currentRetention = retention();
    const currentActor = actor();
    const otherActorContent = { ...actorContent(), workspaceId: "workspace-other" };
    const mismatchedCommand = command({
      workspaceId: "workspace-other",
      actorEvidenceRef: { id: currentActor.evidenceId, version: 9, fingerprint: fingerprintOf("old-actor") },
      purposeAuthorizationRef: { id: currentPurpose.purposeId, version: 9, fingerprint: fingerprintOf("old-purpose") },
      retentionAuthorizationRef: { id: currentRetention.policyId, version: 9, fingerprint: fingerprintOf("old-retention") },
      expectedAuthorityVector: [{ family: "AUTHORITY_KERNEL", version: 9, fingerprint: fingerprintOf("old-authority") }],
    });
    const result = preflight(
      readyInput({
        command: mismatchedCommand,
        actorEvidence: createActorEvidence({ ...otherActorContent, fingerprint: fingerprintActorEvidence(otherActorContent) }),
        purposeEvidence: purpose(),
        retentionEvidence: retention(),
        authorityEvidence: authority({ vector: [{ family: "AUTHORITY_KERNEL", version: 8, fingerprint: fingerprintOf("other-authority") }] }),
        idempotencyEvidence: matchedIdentity(command(), actor(), {
          commandId: "other-command",
          idempotencyKey: "other-idem",
          payloadFingerprint: fingerprintOf("other-payload"),
        }),
      }),
    );

    expect(result.state).toBe("BLOCKED");
    expect(codes(result)).toEqual(expect.arrayContaining([
      "ACTOR_VERSION_STALE",
      "ACTOR_FINGERPRINT_STALE",
      "PURPOSE_VERSION_STALE",
      "PURPOSE_FINGERPRINT_STALE",
      "RETENTION_VERSION_STALE",
      "RETENTION_FINGERPRINT_STALE",
      "AUTHORITY_VERSION_STALE",
      "AUTHORITY_FINGERPRINT_STALE",
      "COMMAND_IDENTITY_MISMATCH",
      "IDEMPOTENCY_SCOPE_MISMATCH",
    ]));
  });

  it("blocks expired, revoked, deleted, withdrawn, and disallowed purpose/retention states", () => {
    const result = preflight(
      readyInput({
        now: LATER,
        purposeEvidence: purpose({
          allowedActionFamilies: ["CURATORIAL_SEPARATION"],
          allowedFactFamilies: ["DECISION"],
          expiresAt: LATER,
          revoked: true,
        }),
        retentionEvidence: retention({
          allowedFactFamilies: ["DECISION"],
          retainUntil: NOW,
          deleted: true,
          withdrawn: true,
        }),
      }),
    );

    expect(result.state).toBe("BLOCKED");
    expect(codes(result)).toEqual(expect.arrayContaining([
      "PURPOSE_EXPIRED",
      "PURPOSE_REVOKED",
      "ACTION_FAMILY_DISALLOWED",
      "FACT_FAMILY_DISALLOWED",
      "RETENTION_EXPIRED",
      "RETENTION_DELETED",
      "RETENTION_WITHDRAWN",
      "RETENTION_FACT_FAMILY_DISALLOWED",
    ]));
  });

  it("rejects inferred consent, callbacks, arbitrary payloads, and unknown fields", () => {
    expectInputError(() => createCommandEnvelope({ ...command(), payload: () => true }), "UNKNOWN_FIELD");
    expectInputError(() => createPurposeAuthorizationEvidence({
      ...purpose(),
      consent: true,
    }), "UNKNOWN_FIELD");
    expectInputError(() => createCommandEnvelope({
      ...command(),
      commandId: "same",
      idempotencyKey: "SAME",
    }), "DUPLICATE_NORMALIZED_IDENTITY");
  });

  it("requires exact UTC millisecond timestamps and rejects temporal ambiguity", () => {
    expectInputError(() => createCommandEnvelope({ ...command(), issuedAt: "2026-08-12T12:00:00Z" }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), issuedAt: "2026-08-12T14:00:00.000+02:00" }), "INVALID_VALUE");
    expectInputError(() => createPurposeAuthorizationEvidence({ ...purpose(), validFrom: "2026-02-30T12:00:00.000Z" }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), issuedAt: "2026-08-12t12:00:00.000z" }), "INVALID_VALUE");
    expect(preflight(readyInput({ now: "2026-08-12T12:00:00Z" })).state).toBe("BLOCKED");
  });

  it("rejects malformed and ambiguous identifiers", () => {
    expectInputError(() => createCommandEnvelope({ ...command(), workspaceId: "" }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), eventId: "../event-001" }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({
      ...command(),
      subject: { kind: "PERSON", id: "person/other" },
    }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), commandId: "-command" }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), idempotencyKey: "idem\ud800" }), "INVALID_VALUE");
  });

  it("rejects accessors, transparent proxies, toJSON hooks, and functions without executing them", () => {
    let executions = 0;
    const accessor: Record<string, unknown> = { ...command() };
    Object.defineProperty(accessor, "workspaceId", {
      enumerable: true,
      get: () => {
        executions += 1;
        return WORKSPACE_ID;
      },
    });
    expectInputError(() => createCommandEnvelope(accessor), "ACCESSOR_INPUT");

    const proxyTarget = { ...command() };
    const proxy = new Proxy(proxyTarget, {
      get: (target, property, receiver) => {
        executions += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor: (target, property) => {
        executions += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf: (target) => {
        executions += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        executions += 1;
        return Reflect.ownKeys(target);
      },
    });
    expectInputError(() => createCommandEnvelope(proxy), "PROXY_INPUT");
    expect(preflight({ ...readyInput(), command: proxy }).state).toBe("BLOCKED");

    const revoked = Proxy.revocable({ ...command() }, {});
    revoked.revoke();
    expectInputError(() => createCommandEnvelope(revoked.proxy), "PROXY_INPUT");

    const withToJSON = {
      value: "plain",
      toJSON: () => {
        executions += 1;
        return { value: "executed" };
      },
    };
    expectInputError(() => fingerprintOf(withToJSON), "INVALID_VALUE");
    const bytesWithToJSON = new Uint8Array([1, 2, 3]) as Uint8Array & { toJSON?: () => unknown };
    bytesWithToJSON.toJSON = () => {
      executions += 1;
      return [9, 9, 9];
    };
    expectInputError(() => fingerprintOf(bytesWithToJSON), "UNKNOWN_FIELD");
    expectInputError(() => fingerprintOf(() => {
      executions += 1;
    }), "INVALID_VALUE");
    expectInputError(() => createCommandEnvelope({ ...command(), workspace_id: WORKSPACE_ID }), "UNKNOWN_FIELD");
    expect(executions).toBe(0);
  });

  it("enforces cycle, collection, byte, node, depth, and canonical-size bounds", () => {

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expectInputError(() => fingerprintOf(cycle), "CYCLE_INPUT");

    expectInputError(() => createCommandEnvelope({ ...command(), factFamilies: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, () => "FACT") }), "BOUND_EXCEEDED");
    expectInputError(() => fingerprintOf(new Uint8Array(MAX_BYTES + 1)), "BOUND_EXCEEDED");

    const tooManyNodes = Object.fromEntries(
      Array.from({ length: MAX_NODES }, (_, index) => [`node${index}`, "x"]),
    );
    expectInputError(() => fingerprintOf(tooManyNodes), "BOUND_EXCEEDED");

    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index <= MAX_DEPTH; index += 1) deep = { next: deep };
    expectInputError(() => fingerprintOf(deep), "BOUND_EXCEEDED");

    const wide: Record<string, string> = {};
    const wideValues = Math.ceil(MAX_CANONICAL_BYTES / 512) + 1;
    for (let index = 0; index < wideValues; index += 1) wide[`key${index}`] = "x".repeat(512);
    expectInputError(() => fingerprintOf(wide), "BOUND_EXCEEDED");

    expectInputError(() => fingerprintOf(new Uint8Array(new SharedArrayBuffer(8))), "INVALID_VALUE");
  });

  it("bounds deterministic blocker output when many checks fail", () => {
    const factFamilies = Array.from({ length: MAX_ARRAY_ITEMS }, (_, index) => `FACT_${index}`);
    const actorEvidence = actor();
    const purposeBody = { ...purposeContent(), allowedFactFamilies: [] };
    const purposeEvidence = createPurposeAuthorizationEvidence({
      ...purposeBody,
      fingerprint: fingerprintPurposeAuthorizationEvidence(purposeBody),
    });
    const retentionBody = { ...retentionContent(), allowedFactFamilies: [] };
    const retentionEvidence = createRetentionEvidence({
      ...retentionBody,
      fingerprint: fingerprintRetentionEvidence(retentionBody),
    });
    const currentCommand = command({
      factFamilies,
      purposeAuthorizationRef: {
        id: purposeEvidence.purposeId,
        version: purposeEvidence.version,
        fingerprint: purposeEvidence.fingerprint,
      },
      retentionAuthorizationRef: {
        id: retentionEvidence.policyId,
        version: retentionEvidence.version,
        fingerprint: retentionEvidence.fingerprint,
      },
    });

    const result = preflight({
      command: currentCommand,
      now: NOW,
      actorEvidence,
      purposeEvidence,
      retentionEvidence,
      authorityEvidence: authority(),
      idempotencyEvidence: identity(currentCommand, actorEvidence),
    });

    expect(result.state).toBe("BLOCKED");
    expect(result.receipts).toHaveLength(MAX_ARRAY_ITEMS);
    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INPUT_REJECTED", path: "receipts", reason: "receipt-bound-exceeded" }),
    ]));
  });

  it("rejects duplicate normalized identities in every set-like vector", () => {
    expectInputError(() => createCommandEnvelope({ ...command(), factFamilies: ["DECISION", " decision "] }), "DUPLICATE_NORMALIZED_IDENTITY");
    expectInputError(() => createPurposeAuthorizationEvidence({
      ...purpose(),
      allowedActionFamilies: ["REPLAY", "replay"],
    }), "DUPLICATE_NORMALIZED_IDENTITY");
    expectInputError(() => createCommandEnvelope({
      ...command(),
      expectedAuthorityVector: [
        { family: "AUTHORITY_KERNEL", version: 1, fingerprint: AUTHORITY_FINGERPRINT },
        { family: "authority_kernel", version: 2, fingerprint: fingerprintOf("other") },
      ],
    }), "DUPLICATE_NORMALIZED_IDENTITY");
  });

  it("permits an exact idempotent replay match but never authorizes a mutation", () => {
    const current = command();
    const result = preflight(readyInput({
      command: current,
      idempotencyEvidence: matchedIdentity(current),
    }));

    expect(result.state).toBe("READY");
    expect(Object.keys(result).sort()).toEqual(["checkedAt", "commandFingerprint", "receiptFingerprint", "receipts", "schema", "state"].sort());
    expect(Object.values(result).some((value) => typeof value === "function")).toBe(false);
  });

  it("blocks replay evidence reused across subject, action, purpose, and event boundaries", () => {
    const original = scopedReadyInput();
    const originalIdentities = [
      identity(original.command, original.actorEvidence),
      matchedIdentity(original.command, original.actorEvidence),
    ];
    const variants = [
      {
        input: scopedReadyInput({ subject: { kind: "PERSON", id: "person-002" } }),
        path: "idempotencyEvidence.subject",
      },
      {
        input: scopedReadyInput({ actionFamily: "CURATORIAL_SEPARATION" }),
        path: "idempotencyEvidence.actionFamily",
      },
      {
        input: scopedReadyInput({ purposeId: "purpose-002" }),
        path: "idempotencyEvidence.purposeAuthorizationRef",
      },
      {
        input: scopedReadyInput({ eventId: "event-002" }),
        path: "idempotencyEvidence.eventId",
      },
    ];

    for (const originalIdentity of originalIdentities) {
      for (const variant of variants) {
        const result = preflight({ ...variant.input, idempotencyEvidence: originalIdentity });
        expect(result.state).toBe("BLOCKED");
        expect(result.receipts.map((item) => item.path)).toContain(variant.path);
        expect(result.receipts.map((item) => item.path)).toContain("idempotencyEvidence.commandFingerprint");
      }
    }
  });

  it("binds replay evidence to actor, retention, authority, payload, and the exact command", () => {
    const original = scopedReadyInput();
    const originalIdentity = matchedIdentity(original.command, original.actorEvidence);
    const variants = [
      {
        input: scopedReadyInput({ actorId: "account-002" }),
        path: "idempotencyEvidence.actorId",
      },
      {
        input: scopedReadyInput({ retentionId: "retention-002" }),
        path: "idempotencyEvidence.retentionAuthorizationRef",
      },
      {
        input: scopedReadyInput({
          authorityVector: [{ family: "AUTHORITY_KERNEL", version: 2, fingerprint: fingerprintOf("authority-v2") }],
        }),
        path: "idempotencyEvidence.expectedAuthorityVector",
      },
      {
        input: scopedReadyInput({ payloadFingerprint: fingerprintOf("different-payload") }),
        path: "idempotencyEvidence.payloadFingerprint",
      },
      {
        input: scopedReadyInput({ issuedAt: LATER, now: LATER }),
        path: "idempotencyEvidence.commandFingerprint",
      },
    ];

    for (const variant of variants) {
      const result = preflight({ ...variant.input, idempotencyEvidence: originalIdentity });
      expect(result.state).toBe("BLOCKED");
      expect(result.receipts.map((item) => item.path)).toContain(variant.path);
    }
  });

  it("returns deep-detached frozen snapshots that cannot be changed through source mutation", () => {
    const raw = structuredClone(scopedReadyInput());
    const result = preflight(raw);
    expect(result.state).toBe("READY");
    const originalReceiptFingerprint = result.receiptFingerprint;

    (raw.actorEvidence as { actorId: string }).actorId = "account-mutated";
    (raw.purposeEvidence.allowedActionFamilies as string[])[0] = "MUTATED";
    (raw.retentionEvidence.allowedFactFamilies as string[])[0] = "MUTATED";
    (raw.authorityEvidence.vector[0] as unknown as { version: number }).version = 999;

    expect(result.state).toBe("READY");
    expect(result.receiptFingerprint).toBe(originalReceiptFingerprint);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts)).toBe(true);

    const rawPurpose = {
      ...purposeContent(),
      subject: { ...SUBJECT },
      allowedActionFamilies: [...purposeContent().allowedActionFamilies],
      allowedFactFamilies: [...purposeContent().allowedFactFamilies],
    };
    const detached = createPurposeAuthorizationEvidence({
      ...rawPurpose,
      fingerprint: fingerprintPurposeAuthorizationEvidence(rawPurpose),
    });
    (rawPurpose.subject as { id: string }).id = "person-mutated";
    rawPurpose.allowedActionFamilies[0] = "MUTATED";
    expect(detached.subject.id).toBe(SUBJECT.id);
    expect(detached.allowedActionFamilies).toEqual(["AUDIENCE_RELEASE", "CURATORIAL_SEPARATION"]);
    expect(Object.isFrozen(detached.subject)).toBe(true);
    expect(Object.isFrozen(detached.allowedActionFamilies)).toBe(true);
  });

  it("uses RFC 8785 code-unit ordering without ambient locale methods", () => {
    const first = { "\ue000": "private", "😀": "astral", "é": "accent", a: "ascii" };
    const second = { a: "ascii", "é": "accent", "😀": "astral", "\ue000": "private" };
    expect(canonicalJson(first)).toBe('{"a":"ascii","é":"accent","😀":"astral","":"private"}');
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(fingerprintOf(first)).toBe(fingerprintOf(second));

    const originalLower = String.prototype.toLocaleLowerCase;
    const originalUpper = String.prototype.toLocaleUpperCase;
    let normalizedCommand: ReturnType<typeof command> | undefined;
    try {
      String.prototype.toLocaleLowerCase = () => { throw new Error("ambient locale lowercasing used"); };
      String.prototype.toLocaleUpperCase = () => { throw new Error("ambient locale uppercasing used"); };
      normalizedCommand = command({ factFamilies: ["DECISION", "COMMITMENT"] });
    } finally {
      String.prototype.toLocaleLowerCase = originalLower;
      String.prototype.toLocaleUpperCase = originalUpper;
    }
    expect(normalizedCommand?.factFamilies).toEqual(["COMMITMENT", "DECISION"]);
  });

  it("uses stable fingerprints for detached byte snapshots and exposes only immutable receipts", () => {
    const left = new Uint8Array([1, 2, 3, 4]);
    const right = new Uint8Array([1, 2, 3, 4]);
    expect(fingerprintOf(left)).toBe(fingerprintOf(right));

    const result = preflight(readyInput({
      purposeEvidence: { available: false, reason: "purpose-index-not-loaded" },
    }));
    expect(result.state).toBe("UNAVAILABLE");
    expect(Object.isFrozen(result.receipts[0])).toBe(true);
    expect(result.receipts[0].fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receiptFingerprint).toBe(fingerprintOf({
      schema: result.schema,
      state: result.state,
      checkedAt: result.checkedAt,
      commandFingerprint: result.commandFingerprint,
      receipts: result.receipts,
    }));
  });

  it("keeps the evidence schemas and command identity schemas exact", () => {
    expect(actor().schema).toBe(ACTOR_EVIDENCE_SCHEMA);
    expect(purpose().schema).toBe(PURPOSE_EVIDENCE_SCHEMA);
    expect(retention().schema).toBe(RETENTION_EVIDENCE_SCHEMA);
    expect(authority().schema).toBe(AUTHORITY_EVIDENCE_SCHEMA);
    expect(identity().schema).toBe(COMMAND_IDENTITY_SCHEMA);
    expect(Object.keys(identity()).sort()).toEqual([
      "actionFamily",
      "actorEvidenceRef",
      "actorId",
      "commandFingerprint",
      "commandId",
      "eventId",
      "expectedAuthorityVector",
      "idempotencyKey",
      "payloadFingerprint",
      "purposeAuthorizationRef",
      "retentionAuthorizationRef",
      "schema",
      "state",
      "subject",
      "workspaceId",
    ].sort());
  });
});
