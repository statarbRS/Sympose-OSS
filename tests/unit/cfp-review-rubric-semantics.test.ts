import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import {
  CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
} from "../../src/server/services/cfp-review/artifact-types";
import {
  canonicalReviewRubricSemanticsJson,
  CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
  CFP_RUBRIC_SCHEMA,
  fingerprintReviewRubricSemantics,
  normalizeReviewRubricSemantics,
  normalizeSealCriteria,
  parseCanonicalReviewRubricSemantics,
  projectReviewRubricSemantics,
  REVIEW_JUDGMENT_AUTHORITY,
  REVIEW_RECOMMENDATION_CHOICES,
  REVIEW_RUBRIC_COPY,
  REVIEW_RUBRIC_LIMITS,
  REVIEW_RUBRIC_SEMANTIC_CODES,
  REVIEW_RUBRIC_STRUCTURED_KINDS,
  REVIEW_RUBRIC_TITLE,
  REVIEW_SCALE_CHOICES,
  REVIEW_SCALE_CODE,
  ReviewRubricSemanticsError,
  type ReviewRubricSemanticsErrorCode,
} from "../../src/server/services/cfp-review/rubric-semantics";

const ISSUED_AT = "2026-08-11T12:00:00.000Z";

function hash(seed: unknown): string {
  return fingerprintOf({ seed });
}

function semanticsFixture(): Record<string, unknown> {
  return {
    schema: CFP_REVIEW_RUBRIC_SEMANTICS_SCHEMA,
    version: 1,
    workspaceId: "workspace-1",
    roundId: "round-1",
    rubricVersionId: "rubric-version-1",
    rubricVersionNumber: 4,
    rubricVersionFingerprint: hash("legacy-rubric-json"),
    criteria: [
      {
        semantic: "PROPOSAL_QUALITY",
        kind: "numeric",
        required: true,
        weight: 3,
        minimum: 1,
        maximum: 5,
        step: 1,
      },
      {
        semantic: "AUDIENCE_RELEVANCE",
        kind: "scale",
        required: true,
        weight: 2,
        scaleCode: REVIEW_SCALE_CODE,
      },
      {
        semantic: "EVIDENCE_STRENGTH",
        kind: "numeric",
        required: false,
        weight: 1,
        minimum: 0,
        maximum: 10,
        step: 0.5,
      },
      {
        semantic: "DELIVERY_FEASIBILITY",
        kind: "scale",
        required: true,
        weight: 1,
        scaleCode: REVIEW_SCALE_CODE,
      },
      {
        semantic: "CLAIMS_SUPPORTED",
        kind: "yesNo",
        required: true,
        weight: 1,
      },
      {
        semantic: "INDEPENDENT_RECOMMENDATION",
        kind: "recommendation",
        required: true,
        weight: 0,
      },
      {
        semantic: "REVIEWER_NOTES",
        kind: "comment",
        required: false,
        weight: 0,
        maxLength: 4_000,
      },
    ],
    issuer: {
      accountId: "organizer-account-1",
      role: "program_manager",
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt: ISSUED_AT,
  };
}

function captureRubricError(action: () => unknown): ReviewRubricSemanticsError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewRubricSemanticsError);
  return thrown as ReviewRubricSemanticsError;
}

function expectRubricError(action: () => unknown, code: ReviewRubricSemanticsErrorCode): void {
  expect(captureRubricError(action).code).toBe(code);
}

describe("neutral structured rubric semantics", () => {
  it("accepts only the seven frozen semantic codes and five structured kinds", () => {
    expect(REVIEW_RUBRIC_SEMANTIC_CODES).toEqual([
      "PROPOSAL_QUALITY",
      "AUDIENCE_RELEVANCE",
      "EVIDENCE_STRENGTH",
      "DELIVERY_FEASIBILITY",
      "CLAIMS_SUPPORTED",
      "INDEPENDENT_RECOMMENDATION",
      "REVIEWER_NOTES",
    ]);
    expect(REVIEW_RUBRIC_STRUCTURED_KINDS).toEqual([
      "numeric",
      "scale",
      "yesNo",
      "recommendation",
      "comment",
    ]);
    const normalized = normalizeReviewRubricSemantics(semanticsFixture());
    expect(normalized.criteria.map((criterion) => criterion.semantic)).toEqual(
      REVIEW_RUBRIC_SEMANTIC_CODES,
    );
  });

  it("rejects organizer title, label, guidance, choice, authority, and unknown prose", () => {
    const proseAttempts = [
      ["title", "Organizer decides the final program"],
      ["label", "Accept this speaker"],
      ["guidance", "Reviewer has final say"],
      ["choices", [{ value: "ACCEPT", label: "Accept" }]],
      ["choiceLabels", ["Program slot", "Reject"]],
      ["selectionAuthority", "final-selection-control"],
      ["organizerNotes", "Alice at Example Organization, session S-42"],
    ] as const;
    for (const [key, value] of proseAttempts) {
      const fixture = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
      fixture.criteria[0] = { ...fixture.criteria[0], [key]: value };
      const error = captureRubricError(() => normalizeReviewRubricSemantics(fixture));
      expect(error.code).toBe("RUBRIC_SEMANTICS_CRITERION_INVALID");
      expect(`${error.name}:${error.message}`).not.toContain("Alice");
      expect(`${error.name}:${error.message}`).not.toContain("final say");
    }

    expectRubricError(
      () => normalizeReviewRubricSemantics({ ...semanticsFixture(), title: "Injected title" }),
      "RUBRIC_SEMANTICS_SHAPE_INVALID",
    );
  });

  it("rejects arbitrary semantic strings and incompatible semantic/kind pairs", () => {
    for (const semantic of [
      "FINAL_PROGRAM_SELECTION",
      "ACCEPT_REJECT",
      "ALICE_EXAMPLE",
      "ORGANIZATION_AND_SESSION_CODE",
    ]) {
      const fixture = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
      fixture.criteria[0] = { ...fixture.criteria[0], semantic };
      expectRubricError(
        () => normalizeReviewRubricSemantics(fixture),
        "RUBRIC_SEMANTICS_CRITERION_INVALID",
      );
    }

    const incompatible = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
    incompatible.criteria[4] = {
      semantic: "CLAIMS_SUPPORTED",
      kind: "recommendation",
      required: true,
      weight: 1,
    };
    expectRubricError(
      () => normalizeReviewRubricSemantics(incompatible),
      "RUBRIC_SEMANTICS_CRITERION_INVALID",
    );
  });

  it("enforces numeric, scale, weight, and comment boundaries", () => {
    const invalidCriteria = [
      {
        semantic: "PROPOSAL_QUALITY",
        kind: "numeric",
        required: true,
        weight: 1,
        minimum: 5,
        maximum: 5,
        step: 1,
      },
      {
        semantic: "PROPOSAL_QUALITY",
        kind: "numeric",
        required: true,
        weight: 1,
        minimum: 1,
        maximum: 5,
        step: 0,
      },
      {
        semantic: "AUDIENCE_RELEVANCE",
        kind: "scale",
        required: true,
        weight: 1,
        scaleCode: "ORGANIZER_SCALE",
      },
      {
        semantic: "REVIEWER_NOTES",
        kind: "comment",
        required: false,
        weight: 0,
        maxLength: REVIEW_RUBRIC_LIMITS.maxCommentLength + 1,
      },
      {
        semantic: "PROPOSAL_QUALITY",
        kind: "scale",
        required: true,
        weight: 1_001,
        scaleCode: REVIEW_SCALE_CODE,
      },
    ];
    for (const criterion of invalidCriteria) {
      expectRubricError(
        () => normalizeSealCriteria([criterion]),
        "RUBRIC_SEMANTICS_CRITERION_INVALID",
      );
    }
  });

  it("rejects duplicate, empty, and over-limit criterion collections", () => {
    const fixture = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
    fixture.criteria = [fixture.criteria[0]!, { ...fixture.criteria[0] }];
    expectRubricError(
      () => normalizeReviewRubricSemantics(fixture),
      "RUBRIC_SEMANTICS_CRITERION_DUPLICATE",
    );
    expectRubricError(
      () => normalizeSealCriteria([]),
      "RUBRIC_SEMANTICS_LIMIT_EXCEEDED",
    );
    expectRubricError(
      () =>
        normalizeSealCriteria(
          Array.from({ length: REVIEW_RUBRIC_LIMITS.maxCriteria + 1 }, () => ({
            semantic: "PROPOSAL_QUALITY",
            kind: "scale",
            required: true,
            weight: 1,
            scaleCode: REVIEW_SCALE_CODE,
          })),
        ),
      "RUBRIC_SEMANTICS_LIMIT_EXCEEDED",
    );
  });

  it("preserves custom numeric, dropdown, and text fields with their weights and bounds", () => {
    const normalized = normalizeReviewRubricSemantics({
      ...semanticsFixture(),
      criteria: [],
      customRubric: {
        schema: CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
        version: 1,
        title: "Organizer review rubric",
        judgmentBoundary: "independent-review-evidence",
        fields: [
          {
            id: "impact",
            label: "Impact",
            guidance: "Assess the proposal evidence.",
            kind: "numeric",
            required: true,
            weight: 3.5,
            minimum: 0,
            maximum: 10,
            step: 0.5,
            choices: [],
            maxLength: null,
          },
          {
            id: "recommendation",
            label: "Recommendation",
            guidance: "Record an independent recommendation.",
            kind: "dropdown",
            required: true,
            weight: 2,
            minimum: null,
            maximum: null,
            step: null,
            choices: [
              { value: "ADVANCE", label: "Advance" },
              { value: "HOLD", label: "Hold" },
            ],
            maxLength: null,
          },
          {
            id: "notes",
            label: "Notes",
            guidance: "Record evidence only.",
            kind: "text",
            required: false,
            weight: 1,
            minimum: null,
            maximum: null,
            step: null,
            choices: [],
            maxLength: 500,
          },
        ],
      },
    });
    const projection = projectReviewRubricSemantics(normalized);
    expect(projection.criteria.map((criterion) => [criterion.id, criterion.kind, criterion.weight])).toEqual([
      ["impact", "numeric", 3.5],
      ["recommendation", "dropdown", 2],
      ["notes", "text", 1],
    ]);
    expect(projection.criteria[0]).toMatchObject({ minimum: 0, maximum: 10, step: 0.5 });
    expect(projection.criteria[1]).toMatchObject({ choices: [{ value: "ADVANCE", label: "Advance" }, { value: "HOLD", label: "Hold" }] });
    expect(projection.criteria[2]).toMatchObject({ maxLength: 500 });
  });

  it("rejects custom fields with mismatched kind-specific payloads", () => {
    const customRubric = {
      schema: CUSTOM_REVIEW_RUBRIC_DOCUMENT_SCHEMA,
      version: 1,
      title: "Organizer review rubric",
      judgmentBoundary: "independent-review-evidence",
      fields: [{
        id: "impact",
        label: "Impact",
        guidance: "",
        kind: "numeric",
        required: true,
        weight: 1,
        minimum: 0,
        maximum: 10,
        step: 1,
        choices: [{ value: "not-allowed", label: "Not allowed" }],
        maxLength: null,
      }],
    };
    expectRubricError(
      () => normalizeReviewRubricSemantics({ ...semanticsFixture(), criteria: [], customRubric }),
      "RUBRIC_SEMANTICS_CRITERION_INVALID",
    );
  });
});

describe("server-owned rubric projection", () => {
  it("projects the exact frozen title, copy, choices, ordinal keys, and independent authority", () => {
    const projection = projectReviewRubricSemantics(semanticsFixture());
    expect(projection.schema).toBe(CFP_RUBRIC_SCHEMA);
    expect(projection.title).toBe(REVIEW_RUBRIC_TITLE);
    expect(projection.judgmentAuthority).toBe(REVIEW_JUDGMENT_AUTHORITY);
    expect(projection.criteria.map((criterion) => criterion.id)).toEqual([
      "criterion-0001",
      "criterion-0002",
      "criterion-0003",
      "criterion-0004",
      "criterion-0005",
      "criterion-0006",
      "criterion-0007",
    ]);
    expect(Object.keys(projection.criteria[0]!).sort()).toEqual([
      "guidance",
      "id",
      "kind",
      "label",
      "maximum",
      "minimum",
      "required",
      "step",
      "weight",
    ]);
    for (const [index, criterion] of projection.criteria.entries()) {
      const semantic = REVIEW_RUBRIC_SEMANTIC_CODES[index]!;
      expect(criterion.label).toBe(REVIEW_RUBRIC_COPY[semantic].label);
      expect(criterion.guidance).toBe(REVIEW_RUBRIC_COPY[semantic].guidance);
    }
    expect(projection.criteria[1]).toMatchObject({
      kind: "scale",
      choices: REVIEW_SCALE_CHOICES,
    });
    expect(projection.criteria[5]).toMatchObject({
      kind: "recommendation",
      choices: REVIEW_RECOMMENDATION_CHOICES,
    });
    expect(REVIEW_RUBRIC_COPY.INDEPENDENT_RECOMMENDATION.guidance).toContain(
      "this is not a program decision",
    );
  });

  it("contains only reviewer-safe fields and none of the internal fingerprints or issuer facts", () => {
    const document = normalizeReviewRubricSemantics(semanticsFixture());
    const projection = projectReviewRubricSemantics(document);
    expect(Object.keys(projection).sort()).toEqual([
      "criteria",
      "judgmentAuthority",
      "schema",
      "title",
      "versionId",
      "versionNumber",
    ]);
    const serialized = JSON.stringify(projection).toLowerCase();
    for (const forbidden of [
      document.workspaceId,
      document.roundId,
      document.rubricVersionFingerprint,
      document.issuer.accountId,
      document.issuer.role,
      fingerprintReviewRubricSemantics(document),
      "legacy-rubric-json",
    ]) {
      expect(serialized).not.toContain(forbidden.toLowerCase());
    }
    expect(serialized).not.toContain("fingerprint");
    expect(serialized).not.toContain("issuer");
  });

  it("is identical across assignments and internal issuer/tenant bindings sharing semantics", () => {
    const first = semanticsFixture();
    const second = {
      ...semanticsFixture(),
      workspaceId: "workspace-2",
      roundId: "round-2",
      rubricVersionFingerprint: hash("other-internal-rubric-evidence"),
      issuer: {
        accountId: "different-program-manager",
        role: "workspace_admin",
        authority: REVIEW_ISSUER_AUTHORITY,
      },
      issuedAt: "2026-08-11T13:00:00.000Z",
    };
    expect(projectReviewRubricSemantics(second)).toEqual(projectReviewRubricSemantics(first));
    expect(fingerprintReviewRubricSemantics(second)).not.toBe(
      fingerprintReviewRubricSemantics(first),
    );
  });
});

describe("canonical and hostile rubric inputs", () => {
  it("round-trips canonical JSON and changes the internal fingerprint on semantic mutation", () => {
    const normalized = normalizeReviewRubricSemantics(semanticsFixture());
    const serialized = canonicalReviewRubricSemanticsJson(normalized);
    expect(serialized).toBe(canonicalJson(normalized));
    expect(parseCanonicalReviewRubricSemantics(serialized)).toEqual(normalized);
    expectRubricError(
      () => parseCanonicalReviewRubricSemantics(JSON.stringify(normalized)),
      "RUBRIC_SEMANTICS_CANONICAL_JSON_INVALID",
    );

    const changed = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
    changed.criteria[0] = { ...changed.criteria[0], weight: 4 };
    expect(fingerprintReviewRubricSemantics(changed)).not.toBe(
      fingerprintReviewRubricSemantics(normalized),
    );
  });

  it("detaches and deeply freezes normalized and projected structures", () => {
    const input = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
    const normalized = normalizeReviewRubricSemantics(input);
    const projection = projectReviewRubricSemantics(normalized);
    input.criteria[0]!.weight = 999;

    expect(normalized.criteria[0]!.weight).toBe(3);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.criteria)).toBe(true);
    expect(Object.isFrozen(normalized.criteria[0]!)).toBe(true);
    expect(Object.isFrozen(normalized.issuer)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.criteria)).toBe(true);
    expect(Object.isFrozen(REVIEW_SCALE_CHOICES)).toBe(true);
    expect(Object.isFrozen(REVIEW_SCALE_CHOICES[0]!)).toBe(true);
  });

  it("rejects accessors, proxies, cycles, malformed schemas, and oversized prose without reflection", () => {
    let calls = 0;
    const accessor = semanticsFixture();
    Object.defineProperty(accessor, "criteria", {
      enumerable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    const accessorError = captureRubricError(() => normalizeReviewRubricSemantics(accessor));
    expect(accessorError.code).toBe("RUBRIC_SEMANTICS_INPUT_UNSAFE");
    expect(calls).toBe(0);

    const proxyError = captureRubricError(() => normalizeReviewRubricSemantics(new Proxy({}, {})));
    expect(proxyError.code).toBe("RUBRIC_SEMANTICS_INPUT_UNSAFE");
    const cyclic = semanticsFixture() as Record<string, unknown>;
    cyclic.loop = cyclic;
    expectRubricError(
      () => normalizeReviewRubricSemantics(cyclic),
      "RUBRIC_SEMANTICS_INPUT_UNSAFE",
    );
    expectRubricError(
      () => normalizeReviewRubricSemantics({ ...semanticsFixture(), schema: "unknown" }),
      "RUBRIC_SEMANTICS_SCHEMA_UNSUPPORTED",
    );

    const oversized = semanticsFixture() as { criteria: Array<Record<string, unknown>> };
    oversized.criteria[0] = {
      ...oversized.criteria[0],
      guidance: "SENTINEL_SECRET".repeat(8_000),
    };
    const oversizedError = captureRubricError(() => normalizeReviewRubricSemantics(oversized));
    expect(oversizedError.code).toBe("RUBRIC_SEMANTICS_LIMIT_EXCEEDED");
    expect(oversizedError.message).not.toContain("SENTINEL_SECRET");
  });
});
