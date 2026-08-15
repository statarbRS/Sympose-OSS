import type { SessionInfo } from "../../auth";
import { hasCapability } from "../../auth";
import { canonicalJson, fingerprintOf, nowIso, uuid } from "../../canonical";
import { withTransactionOrSavepoint, type Db } from "../../db";
import { writeAudit, writeDenialAudit } from "../audit";
import { readCurrentReleasedCfpSession } from "../publication";
import {
  readSubmissionRevision,
  type SubmissionRevision,
} from "./form-documents";
import {
  ensureAcceptedCfpSession,
  readCfpSessionHandoff,
  CfpSessionHandoffError,
  CFP_SESSION_HANDOFF_SCHEMA,
  CFP_SESSION_MINIMUM_CAPACITY,
  type CfpSessionHandoffEvidence,
  type ReadableCfpSessionHandoffEvidence,
} from "./session-handoff";
import type {
  CfpAcceptedSessionHandoff,
  CfpDecisionCommunicationMergeValues,
  CfpDecisionCommunicationReceipt,
  CfpDecisionCommunicationTemplateKey,
  CfpSubmissionDecision,
  CfpSubmissionDecisionProjection,
  CfpSubmissionDecisionReceipt,
} from "./decision-types";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

const LEGACY_DECISION_EVENT_SCHEMA = "cfp-submission-decision/v2" as const;
const LINEAGE_DECISION_EVENT_SCHEMA = "cfp-submission-decision/v3" as const;
const DECISION_EVENT_SCHEMA = "cfp-submission-decision/v4" as const;
const COMMUNICATION_ANCHOR_SCHEMA = "cfp-decision-communication-anchor/v1" as const;
const COMMUNICATION_SCHEMA = "cfp-decision-communication/v2" as const;
const ACCEPTED_TEMPLATE_KEY = "cfp-decision-accepted-v1" as const;
const REJECTED_TEMPLATE_KEY = "cfp-decision-rejected-v1" as const;
const EMAIL_MAX_LENGTH = 320;
const RENDERED_SUBJECT_MAX_LENGTH = 512;
const RENDERED_BODY_MAX_LENGTH = 4_000;
const MAX_CFP_SCHEDULE_INVENTORY = 200;
const BODY_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const HAS_OWN = Object.prototype.hasOwnProperty;

const ERROR_MESSAGES = {
  INPUT_INVALID: "The CFP decision input is invalid.",
  ACCESS_DENIED: "This CFP decision action is not available.",
  SUBMISSION_NOT_AVAILABLE: "The submission is not available for this event.",
  SUBMISSION_NOT_SUBMITTED: "Only a submitted application can receive an organizer decision.",
  SUBMISSION_STALE: "The submission changed after this decision surface loaded. Reload the current revision.",
  DECISION_ALREADY_RECORDED: "A decision is already recorded for this submission revision.",
  DECISION_READ_FAILED: "The CFP decision projection could not be read safely.",
  DECISION_WRITE_FAILED: "The CFP decision could not be recorded safely.",
} as const;

export type CfpDecisionErrorCode = keyof typeof ERROR_MESSAGES;

export class CfpDecisionError extends Error {
  readonly code: CfpDecisionErrorCode;

  constructor(code: CfpDecisionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CfpDecisionError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: CfpDecisionErrorCode): never {
  throw new CfpDecisionError(code);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail("INPUT_INVALID");
  return value;
}

function storedIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail("DECISION_READ_FAILED");
  return value;
}

function text(value: unknown, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return value;
}

function nullableText(value: unknown, maxLength = 512): string | null {
  return value === null ? null : text(value, maxLength);
}

function bodyText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > RENDERED_BODY_MAX_LENGTH ||
    BODY_CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return value;
}

function storedEmail(value: unknown): string {
  if (typeof value !== "string") return fail("DECISION_READ_FAILED");
  const normalized = value.trim().toLowerCase().normalize("NFC");
  const atIndex = normalized.indexOf("@");
  if (
    normalized.length === 0 ||
    normalized !== value ||
    normalized.length > EMAIL_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    atIndex <= 0 ||
    atIndex === normalized.length - 1 ||
    normalized.indexOf("@", atIndex + 1) !== -1
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return normalized;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => HAS_OWN.call(value, key));
}

function communicationTemplateKey(selectedDecision: CfpSubmissionDecision): CfpDecisionCommunicationTemplateKey {
  return selectedDecision === "ACCEPTED" ? ACCEPTED_TEMPLATE_KEY : REJECTED_TEMPLATE_KEY;
}

function renderDecisionCommunication(
  selectedDecision: CfpSubmissionDecision,
  recipientDisplayName: string,
  mergeValues: CfpDecisionCommunicationMergeValues,
): { readonly subject: string; readonly body: string } {
  const outcome = selectedDecision === "ACCEPTED" ? "accepted" : "rejected";
  const subject = `${mergeValues.eventName} — ${mergeValues.callName}: ${mergeValues.proposalTitle} ${outcome}`;
  const body = [
    `Hello ${recipientDisplayName},`,
    "",
    `Your proposal \"${mergeValues.proposalTitle}\" was ${outcome} for ${mergeValues.eventName} through ${mergeValues.callName}.`,
    "",
    "This communication is queued in the local inbox simulation. No external provider mutation occurred.",
  ].join("\n");
  return Object.freeze({
    subject: text(subject, RENDERED_SUBJECT_MAX_LENGTH),
    body: bodyText(body),
  });
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") return fail("DECISION_READ_FAILED");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail("DECISION_READ_FAILED");
  return value;
}

function decision(value: unknown): CfpSubmissionDecision {
  if (value !== "ACCEPTED" && value !== "REJECTED") return fail("DECISION_READ_FAILED");
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) return fail("DECISION_READ_FAILED");
  return value;
}

function answerText(revision: SubmissionRevision, ids: readonly string[], labels: readonly string[]): string | null {
  const fields = new Map(revision.formDocument.fields.map((field) => [field.id, field]));
  const answers = new Map(revision.formDocument.historicalAnswers.map((answer) => [answer.fieldId, answer.value]));
  for (const id of ids) {
    const value = answers.get(id);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  for (const [fieldId, field] of fields) {
    if (!labels.some((label) => field.label.toLowerCase().includes(label))) continue;
    const value = answers.get(fieldId);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function proposalDurationValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const candidate = typeof value === "string" && /^[0-9]{1,4}$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > 720
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return candidate;
}

function proposalDuration(
  revision: SubmissionRevision,
  format: string | null,
): {
  readonly durationMinutes: number | null;
  readonly durationSource: "PROPOSAL_ANSWER" | "FORMAT_OPTION" | null;
} {
  const answers = new Map(revision.formDocument.historicalAnswers.map((answer) => [answer.fieldId, answer.value]));
  const explicit: number[] = [];
  for (const field of revision.formDocument.fields) {
    const normalizedLabel = field.label.toLowerCase();
    if (
      field.id !== "duration" &&
      field.id !== "durationMinutes" &&
      field.id !== "sessionDuration" &&
      !normalizedLabel.includes("duration")
    ) {
      continue;
    }
    const value = proposalDurationValue(answers.get(field.id));
    if (value !== null) explicit.push(value);
  }
  if (new Set(explicit).size > 1) return fail("DECISION_READ_FAILED");

  const configured: number[] = [];
  if (format !== null) {
    for (const field of revision.formDocument.fields) {
      const normalizedLabel = field.label.toLowerCase();
      if (
        field.id !== "format" &&
        field.id !== "sessionFormat" &&
        !normalizedLabel.includes("format")
      ) {
        continue;
      }
      const config = recordValue(field.config);
      if (!config) continue;
      const direct = proposalDurationValue(config.durationMinutes);
      if (direct !== null) configured.push(direct);
      if (!Array.isArray(config.options)) continue;
      for (const option of config.options) {
        const candidate = recordValue(option);
        if (!candidate || candidate.value !== format) continue;
        const optionDuration = proposalDurationValue(candidate.durationMinutes);
        if (optionDuration === null) return fail("DECISION_READ_FAILED");
        configured.push(optionDuration);
      }
    }
  }
  if (new Set(configured).size > 1) return fail("DECISION_READ_FAILED");
  if (explicit[0] !== undefined && configured[0] !== undefined && explicit[0] !== configured[0]) {
    return fail("DECISION_READ_FAILED");
  }
  if (explicit[0] !== undefined) {
    return Object.freeze({ durationMinutes: explicit[0], durationSource: "PROPOSAL_ANSWER" });
  }
  if (configured[0] !== undefined) {
    return Object.freeze({ durationMinutes: configured[0], durationSource: "FORMAT_OPTION" });
  }
  return Object.freeze({ durationMinutes: null, durationSource: null });
}

function proposalTrackRequired(revision: SubmissionRevision): boolean {
  return revision.formDocument.fields.some((field) =>
    (field.id === "track" || field.id === "trackId" || field.label.toLowerCase().includes("track")) &&
    field.required
  );
}

function answerByIdOrLabel(
  revision: SubmissionRevision,
  ids: readonly string[],
  labels: readonly string[],
): string | null {
  return answerText(revision, ids, labels);
}

function proposalDisplay(revision: SubmissionRevision): {
  readonly title: string;
  readonly abstract: string | null;
  readonly format: string | null;
  readonly track: string | null;
  readonly trackRequired: boolean;
  readonly durationMinutes: number | null;
  readonly durationSource: "PROPOSAL_ANSWER" | "FORMAT_OPTION" | null;
} {
  const format = answerByIdOrLabel(revision, ["format", "sessionFormat"], ["format"]);
  const duration = proposalDuration(revision, format);
  return Object.freeze({
    title: answerByIdOrLabel(
      revision,
      ["title", "proposalTitle", "proposal", "name"],
      ["title", "proposal", "name"],
    ) ?? "Untitled proposal",
    abstract: answerByIdOrLabel(revision, ["abstract", "summary", "description"], ["abstract", "summary", "description"]),
    format,
    track: answerByIdOrLabel(revision, ["track", "trackId"], ["track"]),
    trackRequired: proposalTrackRequired(revision),
    durationMinutes: duration.durationMinutes,
    durationSource: duration.durationSource,
  });
}

function acceptedHandoff(
  revision: SubmissionRevision,
  submissionId: string,
  revisionId: string,
  personId: string,
  displayName: string,
  linkedSession: ReturnType<typeof readCfpSessionHandoff>,
): CfpAcceptedSessionHandoff {
  const proposal = proposalDisplay(revision);
  return Object.freeze({
    status: "READY_FOR_SESSION_HANDOFF",
    title: proposal.title,
    abstract: proposal.abstract,
    format: proposal.format,
    track: proposal.track,
    speaker: Object.freeze({ personId, displayName }),
    linkedSession: Object.freeze({
      programUnitId: linkedSession.programUnitId,
      eventId: linkedSession.eventId,
      proposalLineageId: linkedSession.proposalLineageId,
      capacity: linkedSession.capacity,
      durationMinutes: linkedSession.durationMinutes,
      trackId: linkedSession.trackId,
      trackName: linkedSession.trackName,
      status: linkedSession.status,
      speakerLinkId: linkedSession.speakerLinkId,
      placement: linkedSession.placement,
      release: linkedSession.release,
    }),
    sourceSubmissionId: submissionId,
    sourceRevisionId: revisionId,
    note: linkedSession.status === "UNSCHEDULED"
      ? "A real event program session is linked, but it remains unscheduled. No room, time slot, or publication has been assigned."
      : "A real event program session is linked. Scheduling and publication are represented separately from this CFP decision.",
  });
}

type DecisionCommunicationPayload = {
  readonly schema: typeof COMMUNICATION_SCHEMA;
  readonly decisionEventId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly recipientPersonId: string;
  readonly recipientDisplayName: string;
  readonly recipientEmail: string;
  readonly decision: CfpSubmissionDecision;
  readonly templateKey: CfpDecisionCommunicationTemplateKey;
  readonly mergeValues: CfpDecisionCommunicationMergeValues;
  readonly renderedSubject: string;
  readonly renderedBody: string;
  readonly sessionHandoff: ReadableCfpSessionHandoffEvidence | null;
  readonly channel: "local-inbox-simulation";
  readonly simulated: true;
  readonly providerMutation: false;
  readonly payloadFingerprint: string;
};

type DecisionCommunicationAnchor = {
  readonly schema: typeof COMMUNICATION_ANCHOR_SCHEMA;
  readonly outboxMessageId: string;
  readonly destinationKey: string;
  readonly status: "PENDING";
  readonly attemptCount: 0;
  readonly nextAttemptAt: string;
  readonly claimToken: null;
  readonly leaseExpiresAt: null;
  readonly createdAt: string;
  readonly deliveredAt: null;
  readonly lastError: null;
  readonly payloadFingerprint: string;
  readonly payload: DecisionCommunicationPayload;
};

type DecisionEventCore = {
  readonly schema:
    | typeof LEGACY_DECISION_EVENT_SCHEMA
    | typeof LINEAGE_DECISION_EVENT_SCHEMA
    | typeof DECISION_EVENT_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly decision: CfpSubmissionDecision;
  readonly decidedAt: string;
  readonly sessionHandoff: ReadableCfpSessionHandoffEvidence | null;
};

type DecisionEvent = {
  readonly id: string;
  readonly payload: DecisionEventCore & {
    readonly communication: DecisionCommunicationAnchor;
  };
};

function parseSessionHandoff(
  value: unknown,
  selectedDecision: CfpSubmissionDecision,
  decisionSchema:
    | typeof LEGACY_DECISION_EVENT_SCHEMA
    | typeof LINEAGE_DECISION_EVENT_SCHEMA
    | typeof DECISION_EVENT_SCHEMA,
): ReadableCfpSessionHandoffEvidence | null {
  if (selectedDecision === "REJECTED") {
    if (value !== null) return fail("DECISION_READ_FAILED");
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("DECISION_READ_FAILED");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema === "cfp-session-handoff/v1") {
    if (
      decisionSchema !== LEGACY_DECISION_EVENT_SCHEMA ||
      !exactKeys(candidate, [
        "schema",
        "eventId",
        "programUnitId",
        "sourceSubmissionId",
        "sourceRevisionId",
        "sourceRevisionFingerprint",
        "speakerPersonId",
        "speakerLinkId",
        "createdStatus",
      ]) ||
      typeof candidate.eventId !== "string" ||
      typeof candidate.programUnitId !== "string" ||
      typeof candidate.sourceSubmissionId !== "string" ||
      typeof candidate.sourceRevisionId !== "string" ||
      typeof candidate.sourceRevisionFingerprint !== "string" ||
      typeof candidate.speakerPersonId !== "string" ||
      (candidate.speakerLinkId !== null && typeof candidate.speakerLinkId !== "string") ||
      candidate.createdStatus !== "UNSCHEDULED"
    ) {
      return fail("DECISION_READ_FAILED");
    }
    return Object.freeze({
      schema: "cfp-session-handoff/v1",
      eventId: storedIdentifier(candidate.eventId),
      programUnitId: storedIdentifier(candidate.programUnitId),
      sourceSubmissionId: storedIdentifier(candidate.sourceSubmissionId),
      sourceRevisionId: storedIdentifier(candidate.sourceRevisionId),
      sourceRevisionFingerprint: fingerprint(candidate.sourceRevisionFingerprint),
      speakerPersonId: storedIdentifier(candidate.speakerPersonId),
      speakerLinkId: candidate.speakerLinkId === null ? null : storedIdentifier(candidate.speakerLinkId),
      createdStatus: "UNSCHEDULED",
    });
  }
  if (candidate.schema === "cfp-session-handoff/v2") {
    if (
      decisionSchema !== LINEAGE_DECISION_EVENT_SCHEMA ||
      !exactKeys(candidate, [
        "schema",
        "eventId",
        "programUnitId",
        "proposalLineageId",
        "sourceSubmissionId",
        "sourceRevisionId",
        "sourceRevisionFingerprint",
        "speakerPersonId",
        "speakerLinkId",
        "capacity",
        "createdStatus",
      ]) ||
      typeof candidate.eventId !== "string" ||
      typeof candidate.programUnitId !== "string" ||
      typeof candidate.proposalLineageId !== "string" ||
      typeof candidate.sourceSubmissionId !== "string" ||
      typeof candidate.sourceRevisionId !== "string" ||
      typeof candidate.sourceRevisionFingerprint !== "string" ||
      typeof candidate.speakerPersonId !== "string" ||
      (candidate.speakerLinkId !== null && typeof candidate.speakerLinkId !== "string") ||
      candidate.capacity !== CFP_SESSION_MINIMUM_CAPACITY ||
      candidate.createdStatus !== "UNSCHEDULED"
    ) {
      return fail("DECISION_READ_FAILED");
    }
    return Object.freeze({
      schema: "cfp-session-handoff/v2",
      eventId: storedIdentifier(candidate.eventId),
      programUnitId: storedIdentifier(candidate.programUnitId),
      proposalLineageId: storedIdentifier(candidate.proposalLineageId),
      sourceSubmissionId: storedIdentifier(candidate.sourceSubmissionId),
      sourceRevisionId: storedIdentifier(candidate.sourceRevisionId),
      sourceRevisionFingerprint: fingerprint(candidate.sourceRevisionFingerprint),
      speakerPersonId: storedIdentifier(candidate.speakerPersonId),
      speakerLinkId: candidate.speakerLinkId === null ? null : storedIdentifier(candidate.speakerLinkId),
      capacity: CFP_SESSION_MINIMUM_CAPACITY,
      createdStatus: "UNSCHEDULED",
    });
  }
  if (
    decisionSchema !== DECISION_EVENT_SCHEMA ||
    !exactKeys(candidate, [
      "schema",
      "eventId",
      "programUnitId",
      "programUnitName",
      "proposalLineageId",
      "sourceSubmissionId",
      "sourceRevisionId",
      "sourceRevisionFingerprint",
      "speakerPersonId",
      "speakerLinkId",
      "capacity",
      "format",
      "durationMinutes",
      "durationSource",
      "startsAt",
      "endsAt",
      "proposalTrack",
      "trackId",
      "trackName",
      "trackSource",
      "createdStatus",
    ]) ||
    candidate.schema !== CFP_SESSION_HANDOFF_SCHEMA ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.programUnitId !== "string" ||
    typeof candidate.programUnitName !== "string" ||
    typeof candidate.proposalLineageId !== "string" ||
    typeof candidate.sourceSubmissionId !== "string" ||
    typeof candidate.sourceRevisionId !== "string" ||
    typeof candidate.sourceRevisionFingerprint !== "string" ||
    typeof candidate.speakerPersonId !== "string" ||
    (candidate.speakerLinkId !== null && typeof candidate.speakerLinkId !== "string") ||
    candidate.capacity !== CFP_SESSION_MINIMUM_CAPACITY ||
    (candidate.format !== null && typeof candidate.format !== "string") ||
    typeof candidate.durationMinutes !== "number" ||
    !Number.isSafeInteger(candidate.durationMinutes) ||
    candidate.durationMinutes < 1 ||
    candidate.durationMinutes > 720 ||
    (candidate.durationSource !== "PROPOSAL_ANSWER" &&
      candidate.durationSource !== "FORMAT_OPTION" &&
      candidate.durationSource !== "CANONICAL_DEFAULT") ||
    typeof candidate.startsAt !== "string" ||
    typeof candidate.endsAt !== "string" ||
    (candidate.proposalTrack !== null && typeof candidate.proposalTrack !== "string") ||
    typeof candidate.trackId !== "string" ||
    typeof candidate.trackName !== "string" ||
    (candidate.trackSource !== "PROPOSAL" && candidate.trackSource !== "CANONICAL_FALLBACK") ||
    candidate.createdStatus !== "UNSCHEDULED"
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return Object.freeze({
    schema: CFP_SESSION_HANDOFF_SCHEMA,
    eventId: storedIdentifier(candidate.eventId),
    programUnitId: storedIdentifier(candidate.programUnitId),
    programUnitName: text(candidate.programUnitName, 160),
    proposalLineageId: storedIdentifier(candidate.proposalLineageId),
    sourceSubmissionId: storedIdentifier(candidate.sourceSubmissionId),
    sourceRevisionId: storedIdentifier(candidate.sourceRevisionId),
    sourceRevisionFingerprint: fingerprint(candidate.sourceRevisionFingerprint),
    speakerPersonId: storedIdentifier(candidate.speakerPersonId),
    speakerLinkId: candidate.speakerLinkId === null ? null : storedIdentifier(candidate.speakerLinkId),
    capacity: CFP_SESSION_MINIMUM_CAPACITY,
    format: nullableText(candidate.format, 120),
    durationMinutes: candidate.durationMinutes,
    durationSource: candidate.durationSource,
    startsAt: timestamp(candidate.startsAt),
    endsAt: timestamp(candidate.endsAt),
    proposalTrack: nullableText(candidate.proposalTrack, 120),
    trackId: storedIdentifier(candidate.trackId),
    trackName: text(candidate.trackName, 120),
    trackSource: candidate.trackSource,
    createdStatus: "UNSCHEDULED",
  });
}

function parseDecisionCommunicationPayload(
  value: unknown,
  decisionEventId: string,
  event: DecisionEventCore,
): DecisionCommunicationPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("DECISION_READ_FAILED");
  }
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, [
    "schema",
    "decisionEventId",
    "workspaceId",
    "eventId",
    "callId",
    "submissionId",
    "submissionRevisionId",
    "submissionRevisionFingerprint",
    "recipientPersonId",
    "recipientDisplayName",
    "recipientEmail",
    "decision",
    "templateKey",
    "mergeValues",
    "renderedSubject",
    "renderedBody",
    "sessionHandoff",
    "channel",
    "simulated",
    "providerMutation",
    "payloadFingerprint",
  ])) {
    return fail("DECISION_READ_FAILED");
  }
  const selectedDecision = decision(candidate.decision);
  const recipientPersonId = storedIdentifier(candidate.recipientPersonId);
  const recipientDisplayName = text(candidate.recipientDisplayName);
  const recipientEmail = storedEmail(candidate.recipientEmail);
  if (candidate.mergeValues === null || typeof candidate.mergeValues !== "object" || Array.isArray(candidate.mergeValues)) {
    return fail("DECISION_READ_FAILED");
  }
  const rawMergeValues = candidate.mergeValues as Record<string, unknown>;
  if (!exactKeys(rawMergeValues, ["eventName", "callName", "proposalTitle"])) {
    return fail("DECISION_READ_FAILED");
  }
  const mergeValues = Object.freeze({
    eventName: text(rawMergeValues.eventName),
    callName: text(rawMergeValues.callName),
    proposalTitle: text(rawMergeValues.proposalTitle),
  });
  const templateKey = communicationTemplateKey(selectedDecision);
  const renderedSubject = text(candidate.renderedSubject, RENDERED_SUBJECT_MAX_LENGTH);
  const renderedBody = bodyText(candidate.renderedBody);
  const payloadFingerprint = fingerprint(candidate.payloadFingerprint);
  const expectedRendering = renderDecisionCommunication(selectedDecision, recipientDisplayName, mergeValues);
  if (
    candidate.schema !== COMMUNICATION_SCHEMA ||
    candidate.decisionEventId !== decisionEventId ||
    candidate.workspaceId !== event.workspaceId ||
    candidate.eventId !== event.eventId ||
    candidate.callId !== event.callId ||
    candidate.submissionId !== event.submissionId ||
    candidate.submissionRevisionId !== event.submissionRevisionId ||
    candidate.submissionRevisionFingerprint !== event.submissionRevisionFingerprint ||
    selectedDecision !== event.decision ||
    candidate.templateKey !== templateKey ||
    renderedSubject !== expectedRendering.subject ||
    renderedBody !== expectedRendering.body ||
    canonicalJson(candidate.sessionHandoff) !== canonicalJson(event.sessionHandoff) ||
    candidate.channel !== "local-inbox-simulation" ||
    candidate.simulated !== true ||
    candidate.providerMutation !== false
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const payloadBasis = Object.freeze({
    schema: COMMUNICATION_SCHEMA,
    decisionEventId,
    workspaceId: event.workspaceId,
    eventId: event.eventId,
    callId: event.callId,
    submissionId: event.submissionId,
    submissionRevisionId: event.submissionRevisionId,
    submissionRevisionFingerprint: event.submissionRevisionFingerprint,
    recipientPersonId,
    recipientDisplayName,
    recipientEmail,
    decision: selectedDecision,
    templateKey,
    mergeValues,
    renderedSubject,
    renderedBody,
    sessionHandoff: event.sessionHandoff,
    channel: "local-inbox-simulation" as const,
    simulated: true as const,
    providerMutation: false as const,
  });
  if (fingerprintOf(payloadBasis) !== payloadFingerprint) return fail("DECISION_READ_FAILED");
  const payload = Object.freeze({ ...payloadBasis, payloadFingerprint });
  if (canonicalJson(payload) !== canonicalJson(candidate)) return fail("DECISION_READ_FAILED");
  return payload;
}

function parseDecisionCommunicationAnchor(
  value: unknown,
  decisionEventId: string,
  event: DecisionEventCore,
): DecisionCommunicationAnchor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("DECISION_READ_FAILED");
  }
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, [
    "schema",
    "outboxMessageId",
    "destinationKey",
    "status",
    "attemptCount",
    "nextAttemptAt",
    "claimToken",
    "leaseExpiresAt",
    "createdAt",
    "deliveredAt",
    "lastError",
    "payloadFingerprint",
    "payload",
  ])) {
    return fail("DECISION_READ_FAILED");
  }
  const outboxMessageId = storedIdentifier(candidate.outboxMessageId);
  const payload = parseDecisionCommunicationPayload(candidate.payload, decisionEventId, event);
  const payloadFingerprint = fingerprint(candidate.payloadFingerprint);
  const destinationKey = text(candidate.destinationKey, 1_024);
  const nextAttemptAt = timestamp(candidate.nextAttemptAt);
  const createdAt = timestamp(candidate.createdAt);
  const expectedDestination = `cfp:${event.submissionId}:${payload.recipientPersonId}:${decisionEventId}:${payload.payloadFingerprint}`;
  if (
    candidate.schema !== COMMUNICATION_ANCHOR_SCHEMA ||
    destinationKey !== expectedDestination ||
    candidate.status !== "PENDING" ||
    candidate.attemptCount !== 0 ||
    nextAttemptAt !== event.decidedAt ||
    candidate.claimToken !== null ||
    candidate.leaseExpiresAt !== null ||
    createdAt !== event.decidedAt ||
    candidate.deliveredAt !== null ||
    candidate.lastError !== null ||
    payloadFingerprint !== payload.payloadFingerprint
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return Object.freeze({
    schema: COMMUNICATION_ANCHOR_SCHEMA,
    outboxMessageId,
    destinationKey,
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt,
    claimToken: null,
    leaseExpiresAt: null,
    createdAt,
    deliveredAt: null,
    lastError: null,
    payloadFingerprint,
    payload,
  });
}

function parseDecisionEvent(row: {
  id: unknown;
  workspace_id: unknown;
  event_type: unknown;
  aggregate_type: unknown;
  aggregate_id: unknown;
  payload_json: unknown;
  payload_fingerprint: unknown;
  created_at: unknown;
}): DecisionEvent {
  const id = storedIdentifier(row.id);
  if (typeof row.payload_json !== "string") return fail("DECISION_READ_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return fail("DECISION_READ_FAILED");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("DECISION_READ_FAILED");
  const value = parsed as Record<string, unknown>;
  if (
    canonicalJson(value) !== row.payload_json ||
    !exactKeys(value, [
      "schema",
      "workspaceId",
      "eventId",
      "callId",
      "submissionId",
      "submissionRevisionId",
      "submissionRevisionFingerprint",
      "decision",
      "decidedAt",
      "sessionHandoff",
      "communication",
    ]) ||
    (value.schema !== LEGACY_DECISION_EVENT_SCHEMA &&
      value.schema !== LINEAGE_DECISION_EVENT_SCHEMA &&
      value.schema !== DECISION_EVENT_SCHEMA)
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const decisionSchema = value.schema as
    | typeof LEGACY_DECISION_EVENT_SCHEMA
    | typeof LINEAGE_DECISION_EVENT_SCHEMA
    | typeof DECISION_EVENT_SCHEMA;
  const selectedDecision = decision(value.decision);
  const core = Object.freeze({
    schema: decisionSchema,
    workspaceId: storedIdentifier(value.workspaceId),
    eventId: storedIdentifier(value.eventId),
    callId: storedIdentifier(value.callId),
    submissionId: storedIdentifier(value.submissionId),
    submissionRevisionId: storedIdentifier(value.submissionRevisionId),
    submissionRevisionFingerprint: fingerprint(value.submissionRevisionFingerprint),
    decision: selectedDecision,
    decidedAt: timestamp(value.decidedAt),
    sessionHandoff: parseSessionHandoff(value.sessionHandoff, selectedDecision, decisionSchema),
  });
  const payload = Object.freeze({
    ...core,
    communication: parseDecisionCommunicationAnchor(value.communication, id, core),
  });
  if (
    canonicalJson(payload) !== row.payload_json ||
    row.workspace_id !== payload.workspaceId ||
    row.event_type !== "cfp.submission.decision" ||
    row.aggregate_type !== "cfp_submission" ||
    row.aggregate_id !== payload.submissionId ||
    fingerprint(row.payload_fingerprint) !== fingerprintOf(payload) ||
    timestamp(row.created_at) !== payload.decidedAt
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return Object.freeze({ id, payload });
}

function parseCommunication(
  row: {
    id: unknown;
    workspace_id: unknown;
    domain_event_id: unknown;
    destination_key: unknown;
    status: unknown;
    attempt_count: unknown;
    next_attempt_at: unknown;
    claim_token: unknown;
    lease_expires_at: unknown;
    created_at: unknown;
    delivered_at: unknown;
    last_error: unknown;
    payload_json: unknown;
  },
  event: DecisionEvent,
  recipientPersonId: string,
): CfpDecisionCommunicationReceipt {
  const anchor = event.payload.communication;
  const payload = anchor.payload;
  if (
    row.id !== anchor.outboxMessageId ||
    row.workspace_id !== event.payload.workspaceId ||
    row.domain_event_id !== event.id ||
    row.destination_key !== anchor.destinationKey ||
    row.status !== anchor.status ||
    row.attempt_count !== anchor.attemptCount ||
    row.next_attempt_at !== anchor.nextAttemptAt ||
    row.claim_token !== anchor.claimToken ||
    row.lease_expires_at !== anchor.leaseExpiresAt ||
    row.created_at !== anchor.createdAt ||
    row.delivered_at !== anchor.deliveredAt ||
    row.last_error !== anchor.lastError ||
    row.payload_json !== canonicalJson(payload) ||
    payload.payloadFingerprint !== anchor.payloadFingerprint ||
    payload.recipientPersonId !== recipientPersonId
  ) {
    return fail("DECISION_READ_FAILED");
  }
  return Object.freeze({
    evidenceVersion: "rendered-v2",
    receiptId: anchor.outboxMessageId,
    decisionEventId: event.id,
    status: "PENDING",
    channel: "local-inbox-simulation",
    recipientPersonId: payload.recipientPersonId,
    recipientDisplayName: payload.recipientDisplayName,
    recipientEmail: payload.recipientEmail,
    templateKey: payload.templateKey,
    mergeValues: payload.mergeValues,
    renderedSubject: payload.renderedSubject,
    renderedBody: payload.renderedBody,
    payloadFingerprint: payload.payloadFingerprint,
    queuedAt: anchor.createdAt,
    simulated: true,
    providerMutation: false,
    message: `Decision communication is queued for ${payload.recipientDisplayName} <${payload.recipientEmail}> in the local inbox simulation; no send or delivery is claimed.`,
  });
}

interface SubmissionDecisionContext {
  readonly eventId: string;
  readonly callId: string;
  readonly revisionId: string;
  readonly revision: SubmissionRevision;
  readonly personId: string;
  readonly displayName: string;
  readonly organization: string | null;
  readonly recipientEmail: string;
  readonly eventName: string;
  readonly callName: string;
}

function submissionContext(
  db: Db,
  workspaceId: string,
  eventId: string | undefined,
  callId: string | undefined,
  submissionId: string,
): SubmissionDecisionContext {
  const row = db
    .prepare(
      `SELECT s.id, s.workspace_id, s.event_id, s.call_id, s.state,
              s.current_revision_id, s.owner_person_id,
              p.id AS person_id, p.full_name, p.organization, p.canonical_email,
              e.name AS event_name, c.name AS call_name
       FROM submissions s
       JOIN events e ON e.id = s.event_id AND e.workspace_id = s.workspace_id
       JOIN calls c ON c.id = s.call_id AND c.workspace_id = s.workspace_id AND c.event_id = s.event_id
       JOIN people p ON p.id = s.owner_person_id AND p.workspace_id = s.workspace_id
       WHERE s.workspace_id = ? AND s.id = ?
       LIMIT 1`,
    )
    .get(workspaceId, submissionId) as
    | {
        id: unknown;
        workspace_id: unknown;
        event_id: unknown;
        call_id: unknown;
        state: unknown;
        current_revision_id: unknown;
        owner_person_id: unknown;
        person_id: unknown;
        full_name: unknown;
        organization: unknown;
        canonical_email: unknown;
        event_name: unknown;
        call_name: unknown;
      }
    | undefined;
  if (!row) return fail("SUBMISSION_NOT_AVAILABLE");
  if (
    row.id !== submissionId ||
    row.workspace_id !== workspaceId ||
    (eventId !== undefined && row.event_id !== eventId) ||
    (callId !== undefined && row.call_id !== callId) ||
    row.state !== "SUBMITTED" ||
    typeof row.current_revision_id !== "string" ||
    row.current_revision_id.length === 0 ||
    row.owner_person_id !== row.person_id
  ) {
    return fail(row.state === "SUBMITTED" ? "SUBMISSION_NOT_AVAILABLE" : "SUBMISSION_NOT_SUBMITTED");
  }
  const revisionId = storedIdentifier(row.current_revision_id);
  const revision = readSubmissionRevision(db, workspaceId, revisionId);
  if (revision.submissionId !== submissionId) return fail("DECISION_READ_FAILED");
  return Object.freeze({
    eventId: storedIdentifier(row.event_id),
    callId: storedIdentifier(row.call_id),
    revisionId,
    revision,
    personId: storedIdentifier(row.person_id),
    displayName: text(row.full_name),
    organization: row.organization === null ? null : text(row.organization),
    recipientEmail: storedEmail(row.canonical_email),
    eventName: text(row.event_name),
    callName: text(row.call_name),
  });
}

function submissionContextForRevision(
  db: Db,
  workspaceId: string,
  eventId: string,
  submissionId: string,
  revisionId: string,
): SubmissionDecisionContext {
  const row = db.prepare(
    `SELECT s.id, s.workspace_id, s.event_id, s.call_id, s.owner_person_id,
            p.id AS person_id, p.full_name, p.organization, p.canonical_email,
            e.name AS event_name, c.name AS call_name
       FROM submissions s
       JOIN events e ON e.id = s.event_id AND e.workspace_id = s.workspace_id
       JOIN calls c ON c.id = s.call_id AND c.workspace_id = s.workspace_id AND c.event_id = s.event_id
       JOIN people p ON p.id = s.owner_person_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.event_id = ? AND s.id = ?
      LIMIT 1`,
  ).get(workspaceId, eventId, submissionId) as Record<string, unknown> | undefined;
  if (
    !row ||
    row.id !== submissionId ||
    row.workspace_id !== workspaceId ||
    row.event_id !== eventId ||
    row.owner_person_id !== row.person_id
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const revision = readSubmissionRevision(db, workspaceId, revisionId);
  if (revision.submissionId !== submissionId) return fail("DECISION_READ_FAILED");
  return Object.freeze({
    eventId,
    callId: storedIdentifier(row.call_id),
    revisionId,
    revision,
    personId: storedIdentifier(row.person_id),
    displayName: text(row.full_name),
    organization: row.organization === null ? null : text(row.organization),
    recipientEmail: storedEmail(row.canonical_email),
    eventName: text(row.event_name),
    callName: text(row.call_name),
  });
}

function currentDecisionEvent(
  db: Db,
  workspaceId: string,
  submissionId: string,
  revisionId: string,
): DecisionEvent | null {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ?
         AND event_type = 'cfp.submission.decision'
         AND aggregate_type = 'cfp_submission'
         AND aggregate_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(workspaceId, submissionId) as Array<{
      id: unknown;
      workspace_id: unknown;
      event_type: unknown;
      aggregate_type: unknown;
      aggregate_id: unknown;
      payload_json: unknown;
      payload_fingerprint: unknown;
      created_at: unknown;
    }>;
  let match: DecisionEvent | null = null;
  for (const row of rows) {
    const event = parseDecisionEvent(row);
    if (
      event.payload.workspaceId === workspaceId &&
      event.payload.submissionId === submissionId &&
      event.payload.submissionRevisionId === revisionId
    ) {
      if (match !== null) return fail("DECISION_READ_FAILED");
      match = event;
    }
  }
  return match;
}

function projectionForEvent(
  db: Db,
  workspaceId: string,
  event: DecisionEvent,
  context: SubmissionDecisionContext,
): CfpSubmissionDecisionProjection {
  if (
    event.payload.workspaceId !== workspaceId ||
    event.payload.eventId !== context.eventId ||
    event.payload.callId !== context.callId ||
    event.payload.submissionId !== context.revision.submissionId ||
    event.payload.submissionRevisionId !== context.revisionId ||
    event.payload.submissionRevisionFingerprint !== context.revision.fingerprint
  ) {
    return fail("DECISION_READ_FAILED");
  }
  if (
    event.payload.decision === "ACCEPTED" &&
    (!event.payload.sessionHandoff ||
      event.payload.sessionHandoff.eventId !== context.eventId ||
      event.payload.sessionHandoff.sourceSubmissionId !== context.revision.submissionId ||
      event.payload.sessionHandoff.sourceRevisionId !== context.revisionId ||
      event.payload.sessionHandoff.sourceRevisionFingerprint !== context.revision.fingerprint ||
      event.payload.sessionHandoff.speakerPersonId !== context.personId)
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const communicationRows = db
    .prepare(
      `SELECT id, workspace_id, domain_event_id, destination_key, payload_json,
              status, attempt_count, next_attempt_at, claim_token, lease_expires_at,
              created_at, delivered_at, last_error
       FROM outbox_messages
       WHERE domain_event_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(event.id) as Array<{
        id: unknown;
        workspace_id: unknown;
        domain_event_id: unknown;
        destination_key: unknown;
        payload_json: unknown;
        status: unknown;
        attempt_count: unknown;
        next_attempt_at: unknown;
        claim_token: unknown;
        lease_expires_at: unknown;
        created_at: unknown;
        delivered_at: unknown;
        last_error: unknown;
      }>;
  if (communicationRows.length !== 1) return fail("DECISION_READ_FAILED");
  const communication = parseCommunication(
    communicationRows[0]!,
    event,
    context.personId,
  );
  const proposal = proposalDisplay(context.revision);
  const linkedSession = event.payload.decision === "ACCEPTED" && event.payload.sessionHandoff
      ? readCfpSessionHandoff(db, {
        workspaceId,
        evidence: event.payload.sessionHandoff,
        title: proposal.title,
        format: proposal.format,
        track: proposal.track,
        trackRequired: proposal.trackRequired,
        requestedDurationMinutes: proposal.durationMinutes,
        requestedDurationSource: proposal.durationSource,
      })
    : null;
  const releasedSession = linkedSession
    ? readCurrentReleasedCfpSession(db, {
        workspaceId,
        eventId: context.eventId,
        programUnitId: linkedSession.programUnitId,
        speakerPersonId: context.personId,
      })
    : null;
  const projectedSession = linkedSession && releasedSession
    ? Object.freeze({
        ...linkedSession,
        status: "RELEASED" as const,
        placement: releasedSession.placement,
        release: Object.freeze({
          sealedAt: releasedSession.sealedAt,
          releaseNumber: releasedSession.releaseNumber,
        }),
      })
    : linkedSession;
  return Object.freeze({
    decisionEventId: event.id,
    submissionId: context.revision.submissionId,
    submissionRevisionId: context.revisionId,
    submissionRevisionFingerprint: context.revision.fingerprint,
    decision: event.payload.decision,
    decidedAt: event.payload.decidedAt,
    handoff: event.payload.decision === "ACCEPTED"
      ? acceptedHandoff(
          context.revision,
          context.revision.submissionId,
          context.revisionId,
          context.personId,
          context.displayName,
          projectedSession ?? fail("DECISION_READ_FAILED"),
        )
      : null,
    communication,
  });
}

function organizerAuth(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
): { readonly workspaceId: string; readonly accountId: string } {
  if (!hasCapability(session, "phase0.pipeline.manage") || session.workspaceSlug !== workspaceSlug) {
    writeDenialAudit(db, session.workspaceId, {
      actorKind: "account",
      actorRef: session.accountId,
      code: "CFP_DECISION_ACCESS_DENIED",
      targetType: "workspace",
      targetId: session.workspaceId,
    });
    return fail("ACCESS_DENIED");
  }
  const workspace = db
    .prepare("SELECT id, slug FROM workspaces WHERE id = ? AND slug = ? LIMIT 1")
    .get(session.workspaceId, workspaceSlug) as { id: unknown; slug: unknown } | undefined;
  const account = db
    .prepare("SELECT id, workspace_id, role FROM accounts WHERE id = ? LIMIT 1")
    .get(session.accountId) as { id: unknown; workspace_id: unknown; role: unknown } | undefined;
  if (
    !workspace ||
    workspace.id !== session.workspaceId ||
    workspace.slug !== workspaceSlug ||
    !account ||
    account.id !== session.accountId ||
    account.workspace_id !== session.workspaceId ||
    account.role !== session.role
  ) {
    return fail("ACCESS_DENIED");
  }
  return Object.freeze({ workspaceId: session.workspaceId, accountId: session.accountId });
}

export interface DecideCfpSubmissionInput {
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly expectedRevisionId: string;
  readonly decision: CfpSubmissionDecision;
}

export interface AcceptedCfpScheduleInventoryLink {
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly decidedAt: string;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly speakerLinkId: string | null;
  readonly speakerName: string;
  readonly speakerOrganization: string | null;
  readonly speakerEmail: string;
  readonly linkFingerprint: string;
}

export interface AcceptedCfpScheduleInventoryEntry {
  readonly authorityVersion: "LEGACY_V1" | "LINEAGE_V2" | "BOUNDED_V3";
  readonly proposalLineageId: string | null;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly abstract: string | null;
  readonly format: string | null;
  readonly unitType: "session";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly durationSource: "PROPOSAL_ANSWER" | "FORMAT_OPTION" | "CANONICAL_DEFAULT";
  readonly capacity: number;
  readonly proposalTrack: string | null;
  readonly trackId: string;
  readonly trackName: string;
  readonly trackSource: "PROPOSAL" | "CANONICAL_FALLBACK";
  readonly sessionFingerprint: string;
  readonly links: readonly AcceptedCfpScheduleInventoryLink[];
}

function validateDecisionInput(input: DecideCfpSubmissionInput): DecideCfpSubmissionInput {
  if (input === null || typeof input !== "object") return fail("INPUT_INVALID");
  if (
    typeof input.workspaceSlug !== "string" ||
    typeof input.eventId !== "string" ||
    typeof input.callId !== "string" ||
    typeof input.submissionId !== "string" ||
    typeof input.expectedRevisionId !== "string" ||
    !IDENTIFIER_PATTERN.test(input.workspaceSlug) ||
    !IDENTIFIER_PATTERN.test(input.eventId) ||
    !IDENTIFIER_PATTERN.test(input.callId) ||
    !IDENTIFIER_PATTERN.test(input.submissionId) ||
    !IDENTIFIER_PATTERN.test(input.expectedRevisionId) ||
    (input.decision !== "ACCEPTED" && input.decision !== "REJECTED")
  ) {
    return fail("INPUT_INVALID");
  }
  return Object.freeze({ ...input });
}

export function readCfpSubmissionDecision(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly submissionId: string;
    readonly currentRevisionId: string;
  },
): CfpSubmissionDecisionProjection | null {
  if (
    !IDENTIFIER_PATTERN.test(input.workspaceId) ||
    !IDENTIFIER_PATTERN.test(input.submissionId) ||
    !IDENTIFIER_PATTERN.test(input.currentRevisionId)
  ) {
    return null;
  }
  const context = submissionContext(db, input.workspaceId, undefined, undefined, input.submissionId);
  if (context.revisionId !== input.currentRevisionId) return null;
  const event = currentDecisionEvent(db, input.workspaceId, input.submissionId, input.currentRevisionId);
  return event ? projectionForEvent(db, input.workspaceId, event, context) : null;
}

interface AcceptedCfpInventoryCandidate {
  readonly core: Omit<AcceptedCfpScheduleInventoryEntry, "links">;
  readonly link: AcceptedCfpScheduleInventoryLink;
}

function acceptedCfpInventoryCandidate(
  db: Db,
  workspaceId: string,
  eventId: string,
  event: DecisionEvent,
  context: SubmissionDecisionContext,
  authorityMode: "CURRENT" | "HISTORICAL",
): AcceptedCfpInventoryCandidate | null {
  if (
    event.payload.workspaceId !== workspaceId ||
    event.payload.eventId !== eventId ||
    event.payload.callId !== context.callId ||
    event.payload.submissionId !== context.revision.submissionId ||
    event.payload.submissionRevisionId !== context.revisionId ||
    event.payload.submissionRevisionFingerprint !== context.revision.fingerprint
  ) {
    return fail("DECISION_READ_FAILED");
  }
  if (event.payload.decision === "REJECTED") return null;
  const evidence = event.payload.sessionHandoff;
  if (!evidence) return fail("DECISION_READ_FAILED");
  const proposal = proposalDisplay(context.revision);
  const linked = readCfpSessionHandoff(db, {
    workspaceId,
    evidence,
    title: proposal.title,
    format: proposal.format,
    track: proposal.track,
    trackRequired: proposal.trackRequired,
    requestedDurationMinutes: proposal.durationMinutes,
    requestedDurationSource: proposal.durationSource,
    authorityMode,
  });
  if (
    linked.capacity !== CFP_SESSION_MINIMUM_CAPACITY ||
    linked.sourceSubmissionId !== event.payload.submissionId ||
    linked.sourceRevisionId !== event.payload.submissionRevisionId ||
    linked.sourceRevisionFingerprint !== event.payload.submissionRevisionFingerprint ||
    linked.speakerPersonId !== context.personId
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const authorityVersion = evidence.schema === "cfp-session-handoff/v1"
    ? "LEGACY_V1"
    : evidence.schema === "cfp-session-handoff/v2"
      ? "LINEAGE_V2"
      : "BOUNDED_V3";
  const coreBasis = Object.freeze({
    authorityVersion,
    proposalLineageId: linked.proposalLineageId,
    programUnitId: linked.programUnitId,
    programUnitName: linked.name,
    abstract: proposal.abstract,
    format: linked.format,
    unitType: linked.unitType,
    startsAt: linked.startsAt,
    endsAt: linked.endsAt,
    durationMinutes: linked.durationMinutes,
    durationSource: linked.durationSource,
    capacity: linked.capacity,
    proposalTrack: linked.proposalTrack,
    trackId: linked.trackId,
    trackName: linked.trackName,
    trackSource: linked.trackSource,
  });
  const sessionFingerprint = fingerprintOf(coreBasis);
  const communication = event.payload.communication.payload;
  if (communication.recipientPersonId !== linked.speakerPersonId) {
    return fail("DECISION_READ_FAILED");
  }
  const linkBasis = Object.freeze({
    decisionEventId: event.id,
    decisionFingerprint: fingerprintOf(event.payload),
    decidedAt: event.payload.decidedAt,
    sourceSubmissionId: linked.sourceSubmissionId,
    sourceRevisionId: linked.sourceRevisionId,
    sourceRevisionFingerprint: linked.sourceRevisionFingerprint,
    speakerPersonId: linked.speakerPersonId,
    speakerLinkId: linked.speakerLinkId,
    speakerName: communication.recipientDisplayName,
    speakerOrganization: null,
    speakerEmail: communication.recipientEmail,
  });
  return Object.freeze({
    core: Object.freeze({ ...coreBasis, sessionFingerprint }),
    link: Object.freeze({ ...linkBasis, linkFingerprint: fingerprintOf(linkBasis) }),
  });
}

function groupAcceptedCfpInventory(
  candidates: readonly AcceptedCfpInventoryCandidate[],
): readonly AcceptedCfpScheduleInventoryEntry[] {
  const grouped = new Map<string, {
    readonly core: Omit<AcceptedCfpScheduleInventoryEntry, "links">;
    readonly links: AcceptedCfpScheduleInventoryLink[];
  }>();
  const lineageUnits = new Map<string, string>();
  const seenLinkFingerprints = new Set<string>();
  for (const { core, link } of candidates) {
    if (core.proposalLineageId !== null) {
      const priorUnit = lineageUnits.get(core.proposalLineageId);
      if (priorUnit && priorUnit !== core.programUnitId) return fail("DECISION_READ_FAILED");
      lineageUnits.set(core.proposalLineageId, core.programUnitId);
    }
    if (seenLinkFingerprints.has(link.linkFingerprint)) return fail("DECISION_READ_FAILED");
    seenLinkFingerprints.add(link.linkFingerprint);
    const existing = grouped.get(core.programUnitId);
    if (existing) {
      if (existing.core.sessionFingerprint !== core.sessionFingerprint) return fail("DECISION_READ_FAILED");
      existing.links.push(link);
    } else {
      grouped.set(core.programUnitId, { core, links: [link] });
    }
  }
  return Object.freeze([...grouped.values()]
    .map(({ core, links }) => Object.freeze({
      ...core,
      links: Object.freeze([...links].sort((first, second) =>
        first.sourceSubmissionId.localeCompare(second.sourceSubmissionId) ||
        first.sourceRevisionId.localeCompare(second.sourceRevisionId) ||
        first.decisionEventId.localeCompare(second.decisionEventId),
      )),
    }))
    .sort((first, second) => first.programUnitId.localeCompare(second.programUnitId)));
}

/**
 * Current scheduler inventory derived only from exact, current, accepted CFP decision evidence.
 * This is decision truth: it deliberately does not require or synthesize a speaker commitment.
 */
export function readAcceptedCfpScheduleInventory(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
): readonly AcceptedCfpScheduleInventoryEntry[] {
  const workspaceId = storedIdentifier(scope.workspaceId);
  const eventId = storedIdentifier(scope.eventId);
  const rows = db.prepare(
    `SELECT id, current_revision_id AS currentRevisionId
       FROM submissions
      WHERE workspace_id = ? AND event_id = ? AND state = 'SUBMITTED'
      ORDER BY id
      LIMIT ?`,
  ).all(workspaceId, eventId, MAX_CFP_SCHEDULE_INVENTORY + 1) as Array<{
    id: unknown;
    currentRevisionId: unknown;
  }>;
  if (rows.length > MAX_CFP_SCHEDULE_INVENTORY) return fail("DECISION_READ_FAILED");
  const candidates: AcceptedCfpInventoryCandidate[] = [];
  for (const row of rows) {
    const submissionId = storedIdentifier(row.id);
    const currentRevisionId = storedIdentifier(row.currentRevisionId);
    const context = submissionContext(db, workspaceId, eventId, undefined, submissionId);
    if (context.revisionId !== currentRevisionId) return fail("DECISION_READ_FAILED");
    const event = currentDecisionEvent(db, workspaceId, submissionId, currentRevisionId);
    if (!event) continue;
    const projection = projectionForEvent(db, workspaceId, event, context);
    if (projection.decision === "REJECTED") continue;
    const candidate = acceptedCfpInventoryCandidate(
      db,
      workspaceId,
      eventId,
      event,
      context,
      "CURRENT",
    );
    if (!candidate) return fail("DECISION_READ_FAILED");
    candidates.push(candidate);
  }
  return groupAcceptedCfpInventory(candidates);
}

export interface AcceptedCfpScheduleInventoryCutoff {
  readonly at: string;
  readonly auditRowid: number;
}

function acceptedDecisionAuditPrecedesCutoff(
  db: Db,
  event: DecisionEvent,
  cutoff: AcceptedCfpScheduleInventoryCutoff,
): boolean {
  const rows = db.prepare(
    `SELECT audit.rowid, audit.actor_kind AS actorKind, audit.actor_ref AS actorRef,
            audit.details_json AS detailsJson, audit.created_at AS createdAt
       FROM audit_events audit
      WHERE audit.workspace_id = ?
        AND audit.action = 'cfp.submission.decision.recorded'
        AND audit.target_type = 'cfp_submission'
        AND audit.target_id = ?
        AND CASE WHEN json_valid(audit.details_json)
              THEN json_extract(audit.details_json, '$.submissionRevisionId')
              ELSE NULL END = ?
      ORDER BY audit.rowid`,
  ).all(
    event.payload.workspaceId,
    event.payload.submissionId,
    event.payload.submissionRevisionId,
  ) as unknown as Array<{
    rowid: number;
    actorKind: string;
    actorRef: string | null;
    detailsJson: string;
    createdAt: string;
  }>;
  if (rows.length !== 1) return fail("DECISION_READ_FAILED");
  const audit = rows[0]!;
  const handoff = event.payload.sessionHandoff as Record<string, unknown> | null;
  const expectedDetails = JSON.stringify({
    eventId: event.payload.eventId,
    callId: event.payload.callId,
    decision: event.payload.decision,
    submissionRevisionId: event.payload.submissionRevisionId,
    submissionRevisionFingerprint: event.payload.submissionRevisionFingerprint,
    programUnitId: handoff?.programUnitId ?? null,
    proposalLineageId: handoff?.proposalLineageId ?? null,
    speakerLinkId: handoff?.speakerLinkId ?? null,
    sessionCapacity: handoff?.capacity ?? null,
    sessionDurationMinutes: handoff?.durationMinutes ?? null,
    sessionDurationSource: handoff?.durationSource ?? null,
    sessionTrackId: handoff?.trackId ?? null,
    sessionTrackName: handoff?.trackName ?? null,
    sessionTrackSource: handoff?.trackSource ?? null,
    sessionStatus: handoff?.createdStatus ?? null,
    communication: "local-inbox-simulation",
    providerMutation: false,
  });
  if (
    !Number.isSafeInteger(audit.rowid) ||
    audit.rowid < 1 ||
    audit.actorKind !== "account" ||
    audit.actorRef === null ||
    !IDENTIFIER_PATTERN.test(audit.actorRef) ||
    audit.detailsJson !== expectedDetails ||
    timestamp(audit.createdAt) !== audit.createdAt ||
    Date.parse(audit.createdAt) < Date.parse(event.payload.decidedAt)
  ) {
    return fail("DECISION_READ_FAILED");
  }
  const actor = db.prepare(
    "SELECT id FROM accounts WHERE workspace_id = ? AND id = ? LIMIT 1",
  ).get(event.payload.workspaceId, audit.actorRef) as { id: string } | undefined;
  if (!actor || actor.id !== audit.actorRef) return fail("DECISION_READ_FAILED");
  return audit.rowid < cutoff.auditRowid && audit.createdAt <= cutoff.at;
}

/** Reconstruct exact accepted-revision CFP inventory before one immutable schedule audit row. */
export function readAcceptedCfpScheduleInventoryAt(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  cutoff: AcceptedCfpScheduleInventoryCutoff,
): readonly AcceptedCfpScheduleInventoryEntry[] {
  const workspaceId = storedIdentifier(scope.workspaceId);
  const eventId = storedIdentifier(scope.eventId);
  const cutoffAt = timestamp(cutoff.at);
  if (!Number.isSafeInteger(cutoff.auditRowid) || cutoff.auditRowid < 1) {
    return fail("DECISION_READ_FAILED");
  }
  const rows = db.prepare(
    `SELECT decision.id, decision.workspace_id, decision.event_type, decision.aggregate_type,
            decision.aggregate_id, decision.payload_json, decision.payload_fingerprint,
            decision.created_at
       FROM domain_events decision
       JOIN submissions submission
         ON submission.workspace_id = decision.workspace_id
        AND submission.id = decision.aggregate_id
        AND submission.event_id = ?
      WHERE decision.workspace_id = ?
        AND decision.event_type = 'cfp.submission.decision'
        AND decision.aggregate_type = 'cfp_submission'
        AND decision.created_at <= ?
      ORDER BY decision.created_at, decision.rowid
      LIMIT ?`,
  ).all(
    eventId,
    workspaceId,
    cutoffAt,
    MAX_CFP_SCHEDULE_INVENTORY + 1,
  ) as Array<{
    id: unknown;
    workspace_id: unknown;
    event_type: unknown;
    aggregate_type: unknown;
    aggregate_id: unknown;
    payload_json: unknown;
    payload_fingerprint: unknown;
    created_at: unknown;
  }>;
  if (rows.length > MAX_CFP_SCHEDULE_INVENTORY) return fail("DECISION_READ_FAILED");
  const candidates: AcceptedCfpInventoryCandidate[] = [];
  const seenRevisions = new Set<string>();
  for (const row of rows) {
    const event = parseDecisionEvent(row);
    if (event.payload.eventId !== eventId || event.payload.workspaceId !== workspaceId) {
      return fail("DECISION_READ_FAILED");
    }
    const revisionKey = `${event.payload.submissionId}:${event.payload.submissionRevisionId}`;
    if (seenRevisions.has(revisionKey)) return fail("DECISION_READ_FAILED");
    seenRevisions.add(revisionKey);
    if (!acceptedDecisionAuditPrecedesCutoff(db, event, cutoff)) continue;
    const context = submissionContextForRevision(
      db,
      workspaceId,
      eventId,
      event.payload.submissionId,
      event.payload.submissionRevisionId,
    );
    const candidate = acceptedCfpInventoryCandidate(
      db,
      workspaceId,
      eventId,
      event,
      context,
      "HISTORICAL",
    );
    if (candidate) candidates.push(candidate);
  }
  return groupAcceptedCfpInventory(candidates);
}

export function decideCfpSubmission(
  db: Db,
  session: SessionInfo,
  rawInput: DecideCfpSubmissionInput,
): CfpSubmissionDecisionReceipt {
  const input = validateDecisionInput(rawInput);
  try {
    return withTransactionOrSavepoint(db, "cfp_decide_submission", () => {
    const organizer = organizerAuth(db, session, input.workspaceSlug);
    const context = submissionContext(db, organizer.workspaceId, input.eventId, input.callId, input.submissionId);
    if (context.revisionId !== input.expectedRevisionId) return fail("SUBMISSION_STALE");

    const existing = currentDecisionEvent(db, organizer.workspaceId, input.submissionId, context.revisionId);
    if (existing) {
      if (existing.payload.decision !== input.decision) return fail("DECISION_ALREADY_RECORDED");
      return Object.freeze({
          ...projectionForEvent(db, organizer.workspaceId, existing, context),
          replayed: true,
        });
    }

    const decidedAt = nowIso();
    const proposal = proposalDisplay(context.revision);
    const proposalTitle = proposal.title;
    let sessionHandoff: CfpSessionHandoffEvidence | null = null;
    if (input.decision === "ACCEPTED") {
      try {
        sessionHandoff = ensureAcceptedCfpSession(db, {
          workspaceId: organizer.workspaceId,
          eventId: context.eventId,
          submissionId: input.submissionId,
          revisionId: context.revisionId,
          revisionFingerprint: context.revision.fingerprint,
          speakerPersonId: context.personId,
          actor: session,
          title: proposalTitle,
          abstract: proposal.abstract,
          format: proposal.format,
          track: proposal.track,
          trackRequired: proposal.trackRequired,
          requestedDurationMinutes: proposal.durationMinutes,
          requestedDurationSource: proposal.durationSource,
          createdAt: decidedAt,
        });
      } catch (error) {
        if (error instanceof CfpSessionHandoffError) {
          return fail("DECISION_WRITE_FAILED");
        }
        throw error;
      }
    }
    const decisionEventId = uuid();
    const outboxMessageId = uuid();
    const templateKey = communicationTemplateKey(input.decision);
    const mergeValues = Object.freeze({
      eventName: context.eventName,
      callName: context.callName,
      proposalTitle,
    });
    const rendered = renderDecisionCommunication(input.decision, context.displayName, mergeValues);
    const communicationPayloadBasis = Object.freeze({
      schema: COMMUNICATION_SCHEMA,
      decisionEventId,
      workspaceId: organizer.workspaceId,
      eventId: context.eventId,
      callId: context.callId,
      submissionId: input.submissionId,
      submissionRevisionId: context.revisionId,
      submissionRevisionFingerprint: context.revision.fingerprint,
      recipientPersonId: context.personId,
      recipientDisplayName: context.displayName,
      recipientEmail: context.recipientEmail,
      decision: input.decision,
      templateKey,
      mergeValues,
      renderedSubject: rendered.subject,
      renderedBody: rendered.body,
      sessionHandoff,
      channel: "local-inbox-simulation",
      simulated: true,
      providerMutation: false,
    });
    const communicationPayloadFingerprint = fingerprintOf(communicationPayloadBasis);
    const communicationPayload = Object.freeze({
      ...communicationPayloadBasis,
      payloadFingerprint: communicationPayloadFingerprint,
    });
    const destinationKey = `cfp:${input.submissionId}:${context.personId}:${decisionEventId}:${communicationPayloadFingerprint}`;
    const communication = Object.freeze({
      schema: COMMUNICATION_ANCHOR_SCHEMA,
      outboxMessageId,
      destinationKey,
      status: "PENDING" as const,
      attemptCount: 0 as const,
      nextAttemptAt: decidedAt,
      claimToken: null,
      leaseExpiresAt: null,
      createdAt: decidedAt,
      deliveredAt: null,
      lastError: null,
      payloadFingerprint: communicationPayloadFingerprint,
      payload: communicationPayload,
    });
    const payload = Object.freeze({
      schema: DECISION_EVENT_SCHEMA,
      workspaceId: organizer.workspaceId,
      eventId: context.eventId,
      callId: context.callId,
      submissionId: input.submissionId,
      submissionRevisionId: context.revisionId,
      submissionRevisionFingerprint: context.revision.fingerprint,
      decision: input.decision,
      decidedAt,
      sessionHandoff,
      communication,
    });
    const payloadJson = canonicalJson(payload);
    const eventPayloadFingerprint = fingerprintOf(payload);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'cfp.submission.decision', 'cfp_submission', ?, ?, ?, ?)`,
    ).run(
      decisionEventId,
      organizer.workspaceId,
      input.submissionId,
      payloadJson,
      eventPayloadFingerprint,
      decidedAt,
    );
    db.prepare(
      `INSERT INTO outbox_messages
         (id, workspace_id, domain_event_id, destination_key, payload_json,
          status, attempt_count, next_attempt_at, claim_token, lease_expires_at,
          created_at, delivered_at, last_error)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      outboxMessageId,
      organizer.workspaceId,
      decisionEventId,
      destinationKey,
      canonicalJson(communicationPayload),
      decidedAt,
      decidedAt,
    );
    writeAudit(db, organizer.workspaceId, {
      actorKind: "account",
      actorRef: organizer.accountId,
      action: "cfp.submission.decision.recorded",
      targetType: "cfp_submission",
      targetId: input.submissionId,
      details: {
        eventId: context.eventId,
        callId: context.callId,
        decision: input.decision,
        submissionRevisionId: context.revisionId,
        submissionRevisionFingerprint: context.revision.fingerprint,
        programUnitId: sessionHandoff?.programUnitId ?? null,
        proposalLineageId: sessionHandoff?.proposalLineageId ?? null,
        speakerLinkId: sessionHandoff?.speakerLinkId ?? null,
        sessionCapacity: sessionHandoff?.capacity ?? null,
        sessionDurationMinutes: sessionHandoff?.durationMinutes ?? null,
        sessionDurationSource: sessionHandoff?.durationSource ?? null,
        sessionTrackId: sessionHandoff?.trackId ?? null,
        sessionTrackName: sessionHandoff?.trackName ?? null,
        sessionTrackSource: sessionHandoff?.trackSource ?? null,
        sessionStatus: sessionHandoff?.createdStatus ?? null,
        communication: "local-inbox-simulation",
        providerMutation: false,
      },
    });
    const event = parseDecisionEvent({
      id: decisionEventId,
      workspace_id: organizer.workspaceId,
      event_type: "cfp.submission.decision",
      aggregate_type: "cfp_submission",
      aggregate_id: input.submissionId,
      payload_json: payloadJson,
      payload_fingerprint: eventPayloadFingerprint,
      created_at: decidedAt,
    });
    return Object.freeze({
      ...projectionForEvent(db, organizer.workspaceId, event, context),
      replayed: false,
    });
    });
  } catch (error) {
    if (error instanceof CfpDecisionError) throw error;
    throw new CfpDecisionError("DECISION_WRITE_FAILED");
  }
}

export type {
  CfpAcceptedSessionHandoff,
  CfpDecisionCommunicationMergeValues,
  CfpDecisionCommunicationReceipt,
  CfpDecisionCommunicationTemplateKey,
  CfpLinkedSessionProjection,
  CfpSubmissionDecision,
  CfpSubmissionDecisionProjection,
  CfpSubmissionDecisionReceipt,
} from "./decision-types";
