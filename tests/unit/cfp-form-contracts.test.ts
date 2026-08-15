import { describe, expect, it } from "vitest";

import {
  compareFormFieldIds,
  effectiveAnswersOf,
  FORM_DOCUMENT_SCHEMA,
  FormDocumentError,
  historicalAnswersOf,
  normalizeFormDocument,
  verifyFormDocumentFingerprint,
  type FormDocumentErrorCode,
} from "../../src/server/services/cfp/form-types";
import {
  DEFAULT_FORM_SAFETY_LIMITS,
  FormSafetyError,
  sanitizeFormData,
  type FormSafetyErrorCode,
} from "../../src/server/services/cfp/form-safety";
import { fingerprintOf } from "../../src/server/canonical";

function formFixture(): Record<string, unknown> {
  return {
    schema: FORM_DOCUMENT_SCHEMA,
    formVersionId: "form-v1",
    ruleVersionId: "rules-v1",
    fields: [
      {
        id: "title",
        type: "shortText",
        label: "Talk title",
        required: true,
        defaultVisibility: "visible",
        config: { placeholder: "A concise title", suggestions: ["Example"] },
      },
      {
        id: "privateNote",
        type: "longText",
        label: "Private note",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "details",
        type: "section",
        label: "Details",
        required: false,
        defaultVisibility: "visible",
      },
    ],
    historicalAnswers: [
      { fieldId: "title", value: "Fail closed by construction" },
      { fieldId: "privateNote", value: { text: "history only" } },
    ],
    effectiveAnswers: [{ fieldId: "title", value: "Fail closed by construction" }],
  };
}

function jsonNodeCount(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce((count, item) => count + jsonNodeCount(item), 0);
  }
  if (value !== null && typeof value === "object") {
    return 1 + Object.values(value).reduce((count, item) => count + jsonNodeCount(item), 0);
  }
  return 1;
}

function captureSafetyError(action: () => unknown, context?: string): FormSafetyError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, context).toBeInstanceOf(FormSafetyError);
  return thrown as FormSafetyError;
}

function expectSafetyError(action: () => unknown, code: FormSafetyErrorCode, context?: string): void {
  expect(captureSafetyError(action, context).code).toBe(code);
}

function captureDocumentError(action: () => unknown): FormDocumentError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FormDocumentError);
  return thrown as FormDocumentError;
}

function expectDocumentError(action: () => unknown, code: FormDocumentErrorCode): void {
  expect(captureDocumentError(action).code).toBe(code);
}

describe("CFP form safety boundary", () => {
  it("returns detached, deeply frozen JSON-safe data", () => {
    const nested = { options: ["one", "two"] };
    const input = { enabled: true, nested };
    const normalized = sanitizeFormData(input) as {
      readonly enabled: boolean;
      readonly nested: { readonly options: readonly string[] };
    };

    nested.options.push("three");
    input.enabled = false;

    expect(normalized).toEqual({ enabled: true, nested: { options: ["one", "two"] } });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.nested)).toBe(true);
    expect(Object.isFrozen(normalized.nested.options)).toBe(true);
    expect(() => (normalized.nested.options as string[]).push("blocked")).toThrow();
  });

  it("rejects an accessor without invoking it and never reflects hostile content", () => {
    let calls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "SENTINEL_SECRET_KEY", {
      enumerable: true,
      get() {
        calls += 1;
        return "SENTINEL_SECRET_VALUE";
      },
    });

    const error = captureSafetyError(() => sanitizeFormData(input));
    expect(error.code).toBe("UNSAFE_ACCESSOR");
    expect(calls).toBe(0);
    expect(`${error.name}:${error.message}`).not.toContain("SENTINEL_SECRET");
  });

  it("rejects proxies before invoking their traps", () => {
    let calls = 0;
    const input = new Proxy(
      {},
      {
        ownKeys() {
          calls += 1;
          throw new Error("SENTINEL_PROXY_VALUE");
        },
      },
    );

    const error = captureSafetyError(() => sanitizeFormData(input));
    expect(error.code).toBe("UNSAFE_PROXY");
    expect(calls).toBe(0);
    expect(error.message).not.toContain("SENTINEL_PROXY_VALUE");
  });

  it("rejects exotic structures, cycles, sparse arrays, symbols, and unsupported values", () => {
    const symbolObject: Record<PropertyKey, unknown> = { safe: true };
    symbolObject[Symbol("hidden")] = "value";
    const sparse = new Array(2);
    sparse[1] = "present";
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const cases: Array<[string, unknown, FormSafetyErrorCode]> = [
      ["non-plain prototype", Object.create({ inherited: true }), "UNSAFE_PROTOTYPE"],
      ["symbol property", symbolObject, "UNSAFE_SYMBOL"],
      ["sparse array", sparse, "SPARSE_ARRAY"],
      ["cycle", cyclic, "CYCLE"],
      ["undefined", { value: undefined }, "UNSAFE_VALUE"],
      ["bigint", { value: 10n }, "UNSAFE_VALUE"],
      ["non-finite number", { value: Number.NaN }, "UNSAFE_VALUE"],
      ["lone surrogate", { value: "\ud800" }, "UNSAFE_VALUE"],
    ];

    for (const [label, input, code] of cases) {
      expectSafetyError(() => sanitizeFormData(input), code, label);
    }
  });

  it("rejects prototype-pollution keys without reflecting the key", () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "__proto__", {
      enumerable: true,
      value: "SENTINEL_POLLUTION_VALUE",
      writable: true,
    });

    const error = captureSafetyError(() => sanitizeFormData(input));
    expect(error.code).toBe("UNSAFE_KEY");
    expect(error.message).not.toContain("__proto__");
    expect(error.message).not.toContain("SENTINEL_POLLUTION_VALUE");
  });

  it("enforces explicit depth, collection, node, string, and serialized-size limits", () => {
    expect(Object.isFrozen(DEFAULT_FORM_SAFETY_LIMITS)).toBe(true);
    expectSafetyError(
      () => sanitizeFormData({ a: { b: { c: true } } }, { maxDepth: 2 }),
      "DEPTH_LIMIT",
    );
    expectSafetyError(() => sanitizeFormData([1, 2, 3], { maxArrayLength: 2 }), "ARRAY_LIMIT");
    expectSafetyError(() => sanitizeFormData({ a: 1, b: 2 }, { maxObjectKeys: 1 }), "OBJECT_LIMIT");
    expectSafetyError(() => sanitizeFormData([1, 2, 3], { maxNodes: 3 }), "NODE_LIMIT");
    expectSafetyError(() => sanitizeFormData("four", { maxStringBytes: 3 }), "STRING_LIMIT");
    expectSafetyError(
      () => sanitizeFormData("1234567", { maxSerializedBytes: 8 }),
      "SERIALIZED_SIZE_LIMIT",
    );
    const repeatedValue = "x".repeat(48);
    expectSafetyError(
      () =>
        sanitizeFormData([repeatedValue, repeatedValue, repeatedValue], {
          maxSerializedBytes: 100,
        }),
      "SERIALIZED_SIZE_LIMIT",
      "shared-value serialization amplification",
    );

    const escapedBoundary = { emoji: "😀", quote: "\"\n", values: [-0, true, null] };
    const exactBytes = Buffer.byteLength(JSON.stringify(escapedBoundary), "utf8");
    expect(sanitizeFormData(escapedBoundary, { maxSerializedBytes: exactBytes })).toEqual({
      emoji: "😀",
      quote: "\"\n",
      values: [0, true, null],
    });
    expectSafetyError(
      () => sanitizeFormData(escapedBoundary, { maxSerializedBytes: exactBytes - 1 }),
      "SERIALIZED_SIZE_LIMIT",
      "exact escaped JSON byte boundary",
    );
  });
});

describe("CFP form document contract", () => {
  it("normalizes a versioned snapshot and keeps hidden history out of effective answers", () => {
    const document = normalizeFormDocument(formFixture());

    expect(document.schema).toBe(FORM_DOCUMENT_SCHEMA);
    expect(document.formVersionId).toBe("form-v1");
    expect(document.ruleVersionId).toBe("rules-v1");
    expect(document.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(historicalAnswersOf(document).map((answer) => answer.fieldId)).toEqual([
      "privateNote",
      "title",
    ]);
    expect(effectiveAnswersOf(document).map((answer) => answer.fieldId)).toEqual(["title"]);
    expect(verifyFormDocumentFingerprint(document)).toBe(true);
  });

  it("requires every effective answer to exactly match answer history", () => {
    const mismatched = formFixture();
    mismatched.effectiveAnswers = [{ fieldId: "title", value: "different" }];
    expectDocumentError(
      () => normalizeFormDocument(mismatched),
      "FORM_EFFECTIVE_ANSWER_NOT_HISTORICAL",
    );

    const missingHistory = formFixture();
    missingHistory.historicalAnswers = [{ fieldId: "privateNote", value: { text: "history only" } }];
    expectDocumentError(
      () => normalizeFormDocument(missingHistory),
      "FORM_EFFECTIVE_ANSWER_NOT_HISTORICAL",
    );
  });

  it("rejects unknown, duplicate, and container-field answers", () => {
    const unknown = formFixture();
    unknown.historicalAnswers = [{ fieldId: "unknown", value: "value" }];
    unknown.effectiveAnswers = [];
    expectDocumentError(() => normalizeFormDocument(unknown), "FORM_ANSWER_FIELD_UNKNOWN");

    const duplicate = formFixture();
    duplicate.historicalAnswers = [
      { fieldId: "title", value: "first" },
      { fieldId: "title", value: "second" },
    ];
    duplicate.effectiveAnswers = [];
    expectDocumentError(() => normalizeFormDocument(duplicate), "FORM_ANSWER_DUPLICATE");

    const container = formFixture();
    container.historicalAnswers = [{ fieldId: "details", value: "not allowed" }];
    container.effectiveAnswers = [];
    expectDocumentError(() => normalizeFormDocument(container), "FORM_ANSWER_FIELD_CONTAINER");
  });

  it("produces a stable fingerprint and rejects fingerprinted tampering", () => {
    const first = normalizeFormDocument(formFixture());
    const second = normalizeFormDocument(first);

    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);

    const tampered = JSON.parse(JSON.stringify(first)) as Record<string, unknown> & {
      fields: Array<Record<string, unknown>>;
    };
    tampered.fields[0]!.label = "Tampered title";
    expectDocumentError(() => normalizeFormDocument(tampered), "FORM_FINGERPRINT_MISMATCH");
    expect(verifyFormDocumentFingerprint(tampered)).toBe(false);
  });

  it("keeps maximum unfingerprinted inputs self-verifiable after adding the fingerprint", () => {
    const nodeBoundary = formFixture() as {
      fields: Array<{ config?: unknown }>;
      [key: string]: unknown;
    };
    const nodeChunks: unknown[] = [];
    nodeBoundary.fields[0]!.config = { chunks: nodeChunks };
    let remainingNodes =
      DEFAULT_FORM_SAFETY_LIMITS.maxNodes - 1 - jsonNodeCount(nodeBoundary);
    while (remainingNodes > 0) {
      if (remainingNodes === 1) {
        nodeChunks.push(null);
        remainingNodes = 0;
      } else {
        const leafCount = Math.min(1_024, remainingNodes - 1);
        nodeChunks.push(Array.from({ length: leafCount }, () => null));
        remainingNodes -= leafCount + 1;
      }
    }
    expect(jsonNodeCount(nodeBoundary)).toBe(DEFAULT_FORM_SAFETY_LIMITS.maxNodes - 1);
    const nodeDocument = normalizeFormDocument(nodeBoundary);
    expect(jsonNodeCount(nodeDocument)).toBe(DEFAULT_FORM_SAFETY_LIMITS.maxNodes);
    expect(verifyFormDocumentFingerprint(nodeDocument)).toBe(true);

    const byteBoundary = formFixture() as {
      fields: Array<{ config?: unknown }>;
      [key: string]: unknown;
    };
    const byteChunks: string[] = [];
    byteBoundary.fields[0]!.config = { chunks: byteChunks };
    const reducedByteLimit = DEFAULT_FORM_SAFETY_LIMITS.maxSerializedBytes - 128;
    const desiredBytes = reducedByteLimit - 40;
    let currentBytes = Buffer.byteLength(JSON.stringify(byteBoundary), "utf8");
    while (currentBytes < desiredBytes) {
      const separatorBytes = byteChunks.length === 0 ? 0 : 1;
      const availablePayloadBytes = desiredBytes - currentBytes - separatorBytes - 2;
      if (availablePayloadBytes < 0) {
        break;
      }
      const payloadBytes = Math.min(DEFAULT_FORM_SAFETY_LIMITS.maxStringBytes, availablePayloadBytes);
      byteChunks.push("x".repeat(payloadBytes));
      currentBytes += separatorBytes + payloadBytes + 2;
    }
    const rawBytes = Buffer.byteLength(JSON.stringify(byteBoundary), "utf8");
    expect(rawBytes).toBeLessThanOrEqual(reducedByteLimit);
    expect(rawBytes + 81).toBeGreaterThan(reducedByteLimit);
    const byteDocument = normalizeFormDocument(byteBoundary);
    expect(Buffer.byteLength(JSON.stringify(byteDocument), "utf8")).toBe(rawBytes + 81);
    expect(verifyFormDocumentFingerprint(byteDocument)).toBe(true);
  });

  it("detaches and deeply freezes fields, config, and answer values", () => {
    const input = formFixture() as {
      fields: Array<{ config?: { suggestions: string[] } }>;
      historicalAnswers: Array<{ fieldId: string; value: unknown }>;
      [key: string]: unknown;
    };
    const document = normalizeFormDocument(input);

    input.fields[0]!.config!.suggestions.push("mutated");
    input.historicalAnswers[0]!.value = "mutated";

    expect(document.fields[0]!.config).toEqual({
      placeholder: "A concise title",
      suggestions: ["Example"],
    });
    const titleAnswer = document.historicalAnswers.find((a) => a.fieldId === "title");
    const privateNoteAnswer = document.historicalAnswers.find((a) => a.fieldId === "privateNote");
    expect(titleAnswer?.value).toBe("Fail closed by construction");
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.fields)).toBe(true);
    expect(Object.isFrozen(document.fields[0]!)).toBe(true);
    expect(Object.isFrozen(document.fields[0]!.config as object)).toBe(true);
    expect(Object.isFrozen(document.historicalAnswers)).toBe(true);
    expect(Object.isFrozen(document.effectiveAnswers)).toBe(true);
    expect(Object.isFrozen(privateNoteAnswer?.value as object)).toBe(true);
  });

  it("uses stable document errors that do not echo rejected content", () => {
    const input = formFixture();
    input.SENTINEL_UNKNOWN_PROPERTY = "SENTINEL_UNKNOWN_VALUE";

    const error = captureDocumentError(() => normalizeFormDocument(input));
    expect(error.code).toBe("FORM_DOCUMENT_SHAPE_INVALID");
    expect(`${error.name}:${error.message}`).not.toContain("SENTINEL_UNKNOWN");

    const invalidFingerprint = formFixture();
    invalidFingerprint.fingerprint = { toString: "SENTINEL_NOT_CALLABLE" };
    const fingerprintError = captureDocumentError(() => normalizeFormDocument(invalidFingerprint));
    expect(fingerprintError.code).toBe("FORM_FINGERPRINT_INVALID");
    expect(fingerprintError.message).not.toContain("SENTINEL_NOT_CALLABLE");
  });

  it("exports compareFormFieldIds and enforces exact raw string ordering", () => {
    expect(compareFormFieldIds("same", "same")).toBe(0);
    expect(compareFormFieldIds("a", "b")).toBe(-1);
    expect(compareFormFieldIds("b", "a")).toBe(1);

    // Raw string comparison (no numeric parsing: 'field10' < 'field2' because '1' < '2')
    expect(compareFormFieldIds("field10", "field2")).toBe(-1);

    // Raw string comparison (no case folding: 'Field' < 'field' because 'F' < 'f')
    expect(compareFormFieldIds("Field", "field")).toBe(-1);

    // Punctuation and digit ordering allowed by identifier regex
    expect(compareFormFieldIds("a-1", "a.1")).toBe(-1);
    expect(compareFormFieldIds("a.1", "a-1")).toBe(1);
    expect(compareFormFieldIds("a:1", "a_1")).toBe(-1);
    expect(compareFormFieldIds("a1", "a_1")).toBe(-1);

    // Raw code-unit comparison rather than Unicode normalization (NFD vs NFC of canonically equivalent strings)
    const nfd = "e\u0301";
    const nfc = "\u00e9";
    expect(nfd.normalize("NFC")).toBe(nfc);
    expect(compareFormFieldIds(nfd, nfc)).toBe(-1);
    expect(compareFormFieldIds(nfc, nfd)).toBe(1);
  });

  it("preserves sealed fields display order while normalizing answers to raw fieldId order", () => {
    const input = {
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-v1",
      ruleVersionId: "rules-v1",
      fields: [
        { id: "z-last", type: "shortText", label: "Z Last", required: false, defaultVisibility: "visible" },
        { id: "a-first", type: "shortText", label: "A First", required: false, defaultVisibility: "visible" },
        { id: "m-middle", type: "shortText", label: "M Middle", required: false, defaultVisibility: "visible" },
      ],
      historicalAnswers: [
        { fieldId: "m-middle", value: "val-m" },
        { fieldId: "z-last", value: "val-z" },
        { fieldId: "a-first", value: "val-a" },
      ],
      effectiveAnswers: [
        { fieldId: "z-last", value: "val-z" },
        { fieldId: "a-first", value: "val-a" },
        { fieldId: "m-middle", value: "val-m" },
      ],
    };

    const doc = normalizeFormDocument(input);

    expect(doc.fields.map((f) => f.id)).toEqual(["z-last", "a-first", "m-middle"]);
    expect(doc.historicalAnswers.map((a) => a.fieldId)).toEqual(["a-first", "m-middle", "z-last"]);
    expect(doc.effectiveAnswers.map((a) => a.fieldId)).toEqual(["a-first", "m-middle", "z-last"]);
  });

  it("produces identical normalized arrays and fingerprint for every permutation of three historical answers", () => {
    const baseFields = [
      { id: "a-first", type: "shortText", label: "A First", required: false, defaultVisibility: "visible" },
      { id: "m-middle", type: "shortText", label: "M Middle", required: false, defaultVisibility: "visible" },
      { id: "z-last", type: "shortText", label: "Z Last", required: false, defaultVisibility: "visible" },
    ];
    const answers = [
      { fieldId: "z-last", value: "val-z" },
      { fieldId: "a-first", value: "val-a" },
      { fieldId: "m-middle", value: "val-m" },
    ];

    const permutations = [
      [answers[0]!, answers[1]!, answers[2]!],
      [answers[0]!, answers[2]!, answers[1]!],
      [answers[1]!, answers[0]!, answers[2]!],
      [answers[1]!, answers[2]!, answers[0]!],
      [answers[2]!, answers[0]!, answers[1]!],
      [answers[2]!, answers[1]!, answers[0]!],
    ];

    const results = permutations.map((perm) =>
      normalizeFormDocument({
        schema: FORM_DOCUMENT_SCHEMA,
        formVersionId: "form-v1",
        ruleVersionId: "rules-v1",
        fields: baseFields,
        historicalAnswers: perm,
        effectiveAnswers: [],
      }),
    );

    const first = results[0]!;
    for (const res of results) {
      expect(res.historicalAnswers).toEqual(first.historicalAnswers);
      expect(res.fingerprint).toBe(first.fingerprint);
    }
  });

  it("produces identical effective answers and fingerprint for every permutation of an effective subset", () => {
    const baseFields = [
      { id: "a-first", type: "shortText", label: "A First", required: false, defaultVisibility: "visible" },
      { id: "m-middle", type: "shortText", label: "M Middle", required: false, defaultVisibility: "visible" },
      { id: "z-last", type: "shortText", label: "Z Last", required: false, defaultVisibility: "visible" },
    ];
    const historicalAnswers = [
      { fieldId: "a-first", value: "val-a" },
      { fieldId: "m-middle", value: "val-m" },
      { fieldId: "z-last", value: "val-z" },
    ];

    const effectivePerm1 = [
      { fieldId: "z-last", value: "val-z" },
      { fieldId: "a-first", value: "val-a" },
    ];
    const effectivePerm2 = [
      { fieldId: "a-first", value: "val-a" },
      { fieldId: "z-last", value: "val-z" },
    ];

    const doc1 = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-v1",
      ruleVersionId: "rules-v1",
      fields: baseFields,
      historicalAnswers,
      effectiveAnswers: effectivePerm1,
    });

    const doc2 = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-v1",
      ruleVersionId: "rules-v1",
      fields: baseFields,
      historicalAnswers,
      effectiveAnswers: effectivePerm2,
    });

    expect(doc1.effectiveAnswers).toEqual(doc2.effectiveAnswers);
    expect(doc1.effectiveAnswers.map((a) => a.fieldId)).toEqual(["a-first", "z-last"]);
    expect(doc1.fingerprint).toBe(doc2.fingerprint);

    for (const eff of doc1.effectiveAnswers) {
      const hist = doc1.historicalAnswers.find((h) => h.fieldId === eff.fieldId);
      expect(hist).toBeDefined();
      expect(eff.value).toEqual(hist!.value);
    }
  });

  it("completes full validation of all answers before sorting", () => {
    const baseFields = [
      { id: "a-first", type: "shortText", label: "A First", required: false, defaultVisibility: "visible" },
      { id: "z-last", type: "section", label: "Section Container", required: false, defaultVisibility: "visible" },
    ];

    expectDocumentError(
      () =>
        normalizeFormDocument({
          schema: FORM_DOCUMENT_SCHEMA,
          formVersionId: "form-v1",
          ruleVersionId: "rules-v1",
          fields: baseFields,
          historicalAnswers: [
            { fieldId: "z-unknown", value: 1 },
            { fieldId: "a-first", value: 2 },
          ],
          effectiveAnswers: [],
        }),
      "FORM_ANSWER_FIELD_UNKNOWN",
    );

    expectDocumentError(
      () =>
        normalizeFormDocument({
          schema: FORM_DOCUMENT_SCHEMA,
          formVersionId: "form-v1",
          ruleVersionId: "rules-v1",
          fields: baseFields,
          historicalAnswers: [
            { fieldId: "z-last", value: "container-value" },
            { fieldId: "a-first", value: "valid" },
          ],
          effectiveAnswers: [],
        }),
      "FORM_ANSWER_FIELD_CONTAINER",
    );
  });

  it("rejects a fingerprint computed over the old caller order", () => {
    const baseFields = [
      { id: "z-last", type: "shortText", label: "Z Last", required: false, defaultVisibility: "visible" },
      { id: "a-first", type: "shortText", label: "A First", required: false, defaultVisibility: "visible" },
    ];
    const callerOrderAnswers = [
      { fieldId: "z-last", value: "val-z" },
      { fieldId: "a-first", value: "val-a" },
    ];

    const oldOrderContent = {
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-v1",
      ruleVersionId: "rules-v1",
      fields: baseFields,
      historicalAnswers: callerOrderAnswers,
      effectiveAnswers: callerOrderAnswers,
    };
    const oldOrderFingerprint = fingerprintOf(oldOrderContent);

    const docWithOldFingerprint = {
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-v1",
      ruleVersionId: "rules-v1",
      fields: baseFields,
      historicalAnswers: callerOrderAnswers,
      effectiveAnswers: callerOrderAnswers,
      fingerprint: oldOrderFingerprint,
    };

    expectDocumentError(() => normalizeFormDocument(docWithOldFingerprint), "FORM_FINGERPRINT_MISMATCH");
    expect(verifyFormDocumentFingerprint(docWithOldFingerprint)).toBe(false);
  });
});
