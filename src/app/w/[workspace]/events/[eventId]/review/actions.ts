"use server";

import { Buffer } from "node:buffer";

import { revalidatePath } from "next/cache";

import {
  IDLE_REVIEWER_PROVISIONING_ACTION,
  type ReviewerProvisioningActionState,
} from "@/components/cfp-review/reviewer-provisioning-action-state";
import { getDb } from "@/server/db";
import {
  OrganizerReviewServiceError,
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  distributeOrganizerReviewAssignments,
  recordOrganizerReviewReminders,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundSchedule,
  setOrganizerReviewRoundState,
  type CreateOrganizerReviewRoundInput,
  type CreateOrganizerReviewRubricInput,
  type DistributeOrganizerReviewAssignmentsInput,
  type OrganizerReviewDistributionReceipt,
  type OrganizerReviewBlindArtifactDecisionSet,
  type OrganizerReviewRubricFieldInput,
  type OrganizerReviewRoundReceipt,
  type OrganizerReviewRoundScheduleReceipt,
  type OrganizerReviewRoundStateReceipt,
  type SetOrganizerReviewRoundScheduleInput,
  type SetOrganizerReviewRoundStateInput,
} from "@/server/services/cfp-review/organizer";
import {
  OrganizerReviewBlindControlError,
  setOrganizerReviewBlindControl,
  type OrganizerReviewBlindControlReceipt,
} from "@/server/services/cfp-review/review-blind-control";
import type { OrganizerReviewRubricReceipt } from "@/server/services/cfp-review/organizer-types";
import {
  provisionPinnedReviewer,
  ReviewerProvisioningServiceError,
  type ReviewerAccessIntent,
  type ReviewerProvisioningReceipt,
} from "@/server/services/cfp-review/reviewer-provisioning";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_ARRAY_LENGTH = 4_096;
const MAX_JSON_OBJECT_KEYS = 64;
const MAX_JSON_STRING_BYTES = 64 * 1024;
const MAX_RUBRIC_FIELDS = 32;
const MAX_RUBRIC_CHOICES = 32;
const MAX_DISTRIBUTION_REVIEWERS = 256;
const MAX_DISTRIBUTION_SUBMISSIONS = 4_096;
const MAX_DISTRIBUTION_POOLS = 32;
const MAX_ASSIGNMENTS_PER_REVIEWER = 4_096;
const MAX_NUMERIC_MAGNITUDE = 1_000_000_000;
const MAX_FORM_ENTRIES = 4_500;
const MAX_FORM_BYTES = 2 * 1024 * 1024;

const INVALID_VALUE = Symbol("invalid-form-value");
type InvalidValue = typeof INVALID_VALUE;

type OrganizerReviewActionError = {
  readonly kind: "error";
  readonly code: string;
  readonly message: string;
};

export type OrganizerReviewRoundActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_ROUND_SAVED";
      readonly message: string;
      readonly receipt: OrganizerReviewRoundReceipt;
      readonly revalidated: boolean;
    };

export type OrganizerReviewRoundScheduleActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_ROUND_SCHEDULE_SAVED";
      readonly message: string;
      readonly receipt: OrganizerReviewRoundScheduleReceipt;
      readonly revalidated: boolean;
    };

export type OrganizerReviewRoundStateActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_ROUND_STATE_SAVED";
      readonly message: string;
      readonly receipt: OrganizerReviewRoundStateReceipt;
      readonly revalidated: boolean;
    };

export type OrganizerReviewRubricActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_RUBRIC_SAVED";
      readonly message: string;
      readonly receipt: OrganizerReviewRubricReceipt;
      readonly revalidated: boolean;
    };

export type OrganizerReviewDistributionActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_ASSIGNMENTS_DISTRIBUTED";
      readonly message: string;
      readonly receipt: OrganizerReviewDistributionReceipt;
      readonly revalidated: boolean;
    };

export type OrganizerReviewBlindControlActionState =
  | { readonly kind: "idle" }
  | OrganizerReviewActionError
  | {
      readonly kind: "success";
      readonly code: "REVIEW_BLIND_CONTROL_SAVED";
      readonly message: string;
      readonly receipt: OrganizerReviewBlindControlReceipt;
      readonly revalidated: boolean;
    };

const IDLE_ORGANIZER_REVIEW_ROUND_ACTION: OrganizerReviewRoundActionState = {
  kind: "idle",
};
const IDLE_ORGANIZER_REVIEW_ROUND_SCHEDULE_ACTION: OrganizerReviewRoundScheduleActionState = {
  kind: "idle",
};
const IDLE_ORGANIZER_REVIEW_ROUND_STATE_ACTION: OrganizerReviewRoundStateActionState = {
  kind: "idle",
};
const IDLE_ORGANIZER_REVIEW_RUBRIC_ACTION: OrganizerReviewRubricActionState = {
  kind: "idle",
};
const IDLE_ORGANIZER_REVIEW_DISTRIBUTION_ACTION: OrganizerReviewDistributionActionState = {
  kind: "idle",
};
const IDLE_ORGANIZER_REVIEW_BLIND_CONTROL_ACTION: OrganizerReviewBlindControlActionState = {
  kind: "idle",
};
export type OrganizerReviewReminderActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "success";
      readonly message: string;
      readonly outstandingCount: number;
      readonly recordedCount: number;
      readonly replayed: boolean;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

const INITIAL_STATE: OrganizerReviewReminderActionState = { kind: "idle" };

function postedIdentifier(formData: FormData, name: string, pattern: RegExp): string | null {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string" || !pattern.test(values[0])) {
    return null;
  }
  return values[0];
}

function textValue(value: unknown, maximumBytes: number): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value.trim();
}

function postedText(formData: FormData, name: string, maximumBytes: number): string | null {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  return textValue(values[0], maximumBytes);
}

function postedUtcTimestamp(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(values[0])
    ? `${values[0]}:00.000Z`
    : values[0];
  try {
    return new Date(candidate).toISOString() === candidate ? candidate : null;
  } catch {
    return null;
  }
}

function optionalPostedUtcTimestamp(
  formData: FormData,
  name: string,
): string | undefined | null {
  if (formData.getAll(name).length === 0) return undefined;
  return postedUtcTimestamp(formData, name);
}

function optionalIdentifier(
  formData: FormData,
  name: string,
): string | undefined | null {
  const values = formData.getAll(name);
  if (values.length === 0) return undefined;
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    !IDENTIFIER_PATTERN.test(values[0])
  ) {
    return null;
  }
  return values[0];
}

function boundedJson(value: unknown): unknown | InvalidValue {
  let nodes = 0;

  function visit(candidate: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") {
      return typeof candidate !== "number" || Number.isFinite(candidate);
    }
    if (typeof candidate === "string") {
      return (
        Buffer.byteLength(candidate, "utf8") <= MAX_JSON_STRING_BYTES &&
        !CONTROL_CHARACTER_PATTERN.test(candidate)
      );
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_ARRAY_LENGTH) return false;
      return candidate.every((item) => visit(item, depth + 1));
    }
    if (typeof candidate !== "object") return false;
    const keys = Object.keys(candidate);
    if (
      keys.length > MAX_JSON_OBJECT_KEYS ||
      keys.some((key) => Buffer.byteLength(key, "utf8") > 128)
    ) {
      return false;
    }
    return keys.every((key) => visit((candidate as Record<string, unknown>)[key], depth + 1));
  }

  return visit(value, 0) ? value : INVALID_VALUE;
}

function jsonField(formData: FormData, name: string): unknown | undefined | InvalidValue {
  const values = formData.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") return INVALID_VALUE;
  if (Buffer.byteLength(values[0], "utf8") > MAX_JSON_BYTES) return INVALID_VALUE;
  try {
    return boundedJson(JSON.parse(values[0]) as unknown);
  } catch {
    return INVALID_VALUE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactJsonKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function jsonText(value: unknown, maximumBytes: number): string | null {
  return textValue(value, maximumBytes);
}

function jsonIdentifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function jsonNumber(value: unknown, maximumMagnitude = MAX_NUMERIC_MAGNITUDE): number | null {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= maximumMagnitude
  )
    ? value
    : null;
}

function jsonPositiveInteger(value: unknown, maximum: number): number | null {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  )
    ? value
    : null;
}

function formDataWithinBounds(formData: FormData): boolean {
  let entries = 0;
  let bytes = 0;
  for (const [key, value] of formData.entries()) {
    entries += 1;
    if (entries > MAX_FORM_ENTRIES || Buffer.byteLength(key, "utf8") > 128) return false;
    if (typeof value !== "string") return false;
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_FORM_BYTES) return false;
  }
  return true;
}

function rubricFieldFromJson(value: unknown): OrganizerReviewRubricFieldInput | null {
  if (!isRecord(value)) return null;
  const id = jsonIdentifier(value.id);
  const label = jsonText(value.label, 512);
  const kind = value.kind;
  const required = value.required;
  const weight = jsonNumber(value.weight, 100_000);
  const recommendation = value.recommendation === undefined ? undefined : value.recommendation;
  if (
    !id ||
    !label ||
    (kind !== "numeric" && kind !== "dropdown" && kind !== "text") ||
    typeof required !== "boolean" ||
    weight === null ||
    weight <= 0 ||
    (recommendation !== undefined && typeof recommendation !== "boolean")
  ) {
    return null;
  }

  let guidance: string | undefined;
  if (value.guidance !== undefined) {
    const parsedGuidance = jsonText(value.guidance, 4_096);
    if (!parsedGuidance) return null;
    guidance = parsedGuidance;
  }

  if (kind === "numeric") {
    if (
      !hasExactJsonKeys(
        value,
        ["id", "label", "kind", "required", "weight"],
        ["guidance", "recommendation", "minimum", "maximum", "step"],
      ) ||
      Object.hasOwn(value, "choices") ||
      Object.hasOwn(value, "maxLength")
    ) {
      return null;
    }
    const minimum = value.minimum === undefined ? 0 : jsonNumber(value.minimum);
    const maximum = value.maximum === undefined ? 10 : jsonNumber(value.maximum);
    const step = value.step === undefined ? 1 : jsonNumber(value.step);
    if (
      minimum === null ||
      maximum === null ||
      step === null ||
      maximum <= minimum ||
      step <= 0 ||
      step > maximum - minimum
    ) return null;
    return {
      id,
      label,
      ...(guidance !== undefined ? { guidance } : {}),
      kind,
      required,
      weight,
      ...(recommendation !== undefined ? { recommendation } : {}),
      minimum,
      maximum,
      step,
    };
  }

  if (kind === "dropdown") {
    if (
      !hasExactJsonKeys(
        value,
        ["id", "label", "kind", "required", "weight", "choices"],
        ["guidance", "recommendation"],
      ) ||
      !Array.isArray(value.choices) ||
      value.choices.length < 1 ||
      value.choices.length > MAX_RUBRIC_CHOICES
    ) {
      return null;
    }
    const choices: Array<{ readonly value: string; readonly label: string }> = [];
    const seen = new Set<string>();
    for (const choice of value.choices) {
      if (!isRecord(choice) || !hasExactJsonKeys(choice, ["value", "label"])) return null;
      const choiceValue = jsonText(choice.value, 128);
      const choiceLabel = jsonText(choice.label, 512);
      if (!choiceValue || !choiceLabel || seen.has(choiceValue)) return null;
      seen.add(choiceValue);
      choices.push({ value: choiceValue, label: choiceLabel });
    }
    return {
      id,
      label,
      ...(guidance !== undefined ? { guidance } : {}),
      kind,
      required,
      weight,
      ...(recommendation !== undefined ? { recommendation } : {}),
      choices,
    };
  }

  if (
    !hasExactJsonKeys(
      value,
      ["id", "label", "kind", "required", "weight"],
      ["guidance", "recommendation", "maxLength"],
    ) ||
    Object.hasOwn(value, "choices") ||
    Object.hasOwn(value, "minimum") ||
    Object.hasOwn(value, "maximum") ||
    Object.hasOwn(value, "step")
  ) {
    return null;
  }
  const maxLength = value.maxLength === undefined
    ? 4_096
    : jsonPositiveInteger(value.maxLength, 64 * 1024);
  if (maxLength === null) return null;
  return {
    id,
    label,
    ...(guidance !== undefined ? { guidance } : {}),
    kind,
    required,
    weight,
    ...(recommendation !== undefined ? { recommendation } : {}),
    maxLength,
  };
}

function rubricFieldsFromJson(value: unknown): readonly OrganizerReviewRubricFieldInput[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RUBRIC_FIELDS) return null;
  const seen = new Set<string>();
  const fields: OrganizerReviewRubricFieldInput[] = [];
  for (const candidate of value) {
    const field = rubricFieldFromJson(candidate);
    if (!field || seen.has(field.id)) return null;
    seen.add(field.id);
    fields.push(field);
  }
  return Object.freeze(fields);
}

function rubricFieldsFromForm(formData: FormData): readonly OrganizerReviewRubricFieldInput[] | null {
  const json = jsonField(formData, "fields");
  const criterionValues = formData.getAll("criterion");
  if (json !== undefined && criterionValues.length > 0) return null;
  if (json !== undefined) {
    return json === INVALID_VALUE ? null : rubricFieldsFromJson(json);
  }
  if (criterionValues.length === 0 || criterionValues.length > MAX_RUBRIC_FIELDS) return null;
  const values: unknown[] = [];
  for (const criterion of criterionValues) {
    if (typeof criterion !== "string" || Buffer.byteLength(criterion, "utf8") > MAX_JSON_BYTES) {
      return null;
    }
    try {
      const parsed = boundedJson(JSON.parse(criterion) as unknown);
      if (parsed === INVALID_VALUE) return null;
      values.push(parsed);
    } catch {
      return null;
    }
  }
  return rubricFieldsFromJson(values);
}

type ParsedRubricActionInput = CreateOrganizerReviewRubricInput & {
  readonly eventId: string;
};

type ParsedDistributionActionInput = DistributeOrganizerReviewAssignmentsInput & {
  readonly eventId: string;
};

function integerField(
  formData: FormData,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined | null {
  const values = formData.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  if (!/^[0-9]+$/u.test(values[0])) return null;
  const parsed = Number(values[0]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function enumField<T extends string>(
  formData: FormData,
  name: string,
  choices: readonly T[],
): T | undefined | null {
  const values = formData.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  return choices.includes(values[0] as T) ? (values[0] as T) : null;
}

function hasAnyField(formData: FormData, names: readonly string[]): boolean {
  return names.some((name) => formData.getAll(name).length > 0);
}

function identifierListFromValues(
  values: readonly unknown[],
  maximum: number,
): readonly string[] | null {
  if (values.length === 0 || values.length > maximum) return null;
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value) || seen.has(value)) return null;
    seen.add(value);
    identifiers.push(value);
  }
  return Object.freeze(identifiers);
}

function identifierListField(
  formData: FormData,
  jsonName: string,
  repeatedName: string,
  maximum: number,
): readonly string[] | undefined | InvalidValue {
  const jsonValues = formData.getAll(jsonName);
  const repeatedValues = formData.getAll(repeatedName);
  if (jsonValues.length > 0 && repeatedValues.length > 0) return INVALID_VALUE;
  if (repeatedValues.length > 0) {
    const parsed = identifierListFromValues(repeatedValues, maximum);
    return parsed ?? INVALID_VALUE;
  }
  if (jsonValues.length === 0) return undefined;
  if (jsonValues.length > 1) {
    const parsed = identifierListFromValues(jsonValues, maximum);
    return parsed ?? INVALID_VALUE;
  }
  if (typeof jsonValues[0] !== "string") return INVALID_VALUE;
  const raw = jsonValues[0];
  if (!raw.trim().startsWith("[")) {
    const parsed = identifierListFromValues([raw], maximum);
    return parsed ?? INVALID_VALUE;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) return INVALID_VALUE;
  let parsedJson: unknown;
  try {
    parsedJson = boundedJson(JSON.parse(raw) as unknown);
  } catch {
    return INVALID_VALUE;
  }
  if (parsedJson === INVALID_VALUE || !Array.isArray(parsedJson) || parsedJson.length === 0) {
    return INVALID_VALUE;
  }
  const parsed = identifierListFromValues(parsedJson, maximum);
  return parsed ?? INVALID_VALUE;
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function poolsFromJson(value: unknown): readonly {
  readonly id: string;
  readonly reviewerAccountIds: readonly string[];
  readonly maxAssignments: number;
}[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DISTRIBUTION_POOLS) return null;
  const poolIds = new Set<string>();
  const reviewerIds = new Set<string>();
  const pools: Array<{
    readonly id: string;
    readonly reviewerAccountIds: readonly string[];
    readonly maxAssignments: number;
  }> = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactJsonKeys(candidate, ["id", "reviewerAccountIds", "maxAssignments"])) {
      return null;
    }
    const id = jsonIdentifier(candidate.id);
    if (!id || poolIds.has(id) || !Array.isArray(candidate.reviewerAccountIds)) return null;
    if (
      candidate.reviewerAccountIds.length < 1 ||
      candidate.reviewerAccountIds.length > MAX_DISTRIBUTION_REVIEWERS
    ) {
      return null;
    }
    const poolReviewers: string[] = [];
    const poolReviewerIds = new Set<string>();
    for (const reviewerId of candidate.reviewerAccountIds) {
      const parsedReviewerId = jsonIdentifier(reviewerId);
      if (!parsedReviewerId || poolReviewerIds.has(parsedReviewerId) || reviewerIds.has(parsedReviewerId)) {
        return null;
      }
      poolReviewerIds.add(parsedReviewerId);
      reviewerIds.add(parsedReviewerId);
      poolReviewers.push(parsedReviewerId);
    }
    const maxAssignments = jsonPositiveInteger(
      candidate.maxAssignments,
      MAX_ASSIGNMENTS_PER_REVIEWER * poolReviewers.length,
    );
    if (maxAssignments === null) return null;
    poolIds.add(id);
    pools.push({
      id,
      reviewerAccountIds: Object.freeze(poolReviewers),
      maxAssignments,
    });
  }
  return Object.freeze(pools);
}

function poolsFromForm(
  formData: FormData,
): readonly {
  readonly id: string;
  readonly reviewerAccountIds: readonly string[];
  readonly maxAssignments: number;
}[] | null {
  const json = jsonField(formData, "pools");
  const structuredNames = ["poolId", "poolReviewerAccountIds", "poolReviewerAccountId", "poolMaxAssignments"] as const;
  if (json !== undefined && hasAnyField(formData, structuredNames)) return null;
  if (json !== undefined) return json === INVALID_VALUE ? null : poolsFromJson(json);
  if (!hasAnyField(formData, structuredNames)) return null;

  const id = postedIdentifier(formData, "poolId", IDENTIFIER_PATTERN);
  const reviewerAccountIds = identifierListField(
    formData,
    "poolReviewerAccountIds",
    "poolReviewerAccountId",
    MAX_DISTRIBUTION_REVIEWERS,
  );
  const maxAssignments = integerField(
    formData,
    "poolMaxAssignments",
    1,
    MAX_ASSIGNMENTS_PER_REVIEWER * MAX_DISTRIBUTION_REVIEWERS,
  );
  if (!id || reviewerAccountIds === undefined || reviewerAccountIds === INVALID_VALUE || maxAssignments === undefined || maxAssignments === null) {
    return null;
  }
  if (maxAssignments > MAX_ASSIGNMENTS_PER_REVIEWER * reviewerAccountIds.length) return null;
  return Object.freeze([
    Object.freeze({ id, reviewerAccountIds, maxAssignments }),
  ]);
}

function blindArtifactDecisionFromJson(value: unknown):
  | {
      readonly sourceFieldId: string;
      readonly action: "EXCLUDE";
    }
  | {
      readonly sourceFieldId: string;
      readonly action: "INCLUDE_REDACTED";
      readonly reviewLabel: string;
      readonly redactedValue: unknown;
    }
  | null {
  if (!isRecord(value)) return null;
  const sourceFieldId = jsonIdentifier(value.sourceFieldId);
  if (!sourceFieldId) return null;
  if (
    value.action === "EXCLUDE" &&
    hasExactJsonKeys(value, ["sourceFieldId", "action"])
  ) {
    return { sourceFieldId, action: "EXCLUDE" };
  }
  if (
    value.action !== "INCLUDE_REDACTED" ||
    !hasExactJsonKeys(value, ["sourceFieldId", "action", "reviewLabel", "redactedValue"])
  ) {
    return null;
  }
  const reviewLabel = jsonText(value.reviewLabel, 2 * 1024);
  if (!reviewLabel || !Object.hasOwn(value, "redactedValue")) return null;
  return {
    sourceFieldId,
    action: "INCLUDE_REDACTED",
    reviewLabel,
    redactedValue: value.redactedValue,
  };
}

function blindArtifactDecisionsFromForm(
  formData: FormData,
): readonly OrganizerReviewBlindArtifactDecisionSet[] | undefined | null {
  const posted = formData.getAll("blindArtifactDecisions");
  if (posted.length === 1 && typeof posted[0] === "string" && posted[0].trim().length === 0) {
    return undefined;
  }
  const value = jsonField(formData, "blindArtifactDecisions");
  if (value === undefined) return undefined;
  if (value === INVALID_VALUE || !Array.isArray(value) || value.length > MAX_DISTRIBUTION_SUBMISSIONS) {
    return null;
  }
  const seen = new Set<string>();
  const sets: OrganizerReviewBlindArtifactDecisionSet[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactJsonKeys(candidate, ["submissionId", "submissionRevisionId", "decisions"]) ||
      !Array.isArray(candidate.decisions) ||
      candidate.decisions.length > 16_384
    ) {
      return null;
    }
    const submissionId = jsonIdentifier(candidate.submissionId);
    const submissionRevisionId = jsonIdentifier(candidate.submissionRevisionId);
    if (!submissionId || !submissionRevisionId || seen.has(submissionId)) return null;
    seen.add(submissionId);
    const decisions = candidate.decisions.map(blindArtifactDecisionFromJson);
    if (decisions.some((decision) => decision === null)) return null;
    sets.push({
      submissionId,
      submissionRevisionId,
      decisions: Object.freeze(decisions as OrganizerReviewBlindArtifactDecisionSet["decisions"]),
    });
  }
  return Object.freeze(sets);
}

function roundInputFromForm(formData: FormData): CreateOrganizerReviewRoundInput | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const callId = postedIdentifier(formData, "callId", IDENTIFIER_PATTERN);
  const name = postedText(formData, "name", 512);
  const opensAt = optionalPostedUtcTimestamp(formData, "opensAt");
  const closesAt = optionalPostedUtcTimestamp(formData, "closesAt");
  const idempotencyKey = optionalIdentifier(formData, "idempotencyKey");
  if (
    !workspaceSlug ||
    !eventId ||
    !callId ||
    !name ||
    opensAt === null ||
    closesAt === null ||
    (opensAt === undefined) !== (closesAt === undefined) ||
    (opensAt !== undefined && closesAt !== undefined && opensAt >= closesAt) ||
    idempotencyKey === null
  ) return null;
  return {
    workspaceSlug,
    eventId,
    callId,
    name,
    ...(opensAt !== undefined ? { opensAt, closesAt } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function roundScheduleInputFromForm(
  formData: FormData,
): SetOrganizerReviewRoundScheduleInput | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const expectedScheduleVersion = integerField(
    formData,
    "expectedScheduleVersion",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const opensAt = postedUtcTimestamp(formData, "opensAt");
  const closesAt = postedUtcTimestamp(formData, "closesAt");
  const idempotencyKey = postedIdentifier(formData, "idempotencyKey", IDENTIFIER_PATTERN);
  if (
    !workspaceSlug ||
    !eventId ||
    !roundId ||
    expectedScheduleVersion === undefined ||
    expectedScheduleVersion === null ||
    !opensAt ||
    !closesAt ||
    opensAt >= closesAt ||
    !idempotencyKey
  ) return null;
  return {
    workspaceSlug,
    eventId,
    roundId,
    expectedScheduleVersion,
    opensAt,
    closesAt,
    idempotencyKey,
  };
}

function roundStateInputFromForm(
  formData: FormData,
): (SetOrganizerReviewRoundStateInput & Readonly<{ eventId: string }>) | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const expectedStateSequenceNumber = integerField(
    formData,
    "expectedStateSequenceNumber",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const state = enumField(formData, "state", ["OPEN", "CLOSED", "CANCELLED"] as const);
  const reason = postedText(formData, "reason", 4096);
  const idempotencyKey = optionalIdentifier(formData, "idempotencyKey");
  if (
    !workspaceSlug ||
    !eventId ||
    !roundId ||
    expectedStateSequenceNumber === undefined ||
    expectedStateSequenceNumber === null ||
    !state ||
    !reason ||
    idempotencyKey === null
  ) return null;
  return {
    workspaceSlug,
    eventId,
    roundId,
    expectedStateSequenceNumber,
    state,
    reason,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function rubricInputFromForm(formData: FormData): ParsedRubricActionInput | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const fields = rubricFieldsFromForm(formData);
  const idempotencyKey = optionalIdentifier(formData, "idempotencyKey");
  if (!workspaceSlug || !eventId || !roundId || !fields || idempotencyKey === null) return null;
  return {
    workspaceSlug,
    eventId,
    roundId,
    fields,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function distributionInputFromForm(
  formData: FormData,
): ParsedDistributionActionInput | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const pools = poolsFromForm(formData);
  const reviewerAccountIds = identifierListField(
    formData,
    "reviewerAccountIds",
    "reviewerAccountId",
    MAX_DISTRIBUTION_REVIEWERS,
  );
  const submissionIds = identifierListField(
    formData,
    "submissionIds",
    "submissionId",
    MAX_DISTRIBUTION_SUBMISSIONS,
  );
  const reviewsPerSubmission = integerField(formData, "reviewsPerSubmission", 1, 32);
  const maxAssignmentsPerReviewer = integerField(
    formData,
    "maxAssignmentsPerReviewer",
    1,
    MAX_ASSIGNMENTS_PER_REVIEWER,
  );
  const strategy = enumField(formData, "strategy", ["balanced", "round_robin"] as const);
  const blindArtifactDecisions = blindArtifactDecisionsFromForm(formData);
  const idempotencyKey = optionalIdentifier(formData, "idempotencyKey");
  if (
    !workspaceSlug ||
    !eventId ||
    !roundId ||
    !pools ||
    reviewerAccountIds === INVALID_VALUE ||
    submissionIds === INVALID_VALUE ||
    reviewsPerSubmission === null ||
    maxAssignmentsPerReviewer === null ||
    strategy === null ||
    blindArtifactDecisions === null ||
    idempotencyKey === null
  ) {
    return null;
  }

  const pooledReviewerAccountIds = [...new Set(pools.flatMap((pool) => pool.reviewerAccountIds))];
  if (
    reviewerAccountIds !== undefined &&
    !sameIdentifierSet(reviewerAccountIds, pooledReviewerAccountIds)
  ) {
    return null;
  }
  return {
    workspaceSlug,
    eventId,
    roundId,
    reviewerAccountIds: reviewerAccountIds ?? pooledReviewerAccountIds,
    ...(submissionIds !== undefined ? { submissionIds } : {}),
    ...(reviewsPerSubmission !== undefined ? { reviewsPerSubmission } : {}),
    ...(maxAssignmentsPerReviewer !== undefined ? { maxAssignmentsPerReviewer } : {}),
    pools,
    ...(strategy !== undefined ? { strategy } : {}),
    ...(blindArtifactDecisions !== undefined ? { blindArtifactDecisions } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function blindControlInputFromForm(
  formData: FormData,
): {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly enabled: true;
  readonly idempotencyKey?: string;
} | null {
  const workspaceSlug = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const enabled = formData.getAll("enabled");
  const idempotencyKey = optionalIdentifier(formData, "idempotencyKey");
  if (
    !workspaceSlug ||
    !eventId ||
    !roundId ||
    enabled.length !== 1 ||
    enabled[0] !== "true" ||
    idempotencyKey === null
  ) {
    return null;
  }
  return {
    workspaceSlug,
    eventId,
    roundId,
    enabled: true,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function reviewerProvisioningInputFromForm(formData: FormData): {
  readonly eventId: string;
  readonly roundId: string;
  readonly intent: ReviewerAccessIntent;
  readonly idempotencyKey: string;
} | null {
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  const intent = enumField(formData, "intent", ["PROVISION", "INVITE", "ACTIVATE"] as const);
  const idempotencyKey = postedIdentifier(formData, "idempotencyKey", IDENTIFIER_PATTERN);
  if (
    !eventId ||
    !roundId ||
    !intent ||
    !idempotencyKey ||
    ["workspace", "role", "accountId", "reviewerAccountId", "personId", "password", "token"]
      .some((field) => formData.getAll(field).length > 0)
  ) {
    return null;
  }
  return { eventId, roundId, intent, idempotencyKey };
}

function reviewSetupInputError(message: string): OrganizerReviewActionError {
  return { kind: "error", code: "INPUT_INVALID", message };
}

const REVIEW_SETUP_SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  INPUT_INVALID: "The organizer review request is invalid.",
  ACCESS_DENIED: "Organizer review access is unavailable for this workspace.",
  OUTER_TRANSACTION_DENIED: "Organizer review setup could not be completed safely. Try again.",
  EVENT_NOT_AVAILABLE: "The event is not available for review setup.",
  CALL_NOT_AVAILABLE: "The selected call is not available for review setup.",
  ROUND_NOT_AVAILABLE: "The review round is not available in this workspace.",
  ROUND_SCHEDULE_MISMATCH:
    "Independent review-round dates require a keyed request. Reload and try again.",
  ROUND_SCHEDULE_INVALID: "Enter valid UTC dates with the review round opening before its close.",
  ROUND_SCHEDULE_STALE: "The review-round dates changed. Reload before saving another edit.",
  ROUND_SCHEDULE_IDEMPOTENCY_CONFLICT:
    "This review-round date request was already used for different values. Reload and try again.",
  ROUND_CREATE_IDEMPOTENCY_CONFLICT:
    "This review-round creation request conflicts with an earlier attempt.",
  ROUND_STATE_UNAVAILABLE: "The review round state could not be verified. Reload and try again.",
  ROUND_STATE_INVALID: "The review round is not available for this setup operation.",
  ROUND_STATE_STALE: "The review round state changed. Reload before changing it again.",
  DISTRIBUTION_IDEMPOTENCY_CONFLICT:
    "This reviewer distribution key was already used for different values. Reload and try again.",
  RUBRIC_NOT_AVAILABLE: "A saved review scorecard is required before distribution.",
  ASSIGNMENT_NOT_AVAILABLE: "The review assignment is not available in this workspace.",
  REVIEWER_NOT_AVAILABLE: "One or more selected reviewers are not available in this workspace.",
  SUBMISSION_NOT_AVAILABLE: "One or more selected submissions are not available for this round.",
  READ_FAILED: "The organizer review setup could not be read safely. Reload and try again.",
  WRITE_FAILED: "The organizer review setup could not be completed. Try again.",
};

function reviewSetupServiceFailure(
  error: unknown,
  fallbackCode: string,
): OrganizerReviewActionError {
  if (error instanceof OrganizerReviewServiceError) {
    return {
      kind: "error",
      code: error.code,
      message: REVIEW_SETUP_SERVICE_MESSAGES[error.code] ?? "Organizer review setup could not be completed. Try again.",
    };
  }
  return {
    kind: "error",
    code: fallbackCode,
    message: "Organizer review setup could not be completed. Try again.",
  };
}

const BLIND_CONTROL_SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  INPUT_INVALID: "The blind-review setting request is invalid.",
  ACCESS_DENIED: "Organizer review access is unavailable for this workspace.",
  OUTER_TRANSACTION_DENIED: "The blind-review setting could not be saved safely. Try again.",
  EVENT_NOT_AVAILABLE: "The event is not available for this review round.",
  ROUND_NOT_AVAILABLE: "The review round is not available in this workspace.",
  READ_FAILED: "The blind-review setting could not be read safely. Reload and try again.",
  WRITE_FAILED: "The blind-review setting could not be saved safely. Try again.",
};

const REVIEWER_PROVISIONING_SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  INPUT_INVALID: "The reviewer access request is invalid.",
  ACCESS_DENIED: "Reviewer provisioning is unavailable for this workspace.",
  EVENT_NOT_AVAILABLE: "The pinned reviewer event is unavailable.",
  ROUND_NOT_AVAILABLE: "The pinned reviewer round is unavailable.",
  REVIEWER_NOT_AVAILABLE: "The pinned reviewer is unavailable.",
  ASSIGNMENT_NOT_AVAILABLE: "The pinned reviewer assignment is unavailable.",
  PROVISIONING_REQUIRED: "Provision Sam before sending an invitation.",
  INVITATION_REQUIRED: "Invite Sam before activating reviewer access.",
  IDEMPOTENCY_CONFLICT: "This reviewer access request conflicts with an earlier request.",
  OUTER_TRANSACTION_DENIED: "Reviewer access could not be saved safely. Try again.",
  READ_FAILED: "Reviewer access could not be read safely. Reload and try again.",
  WRITE_FAILED: "Reviewer access could not be saved safely. Try again.",
};

function reviewerProvisioningServiceFailure(error: unknown): OrganizerReviewActionError {
  if (error instanceof ReviewerProvisioningServiceError) {
    return {
      kind: "error",
      code: error.code,
      message:
        REVIEWER_PROVISIONING_SERVICE_MESSAGES[error.code] ??
        "Reviewer access could not be saved safely. Try again.",
    };
  }
  return {
    kind: "error",
    code: "REVIEWER_ACCESS_FAILED",
    message: "Reviewer access could not be saved safely. Try again.",
  };
}

function blindControlServiceFailure(
  error: unknown,
  fallbackCode: string,
): OrganizerReviewActionError {
  if (error instanceof OrganizerReviewBlindControlError) {
    return {
      kind: "error",
      code: error.code,
      message:
        BLIND_CONTROL_SERVICE_MESSAGES[error.code] ??
        "The blind-review setting could not be saved safely. Try again.",
    };
  }
  return {
    kind: "error",
    code: fallbackCode,
    message: "The blind-review setting could not be saved safely. Try again.",
  };
}

function refreshReviewRoom(session: { readonly workspaceSlug: string }, eventId: string): boolean {
  try {
    revalidatePath(
      `/w/${encodeURIComponent(session.workspaceSlug)}/events/${encodeURIComponent(eventId)}/review`,
    );
    return true;
  } catch {
    return false;
  }
}

function committedMessage(message: string, revalidated: boolean): string {
  return revalidated
    ? message
    : `${message} The change was committed, but the review room could not refresh; reload to continue.`;
}

function serviceFailure(error: unknown): OrganizerReviewReminderActionState {
  if (!(error instanceof OrganizerReviewServiceError)) {
    return {
      kind: "error",
      code: "REMINDER_FAILED",
      message: "The simulated reminder record could not be completed. Try again.",
    };
  }
  if (error.code === "ACCESS_DENIED") {
    return {
      kind: "error",
      code: error.code,
      message: "Organizer review access is unavailable for this workspace.",
    };
  }
  if (error.code === "EVENT_NOT_AVAILABLE" || error.code === "ROUND_NOT_AVAILABLE") {
    return {
      kind: "error",
      code: error.code,
      message: "That review round is not available for this event.",
    };
  }
  if (error.code === "INPUT_INVALID") {
    return {
      kind: "error",
      code: error.code,
      message: "The review reminder request is invalid.",
    };
  }
  return {
    kind: "error",
    code: error.code,
    message: "The simulated reminder record could not be completed. Try again.",
  };
}

export async function recordOrganizerReviewRemindersAction(
  _state: OrganizerReviewReminderActionState = INITIAL_STATE,
  formData: FormData,
): Promise<OrganizerReviewReminderActionState> {
  const workspace = postedIdentifier(formData, "workspace", WORKSPACE_PATTERN);
  const eventId = postedIdentifier(formData, "eventId", IDENTIFIER_PATTERN);
  const roundId = postedIdentifier(formData, "roundId", IDENTIFIER_PATTERN);
  if (!workspace || !eventId || !roundId) {
    return {
      kind: "error",
      code: "INPUT_INVALID",
      message: "The review reminder request is invalid.",
    };
  }

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);

  let receipt;
  try {
    receipt = recordOrganizerReviewReminders(getDb(), session, {
      workspaceSlug: workspace,
      eventId,
      roundId,
    });
  } catch (error) {
    return serviceFailure(error);
  }

  try {
    revalidatePath(
      `/w/${encodeURIComponent(session.workspaceSlug)}/events/${encodeURIComponent(eventId)}/review`,
    );
  } catch {
    return {
      kind: "error",
      code: "CACHE_INVALIDATION_FAILED",
      message: "The reminder record was committed, but the review room could not refresh. Reload to continue.",
    };
  }

  const { outstandingAssignmentIds, recordedAssignmentIds, replayed } = receipt;
  return {
    kind: "success",
    outstandingCount: outstandingAssignmentIds.length,
    recordedCount: recordedAssignmentIds.length,
    replayed,
    message: outstandingAssignmentIds.length === 0
      ? "No outstanding reviewer assignments currently need a reminder."
      : recordedAssignmentIds.length === 0
        ? `Simulated reminders were already recorded for all ${outstandingAssignmentIds.length} outstanding assignments.`
        : `Recorded ${recordedAssignmentIds.length} simulated reminder${recordedAssignmentIds.length === 1 ? "" : "s"} for ${outstandingAssignmentIds.length} outstanding assignment${outstandingAssignmentIds.length === 1 ? "" : "s"}. No provider was contacted.`,
  };
}

export async function createOrganizerReviewRoundAction(
  _state: OrganizerReviewRoundActionState = IDLE_ORGANIZER_REVIEW_ROUND_ACTION,
  formData: FormData,
): Promise<OrganizerReviewRoundActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The review round request is invalid.");
  }
  const input = roundInputFromForm(formData);
  if (!input) return reviewSetupInputError("The review round request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewRoundReceipt;
  try {
    receipt = createOrganizerReviewRound(getDb(), session, {
      ...input,
      workspaceSlug: session.workspaceSlug,
    });
  } catch (error) {
    return reviewSetupServiceFailure(error, "REVIEW_ROUND_SETUP_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? "The review round already exists; no duplicate round was created."
    : "Review round created in draft state with its own saved schedule.";
  return {
    kind: "success",
    code: "REVIEW_ROUND_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function setOrganizerReviewRoundScheduleAction(
  _state: OrganizerReviewRoundScheduleActionState = IDLE_ORGANIZER_REVIEW_ROUND_SCHEDULE_ACTION,
  formData: FormData,
): Promise<OrganizerReviewRoundScheduleActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The review-round schedule request is invalid.");
  }
  const input = roundScheduleInputFromForm(formData);
  if (!input) {
    return reviewSetupInputError("Enter valid UTC dates with the review round opening before its close.");
  }

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewRoundScheduleReceipt;
  try {
    receipt = setOrganizerReviewRoundSchedule(getDb(), session, {
      ...input,
      workspaceSlug: session.workspaceSlug,
    });
  } catch (error) {
    return reviewSetupServiceFailure(error, "REVIEW_ROUND_SCHEDULE_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? `Review-round schedule v${receipt.scheduleVersion} was already saved.`
    : `Review-round schedule v${receipt.scheduleVersion} was saved.`;
  return {
    kind: "success",
    code: "REVIEW_ROUND_SCHEDULE_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function setOrganizerReviewRoundStateAction(
  _state: OrganizerReviewRoundStateActionState = IDLE_ORGANIZER_REVIEW_ROUND_STATE_ACTION,
  formData: FormData,
): Promise<OrganizerReviewRoundStateActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The review-round state request is invalid.");
  }
  const input = roundStateInputFromForm(formData);
  if (!input) return reviewSetupInputError("The review-round state request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewRoundStateReceipt;
  try {
    receipt = setOrganizerReviewRoundState(getDb(), session, {
      workspaceSlug: session.workspaceSlug,
      eventId: input.eventId,
      roundId: input.roundId,
      expectedStateSequenceNumber: input.expectedStateSequenceNumber,
      state: input.state,
      reason: input.reason,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  } catch (error) {
    return reviewSetupServiceFailure(error, "REVIEW_ROUND_STATE_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? `Review round is already ${receipt.state.toLowerCase()}; no duplicate state event was created.`
    : `Review round is now ${receipt.state.toLowerCase()}.`;
  return {
    kind: "success",
    code: "REVIEW_ROUND_STATE_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function setOrganizerReviewBlindControlAction(
  _state: OrganizerReviewBlindControlActionState = IDLE_ORGANIZER_REVIEW_BLIND_CONTROL_ACTION,
  formData: FormData,
): Promise<OrganizerReviewBlindControlActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The blind-review setting request is invalid.");
  }
  const input = blindControlInputFromForm(formData);
  if (!input) return reviewSetupInputError("The blind-review setting request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewBlindControlReceipt;
  try {
    receipt = setOrganizerReviewBlindControl(getDb(), session, {
      ...input,
      workspaceSlug: session.workspaceSlug,
    });
  } catch (error) {
    return blindControlServiceFailure(error, "REVIEW_BLIND_CONTROL_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? "Blind review is already enabled for this round; no new setting event was created."
    : "Blind review / anonymize authors is enabled for this round. The immutable setting was recorded.";
  return {
    kind: "success",
    code: "REVIEW_BLIND_CONTROL_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function provisionPinnedReviewerAction(
  _state: ReviewerProvisioningActionState = IDLE_REVIEWER_PROVISIONING_ACTION,
  formData: FormData,
): Promise<ReviewerProvisioningActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The reviewer access request is invalid.");
  }
  const input = reviewerProvisioningInputFromForm(formData);
  if (!input) return reviewSetupInputError("The reviewer access request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, session.workspaceSlug);
  let receipt: ReviewerProvisioningReceipt;
  try {
    receipt = provisionPinnedReviewer(getDb(), session, {
      eventId: input.eventId,
      roundId: input.roundId,
      intent: input.intent,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    return reviewerProvisioningServiceFailure(error);
  }
  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? `${receipt.state} access was already recorded for Sam; no duplicate transition was created.`
    : receipt.transitioned
      ? `Sam reviewer access is now ${receipt.state.toLowerCase()}.`
      : `Sam already has the required reviewer access; no transition was needed.`;
  return {
    kind: "success",
    code: "REVIEWER_ACCESS_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function createOrganizerReviewRubricAction(
  _state: OrganizerReviewRubricActionState = IDLE_ORGANIZER_REVIEW_RUBRIC_ACTION,
  formData: FormData,
): Promise<OrganizerReviewRubricActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The review scorecard request is invalid.");
  }
  const input = rubricInputFromForm(formData);
  if (!input) return reviewSetupInputError("The review scorecard request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewRubricReceipt;
  try {
    const db = getDb();
    readOrganizerReviewSurface(db, session, {
      workspaceSlug: session.workspaceSlug,
      eventId: input.eventId,
      roundId: input.roundId,
    });
    const { eventId: _eventId, ...rubricInput } = input;
    receipt = createOrganizerReviewRubric(db, session, {
      ...rubricInput,
      workspaceSlug: session.workspaceSlug,
    });
  } catch (error) {
    return reviewSetupServiceFailure(error, "REVIEW_RUBRIC_SETUP_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const message = receipt.replayed
    ? "The review scorecard already exists; no duplicate scorecard was created."
    : `Review scorecard saved with ${receipt.fields.length} ${receipt.fields.length === 1 ? "criterion" : "criteria"}.`;
  return {
    kind: "success",
    code: "REVIEW_RUBRIC_SAVED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}

export async function distributeOrganizerReviewAssignmentsAction(
  _state: OrganizerReviewDistributionActionState = IDLE_ORGANIZER_REVIEW_DISTRIBUTION_ACTION,
  formData: FormData,
): Promise<OrganizerReviewDistributionActionState> {
  if (!formDataWithinBounds(formData)) {
    return reviewSetupInputError("The reviewer distribution request is invalid.");
  }
  const input = distributionInputFromForm(formData);
  if (!input) return reviewSetupInputError("The reviewer distribution request is invalid.");

  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, input.workspaceSlug);

  let receipt: OrganizerReviewDistributionReceipt;
  try {
    const db = getDb();
    readOrganizerReviewSurface(db, session, {
      workspaceSlug: session.workspaceSlug,
      eventId: input.eventId,
      roundId: input.roundId,
    });
    const { eventId: _eventId, ...distributionInput } = input;
    receipt = distributeOrganizerReviewAssignments(db, session, {
      ...distributionInput,
      workspaceSlug: session.workspaceSlug,
    });
  } catch (error) {
    return reviewSetupServiceFailure(error, "REVIEW_DISTRIBUTION_FAILED");
  }

  const revalidated = refreshReviewRoom(session, input.eventId);
  const skippedCount = receipt.plan.skippedSubmissionIds.length;
  const message = receipt.replayed
    ? `Reviewer assignments were already distributed; no duplicate assignments were created (${receipt.existingAssignmentIds.length} existing).`
    : `Reviewer distribution committed: ${receipt.createdAssignmentIds.length} assignment${receipt.createdAssignmentIds.length === 1 ? "" : "s"} created${skippedCount === 0 ? "." : `; ${skippedCount} submission${skippedCount === 1 ? "" : "s"} could not receive the requested coverage.`}`;
  return {
    kind: "success",
    code: "REVIEW_ASSIGNMENTS_DISTRIBUTED",
    message: committedMessage(message, revalidated),
    receipt,
    revalidated,
  };
}
