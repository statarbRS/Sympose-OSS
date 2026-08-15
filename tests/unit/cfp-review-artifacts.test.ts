import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import * as artifactExports from "../../src/server/services/cfp-review/artifacts";
import {
  BLIND_ANSWER_TYPES,
  BLIND_REVIEW_ARTIFACT_LIMITS,
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES,
  CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
  CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
  CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
  CFP_SUBMISSION_REVISION_SCHEMA,
  REVIEW_ISSUER_AUTHORITY,
  type BlindArtifactItemV1,
  type BlindFieldDecisionInput,
  type BlindReviewArtifactV1,
  type CreateBlindReviewArtifactInput,
} from "../../src/server/services/cfp-review/artifact-types";
// @ts-expect-error R3 requires this caller-constructible context to remain absent.
import type { BlindProposalProjectionVerificationContext as RemovedProjectionContext } from "../../src/server/services/cfp-review/artifact-types";
import {
  canonicalBlindReviewArtifactJson,
  createBlindReviewArtifact,
  fingerprintBlindReviewArtifact,
  fingerprintReviewFieldDefinitionBinding,
  fingerprintReviewRedactedValueBinding,
  fingerprintReviewSourceAnswerBinding,
  isBlindReviewAnswerType,
  isBlindReviewExclusionOnlyFieldType,
  normalizeBlindReviewArtifact,
  normalizeReviewFieldDefinitionBinding,
  normalizeReviewRedactedValueBinding,
  normalizeReviewSourceAnswerBinding,
  parseCanonicalBlindReviewArtifact,
  ReviewArtifactError,
  verifyBlindReviewArtifactFingerprint,
  type ReviewArtifactErrorCode,
} from "../../src/server/services/cfp-review/artifacts";
import {
  FORM_DOCUMENT_SCHEMA,
  FORM_FIELD_TYPES,
  normalizeFormDocument,
  type FormFieldDefinition,
  type NormalizedFormDocument,
} from "../../src/server/services/cfp/form-types";
import {
  canonicalReviewRubricSemanticsJson,
  fingerprintReviewRubricSemantics,
  normalizeReviewRubricSemantics,
  REVIEW_SCALE_CODE,
} from "../../src/server/services/cfp-review/rubric-semantics";

const ISSUED_AT = "2026-08-11T12:00:00.000Z";
const CREATED_AT = "2026-08-10T12:00:00.000Z";
const FORBIDDEN_PROJECTOR_EXPORTS = [
  "projectBlindProposal",
  "toBlindProposalProjection",
] as const;
type ForbiddenProjectorExport = Extract<
  (typeof FORBIDDEN_PROJECTOR_EXPORTS)[number],
  keyof typeof artifactExports
>;
const NO_FORBIDDEN_PROJECTOR_EXPORTS: ForbiddenProjectorExport extends never ? true : false = true;

function hash(seed: unknown): string {
  return fingerprintOf({ seed });
}

function captureArtifactError(action: () => unknown): ReviewArtifactError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ReviewArtifactError);
  return thrown as ReviewArtifactError;
}

function expectArtifactError(action: () => unknown, code: ReviewArtifactErrorCode): void {
  expect(captureArtifactError(action).code).toBe(code);
}

function fixtureForm(): NormalizedFormDocument {
  return normalizeFormDocument({
    schema: FORM_DOCUMENT_SCHEMA,
    formVersionId: "form-version-1",
    ruleVersionId: "rule-version-1",
    fields: [
      {
        id: "summary",
        type: "shortText",
        label: "Source title",
        required: true,
        defaultVisibility: "visible",
        config: { placeholder: "Original prompt", choices: ["A", "B"] },
      },
      {
        id: "speakerEmail",
        type: "email",
        label: "Speaker email",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "details",
        type: "longText",
        label: "Source abstract",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "hiddenOrg",
        type: "shortText",
        label: "Organization",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "sessionCode",
        type: "shortText",
        label: "Internal session code",
        required: false,
        defaultVisibility: "visible",
      },
    ],
    historicalAnswers: [
      { fieldId: "summary", value: "Alice and Acme propose S-SECRET" },
      { fieldId: "speakerEmail", value: "alice@example.test" },
      { fieldId: "details", value: "Original details with applicant facts" },
      { fieldId: "hiddenOrg", value: "hidden organization incorporated" },
      { fieldId: "sessionCode", value: "session-secret-42" },
    ],
    effectiveAnswers: [
      { fieldId: "summary", value: "Alice and Acme propose S-SECRET" },
      { fieldId: "speakerEmail", value: "alice@example.test" },
      { fieldId: "details", value: "Original details with applicant facts" },
      { fieldId: "sessionCode", value: "session-secret-42" },
    ],
  });
}

function fixtureDecisions(): readonly BlindFieldDecisionInput[] {
  return [
    { sourceFieldId: "sessionCode", action: "EXCLUDE" },
    {
      sourceFieldId: "details",
      action: "INCLUDE_REDACTED",
      reviewLabel: "Abstract",
      redactedValue: "A deliberately redacted abstract",
    },
    { sourceFieldId: "speakerEmail", action: "EXCLUDE" },
    {
      sourceFieldId: "summary",
      action: "INCLUDE_REDACTED",
      reviewLabel: "Proposal",
      redactedValue: "A deliberately redacted proposal",
    },
  ];
}

function artifactInput(options?: {
  readonly assignmentId?: string;
  readonly submissionRevisionId?: string;
  readonly submissionRevisionFingerprint?: string;
  readonly formDocument?: NormalizedFormDocument;
  readonly decisions?: readonly BlindFieldDecisionInput[];
  readonly rubricVersionId?: string;
  readonly rubricSemanticsId?: string;
  readonly rubricSemanticsFingerprint?: string;
}): CreateBlindReviewArtifactInput {
  const assignmentId = options?.assignmentId ?? "assignment-1";
  return {
    workspaceId: "workspace-1",
    assignmentId,
    assignmentCreatedAt: CREATED_AT,
    rubricVersionId: options?.rubricVersionId ?? "rubric-version-1",
    rubricSemanticsId: options?.rubricSemanticsId ?? "rubric-semantics-1",
    rubricSemanticsFingerprint: options?.rubricSemanticsFingerprint ?? hash("semantics"),
    submissionId: "submission-1",
    submissionRevision: {
      id: options?.submissionRevisionId ?? "submission-revision-1",
      number: 1,
      schema: CFP_SUBMISSION_REVISION_SCHEMA,
      fingerprint: options?.submissionRevisionFingerprint ?? hash("revision-1"),
      createdAt: CREATED_AT,
      formDocument: options?.formDocument ?? fixtureForm(),
    },
    disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    conflictAtIssuance: { status: "NONE", sequenceNumber: 0 },
    attestation: BLIND_REVIEW_ATTESTATION,
    issuer: {
      accountId: "organizer-account-1",
      role: "organizer",
      authority: REVIEW_ISSUER_AUTHORITY,
    },
    issuedAt: ISSUED_AT,
    decisions: options?.decisions ?? fixtureDecisions(),
  };
}

function fieldBinding(
  field: FormFieldDefinition = fixtureForm().fields[0]!,
): Record<string, unknown> {
  return {
    schema: CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
    workspaceId: "workspace-1",
    assignmentId: "assignment-1",
    submissionRevisionId: "submission-revision-1",
    formDocumentSchema: FORM_DOCUMENT_SCHEMA,
    formVersionId: "form-version-1",
    ruleVersionId: "rule-version-1",
    formDocumentFingerprint: hash("form-document"),
    field,
  };
}

function recomputedRedactedFingerprint(
  artifact: BlindReviewArtifactV1,
  item: Pick<
    BlindArtifactItemV1,
    | "sourceAnswerFingerprint"
    | "disposition"
    | "answerKey"
    | "displayOrder"
    | "label"
    | "type"
    | "value"
  >,
): string {
  return fingerprintReviewRedactedValueBinding({
    schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
    workspaceId: artifact.workspaceId,
    assignmentId: artifact.assignmentId,
    submissionRevisionId: artifact.submissionRevision.id,
    sourceAnswerFingerprint: item.sourceAnswerFingerprint,
    disclosureStage: artifact.disclosureStage,
    disposition: item.disposition,
    answerKey: item.answerKey,
    displayOrder: item.displayOrder,
    label: item.label,
    type: item.type,
    value: item.value,
  });
}

describe("canonical blind-review artifact bindings", () => {
  it("binds the complete normalized field definition and changes on every frozen mutation", () => {
    const base = fieldBinding();
    const baseFingerprint = fingerprintReviewFieldDefinitionBinding(base);
    const baseField = base.field as FormFieldDefinition;
    const mutations: Record<string, unknown>[] = [
      { ...base, assignmentId: "assignment-2" },
      { ...base, submissionRevisionId: "submission-revision-2" },
      { ...base, formVersionId: "form-version-2" },
      { ...base, ruleVersionId: "rule-version-2" },
      { ...base, formDocumentFingerprint: hash("other-form") },
      { ...base, field: { ...baseField, id: "other-field" } },
      { ...base, field: { ...baseField, label: "Changed source label" } },
      { ...base, field: { ...baseField, type: "longText" } },
      { ...base, field: { ...baseField, required: false } },
      { ...base, field: { ...baseField, defaultVisibility: "hidden" } },
      { ...base, field: { ...baseField, config: { placeholder: "Changed", choices: ["A"] } } },
    ];

    expect(normalizeReviewFieldDefinitionBinding(base).field).toEqual(baseField);
    for (const mutation of mutations) {
      expect(fingerprintReviewFieldDefinitionBinding(mutation)).not.toBe(baseFingerprint);
    }
  });

  it("scopes identical source values to assignment and revision", () => {
    const base = {
      schema: CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
      workspaceId: "workspace-1",
      assignmentId: "assignment-1",
      submissionId: "submission-1",
      submissionRevisionId: "submission-revision-1",
      submissionRevisionFingerprint: hash("revision"),
      fieldId: "summary",
      fieldDefinitionFingerprint: hash("field"),
      value: "the identical source value",
    };
    const baseFingerprint = fingerprintReviewSourceAnswerBinding(base);
    expect(normalizeReviewSourceAnswerBinding(base).value).toBe("the identical source value");
    expect(
      fingerprintReviewSourceAnswerBinding({ ...base, assignmentId: "assignment-2" }),
    ).not.toBe(baseFingerprint);
    expect(
      fingerprintReviewSourceAnswerBinding({
        ...base,
        submissionRevisionId: "submission-revision-2",
      }),
    ).not.toBe(baseFingerprint);
    expect(
      fingerprintReviewSourceAnswerBinding({
        ...base,
        submissionRevisionFingerprint: hash("revision-2"),
      }),
    ).not.toBe(baseFingerprint);
  });

  it("keeps included null distinct from exclusion and verifies every redacted binding member", () => {
    const common = {
      schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
      workspaceId: "workspace-1",
      assignmentId: "assignment-1",
      submissionRevisionId: "submission-revision-1",
      sourceAnswerFingerprint: hash("source"),
      disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
    };
    const included = normalizeReviewRedactedValueBinding({
      ...common,
      disposition: "INCLUDE_REDACTED",
      answerKey: "answer-0001",
      displayOrder: 1,
      label: "Redacted answer",
      type: "shortText",
      value: null,
    });
    const excluded = normalizeReviewRedactedValueBinding({
      ...common,
      disposition: "EXCLUDE",
      answerKey: null,
      displayOrder: null,
      label: null,
      type: null,
      value: null,
    });

    expect(fingerprintReviewRedactedValueBinding(included)).not.toBe(
      fingerprintReviewRedactedValueBinding(excluded),
    );
    for (const mutation of [
      { ...included, assignmentId: "assignment-2" },
      { ...included, submissionRevisionId: "submission-revision-2" },
      { ...included, sourceAnswerFingerprint: hash("other-source") },
      { ...included, answerKey: "answer-0002", displayOrder: 2 },
      { ...included, label: "Other label" },
      { ...included, type: "longText" },
      { ...included, value: "redacted" },
    ]) {
      expect(fingerprintReviewRedactedValueBinding(mutation)).not.toBe(
        fingerprintReviewRedactedValueBinding(included),
      );
    }
  });

  it("fails closed on unknown keys, malformed bindings, and incompatible redacted values", () => {
    expectArtifactError(
      () => normalizeReviewFieldDefinitionBinding({ ...fieldBinding(), unknown: true }),
      "ARTIFACT_BINDING_INVALID",
    );
    expectArtifactError(
      () =>
        normalizeReviewSourceAnswerBinding({
          schema: CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
          workspaceId: "workspace-1",
        }),
      "ARTIFACT_BINDING_INVALID",
    );
    expectArtifactError(
      () =>
        normalizeReviewRedactedValueBinding({
          schema: CFP_REVIEW_REDACTED_VALUE_BINDING_SCHEMA,
          workspaceId: "workspace-1",
          assignmentId: "assignment-1",
          submissionRevisionId: "submission-revision-1",
          sourceAnswerFingerprint: hash("source"),
          disclosureStage: BLIND_REVIEW_DISCLOSURE_STAGE,
          disposition: "INCLUDE_REDACTED",
          answerKey: "answer-0001",
          displayOrder: 1,
          label: "Integer",
          type: "integer",
          value: "not-an-integer",
        }),
      "ARTIFACT_REDACTED_VALUE_INVALID",
    );
  });
});

describe("blind-review artifact construction", () => {
  it("requires exactly one decision for every effective answer", () => {
    expectArtifactError(
      () => createBlindReviewArtifact(artifactInput({ decisions: fixtureDecisions().slice(1) })),
      "ARTIFACT_DECISION_MISSING",
    );
    expectArtifactError(
      () =>
        createBlindReviewArtifact(
          artifactInput({ decisions: [...fixtureDecisions(), fixtureDecisions()[0]!] }),
        ),
      "ARTIFACT_DECISION_DUPLICATE",
    );
    expectArtifactError(
      () =>
        createBlindReviewArtifact(
          artifactInput({
            decisions: [
              ...fixtureDecisions(),
              { sourceFieldId: "unknownField", action: "EXCLUDE" },
            ],
          }),
        ),
      "ARTIFACT_DECISION_UNKNOWN",
    );
    expectArtifactError(
      () =>
        createBlindReviewArtifact(
          artifactInput({
            decisions: [
              ...fixtureDecisions(),
              { sourceFieldId: "hiddenOrg", action: "EXCLUDE" },
            ],
          }),
        ),
      "ARTIFACT_DECISION_UNKNOWN",
    );
  });

  it("uses only structural type policy and rejects inclusion of exclusion-only fields", () => {
    expect(new Set([...BLIND_ANSWER_TYPES, ...BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES])).toEqual(
      new Set(FORM_FIELD_TYPES),
    );
    for (const type of FORM_FIELD_TYPES) {
      expect(isBlindReviewAnswerType(type)).toBe(BLIND_ANSWER_TYPES.includes(type as never));
      expect(isBlindReviewExclusionOnlyFieldType(type)).toBe(
        BLIND_REVIEW_EXCLUSION_ONLY_FIELD_TYPES.includes(type as never),
      );
    }

    const decisions = fixtureDecisions().map((decision) =>
      decision.sourceFieldId === "speakerEmail"
        ? ({
            sourceFieldId: "speakerEmail",
            action: "INCLUDE_REDACTED",
            reviewLabel: "Contact",
            redactedValue: "redacted@example.test",
          } as const)
        : decision,
    );
    expectArtifactError(
      () => createBlindReviewArtifact(artifactInput({ decisions })),
      "ARTIFACT_STRUCTURAL_INCLUDE_FORBIDDEN",
    );
  });

  it("includes a hidden-by-default field when it is in the effective-answer set", () => {
    const baseForm = fixtureForm();
    const hiddenAnswer = baseForm.historicalAnswers.find(
      (answer) => answer.fieldId === "hiddenOrg",
    )!;
    const formDocument = normalizeFormDocument({
      schema: baseForm.schema,
      formVersionId: baseForm.formVersionId,
      ruleVersionId: baseForm.ruleVersionId,
      fields: baseForm.fields,
      historicalAnswers: baseForm.historicalAnswers,
      effectiveAnswers: [...baseForm.effectiveAnswers, hiddenAnswer],
    });
    const decisions: readonly BlindFieldDecisionInput[] = [
      ...fixtureDecisions(),
      {
        sourceFieldId: "hiddenOrg",
        action: "INCLUDE_REDACTED",
        reviewLabel: "Organization",
        redactedValue: "A conditionally shown organization",
      },
    ];

    const artifact = createBlindReviewArtifact(artifactInput({ formDocument, decisions }));
    expect(formDocument.fields.find((field) => field.id === "hiddenOrg")?.defaultVisibility).toBe(
      "hidden",
    );
    expect(formDocument.effectiveAnswers).toContainEqual(hiddenAnswer);
    expect(artifact.items.find((item) => item.sourceFieldId === "hiddenOrg")).toMatchObject({
      disposition: "INCLUDE_REDACTED",
      answerKey: "answer-0003",
      displayOrder: 3,
      label: "Organization",
      type: "shortText",
      value: "A conditionally shown organization",
    });
  });

  it("accepts explicit organizer redactions without claiming text-heuristic blindness", () => {
    const decisions = fixtureDecisions().map((decision) =>
      decision.sourceFieldId === "summary" && decision.action === "INCLUDE_REDACTED"
        ? {
            ...decision,
            reviewLabel: "Alice Example at Acme Incorporated",
            redactedValue: "alice@example.test and session-code-42",
          }
        : decision,
    );
    const input = artifactInput({ decisions });
    const artifact = createBlindReviewArtifact(input);
    expect(artifact.items.find((item) => item.sourceFieldId === "summary")).toMatchObject({
      disposition: "INCLUDE_REDACTED",
      label: "Alice Example at Acme Incorporated",
      value: "alice@example.test and session-code-42",
    });
    expect(artifact.attestation).toBe(BLIND_REVIEW_ATTESTATION);
  });

  it("derives a complete binding chain for every supplied effective answer", () => {
    const input = artifactInput();
    const artifact = createBlindReviewArtifact(input);
    const formDocument = input.submissionRevision.formDocument;

    expect(artifact.sourceAnswerCount).toBe(formDocument.effectiveAnswers.length);
    for (const answer of formDocument.effectiveAnswers) {
      const field = formDocument.fields.find((candidate) => candidate.id === answer.fieldId)!;
      const item = artifact.items.find((candidate) => candidate.sourceFieldId === answer.fieldId)!;
      const fieldDefinitionFingerprint = fingerprintReviewFieldDefinitionBinding({
        schema: CFP_REVIEW_FIELD_DEFINITION_BINDING_SCHEMA,
        workspaceId: input.workspaceId,
        assignmentId: input.assignmentId,
        submissionRevisionId: input.submissionRevision.id,
        formDocumentSchema: formDocument.schema,
        formVersionId: formDocument.formVersionId,
        ruleVersionId: formDocument.ruleVersionId,
        formDocumentFingerprint: formDocument.fingerprint,
        field,
      });
      const sourceAnswerFingerprint = fingerprintReviewSourceAnswerBinding({
        schema: CFP_REVIEW_SOURCE_ANSWER_BINDING_SCHEMA,
        workspaceId: input.workspaceId,
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        submissionRevisionId: input.submissionRevision.id,
        submissionRevisionFingerprint: input.submissionRevision.fingerprint,
        fieldId: answer.fieldId,
        fieldDefinitionFingerprint,
        value: answer.value,
      });

      expect(item.fieldDefinitionFingerprint).toBe(fieldDefinitionFingerprint);
      expect(item.sourceAnswerFingerprint).toBe(sourceAnswerFingerprint);
      expect(item.redactedValueFingerprint).toBe(recomputedRedactedFingerprint(artifact, item));
    }
  });

  it("sorts internal items by source id while preserving compact source-display order", () => {
    const input = artifactInput();
    const artifact = createBlindReviewArtifact(input);
    expect(artifact.items.map((item) => item.sourceFieldId)).toEqual([
      "details",
      "sessionCode",
      "speakerEmail",
      "summary",
    ]);
    const includedInternal = artifact.items.filter(
      (item) => item.disposition === "INCLUDE_REDACTED",
    );
    expect(includedInternal.map((item) => [item.sourceFieldId, item.answerKey, item.displayOrder])).toEqual([
      ["details", "answer-0002", 2],
      ["summary", "answer-0001", 1],
    ]);
    expect(
      [...includedInternal]
        .sort((left, right) => left.displayOrder! - right.displayOrder!)
        .map((item) => item.answerKey),
    ).toEqual(["answer-0001", "answer-0002"]);
  });

  it("supports the current 256-answer submission contract", () => {
    const fields = Array.from({ length: 256 }, (_, index) => ({
      id: `field-${String(index).padStart(3, "0")}`,
      type: "shortText" as const,
      label: `Field ${index}`,
      required: false,
      defaultVisibility: "visible" as const,
    }));
    const answers = fields.map((field) => ({ fieldId: field.id, value: `source-${field.id}` }));
    const formDocument = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "form-256",
      ruleVersionId: "rules-256",
      fields,
      historicalAnswers: answers,
      effectiveAnswers: answers,
    });
    const decisions = fields.map((field) => ({
      sourceFieldId: field.id,
      action: "INCLUDE_REDACTED" as const,
      reviewLabel: `Answer ${field.id}`,
      redactedValue: `redacted-${field.id}`,
    }));
    const input = artifactInput({ formDocument, decisions });
    const artifact = createBlindReviewArtifact(input);
    expect(artifact.sourceAnswerCount).toBe(256);
    const included = artifact.items.filter((item) => item.disposition === "INCLUDE_REDACTED");
    expect(included).toHaveLength(256);
    expect(included.find((item) => item.displayOrder === 256)?.answerKey).toBe("answer-0256");
  });
});

describe("canonical artifact normalization and integrity", () => {
  it("round-trips canonically, sorts caller item permutations, and verifies the internal fingerprint", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    const canonical = canonicalBlindReviewArtifactJson(artifact);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.submissionRevision)).toBe(true);
    expect(Object.isFrozen(artifact.items)).toBe(true);
    expect(artifact.items.every((item) => Object.isFrozen(item))).toBe(true);
    expect(parseCanonicalBlindReviewArtifact(canonical)).toEqual(artifact);
    expect(canonical).toBe(canonicalJson(artifact));
    expect(verifyBlindReviewArtifactFingerprint(artifact, fingerprintBlindReviewArtifact(artifact))).toBe(
      true,
    );
    expect(verifyBlindReviewArtifactFingerprint(artifact, hash("wrong"))).toBe(false);

    const permuted = { ...artifact, items: [...artifact.items].reverse() };
    expect(normalizeBlindReviewArtifact(permuted)).toEqual(artifact);
    expect(fingerprintBlindReviewArtifact(permuted)).toBe(fingerprintBlindReviewArtifact(artifact));
    expectArtifactError(
      () => parseCanonicalBlindReviewArtifact(JSON.stringify(artifact)),
      "ARTIFACT_CANONICAL_JSON_INVALID",
    );
  });

  it("exports no artifact-to-reviewer projector or caller verification context", () => {
    expect(NO_FORBIDDEN_PROJECTOR_EXPORTS).toBe(true);
    for (const exportName of FORBIDDEN_PROJECTOR_EXPORTS) {
      expect(Object.prototype.hasOwnProperty.call(artifactExports, exportName)).toBe(false);
    }
    expect(Object.keys(artifactExports).sort()).toEqual(
      [
        "BlindReviewArtifactError",
        "ReviewArtifactError",
        "blindReviewArtifactFingerprint",
        "buildBlindReviewArtifact",
        "canonicalBlindReviewArtifactJson",
        "createBlindReviewArtifact",
        "fieldDefinitionFingerprint",
        "fingerprintBlindReviewArtifact",
        "fingerprintFieldDefinitionBinding",
        "fingerprintRedactedValueBinding",
        "fingerprintReviewFieldDefinitionBinding",
        "fingerprintReviewRedactedValueBinding",
        "fingerprintReviewSourceAnswerBinding",
        "fingerprintSourceAnswerBinding",
        "isBlindReviewAnswerType",
        "isBlindReviewExclusionOnlyFieldType",
        "normalizeBlindReviewArtifact",
        "normalizeFieldDefinitionBinding",
        "normalizeRedactedValueBinding",
        "normalizeReviewFieldDefinitionBinding",
        "normalizeReviewRedactedValueBinding",
        "normalizeReviewSourceAnswerBinding",
        "normalizeSourceAnswerBinding",
        "parseCanonicalBlindReviewArtifact",
        "redactedValueFingerprint",
        "sourceAnswerFingerprint",
        "verifyBlindReviewArtifactFingerprint",
      ].sort(),
    );
  });

  it("treats recomputable fingerprints as canonical integrity, not provenance", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    const items = artifact.items.map((item) => {
      if (item.sourceFieldId !== "summary" || item.disposition !== "INCLUDE_REDACTED") {
        return item;
      }
      const changed = {
        ...item,
        label: "Recomputed disclosure",
        value: "a caller-selected replacement",
      };
      return {
        ...changed,
        redactedValueFingerprint: recomputedRedactedFingerprint(artifact, changed),
      };
    });
    const rehashed = normalizeBlindReviewArtifact({ ...artifact, items });
    const rehashedFingerprint = fingerprintBlindReviewArtifact(rehashed);

    expect(rehashedFingerprint).not.toBe(fingerprintBlindReviewArtifact(artifact));
    expect(verifyBlindReviewArtifactFingerprint(rehashed, rehashedFingerprint)).toBe(true);
    expect(rehashed.items.find((item) => item.sourceFieldId === "summary")).toMatchObject({
      label: "Recomputed disclosure",
      value: "a caller-selected replacement",
    });
  });

  it("rejects duplicate, unknown, malformed, oversized, and tampered document inputs", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    expectArtifactError(
      () => normalizeBlindReviewArtifact({ ...artifact, unknown: true }),
      "ARTIFACT_SHAPE_INVALID",
    );
    expectArtifactError(
      () =>
        normalizeBlindReviewArtifact({
          ...artifact,
          sourceAnswerCount: artifact.items.length + 1,
          items: [...artifact.items, artifact.items[0]!],
        }),
      "ARTIFACT_ITEM_DUPLICATE",
    );
    expectArtifactError(
      () =>
        normalizeBlindReviewArtifact({
          ...artifact,
          rubricSemanticsFingerprint: "not-a-fingerprint",
        }),
      "ARTIFACT_FINGERPRINT_INVALID",
    );
    const tamperedItems = artifact.items.map((item, index) =>
      index === 0 ? { ...item, redactedValueFingerprint: hash("tampered") } : item,
    );
    expectArtifactError(
      () => normalizeBlindReviewArtifact({ ...artifact, items: tamperedItems }),
      "ARTIFACT_FINGERPRINT_MISMATCH",
    );
    expectArtifactError(
      () =>
        normalizeBlindReviewArtifact({
          ...artifact,
          sourceAnswerCount: BLIND_REVIEW_ARTIFACT_LIMITS.maxItems + 1,
          items: Array.from(
            { length: BLIND_REVIEW_ARTIFACT_LIMITS.maxItems + 1 },
            () => artifact.items[0]!,
          ),
        }),
      "ARTIFACT_LIMIT_EXCEEDED",
    );
  });

  it("rejects hostile outer accessors without invoking them", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    const hostile = { ...artifact } as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(hostile, "items", {
      enumerable: true,
      get() {
        calls += 1;
        return artifact.items;
      },
    });
    const error = captureArtifactError(() => normalizeBlindReviewArtifact(hostile));
    expect(error.code).toBe("ARTIFACT_INPUT_UNSAFE");
    expect(calls).toBe(0);
    expect(error.message).not.toContain("items");
  });

  it("keeps nested proxies, accessors, cycles, symbols, sparse arrays, and unsafe prototypes opaque", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    const includedIndex = artifact.items.findIndex(
      (item) => item.disposition === "INCLUDE_REDACTED",
    );
    const withHostileValue = (value: unknown): Record<string, unknown> => ({
      ...artifact,
      items: artifact.items.map((item, index) =>
        index === includedIndex ? { ...item, value } : item,
      ),
    });

    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(new Proxy({}, {}))),
      "ARTIFACT_INPUT_UNSAFE",
    );

    let accessorCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-run";
      },
    });
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(accessor)),
      "ARTIFACT_INPUT_UNSAFE",
    );
    expect(accessorCalls).toBe(0);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(cyclic)),
      "ARTIFACT_INPUT_UNSAFE",
    );

    const symbolValue = { visible: "safe-looking" };
    Object.defineProperty(symbolValue, Symbol("hidden"), { value: "opaque" });
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(symbolValue)),
      "ARTIFACT_INPUT_UNSAFE",
    );

    const sparse = new Array<unknown>(3);
    sparse[2] = "present";
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(sparse)),
      "ARTIFACT_INPUT_UNSAFE",
    );

    const inherited = Object.create({ inherited: "not-owned" }) as Record<string, unknown>;
    inherited.visible = "owned";
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(inherited)),
      "ARTIFACT_INPUT_UNSAFE",
    );

    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth <= BLIND_REVIEW_ARTIFACT_LIMITS.maxDepth; depth += 1) {
      tooDeep = [tooDeep];
    }
    expectArtifactError(
      () => normalizeBlindReviewArtifact(withHostileValue(tooDeep)),
      "ARTIFACT_LIMIT_EXCEEDED",
    );
  });

  it("applies one aggregate node and byte preflight before malformed per-item bindings", () => {
    const artifact = createBlindReviewArtifact(artifactInput());
    const template = artifact.items.find(
      (item) => item.disposition === "INCLUDE_REDACTED",
    )!;
    const nodeHeavyItems = Array.from({ length: 300 }, (_, index) => ({
      ...template,
      sourceFieldId: `node-heavy-${index}`,
      fieldDefinitionFingerprint: "malformed-before-item-normalization",
      value: Array.from({ length: 900 }, () => null),
    }));
    expectArtifactError(
      () =>
        normalizeBlindReviewArtifact({
          ...artifact,
          sourceAnswerCount: nodeHeavyItems.length,
          items: nodeHeavyItems,
        }),
      "ARTIFACT_LIMIT_EXCEEDED",
    );

    const byteHeavyItems = Array.from({ length: 70 }, (_, index) => ({
      ...template,
      sourceFieldId: `byte-heavy-${index}`,
      fieldDefinitionFingerprint: "malformed-before-item-normalization",
      value: "HOSTILE_AGGREGATE_SENTINEL".padEnd(64 * 1024, "x"),
    }));
    const byteError = captureArtifactError(() =>
      normalizeBlindReviewArtifact({
        ...artifact,
        sourceAnswerCount: byteHeavyItems.length,
        items: byteHeavyItems,
      }),
    );
    expect(byteError.code).toBe("ARTIFACT_LIMIT_EXCEEDED");
    expect(byteError.message).not.toContain("HOSTILE_AGGREGATE_SENTINEL");
  });

  it("enforces the 4 MiB canonical document bound independently of item count", () => {
    const fields = Array.from({ length: 70 }, (_, index) => ({
      id: `large-${index}`,
      type: "shortText" as const,
      label: `Large ${index}`,
      required: false,
      defaultVisibility: "visible" as const,
    }));
    const answers = fields.map((field) => ({ fieldId: field.id, value: "source" }));
    const formDocument = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "large-form",
      ruleVersionId: "large-rules",
      fields,
      historicalAnswers: answers,
      effectiveAnswers: answers,
    });
    const decisions = fields.map((field) => ({
      sourceFieldId: field.id,
      action: "INCLUDE_REDACTED" as const,
      reviewLabel: "Large redaction",
      redactedValue: "x".repeat(64 * 1024),
    }));
    expectArtifactError(
      () => createBlindReviewArtifact(artifactInput({ formDocument, decisions })),
      "ARTIFACT_LIMIT_EXCEEDED",
    );
  });
});

describe("shared neutral semantics at assignment scale", () => {
  it("serves 300 assignments and 900 bound answers without mutating or proliferating the rubric", () => {
    const semantics = normalizeReviewRubricSemantics({
      schema: "cfp-review-rubric-semantics/v1",
      version: 1,
      workspaceId: "workspace-1",
      roundId: "round-1",
      rubricVersionId: "rubric-version-shared",
      rubricVersionNumber: 1,
      rubricVersionFingerprint: hash("legacy-rubric"),
      criteria: [
        {
          semantic: "PROPOSAL_QUALITY",
          kind: "scale",
          required: true,
          weight: 1,
          scaleCode: REVIEW_SCALE_CODE,
        },
      ],
      issuer: {
        accountId: "organizer-account-1",
        role: "organizer",
        authority: REVIEW_ISSUER_AUTHORITY,
      },
      issuedAt: ISSUED_AT,
    });
    const before = canonicalReviewRubricSemanticsJson(semantics);
    const semanticsFingerprint = fingerprintReviewRubricSemantics(semantics);
    const fields = ["first", "second", "third"].map((id) => ({
      id,
      type: "shortText" as const,
      label: id,
      required: true,
      defaultVisibility: "visible" as const,
    }));
    const answers = fields.map((field) => ({ fieldId: field.id, value: "identical source" }));
    const sharedForm = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "shared-form",
      ruleVersionId: "shared-rules",
      fields,
      historicalAnswers: answers,
      effectiveAnswers: answers,
    });
    const decisions = fields.map((field) => ({
      sourceFieldId: field.id,
      action: "INCLUDE_REDACTED" as const,
      reviewLabel: `Redacted ${field.id}`,
      redactedValue: "same redaction",
    }));

    const artifactFingerprints = new Set<string>();
    let bindingCount = 0;
    for (let index = 0; index < 300; index += 1) {
      const artifact = createBlindReviewArtifact(
        artifactInput({
          assignmentId: `assignment-${index + 1}`,
          submissionRevisionId: `revision-${index + 1}`,
          submissionRevisionFingerprint: hash(`revision-${index + 1}`),
          formDocument: sharedForm,
          decisions,
          rubricVersionId: semantics.rubricVersionId,
          rubricSemanticsId: "rubric-semantics-shared",
          rubricSemanticsFingerprint: semanticsFingerprint,
        }),
      );
      expect(artifact.rubricVersionId).toBe(semantics.rubricVersionId);
      expect(artifact.rubricSemanticsId).toBe("rubric-semantics-shared");
      expect(artifact.rubricSemanticsFingerprint).toBe(semanticsFingerprint);
      bindingCount += artifact.items.length;
      artifactFingerprints.add(fingerprintBlindReviewArtifact(artifact));
    }

    expect(bindingCount).toBe(900);
    expect(artifactFingerprints).toHaveLength(300);
    expect(canonicalReviewRubricSemanticsJson(semantics)).toBe(before);
  });
});
