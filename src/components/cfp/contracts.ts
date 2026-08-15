import type { FormFieldType } from "@/server/services/cfp/form-types";
import type {
  ApplicantSubmissionDecisionProjection,
  ApplicantSubmissionEditBoundary,
} from "@/server/services/cfp/applicant-dashboard";

export type ApplicantJson =
  | null
  | boolean
  | number
  | string
  | readonly ApplicantJson[]
  | { readonly [key: string]: ApplicantJson };

export type ApplicantCallState =
  | "DRAFT"
  | "SCHEDULED"
  | "OPEN"
  | "PAUSED"
  | "CLOSED"
  | "ARCHIVED"
  | "CANCELLED";

export type ApplicantCallAvailability =
  | "open"
  | "scheduled"
  | "paused"
  | "closed"
  | "not-open";

export interface ApplicantChoiceView {
  readonly fieldId: string;
  readonly statement: string;
  readonly required: boolean;
}

export interface ApplicantFieldPreview {
  readonly id: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly defaultVisibility: "visible" | "hidden";
}

export interface ApplicantCallView {
  readonly name: string;
  readonly slug: string;
  readonly accessMode: "PUBLIC" | "PUBLIC_AND_INVITED";
  readonly state: ApplicantCallState;
  readonly availability: ApplicantCallAvailability;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly disclosure: Readonly<Record<string, ApplicantJson>>;
  readonly choices: readonly ApplicantChoiceView[];
  readonly fields: readonly ApplicantFieldPreview[];
}

export interface ApplicantFieldView {
  readonly id: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly required: boolean;
  readonly editable: boolean;
  readonly effective: boolean;
  readonly config?: ApplicantJson;
  readonly value?: ApplicantJson;
  readonly policyStatement?: string;
  readonly policyRequired?: boolean;
}

export interface ApplicantDraftView {
  readonly call: ApplicantCallView;
  readonly submissionState: "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";
  readonly currentRevisionId: string;
  readonly fields: readonly ApplicantFieldView[];
  readonly hiddenAnswerCount: number;
  readonly hasConsentReceipt: boolean;
}

export type ApplicantDraftPageState =
  | { readonly kind: "call-state"; readonly call: ApplicantCallView }
  | { readonly kind: "session-required"; readonly call: ApplicantCallView }
  | { readonly kind: "draft-required"; readonly call: ApplicantCallView }
  | { readonly kind: "creation-unconfirmed"; readonly call: ApplicantCallView }
  | { readonly kind: "draft"; readonly call: ApplicantCallView; readonly draft: ApplicantDraftView };

export interface ApplicantSubmissionReceipt {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly submittedAt: string;
}

export interface ApplicantSubmissionStatusView {
  readonly submissionId: string;
  readonly state: "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";
  readonly currentRevisionId: string | null;
  readonly revisionNumber: number | null;
  readonly revisionCreatedAt: string | null;
  readonly submittedAt: string | null;
  readonly hasConsentReceipt: boolean;
  readonly formVersionId: string | null;
  readonly ruleVersionId: string | null;
  readonly formFingerprint: string | null;
  readonly policyFingerprint: string | null;
  readonly lineageId: string | null;
  readonly edit: ApplicantSubmissionEditBoundary;
  readonly decision: ApplicantSubmissionDecisionProjection | null;
}

export type ApplicantDashboardPageState =
  | { readonly kind: "session-required"; readonly call: ApplicantCallView }
  | { readonly kind: "no-submission"; readonly call: ApplicantCallView }
  | {
      readonly kind: "dashboard";
      readonly call: ApplicantCallView;
      readonly submission: ApplicantSubmissionStatusView;
    };

export type ApplicantActionState =
  | { readonly kind: "idle"; readonly message: "" }
  | {
      readonly kind: "success" | "error" | "stale";
      readonly code: string;
      readonly message: string;
      readonly fieldErrors?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "submitted";
      readonly code: "SUBMISSION_RECEIVED";
      readonly message: string;
      readonly receipt: ApplicantSubmissionReceipt;
    };

export const IDLE_APPLICANT_ACTION_STATE: ApplicantActionState = {
  kind: "idle",
  message: "",
};

export function applicantActionRequiresReload(state: ApplicantActionState): boolean {
  return state.kind === "stale";
}

export interface ApplicantSelectOption {
  readonly value: string;
  readonly label: string;
}

function isRecord(value: ApplicantJson | undefined): value is Readonly<Record<string, ApplicantJson>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function fieldConfigRecord(
  config: ApplicantJson | undefined,
): Readonly<Record<string, ApplicantJson>> {
  return isRecord(config) ? config : {};
}

export function fieldConfigText(
  config: ApplicantJson | undefined,
  key: string,
): string | undefined {
  const value = fieldConfigRecord(config)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function fieldConfigInteger(
  config: ApplicantJson | undefined,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = fieldConfigRecord(config)[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

export function fieldOptions(config: ApplicantJson | undefined): readonly ApplicantSelectOption[] {
  const raw = fieldConfigRecord(config).options;
  if (!Array.isArray(raw) || raw.length > 128) return [];

  const options: ApplicantSelectOption[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    let value: string | undefined;
    let label: string | undefined;
    if (typeof candidate === "string") {
      value = candidate;
      label = candidate;
    } else if (isRecord(candidate)) {
      value = typeof candidate.value === "string" ? candidate.value : undefined;
      label = typeof candidate.label === "string" ? candidate.label : value;
    }
    if (
      !value ||
      !label ||
      value.length > 512 ||
      label.length > 512 ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    options.push({ value, label });
  }
  return options;
}
