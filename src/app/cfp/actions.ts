"use server";

import { Buffer } from "node:buffer";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { randomToken, sha256Hex } from "@/server/canonical";
import { closeDb, getDb, type Db } from "@/server/db";
import {
  CfpApplicantPortalFatalError,
  CfpApplicantPortalError,
  consumeApplicantEmailVerification,
  createApplicantSubmissionDraft,
  issueApplicantEmailVerificationForDelivery,
  locateExternallyReachableCall,
  readApplicantOwnedCurrentRevision,
  saveApplicantSubmissionDraft,
  submitApplicantSubmission,
  type ApplicantDraftProjection,
  type PublicCallProjection,
} from "@/server/services/cfp/applicant-portal";
import { readApplicantSubmissionDashboard } from "@/server/services/cfp/applicant-dashboard";
import type { FormAnswer } from "@/server/services/cfp/form-types";
import {
  amendSubmittedSubmission,
  CfpSubmissionCommandError,
  CfpSubmissionCommandFatalError,
} from "@/server/services/cfp/submissions";
import { FormDocumentPersistenceError } from "@/server/services/cfp/form-documents";
import { getWorkspaceBySlug } from "@/server/services/queries";
import {
  normalizeCoPresentersFieldConfig,
  normalizeCoPresentersValue,
} from "@/cfp/co-presenters";
import {
  fieldConfigInteger,
  fieldOptions,
  type ApplicantActionState,
  type ApplicantCallAvailability,
  type ApplicantCallView,
  type ApplicantDashboardPageState,
  type ApplicantDraftPageState,
  type ApplicantDraftView,
  type ApplicantFieldView,
  type ApplicantJson,
  type ApplicantSubmissionStatusView,
} from "@/components/cfp/contracts";
import {
  createHoldCookieName,
  sessionCookieName,
  submissionCookieName,
  verificationCookieName,
} from "@/app/cfp/cookie-scope.server";
import { getApplicantVerificationDeliveryPort } from "@/app/cfp/verification-delivery.server";

const APPLICANT_COOKIE_PATH = "/cfp";
const APPLICANT_SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;
const APPLICANT_CREATE_HOLD_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

type ScopedSessionCookie = {
  readonly version: 1;
  readonly workspace: string;
  readonly call: string;
  readonly token: string;
};

type ScopedSubmissionCookie = {
  readonly version: 1;
  readonly workspace: string;
  readonly call: string;
  readonly submissionId: string;
};

type ScopedVerificationCookie = {
  readonly version: 1;
  readonly workspace: string;
  readonly call: string;
  readonly verificationId: string;
  readonly token: string;
};

type ScopedCreateHoldCookie = {
  readonly version: 1;
  readonly workspace: string;
  readonly call: string;
};

type ResolvedCallContext = {
  readonly workspaceId: string;
  readonly callId: string;
  readonly call: PublicCallProjection;
};

type OwnedDraftContext = ResolvedCallContext & {
  readonly sessionTokenHash: string;
  readonly submissionId: string;
  readonly draft: ApplicantDraftProjection;
};

const TEXT_FIELD_TYPES = new Set([
  "shortText",
  "longText",
  "richText",
  "date",
  "time",
  "dateTime",
  "email",
  "phone",
  "url",
  "fileLink",
]);
const BOOLEAN_FIELD_TYPES = new Set([
  "checkbox",
  "consent",
  "acknowledgement",
  "policyAcceptance",
]);
const UNSUPPORTED_EDITABLE_FIELD_TYPES = new Set([
  "address",
  "location",
  "fileUpload",
  "matrix",
  "calculated",
  "personReference",
  "proposalOwnerReference",
  "coSpeakerReference",
  "repeatableGroup",
  "section",
]);

function applicantPath(workspace: string, call: string, suffix = ""): string {
  return `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(call)}${suffix}`;
}

function safeActionError(
  code: string,
  message: string,
  fieldErrors?: Readonly<Record<string, string>>,
): ApplicantActionState {
  return { kind: "error", code, message, ...(fieldErrors ? { fieldErrors } : {}) };
}

function staleActionError(): ApplicantActionState {
  return {
    kind: "stale",
    code: "SUBMISSION_STALE",
    message:
      "A newer saved revision exists. Reload the latest draft and explicitly reconcile your changes before saving or submitting.",
  };
}

function reloadRequiredActionError(code: string, message: string): ApplicantActionState {
  return { kind: "stale", code, message };
}

function retireFatalConnection(error: unknown, db: Db): void {
  if (
    error instanceof CfpSubmissionCommandFatalError ||
    error instanceof CfpApplicantPortalFatalError
  ) {
    try {
      closeDb(db);
    } finally {
      throw error;
    }
  }
}

function encodeCookiePayload(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCookiePayload(value: string | undefined): Record<string, unknown> | null {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.getPrototypeOf(parsed) === Object.prototype
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readScopedSessionCookie(
  value: string | undefined,
  workspace: string,
  call: string,
): ScopedSessionCookie | null {
  const parsed = decodeCookiePayload(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "workspace", "call", "token"]) ||
    parsed.version !== 1 ||
    parsed.workspace !== workspace ||
    parsed.call !== call ||
    typeof parsed.token !== "string" ||
    !RAW_TOKEN_PATTERN.test(parsed.token)
  ) {
    return null;
  }
  return parsed as ScopedSessionCookie;
}

function readScopedSubmissionCookie(
  value: string | undefined,
  workspace: string,
  call: string,
): ScopedSubmissionCookie | null {
  const parsed = decodeCookiePayload(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "workspace", "call", "submissionId"]) ||
    parsed.version !== 1 ||
    parsed.workspace !== workspace ||
    parsed.call !== call ||
    typeof parsed.submissionId !== "string" ||
    !IDENTIFIER_PATTERN.test(parsed.submissionId)
  ) {
    return null;
  }
  return parsed as ScopedSubmissionCookie;
}

function readScopedVerificationCookie(
  value: string | undefined,
  workspace: string,
  call: string,
): ScopedVerificationCookie | null {
  const parsed = decodeCookiePayload(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "workspace", "call", "verificationId", "token"]) ||
    parsed.version !== 1 ||
    parsed.workspace !== workspace ||
    parsed.call !== call ||
    typeof parsed.verificationId !== "string" ||
    !IDENTIFIER_PATTERN.test(parsed.verificationId) ||
    typeof parsed.token !== "string" ||
    !RAW_TOKEN_PATTERN.test(parsed.token)
  ) {
    return null;
  }
  return parsed as ScopedVerificationCookie;
}

function readScopedCreateHoldCookie(
  value: string | undefined,
  workspace: string,
  call: string,
): ScopedCreateHoldCookie | null {
  const parsed = decodeCookiePayload(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "workspace", "call"]) ||
    parsed.version !== 1 ||
    parsed.workspace !== workspace ||
    parsed.call !== call
  ) {
    return null;
  }
  return parsed as ScopedCreateHoldCookie;
}

function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: APPLICANT_COOKIE_PATH,
    priority: "high" as const,
    ...(expires ? { expires } : { maxAge: APPLICANT_SESSION_MAX_AGE_SECONDS }),
  };
}

function createHoldCookieOptions() {
  return {
    ...cookieOptions(),
    maxAge: APPLICANT_CREATE_HOLD_MAX_AGE_SECONDS,
  };
}

function submissionCookieOptions() {
  return {
    ...cookieOptions(),
    maxAge: APPLICANT_CREATE_HOLD_MAX_AGE_SECONDS,
  };
}

function clearScopedCookie(
  store: Awaited<ReturnType<typeof cookies>>,
  name: string,
): void {
  store.set(name, "", {
    ...cookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}

function classifyAvailability(call: PublicCallProjection, nowMs = Date.now()): ApplicantCallAvailability {
  if (call.state === "PAUSED") return "paused";
  if (call.state === "CLOSED") return "closed";
  if (call.state === "SCHEDULED") return "scheduled";
  if (call.state !== "OPEN") return "not-open";
  if (call.opensAt && nowMs < Date.parse(call.opensAt)) return "scheduled";
  if (call.closesAt && nowMs >= Date.parse(call.closesAt)) return "closed";
  return "open";
}

function publicCallView(call: PublicCallProjection): ApplicantCallView {
  return {
    name: call.name,
    slug: call.slug,
    accessMode: call.accessMode,
    state: call.state,
    availability: classifyAvailability(call),
    timezone: call.timezone,
    opensAt: call.opensAt,
    closesAt: call.closesAt,
    disclosure: call.disclosure as Readonly<Record<string, ApplicantJson>>,
    choices: call.choices.map((choice) => ({ ...choice })),
    fields: call.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      required: field.required,
      defaultVisibility: field.defaultVisibility,
    })),
  };
}

function resolveCallContext(db: Db, workspace: string, call: string): ResolvedCallContext | null {
  if (!SLUG_PATTERN.test(workspace) || !SLUG_PATTERN.test(call)) return null;
  const located = locateExternallyReachableCall(db, {
    workspaceSlug: workspace,
    callSlug: call,
  });
  if (!located.available) return null;
  const tenant = getWorkspaceBySlug(db, workspace);
  if (!tenant || tenant.slug !== workspace) return null;
  return {
    workspaceId: tenant.id,
    callId: located.call.callId,
    call: located.call,
  };
}

function hasMeaningfulAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function draftView(context: ResolvedCallContext, draft: ApplicantDraftProjection): ApplicantDraftView {
  const stateById = new Map(draft.presentationState.fieldStates.map((state) => [state.fieldId, state]));
  const historicalById = new Map(draft.historicalAnswers.map((answer) => [answer.fieldId, answer.value]));
  const policyById = new Map(draft.choices.map((choice) => [choice.fieldId, choice]));

  const visibleFields: ApplicantFieldView[] = [];
  for (const field of draft.fields) {
    const state = stateById.get(field.id);
    if (!state?.visible) continue;
    const policy = policyById.get(field.id);
    const hasValue = historicalById.has(field.id);
    visibleFields.push({
      id: field.id,
      type: field.type,
      label: field.label,
      required: state.required,
      editable: state.editable && !UNSUPPORTED_EDITABLE_FIELD_TYPES.has(field.type),
      effective: state.effective,
      ...(Object.hasOwn(field, "config") ? { config: field.config as ApplicantJson } : {}),
      ...(hasValue ? { value: historicalById.get(field.id) as ApplicantJson } : {}),
      ...(policy ? { policyStatement: policy.statement, policyRequired: policy.required } : {}),
    });
  }

  const hiddenAnswerCount = draft.presentationState.fieldStates.filter(
    (state) => !state.effective && hasMeaningfulAnswer(historicalById.get(state.fieldId)),
  ).length;

  const pinnedCall: ApplicantCallView = {
    ...publicCallView(context.call),
    name: draft.call.name,
    slug: draft.call.slug,
    state: draft.call.state,
    availability: classifyAvailability({
      ...context.call,
      state: draft.call.state,
      opensAt: draft.call.opensAt,
      closesAt: draft.call.closesAt,
      timezone: draft.call.timezone,
    }),
    timezone: draft.call.timezone,
    opensAt: draft.call.opensAt,
    closesAt: draft.call.closesAt,
    disclosure: draft.disclosure as Readonly<Record<string, ApplicantJson>>,
    choices: draft.choices.map((choice) => ({ ...choice })),
    fields: draft.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      required: field.required,
      defaultVisibility: field.defaultVisibility,
    })),
  };

  return {
    call: pinnedCall,
    submissionState: draft.submissionState,
    currentRevisionId: draft.currentRevisionId,
    fields: visibleFields,
    hiddenAnswerCount,
    hasConsentReceipt: draft.hasConsentReceipt,
  };
}

async function ownedDraftContext(
  db: Db,
  workspace: string,
  call: string,
): Promise<OwnedDraftContext | null> {
  const context = resolveCallContext(db, workspace, call);
  if (!context) return null;
  const store = await cookies();
  const session = readScopedSessionCookie(
    store.get(sessionCookieName(workspace, call))?.value,
    workspace,
    call,
  );
  const submission = readScopedSubmissionCookie(
    store.get(submissionCookieName(workspace, call))?.value,
    workspace,
    call,
  );
  if (!session || !submission) return null;
  const sessionTokenHash = sha256Hex(session.token);
  const current = readApplicantOwnedCurrentRevision(db, {
    workspaceId: context.workspaceId,
    callId: context.callId,
    sessionTokenHash,
    submissionId: submission.submissionId,
  });
  if (!current.found) return null;
  return {
    ...context,
    sessionTokenHash,
    submissionId: submission.submissionId,
    draft: current.draft,
  };
}

function answerFieldName(fieldId: string): string {
  return `answer:${fieldId}`;
}

function safeTextValue(value: FormDataEntryValue | null, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength || CONTROL_CHARACTER_PATTERN.test(value)) {
    return undefined;
  }
  return value.length === 0 ? null : value;
}

function mergePostedAnswers(
  draft: ApplicantDraftProjection,
  formData: FormData,
):
  | { readonly ok: true; readonly answers: readonly FormAnswer[] }
  | { readonly ok: false; readonly fieldErrors: Readonly<Record<string, string>> } {
  const stateById = new Map(draft.presentationState.fieldStates.map((state) => [state.fieldId, state]));
  const values = new Map(draft.historicalAnswers.map((answer) => [answer.fieldId, answer.value]));
  const fieldErrors: Record<string, string> = {};

  for (const field of draft.fields) {
    const state = stateById.get(field.id);
    if (!state?.visible || !state.editable || UNSUPPORTED_EDITABLE_FIELD_TYPES.has(field.type)) {
      continue;
    }
    const name = answerFieldName(field.id);

    if (TEXT_FIELD_TYPES.has(field.type)) {
      const configuredMaximum = fieldConfigInteger(field.config as ApplicantJson, "maxLength", 1, 65_536);
      const text = safeTextValue(formData.get(name), configuredMaximum ?? 20_000);
      if (text === undefined) {
        fieldErrors[field.id] = "Enter a valid value within the allowed length.";
      } else {
        values.set(field.id, text);
      }
      continue;
    }

    if (field.type === "singleChoice") {
      const text = safeTextValue(formData.get(name), 512);
      const options = fieldOptions(field.config as ApplicantJson);
      if (
        text === undefined ||
        options.length === 0 ||
        (text !== null && !options.some((option) => option.value === text))
      ) {
        fieldErrors[field.id] = "Choose one of the available options.";
      } else {
        values.set(field.id, text);
      }
      continue;
    }

    if (field.type === "multipleChoice" || field.type === "ranking") {
      const submitted = formData.getAll(name);
      const options = fieldOptions(field.config as ApplicantJson);
      const selected = submitted.filter((value): value is string => typeof value === "string");
      if (
        selected.length !== submitted.length ||
        selected.length > 128 ||
        new Set(selected).size !== selected.length ||
        options.length === 0 ||
        selected.some((value) => !options.some((option) => option.value === value))
      ) {
        fieldErrors[field.id] = "Choose only from the available options.";
      } else {
        values.set(field.id, selected);
      }
      continue;
    }

    if (BOOLEAN_FIELD_TYPES.has(field.type)) {
      const submitted = formData.getAll(name);
      if (
        submitted.length > 1 ||
        (submitted.length === 1 && submitted[0] !== "true")
      ) {
        fieldErrors[field.id] = "Choose a valid acknowledgement value.";
      } else {
        values.set(field.id, submitted.length === 1);
      }
      continue;
    }

    if (field.type === "integer" || field.type === "decimal") {
      const text = safeTextValue(formData.get(name), 128);
      if (text === undefined) {
        fieldErrors[field.id] = "Enter a valid number.";
        continue;
      }
      if (text === null || text.trim().length === 0) {
        values.set(field.id, null);
        continue;
      }
      const numberValue = Number(text);
      if (
        !Number.isFinite(numberValue) ||
        (field.type === "integer" && !Number.isSafeInteger(numberValue))
      ) {
        fieldErrors[field.id] = "Enter a valid number.";
      } else {
        values.set(field.id, Object.is(numberValue, -0) ? 0 : numberValue);
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const knownIds = new Set(draft.fields.map((field) => field.id));
  const answers: FormAnswer[] = [];
  for (const [fieldId, value] of values) {
    if (knownIds.has(fieldId)) answers.push({ fieldId, value });
  }
  answers.sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  return { ok: true, answers };
}

function requiredFieldErrors(draft: ApplicantDraftProjection): Readonly<Record<string, string>> {
  const answers = new Map(draft.historicalAnswers.map((answer) => [answer.fieldId, answer.value]));
  const fieldById = new Map(draft.fields.map((field) => [field.id, field]));
  const errors: Record<string, string> = {};
  for (const fieldId of draft.presentationState.requiredFieldIds) {
    const field = fieldById.get(fieldId);
    const value = answers.get(fieldId);
    let structuredCoPresenters: ReturnType<typeof normalizeCoPresentersFieldConfig> = null;
    let invalidStructuredConfig = false;
    try {
      structuredCoPresenters = field
        ? normalizeCoPresentersFieldConfig(field.config, field.type)
        : null;
    } catch {
      // An invalid structured configuration must not make a required question complete.
      invalidStructuredConfig = true;
    }
    let structuredValueComplete = false;
    if (structuredCoPresenters) {
      try {
        structuredValueComplete =
          (normalizeCoPresentersValue(value, structuredCoPresenters)?.entries.length ?? 0) > 0;
      } catch {
        structuredValueComplete = false;
      }
    }
    const complete = invalidStructuredConfig
      ? false
      : structuredCoPresenters
        ? structuredValueComplete
        : field && BOOLEAN_FIELD_TYPES.has(field.type)
          ? value === true
          : hasMeaningfulAnswer(value);
    if (!complete) errors[fieldId] = "Complete this required question.";
  }
  for (const choice of draft.choices) {
    if (choice.required && answers.get(choice.fieldId) !== true) {
      errors[choice.fieldId] = "Accept this required acknowledgement.";
    }
  }
  return errors;
}

function portalErrorCode(error: unknown): string | null {
  if (error instanceof CfpApplicantPortalError) return error.code;
  if (error instanceof CfpSubmissionCommandError) return error.code;
  if (error instanceof FormDocumentPersistenceError) return error.code;
  return null;
}

export async function loadApplicantPublicCall(
  workspace: string,
  call: string,
): Promise<ApplicantCallView | null> {
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    return context ? publicCallView(context.call) : null;
  } catch (error) {
    retireFatalConnection(error, db);
    return null;
  }
}

export async function loadApplicantVerificationPage(
  workspace: string,
  call: string,
): Promise<{ readonly call: ApplicantCallView; readonly hasPendingVerification: boolean } | null> {
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) return null;
    const store = await cookies();
    const pending = readScopedVerificationCookie(
      store.get(verificationCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    return { call: publicCallView(context.call), hasPendingVerification: pending !== null };
  } catch (error) {
    retireFatalConnection(error, db);
    return null;
  }
}

export async function loadApplicantDashboardPage(
  workspace: string,
  call: string,
): Promise<ApplicantDashboardPageState | null> {
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) return null;
    const callView = publicCallView(context.call);
    const store = await cookies();
    const session = readScopedSessionCookie(
      store.get(sessionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    if (!session) return { kind: "session-required", call: callView };
    const submission = readScopedSubmissionCookie(
      store.get(submissionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    if (!submission) return { kind: "no-submission", call: callView };

    const status = readApplicantSubmissionDashboard(db, {
      workspaceId: context.workspaceId,
      callId: context.callId,
      sessionTokenHash: sha256Hex(session.token),
      submissionId: submission.submissionId,
    });
    if (!status) return { kind: "no-submission", call: callView };
    const submissionView: ApplicantSubmissionStatusView = {
      submissionId: status.submissionId,
      state: status.state,
      currentRevisionId: status.currentRevisionId,
      revisionNumber: status.revisionNumber,
      revisionCreatedAt: status.revisionCreatedAt,
      submittedAt: status.submittedAt,
      hasConsentReceipt: status.hasConsentReceipt,
      formVersionId: status.formVersionId,
      ruleVersionId: status.ruleVersionId,
      formFingerprint: status.formFingerprint,
      policyFingerprint: status.policyFingerprint,
      lineageId: status.lineageId,
      edit: status.edit,
      decision: status.decision,
    };
    return { kind: "dashboard", call: callView, submission: submissionView };
  } catch (error) {
    retireFatalConnection(error, db);
    return null;
  }
}

export async function loadApplicantDraftPage(
  workspace: string,
  call: string,
): Promise<ApplicantDraftPageState | null> {
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) return null;
    const callView = publicCallView(context.call);

    const store = await cookies();
    const session = readScopedSessionCookie(
      store.get(sessionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    if (!session) return { kind: "session-required", call: callView };
    const submission = readScopedSubmissionCookie(
      store.get(submissionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    if (!submission) {
      const createHold = readScopedCreateHoldCookie(
        store.get(createHoldCookieName(workspace, call))?.value,
        workspace,
        call,
      );
      return createHold
        ? { kind: "creation-unconfirmed", call: callView }
        : { kind: "draft-required", call: callView };
    }

    const current = readApplicantOwnedCurrentRevision(db, {
      workspaceId: context.workspaceId,
      callId: context.callId,
      sessionTokenHash: sha256Hex(session.token),
      submissionId: submission.submissionId,
    });
    if (!current.found) {
      return callView.availability === "open"
        ? { kind: "session-required", call: callView }
        : { kind: "call-state", call: callView };
    }
    const view = draftView(context, current.draft);
    return { kind: "draft", call: view.call, draft: view };
  } catch (error) {
    retireFatalConnection(error, db);
    return null;
  }
}

export async function requestApplicantVerificationAction(
  workspace: string,
  call: string,
  _previous: ApplicantActionState,
  formData: FormData,
): Promise<ApplicantActionState> {
  const emailValue = formData.get("email");
  const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : "";
  if (
    email.length === 0 ||
    email.length > 320 ||
    CONTROL_CHARACTER_PATTERN.test(email) ||
    !/^[^\s@]+@[^\s@]+$/u.test(email)
  ) {
    return safeActionError("EMAIL_INVALID", "Check the email address and try again.", {
      email: "Enter a valid email address.",
    });
  }

  const privacySafeSuccess: ApplicantActionState = {
    kind: "success",
    code: "VERIFICATION_REQUESTED",
    message:
      "If this address can be verified for this call, a verification link is on its way.",
  };

  let delivery: ReturnType<typeof getApplicantVerificationDeliveryPort>;
  try {
    delivery = getApplicantVerificationDeliveryPort();
  } catch {
    return privacySafeSuccess;
  }
  if (!delivery) return privacySafeSuccess;

  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) return privacySafeSuccess;
    const deliveryScope = Object.freeze({
      workspaceId: context.workspaceId,
      workspaceSlug: workspace,
      callId: context.callId,
      callSlug: call,
      email,
    });
    await delivery.prepareForRequest(deliveryScope);
    const token = randomToken();
    const issued = issueApplicantEmailVerificationForDelivery(db, {
      workspaceId: context.workspaceId,
      callId: context.callId,
      email,
      tokenHash: sha256Hex(token),
    });
    if (issued.accepted) {
      await delivery.deliver({
        ...deliveryScope,
        verificationId: issued.verificationId,
        token,
        expiresAt: issued.expiresAt,
      });
    }
    return privacySafeSuccess;
  } catch (error) {
    retireFatalConnection(error, db);
    return privacySafeSuccess;
  }
}

export async function consumeApplicantVerificationAction(
  workspace: string,
  call: string,
  _previous: ApplicantActionState,
  formData: FormData,
): Promise<ApplicantActionState> {
  const fullNameValue = formData.get("fullName");
  const fullName = typeof fullNameValue === "string" ? fullNameValue.trim() : "";
  if (
    fullName.length === 0 ||
    fullName.length > 128 ||
    CONTROL_CHARACTER_PATTERN.test(fullName)
  ) {
    return safeActionError("FULL_NAME_INVALID", "Check your full name and try again.", {
      fullName: "Enter your full name (up to 128 characters).",
    });
  }

  let destination: string | null = null;
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) {
      return safeActionError(
        "VERIFICATION_LINK_INVALID",
        "This verification link cannot be used. Request a new one.",
      );
    }
    const store = await cookies();
    const pendingCookieName = verificationCookieName(workspace, call);
    const pendingCookieValue = store.get(pendingCookieName)?.value;
    const pending = readScopedVerificationCookie(
      pendingCookieValue,
      workspace,
      call,
    );
    if (!pending) {
      if (pendingCookieValue !== undefined) clearScopedCookie(store, pendingCookieName);
      return safeActionError(
        "VERIFICATION_LINK_INVALID",
        "This verification link cannot be used. Request a new one.",
      );
    }

    const rawSessionToken = randomToken();
    const consumed = consumeApplicantEmailVerification(db, {
      workspaceId: context.workspaceId,
      callId: context.callId,
      verificationId: pending.verificationId,
      verificationTokenHash: sha256Hex(pending.token),
      applicantSessionTokenHash: sha256Hex(rawSessionToken),
      fullName,
    });
    store.set(
      sessionCookieName(workspace, call),
      encodeCookiePayload({
        version: 1,
        workspace,
        call,
        token: rawSessionToken,
      } satisfies ScopedSessionCookie),
      cookieOptions(new Date(consumed.expiresAt)),
    );
    const priorSubmission = readScopedSubmissionCookie(
      store.get(submissionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    const resumable = priorSubmission
      ? readApplicantOwnedCurrentRevision(db, {
          workspaceId: context.workspaceId,
          callId: context.callId,
          sessionTokenHash: sha256Hex(rawSessionToken),
          submissionId: priorSubmission.submissionId,
        }).found
      : false;
    if (!resumable) clearScopedCookie(store, submissionCookieName(workspace, call));
    clearScopedCookie(store, pendingCookieName);
    destination = applicantPath(workspace, call, "/draft");
  } catch (error) {
    retireFatalConnection(error, db);
    try {
      const store = await cookies();
      clearScopedCookie(store, verificationCookieName(workspace, call));
    } catch {
      // The outward error remains deliberately non-reflective.
    }
    return safeActionError(
      "VERIFICATION_LINK_INVALID",
      "This verification link cannot be used. Request a new one.",
    );
  }
  redirect(destination);
}

export async function createApplicantDraftAction(
  workspace: string,
  call: string,
  _previous: ApplicantActionState,
  _formData: FormData,
): Promise<ApplicantActionState> {
  let destination: string | null = null;
  const db = getDb();
  try {
    const context = resolveCallContext(db, workspace, call);
    if (!context) {
      return safeActionError("CALL_NOT_OPEN", "This call is not accepting applicant actions.");
    }
    const store = await cookies();
    const session = readScopedSessionCookie(
      store.get(sessionCookieName(workspace, call))?.value,
      workspace,
      call,
    );
    if (!session) {
      return safeActionError(
        "SESSION_REQUIRED",
        "Your applicant session is unavailable. Verify your email again.",
      );
    }
    const sessionTokenHash = sha256Hex(session.token);
    const existing = readScopedSubmissionCookie(
      store.get(submissionCookieName(workspace, call))?.value,
      workspace,
      call,
    );

    if (
      !existing &&
      readScopedCreateHoldCookie(
        store.get(createHoldCookieName(workspace, call))?.value,
        workspace,
        call,
      )
    ) {
      return reloadRequiredActionError(
        "DRAFT_CREATION_UNCONFIRMED",
        "A prior draft creation may have completed. Do not create another draft; contact the organizer to reconcile it.",
      );
    }

    if (existing) {
      const current = readApplicantOwnedCurrentRevision(db, {
        workspaceId: context.workspaceId,
        callId: context.callId,
        sessionTokenHash,
        submissionId: existing.submissionId,
      });
      if (current.found) {
        clearScopedCookie(store, createHoldCookieName(workspace, call));
        destination = applicantPath(workspace, call, "/draft");
      } else {
        saveApplicantSubmissionDraft(db, {
          workspaceId: context.workspaceId,
          callId: context.callId,
          sessionTokenHash,
          submissionId: existing.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: null,
        });
        clearScopedCookie(store, createHoldCookieName(workspace, call));
        destination = `${applicantPath(workspace, call, "/draft")}?saved=1`;
      }
    } else {
      store.set(
        createHoldCookieName(workspace, call),
        encodeCookiePayload({ version: 1, workspace, call } satisfies ScopedCreateHoldCookie),
        createHoldCookieOptions(),
      );
      const created = createApplicantSubmissionDraft(db, {
        workspaceId: context.workspaceId,
        callId: context.callId,
        sessionTokenHash,
      });
      store.set(
        submissionCookieName(workspace, call),
        encodeCookiePayload({
          version: 1,
          workspace,
          call,
          submissionId: created.submissionId,
        } satisfies ScopedSubmissionCookie),
        submissionCookieOptions(),
      );
      clearScopedCookie(store, createHoldCookieName(workspace, call));
      saveApplicantSubmissionDraft(db, {
        workspaceId: context.workspaceId,
        callId: context.callId,
        sessionTokenHash,
        submissionId: created.submissionId,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      destination = `${applicantPath(workspace, call, "/draft")}?saved=1`;
    }
  } catch (error) {
    retireFatalConnection(error, db);
    const code = portalErrorCode(error);
    if (code === "PORTAL_WRITE_INDETERMINATE") {
      return reloadRequiredActionError(
        "RESULT_UNCONFIRMED",
        "The draft result could not be confirmed and cannot be safely retried. Reload to enter reconciliation hold; do not create another draft.",
      );
    }
    if (code === "SUBMISSION_NOT_DRAFT") {
      return reloadRequiredActionError(
        "SUBMISSION_TERMINAL",
        "The authoritative submission state changed. Reload to view its current terminal state.",
      );
    }
    return safeActionError(
      "DRAFT_START_FAILED",
      "The draft could not be opened. Your applicant session may need to be verified again.",
    );
  }
  redirect(destination);
}

export async function saveApplicantDraftAction(
  workspace: string,
  call: string,
  expectedRevisionId: string,
  _previous: ApplicantActionState,
  formData: FormData,
): Promise<ApplicantActionState> {
  if (!IDENTIFIER_PATTERN.test(expectedRevisionId)) {
    return staleActionError();
  }

  let destination: string | null = null;
  const db = getDb();
  try {
    const owned = await ownedDraftContext(db, workspace, call);
    if (!owned) {
      return safeActionError(
        "SESSION_REQUIRED",
        "Your applicant session is unavailable. Your answers remain in this form; verify again before retrying.",
      );
    }
    const submittedAmendment =
      owned.draft.submissionState === "SUBMITTED" && classifyAvailability(owned.call) === "open";
    if (owned.draft.submissionState !== "DRAFT" && !submittedAmendment) {
      return reloadRequiredActionError(
        "SUBMISSION_TERMINAL",
        "This submission is terminal and cannot be edited. Reload to view its current state.",
      );
    }
    if (owned.draft.currentRevisionId !== expectedRevisionId) return staleActionError();

    const merged = mergePostedAnswers(owned.draft, formData);
    if (!merged.ok) {
      return safeActionError(
        "ANSWERS_INVALID",
        "Some answers need attention. Nothing was saved; your entries remain in this form.",
        merged.fieldErrors,
      );
    }

    if (submittedAmendment) {
      if (owned.draft.currentRevisionId === null) return staleActionError();
      amendSubmittedSubmission(db, {
        workspaceId: owned.workspaceId,
        callId: owned.callId,
        sessionTokenHash: owned.sessionTokenHash,
        submissionId: owned.submissionId,
        historicalAnswers: merged.answers,
        expectedCurrentRevisionId: owned.draft.currentRevisionId,
      });
    } else {
      saveApplicantSubmissionDraft(db, {
        workspaceId: owned.workspaceId,
        callId: owned.callId,
        sessionTokenHash: owned.sessionTokenHash,
        submissionId: owned.submissionId,
        historicalAnswers: merged.answers,
        expectedCurrentRevisionId: owned.draft.currentRevisionId,
      });
    }
    destination = `${applicantPath(workspace, call, "/draft")}?saved=1`;
  } catch (error) {
    retireFatalConnection(error, db);
    const code = portalErrorCode(error);
    if (code === "SUBMISSION_STALE" || code === "STALE_REVISION") return staleActionError();
    if (code === "SUBMISSION_NOT_DRAFT" || code === "SUBMISSION_AMENDMENT_NOT_ALLOWED") {
      return reloadRequiredActionError(
        "SUBMISSION_NOT_EDITABLE",
        "The authoritative submission can no longer be amended. Reload to view its current state.",
      );
    }
    if (portalErrorCode(error) === "PORTAL_WRITE_INDETERMINATE") {
      return reloadRequiredActionError(
        "RESULT_UNCONFIRMED",
        "The save result could not be confirmed. Reload the authoritative draft before taking another action.",
      );
    }
    return safeActionError(
      "SAVE_FAILED",
      "The draft was not saved. Your entries remain in this form; try again.",
    );
  }
  redirect(destination);
}

export async function submitApplicantDraftAction(
  workspace: string,
  call: string,
  expectedRevisionId: string,
  _previous: ApplicantActionState,
  _formData: FormData,
): Promise<ApplicantActionState> {
  if (!IDENTIFIER_PATTERN.test(expectedRevisionId)) return staleActionError();
  const db = getDb();
  try {
    const owned = await ownedDraftContext(db, workspace, call);
    if (!owned) {
      return safeActionError(
        "SESSION_REQUIRED",
        "Your applicant session is unavailable. Verify your email again before submitting.",
      );
    }
    if (owned.draft.submissionState !== "DRAFT") {
      return reloadRequiredActionError(
        "SUBMISSION_TERMINAL",
        "This submission has already reached a terminal state. Reload to view its current state.",
      );
    }
    if (owned.draft.currentRevisionId !== expectedRevisionId) return staleActionError();

    const fieldErrors = requiredFieldErrors(owned.draft);
    if (Object.keys(fieldErrors).length > 0) {
      return safeActionError(
        "SUBMISSION_INCOMPLETE",
        "Complete every required question and acknowledgement, save the draft, then submit again.",
        fieldErrors,
      );
    }

    const submitted = submitApplicantSubmission(db, {
      workspaceId: owned.workspaceId,
      callId: owned.callId,
      sessionTokenHash: owned.sessionTokenHash,
      submissionId: owned.submissionId,
      historicalAnswers: owned.draft.historicalAnswers,
      expectedCurrentRevisionId: owned.draft.currentRevisionId,
    });
    return {
      kind: "submitted",
      code: "SUBMISSION_RECEIVED",
      message: "Your exact latest saved revision was submitted.",
      receipt: {
        submissionId: submitted.submissionId,
        revisionId: submitted.revisionId,
        submittedAt: submitted.submittedAt,
      },
    };
  } catch (error) {
    retireFatalConnection(error, db);
    const code = portalErrorCode(error);
    if (code === "SUBMISSION_STALE") return staleActionError();
    if (code === "SUBMISSION_INCOMPLETE") {
      return safeActionError(
        "SUBMISSION_INCOMPLETE",
        "Complete every required acknowledgement, save the draft, then submit again.",
      );
    }
    if (code === "SUBMISSION_NOT_DRAFT") {
      return reloadRequiredActionError(
        "SUBMISSION_TERMINAL",
        "The authoritative submission state changed. Reload to view its current terminal state.",
      );
    }
    if (code === "PORTAL_WRITE_INDETERMINATE") {
      return reloadRequiredActionError(
        "RESULT_UNCONFIRMED",
        "The submission result could not be confirmed. Reload before taking another action.",
      );
    }
    return safeActionError("SUBMIT_FAILED", "The submission was not completed. Reload and try again.");
  }
}
