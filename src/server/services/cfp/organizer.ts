import type { SessionInfo } from "../../auth";
import { hasCapability } from "../../auth";
import { canonicalJson, nowIso } from "../../canonical";
import { withTransactionOrSavepoint, type Db } from "../../db";
import { writeAudit, writeDenialAudit } from "../audit";
import {
  CFP_CALL_POLICY_SCHEMA,
  CFP_FINGERPRINT_ALGORITHM,
  createCall,
  createFormDefinition,
  readCall,
  readFormVersionDocument,
  readRuleVersion,
  readSubmissionRevision,
  sealFormVersion,
  updateCallPolicy,
  type CallReadModel,
  type OrganizerContext,
} from "./form-documents";
import {
  FORM_RULES_SCHEMA,
  normalizeFormRuleSet,
  type FormRuleSet,
} from "./form-evaluator";
import {
  FORM_DOCUMENT_SCHEMA,
  normalizeFormDocument,
  type FormFieldDefinition,
  type NormalizedFormDocument,
} from "./form-types";
import { sanitizeFormData, type JsonSafeObject } from "./form-safety";
import type { JsonSafeValue } from "./form-safety";
import {
  readCfpSubmissionDecision,
  type CfpSubmissionDecisionProjection,
} from "./decisions";

export type CfpOrganizerCallState = CallReadModel["state"];

export interface OrganizerCfpField extends FormFieldDefinition {}

export interface OrganizerCfpCallSummary {
  readonly callId: string;
  readonly eventId: string;
  readonly name: string;
  readonly slug: string;
  readonly accessMode: CallReadModel["accessMode"];
  readonly state: CfpOrganizerCallState;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly updatedAt: string;
  readonly formVersionId: string;
  readonly formVersionNumber: number;
  readonly formFingerprint: string;
  readonly ruleVersionId: string;
  readonly ruleFingerprint: string;
  readonly policyFingerprint: string;
  readonly submissionCounts: Readonly<{
    readonly draft: number;
    readonly submitted: number;
    readonly withdrawn: number;
    readonly invalidated: number;
  }>;
}

export interface OrganizerCfpSubmissionSummary {
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
  readonly applicant: {
    readonly personId: string;
    readonly displayName: string;
    readonly organization: string | null;
  };
  readonly answers: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly value: JsonSafeValue;
  }[];
  readonly decision: CfpSubmissionDecisionProjection | null;
}

export interface OrganizerCfpCallProjection {
  readonly summary: OrganizerCfpCallSummary;
  readonly fields: readonly OrganizerCfpField[];
  readonly rules: FormRuleSet;
  readonly policy: CallReadModel["policy"];
  readonly submissions: readonly OrganizerCfpSubmissionSummary[];
}

export interface OrganizerCfpOverview {
  readonly event: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
    readonly lifecycle: string;
  }>;
  readonly calls: readonly OrganizerCfpCallSummary[];
}

export interface SaveOrganizerCfpCallInput {
  readonly eventId: string;
  readonly callId?: string | null;
  readonly expectedUpdatedAt?: string | null;
  readonly name: string;
  readonly slug: string;
  readonly accessMode: CallReadModel["accessMode"];
  readonly state: CfpOrganizerCallState;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly fields: unknown;
  readonly rules: unknown;
  readonly policy: unknown;
  readonly publish?: boolean;
}

export interface SavedOrganizerCfpCall {
  readonly callId: string;
  readonly created: boolean;
  readonly published: boolean;
  readonly formVersionId: string;
  readonly formVersionNumber: number;
  readonly formChanged: boolean;
  readonly policyFingerprint: string;
  readonly updatedAt: string;
}

const CALL_STATES = new Set<CfpOrganizerCallState>([
  "DRAFT",
  "SCHEDULED",
  "OPEN",
  "PAUSED",
  "CLOSED",
  "ARCHIVED",
  "CANCELLED",
]);
const ACCESS_MODES = new Set<CallReadModel["accessMode"]>([
  "PUBLIC",
  "INVITED",
  "PUBLIC_AND_INVITED",
]);
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

const ERROR_MESSAGES = {
  INPUT_INVALID: "The CFP organizer input is invalid.",
  AUTHORIZATION_DENIED: "This CFP organizer action is not available.",
  EVENT_NOT_FOUND: "The event was not found.",
  CALL_NOT_FOUND: "The call for proposals was not found.",
  CALL_LOCKED: "This call is closed and ordinary edits are locked.",
  CALL_STALE: "The call changed after this page loaded. Reload the authoritative editor.",
  FORM_INVALID: "The form fields or conditional rules are invalid.",
  POLICY_INVALID: "The call disclosure or consent policy is invalid.",
  STATE_INVALID: "The requested call lifecycle change is invalid.",
  WRITE_FAILED: "The CFP organizer change could not be saved.",
  READ_FAILED: "The CFP organizer projection could not be read safely.",
} as const;

export type CfpOrganizerErrorCode = keyof typeof ERROR_MESSAGES;

export class CfpOrganizerError extends Error {
  readonly code: CfpOrganizerErrorCode;

  constructor(code: CfpOrganizerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CfpOrganizerError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: CfpOrganizerErrorCode): never {
  throw new CfpOrganizerError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function requiredText(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail("INPUT_INVALID");
  }
  return value.trim();
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 128 || CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("INPUT_INVALID");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("INPUT_INVALID");
  return value;
}

function requiredTimezone(value: unknown): string {
  const timezone = requiredText(value, 128);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    fail("INPUT_INVALID");
  }
  return timezone;
}

function normalizeInput(input: SaveOrganizerCfpCallInput): {
  readonly eventId: string;
  readonly callId: string | null;
  readonly expectedUpdatedAt: string | null;
  readonly name: string;
  readonly slug: string;
  readonly accessMode: CallReadModel["accessMode"];
  readonly state: CfpOrganizerCallState;
  readonly timezone: string;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly fields: unknown;
  readonly rules: unknown;
  readonly policy: unknown;
  readonly publish: boolean;
} {
  if (!isPlainRecord(input)) fail("INPUT_INVALID");
  const eventId = requiredText(input.eventId, 128);
  const callId = input.callId === undefined || input.callId === null || input.callId === ""
    ? null
    : requiredText(input.callId, 128);
  const expectedUpdatedAt = optionalTimestamp(input.expectedUpdatedAt);
  const name = requiredText(input.name, 256);
  const slug = requiredText(input.slug, 128);
  const accessMode = input.accessMode;
  const state = input.state;
  const timezone = requiredTimezone(input.timezone);
  const opensAt = optionalTimestamp(input.opensAt);
  const closesAt = optionalTimestamp(input.closesAt);
  if (!SLUG_PATTERN.test(slug) || !ACCESS_MODES.has(accessMode as CallReadModel["accessMode"])) {
    fail("INPUT_INVALID");
  }
  if (!CALL_STATES.has(state as CfpOrganizerCallState)) fail("INPUT_INVALID");
  if (opensAt !== null && closesAt !== null && Date.parse(opensAt) > Date.parse(closesAt)) {
    fail("INPUT_INVALID");
  }
  if (!Object.hasOwn(input, "fields") || !Object.hasOwn(input, "rules") || !Object.hasOwn(input, "policy")) {
    fail("INPUT_INVALID");
  }
  return {
    eventId,
    callId,
    expectedUpdatedAt,
    name,
    slug,
    accessMode: accessMode as CallReadModel["accessMode"],
    state: state as CfpOrganizerCallState,
    timezone,
    opensAt,
    closesAt,
    fields: input.fields,
    rules: input.rules,
    policy: input.policy,
    publish: input.publish === true,
  };
}

function organizerContext(db: Db, session: SessionInfo): OrganizerContext {
  if (!hasCapability(session, "phase0.pipeline.manage")) {
    writeDenialAudit(db, session.workspaceId, {
      actorKind: "account",
      actorRef: session.accountId,
      code: "CAPABILITY_DENIED",
      targetType: "cfp",
      targetId: session.workspaceId,
    });
    fail("AUTHORIZATION_DENIED");
  }
  const account = db
    .prepare("SELECT id, workspace_id, role FROM accounts WHERE id = ? LIMIT 1")
    .get(session.accountId) as { id: unknown; workspace_id: unknown; role: unknown } | undefined;
  if (
    !account ||
    account.id !== session.accountId ||
    account.workspace_id !== session.workspaceId ||
    account.role !== session.role
  ) {
    fail("AUTHORIZATION_DENIED");
  }
  return { workspaceId: session.workspaceId, accountId: session.accountId };
}

function assertEvent(db: Db, workspaceId: string, eventId: string): Readonly<{
  id: string;
  name: string;
  timezone: string;
  lifecycle: string;
}> {
  const row = db
    .prepare(
      `SELECT id, name, timezone, lifecycle
       FROM events WHERE workspace_id = ? AND id = ? LIMIT 1`,
    )
    .get(workspaceId, eventId) as
    | { id: unknown; name: unknown; timezone: unknown; lifecycle: unknown }
    | undefined;
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.timezone !== "string" ||
    typeof row.lifecycle !== "string"
  ) {
    fail("EVENT_NOT_FOUND");
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    lifecycle: row.lifecycle,
  });
}

function normalizeBuilderArtifacts(fieldsInput: unknown, rulesInput: unknown): {
  readonly document: NormalizedFormDocument;
  readonly rules: FormRuleSet;
} {
  try {
    const fields = sanitizeFormData(fieldsInput);
    const candidateRules = sanitizeFormData(rulesInput);
    const ruleObject = isPlainRecord(candidateRules) && Object.hasOwn(candidateRules, "rules")
      ? candidateRules
      : { schema: FORM_RULES_SCHEMA, rules: candidateRules };
    const document = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "builder-form",
      ruleVersionId: "builder-rules",
      fields,
      historicalAnswers: [],
      effectiveAnswers: [],
    });
    const rules = normalizeFormRuleSet(
      {
        schema: FORM_RULES_SCHEMA,
        ruleVersionId: "builder-rules",
        rules: ruleObject.rules,
      },
      document.fields,
    );
    return { document, rules };
  } catch {
    fail("FORM_INVALID");
  }
}

function rulesForSeal(rules: FormRuleSet): Pick<FormRuleSet, "schema" | "rules"> {
  return {
    schema: FORM_RULES_SCHEMA,
    rules: rules.rules,
  };
}

function policyForPersistence(policy: unknown): JsonSafeObject {
  try {
    const safe = sanitizeFormData(policy);
    if (!isPlainRecord(safe)) fail("POLICY_INVALID");
    return safe as JsonSafeObject;
  } catch (error) {
    if (error instanceof CfpOrganizerError) throw error;
    fail("POLICY_INVALID");
  }
}

function nextMonotonicTimestamp(previous: string): string {
  const now = Date.parse(nowIso());
  const prior = Date.parse(previous);
  return new Date(Math.max(now, prior + 1)).toISOString();
}

function stateTransitionAllowed(
  current: CfpOrganizerCallState,
  next: CfpOrganizerCallState,
  publish: boolean,
): boolean {
  if (current === next) return true;
  if (publish && next === "OPEN" && (current === "DRAFT" || current === "SCHEDULED" || current === "PAUSED")) {
    return true;
  }
  const transitions: Readonly<Record<CfpOrganizerCallState, readonly CfpOrganizerCallState[]>> = {
    DRAFT: ["SCHEDULED", "CANCELLED"],
    SCHEDULED: ["OPEN", "CANCELLED"],
    OPEN: ["PAUSED", "CLOSED", "CANCELLED"],
    PAUSED: ["OPEN", "CLOSED", "CANCELLED"],
    CLOSED: ["ARCHIVED"],
    ARCHIVED: [],
    CANCELLED: ["ARCHIVED"],
  };
  return transitions[current].includes(next);
}

function readCallNameAndCounts(
  db: Db,
  workspaceId: string,
  call: CallReadModel,
): OrganizerCfpCallSummary {
  const row = db
    .prepare(
      `SELECT c.name, c.slug, f.version_number, f.fingerprint AS form_fingerprint,
              r.id AS rule_version_id, r.fingerprint AS rule_fingerprint,
              c.updated_at,
              (SELECT COUNT(*) FROM submissions s WHERE s.workspace_id = c.workspace_id AND s.call_id = c.id AND s.state = 'DRAFT') AS draft_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.workspace_id = c.workspace_id AND s.call_id = c.id AND s.state = 'SUBMITTED') AS submitted_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.workspace_id = c.workspace_id AND s.call_id = c.id AND s.state = 'WITHDRAWN') AS withdrawn_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.workspace_id = c.workspace_id AND s.call_id = c.id AND s.state = 'INVALIDATED') AS invalidated_count
       FROM calls c
       JOIN form_versions f ON f.id = c.form_version_id AND f.workspace_id = c.workspace_id
       JOIN rule_versions r ON r.id = f.rule_version_id AND r.workspace_id = c.workspace_id
       WHERE c.workspace_id = ? AND c.id = ? LIMIT 1`,
    )
    .get(workspaceId, call.id) as
    | {
        name: unknown;
        slug: unknown;
        version_number: unknown;
        form_fingerprint: unknown;
        rule_version_id: unknown;
        rule_fingerprint: unknown;
        updated_at: unknown;
        draft_count: unknown;
        submitted_count: unknown;
        withdrawn_count: unknown;
        invalidated_count: unknown;
      }
    | undefined;
  if (
    !row ||
    typeof row.name !== "string" ||
    typeof row.slug !== "string" ||
    typeof row.version_number !== "number" ||
    typeof row.form_fingerprint !== "string" ||
    typeof row.rule_version_id !== "string" ||
    typeof row.rule_fingerprint !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    fail("READ_FAILED");
  }
  const counts = [row.draft_count, row.submitted_count, row.withdrawn_count, row.invalidated_count];
  if (counts.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    fail("READ_FAILED");
  }
  if (!FINGERPRINT_PATTERN.test(row.form_fingerprint) || !FINGERPRINT_PATTERN.test(row.rule_fingerprint)) {
    fail("READ_FAILED");
  }
  return Object.freeze({
    callId: call.id,
    eventId: call.eventId,
    name: row.name,
    slug: row.slug,
    accessMode: call.accessMode,
    state: call.state,
    timezone: call.timezone,
    opensAt: call.opensAt,
    closesAt: call.closesAt,
    updatedAt: row.updated_at,
    formVersionId: call.formVersionId,
    formVersionNumber: row.version_number,
    formFingerprint: row.form_fingerprint,
    ruleVersionId: row.rule_version_id,
    ruleFingerprint: row.rule_fingerprint,
    policyFingerprint: call.policy.fingerprint,
    submissionCounts: Object.freeze({
      draft: counts[0] as number,
      submitted: counts[1] as number,
      withdrawn: counts[2] as number,
      invalidated: counts[3] as number,
    }),
  });
}

function readOrganizerSubmissionRoundTrip(
  db: Db,
  workspaceId: string,
  callId: string,
): readonly OrganizerCfpSubmissionSummary[] {
  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.state,
         s.current_revision_id,
         s.updated_at,
         s.lineage_id,
         p.id AS person_id,
         p.full_name AS person_name,
         p.organization AS person_organization,
         r.id AS revision_id,
         r.revision_number,
         r.created_at AS revision_created_at
       FROM submissions s
       JOIN people p
         ON p.id = s.owner_person_id AND p.workspace_id = s.workspace_id
       LEFT JOIN submission_revisions r
         ON r.workspace_id = s.workspace_id
        AND r.id = s.current_revision_id
        AND r.submission_id = s.id
       WHERE s.workspace_id = ? AND s.call_id = ?
       ORDER BY s.created_at, s.id`,
    )
    .all(workspaceId, callId) as Array<{
    id: unknown;
    state: unknown;
    current_revision_id: unknown;
    updated_at: unknown;
    lineage_id: unknown;
    person_id: unknown;
    person_name: unknown;
    person_organization: unknown;
    revision_id: unknown;
    revision_number: unknown;
    revision_created_at: unknown;
  }>;

  const summaries: OrganizerCfpSubmissionSummary[] = [];
  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.id) ||
      (row.state !== "DRAFT" &&
        row.state !== "SUBMITTED" &&
        row.state !== "WITHDRAWN" &&
        row.state !== "INVALIDATED") ||
      typeof row.updated_at !== "string" ||
      !Number.isFinite(Date.parse(row.updated_at)) ||
      typeof row.person_id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.person_id) ||
      typeof row.person_name !== "string" ||
      row.person_name.length === 0 ||
      row.person_name.length > 512 ||
      (row.person_organization !== null &&
        (typeof row.person_organization !== "string" || row.person_organization.length > 512)) ||
      (row.lineage_id !== null &&
        (typeof row.lineage_id !== "string" || !IDENTIFIER_PATTERN.test(row.lineage_id)))
    ) {
      fail("READ_FAILED");
    }

    if (row.current_revision_id === null) {
      if (row.revision_id !== null || row.revision_number !== null || row.revision_created_at !== null) {
        fail("READ_FAILED");
      }
      summaries.push(Object.freeze({
        submissionId: row.id,
        state: row.state,
        currentRevisionId: null,
        revisionNumber: null,
        revisionCreatedAt: null,
        submittedAt: row.state === "SUBMITTED" ? row.updated_at : null,
        hasConsentReceipt: false,
        formVersionId: null,
        ruleVersionId: null,
        formFingerprint: null,
        policyFingerprint: null,
        lineageId: row.lineage_id,
        applicant: Object.freeze({
          personId: row.person_id,
          displayName: row.person_name,
          organization: row.person_organization,
        }),
        answers: Object.freeze([]),
        decision: null,
      }));
      continue;
    }

    if (
      typeof row.current_revision_id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.current_revision_id) ||
      row.revision_id !== row.current_revision_id ||
      typeof row.revision_number !== "number" ||
      !Number.isSafeInteger(row.revision_number) ||
      row.revision_number < 1 ||
      typeof row.revision_created_at !== "string" ||
      !Number.isFinite(Date.parse(row.revision_created_at))
    ) {
      fail("READ_FAILED");
    }
    const revision = readSubmissionRevision(db, workspaceId, row.current_revision_id);
    if (revision.submissionId !== row.id || revision.revisionNumber !== row.revision_number) {
      fail("READ_FAILED");
    }
    const fieldLabels = new Map(revision.formDocument.fields.map((field) => [field.id, field.label]));
    const answers = revision.formDocument.historicalAnswers.map((answer) => Object.freeze({
      fieldId: answer.fieldId,
      label: fieldLabels.get(answer.fieldId) ?? answer.fieldId,
      value: answer.value,
    }));
    const decision = row.state === "SUBMITTED"
      ? readCfpSubmissionDecision(db, {
          workspaceId,
          submissionId: row.id,
          currentRevisionId: row.current_revision_id,
        })
      : null;
    summaries.push(Object.freeze({
      submissionId: row.id,
      state: row.state,
      currentRevisionId: row.current_revision_id,
      revisionNumber: row.revision_number,
      revisionCreatedAt: row.revision_created_at,
      submittedAt: row.state === "SUBMITTED" ? row.updated_at : null,
      hasConsentReceipt: revision.consentReceipt !== null,
      formVersionId: revision.formDocument.formVersionId,
      ruleVersionId: revision.formDocument.ruleVersionId,
      formFingerprint: revision.fingerprint,
      policyFingerprint: revision.callPolicy.fingerprint,
      lineageId: row.lineage_id,
      applicant: Object.freeze({
        personId: row.person_id,
        displayName: row.person_name,
        organization: row.person_organization,
      }),
      answers: Object.freeze(answers),
      decision,
    }));
  }
  return Object.freeze(summaries);
}

function readProjectionInternal(
  db: Db,
  workspaceId: string,
  eventId: string,
  callId: string,
): OrganizerCfpCallProjection {
  const call = readCall(db, workspaceId, callId);
  if (call.eventId !== eventId) fail("CALL_NOT_FOUND");
  const form = readFormVersionDocument(db, workspaceId, call.formVersionId);
  const rules = readRuleVersion(db, workspaceId, form.ruleVersionId).rules;
  return Object.freeze({
    summary: readCallNameAndCounts(db, workspaceId, call),
    fields: form.fields,
    rules,
    policy: call.policy,
    submissions: readOrganizerSubmissionRoundTrip(db, workspaceId, call.id),
  });
}

export function readCfpOrganizerOverview(
  db: Db,
  session: SessionInfo,
  eventId: string,
): OrganizerCfpOverview {
  const context = organizerContext(db, session);
  const event = assertEvent(db, context.workspaceId, requiredText(eventId, 128));
  try {
    const rows = db
      .prepare(
        `SELECT id FROM calls WHERE workspace_id = ? AND event_id = ? ORDER BY created_at, id`,
      )
      .all(context.workspaceId, event.id) as Array<{ id: unknown }>;
    const calls = rows.map((row) => {
      if (typeof row.id !== "string" || !IDENTIFIER_PATTERN.test(row.id)) fail("READ_FAILED");
      return readProjectionInternal(db, context.workspaceId, event.id, row.id).summary;
    });
    return Object.freeze({ event, calls: Object.freeze(calls) });
  } catch (error) {
    if (error instanceof CfpOrganizerError) throw error;
    fail("READ_FAILED");
  }
}

export function readCfpOrganizerCall(
  db: Db,
  session: SessionInfo,
  eventId: string,
  callId: string,
): OrganizerCfpCallProjection {
  const context = organizerContext(db, session);
  assertEvent(db, context.workspaceId, requiredText(eventId, 128));
  try {
    return readProjectionInternal(
      db,
      context.workspaceId,
      requiredText(eventId, 128),
      requiredText(callId, 128),
    );
  } catch (error) {
    if (error instanceof CfpOrganizerError) throw error;
    fail("CALL_NOT_FOUND");
  }
}

function formDefinitionId(db: Db, workspaceId: string, formVersionId: string): string {
  const row = db
    .prepare(
      `SELECT form_definition_id FROM form_versions
       WHERE workspace_id = ? AND id = ? LIMIT 1`,
    )
    .get(workspaceId, formVersionId) as { form_definition_id: unknown } | undefined;
  if (!row || typeof row.form_definition_id !== "string") fail("FORM_INVALID");
  return row.form_definition_id;
}

function getOrCreateFormDefinition(
  db: Db,
  context: OrganizerContext,
  slug: string,
): string {
  const definitionName = `CFP ${slug}`;
  const existing = db
    .prepare(
      `SELECT id FROM form_definitions WHERE workspace_id = ? AND name = ? LIMIT 1`,
    )
    .get(context.workspaceId, definitionName) as { id: unknown } | undefined;
  if (existing?.id && typeof existing.id === "string") return existing.id;
  return createFormDefinition(db, context, { name: definitionName }).id;
}

export function saveCfpOrganizerCall(
  db: Db,
  session: SessionInfo,
  rawInput: SaveOrganizerCfpCallInput,
): SavedOrganizerCfpCall {
  const context = organizerContext(db, session);
  const input = normalizeInput(rawInput);
  assertEvent(db, context.workspaceId, input.eventId);
  const artifacts = normalizeBuilderArtifacts(input.fields, input.rules);
  const policy = policyForPersistence(input.policy);
  if (input.publish && input.accessMode === "INVITED") fail("STATE_INVALID");
  if (input.publish && input.state !== "OPEN") fail("STATE_INVALID");

  let result: SavedOrganizerCfpCall;
  try {
    result = withTransactionOrSavepoint(db, "cfp_organizer_save", () => {
      if (input.callId === null) {
        const formDefinition = getOrCreateFormDefinition(db, context, input.slug);
        const form = sealFormVersion(db, context, {
          formDefinitionId: formDefinition,
          fields: artifacts.document.fields,
          rules: rulesForSeal(artifacts.rules),
        });
        const created = createCall(db, context, {
          eventId: input.eventId,
          name: input.name,
          slug: input.slug,
          formVersionId: form.id,
          policy,
          accessMode: input.accessMode,
          state: input.publish ? "OPEN" : input.state,
          timezone: input.timezone,
          opensAt: input.opensAt,
          closesAt: input.closesAt,
        });
        writeAudit(db, context.workspaceId, {
          actorKind: "account",
          actorRef: context.accountId,
          action: input.publish ? "cfp.call.published" : "cfp.call.created",
          targetType: "call",
          targetId: created.id,
          details: {
            formVersionId: form.id,
            formFingerprint: form.fingerprint,
            policySchema: CFP_CALL_POLICY_SCHEMA,
            policyAlgorithm: CFP_FINGERPRINT_ALGORITHM,
            published: input.publish,
          },
        });
        const persistedCall = readCall(db, context.workspaceId, created.id);
        const updatedAt = (db.prepare(
          "SELECT updated_at FROM calls WHERE workspace_id = ? AND id = ?",
        ).get(context.workspaceId, created.id) as { updated_at: string }).updated_at;
        return {
          callId: created.id,
          created: true,
          published: input.publish,
          formVersionId: form.id,
          formVersionNumber: form.versionNumber,
          formChanged: true,
          policyFingerprint: persistedCall.policy.fingerprint,
          updatedAt,
        };
      }

      const callId = input.callId;
      const current = readCall(db, context.workspaceId, callId);
      if (current.eventId !== input.eventId) fail("CALL_NOT_FOUND");
      if (current.state === "CLOSED" || current.state === "ARCHIVED" || current.state === "CANCELLED") {
        fail("CALL_LOCKED");
      }
      const currentSummary = readCallNameAndCounts(db, context.workspaceId, current);
      if (input.expectedUpdatedAt !== null && input.expectedUpdatedAt !== currentSummary.updatedAt) {
        fail("CALL_STALE");
      }
      if (!stateTransitionAllowed(current.state, input.state, input.publish)) fail("STATE_INVALID");

      const currentForm = readFormVersionDocument(db, context.workspaceId, current.formVersionId);
      const currentRules = readRuleVersion(db, context.workspaceId, currentForm.ruleVersionId).rules;
      const formChanged =
        canonicalJson(currentForm.fields) !== canonicalJson(artifacts.document.fields) ||
        canonicalJson(currentRules.rules) !== canonicalJson(artifacts.rules.rules);
      let activeFormVersionId = current.formVersionId;
      let activeFormVersionNumber = currentSummary.formVersionNumber;
      let activeUpdatedAt = currentSummary.updatedAt;

      if (formChanged) {
        const form = sealFormVersion(db, context, {
          formDefinitionId: formDefinitionId(db, context.workspaceId, current.formVersionId),
          fields: artifacts.document.fields,
          rules: rulesForSeal(artifacts.rules),
        });
        const updated = db
          .prepare(
            `UPDATE calls SET form_version_id = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND form_version_id = ? AND updated_at = ?`,
          )
        .run(
            form.id,
            activeUpdatedAt,
            context.workspaceId,
            callId,
            current.formVersionId,
            activeUpdatedAt,
          );
        if (updated.changes !== 1) fail("CALL_STALE");
        activeFormVersionId = form.id;
        activeFormVersionNumber = form.versionNumber;
      }

      const policySnapshot = updateCallPolicy(db, context, {
        callId,
        expectedPolicyFingerprint: current.policy.fingerprint,
        policy,
      });
      activeUpdatedAt = (db.prepare("SELECT updated_at FROM calls WHERE workspace_id = ? AND id = ?").get(context.workspaceId, callId) as { updated_at: string }).updated_at;
      const timestamp = nextMonotonicTimestamp(activeUpdatedAt);
      const metadata = db
        .prepare(
          `UPDATE calls
           SET name = ?, slug = ?, access_mode = ?, state = ?, timezone = ?,
               opens_at = ?, closes_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND event_id = ? AND updated_at = ?`,
        )
        .run(
          input.name,
          input.slug,
          input.accessMode,
          input.state,
          input.timezone,
          input.opensAt,
          input.closesAt,
          timestamp,
          context.workspaceId,
          callId,
          input.eventId,
          activeUpdatedAt,
        );
      if (metadata.changes !== 1) fail("CALL_STALE");
      writeAudit(db, context.workspaceId, {
        actorKind: "account",
        actorRef: context.accountId,
        action: input.publish ? "cfp.call.published" : "cfp.call.updated",
        targetType: "call",
        targetId: callId,
        details: {
          fromState: current.state,
          toState: input.state,
          formChanged,
          formVersionId: activeFormVersionId,
          policyFingerprint: policySnapshot.fingerprint,
        },
      });
      return {
        callId,
        created: false,
        published: input.publish,
        formVersionId: activeFormVersionId,
        formVersionNumber: activeFormVersionNumber,
        formChanged,
        policyFingerprint: policySnapshot.fingerprint,
        updatedAt: timestamp,
      };
    });
  } catch (error) {
    if (error instanceof CfpOrganizerError) throw error;
    let code: CfpOrganizerErrorCode = "WRITE_FAILED";
    if (error instanceof Error && error.name === "FormDocumentPersistenceError") {
      const persistenceCode = (error as { readonly code?: unknown }).code;
      code = persistenceCode === "CALL_POLICY_INVALID" || persistenceCode === "CALL_POLICY_NOT_CANONICAL"
        ? "POLICY_INVALID"
        : persistenceCode === "CALL_NOT_FOUND"
          ? "CALL_NOT_FOUND"
          : "FORM_INVALID";
    }
    fail(code);
  }
  return result;
}
