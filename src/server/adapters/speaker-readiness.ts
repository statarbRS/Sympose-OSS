import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import { fingerprintOf } from "../canonical";

export const SPEAKER_READINESS_SCHEMA = "pd01-speaker-readiness/v2" as const;
export const SPEAKER_FINGERPRINT_ALGORITHM = "sha256-canonical-json-v1" as const;
export const SPEAKER_GATE_TARGETS = ["OFFER", "CONFIRMATION", "SCHEDULING", "PUBLICATION", "OPERATOR_RELEASE"] as const;
export type SpeakerGateTarget = (typeof SPEAKER_GATE_TARGETS)[number];

export type SpeakerTruthKind =
  | "SELECTION" | "ROLE" | "CONDITION" | "VERIFICATION" | "OFFER" | "COMMITMENT"
  | "REQUIREMENT" | "SUBMISSION" | "REQUIREMENT_DECISION" | "REQUIREMENT_WAIVER"
  | "EDITORIAL" | "SCHEDULE" | "PUBLICATION" | string;

export interface SpeakerSourceRef {
  readonly type: SpeakerTruthKind;
  readonly id: string;
  readonly fingerprint: string;
}
export interface SpeakerSourceRecord extends SpeakerSourceRef {
  readonly current: boolean;
  readonly supersededById: string | null;
  readonly quarantined: boolean;
  readonly occurredAt: string;
  readonly supersededAt: string | null;
}
export interface SpeakerAuthorityFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly accountId: string;
  readonly allowedActions: readonly string[];
  readonly subjectKind: "REQUIREMENT" | "CONDITION" | "VERIFICATION" | "DECISION" | "WAIVER";
  readonly subjectId: string;
  readonly subjectFingerprint: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly current: boolean;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
  readonly sourceRecords: readonly SpeakerSourceRef[];
}
export interface SpeakerSelectionFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly status: "SELECTED" | "NOT_SELECTED" | "WAITLISTED";
  readonly current: boolean;
  readonly occurredAt: string;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
}
export type SpeakerConditionState = "OPEN" | "EVIDENCE_SUBMITTED" | "SATISFIED" | "WAIVED" | "EXPIRED" | "REVOKED";
export interface SpeakerConditionVerificationFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly evidenceRecords: readonly SpeakerSourceRef[];
  readonly result: "SATISFIES" | "DOES_NOT_SATISFY" | "INCONCLUSIVE";
  readonly current: boolean;
  readonly occurredAt: string;
  readonly conditionId: string;
  readonly verifiedByAccountId: string;
  readonly authorityRecords: readonly SpeakerSourceRef[];
}
export interface SpeakerConditionTransitionFact {
  readonly id: string;
  readonly sequence: number;
  readonly toState: SpeakerConditionState;
  readonly verificationId: string | null;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
}
export interface SpeakerConditionFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly gateTargets: readonly SpeakerGateTarget[];
  readonly waivable: boolean;
  readonly waiverScope: readonly SpeakerGateTarget[];
  readonly transitions: readonly SpeakerConditionTransitionFact[];
  readonly verifications: readonly SpeakerConditionVerificationFact[];
  readonly waivers: readonly SpeakerConditionWaiverFact[];
}
export interface SpeakerConditionWaiverFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly scope: readonly SpeakerGateTarget[];
  readonly reason: string;
  readonly actorId: string;
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly conditionId: string;
  readonly authorityRecords: readonly SpeakerSourceRef[];
}
export interface SpeakerRoleFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly personId: string;
  readonly applicable: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
}
export interface SpeakerOfferFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly selectionDecisionId: string;
  readonly selectionDecisionFingerprint: string;
  readonly personId: string;
  readonly speakerRoleId: string;
  readonly termsFingerprint: string;
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
}
export interface SpeakerCommitmentFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly offerId: string;
  readonly offerFingerprint: string;
  readonly state: "ACCEPTED" | "DECLINED" | "PENDING" | "REVOKED";
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
}
export type SpeakerSubmissionKind = "ARTIFACT" | "PROFILE_SNAPSHOT" | "FORM_RESPONSE" | "PROGRAM_UNIT_VERSION" | "ACKNOWLEDGEMENT" | "EXTERNAL_REFERENCE" | "MANUAL_EVIDENCE";
export interface SpeakerSubmissionFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly requirementId: string;
  readonly version: number;
  readonly supersedesSubmissionId: string | null;
  readonly kind: SpeakerSubmissionKind;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly current: boolean;
  readonly quarantined: boolean;
  readonly occurredAt: string;
}
export interface SpeakerRequirementDecisionFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly requirementId: string;
  readonly kind: "APPROVE_VERSION" | "REJECT_VERSION" | "REVOKE_DECISION";
  readonly submissionId: string | null;
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly decidedByAccountId: string;
  readonly authorityRecords: readonly SpeakerSourceRef[];
  readonly supersedesDecisionId?: string | null;
}
export interface SpeakerRequirementWaiverFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly requirementId: string;
  readonly scope: readonly SpeakerGateTarget[];
  readonly reason: string;
  readonly actorId: string;
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly authorityRecords: readonly SpeakerSourceRef[];
}
export interface SpeakerRequirementFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly gateTargets: readonly SpeakerGateTarget[];
  readonly required: boolean;
  readonly waivable: boolean;
  readonly submissions: readonly SpeakerSubmissionFact[];
  readonly decisions: readonly SpeakerRequirementDecisionFact[];
  readonly waivers: readonly SpeakerRequirementWaiverFact[];
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
}
export interface SpeakerFindingFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly submissionId: string;
  readonly submissionFingerprint: string;
  readonly severity: "INFO" | "WARNING" | "BLOCKER" | "CRITICAL";
  readonly blocksGateTargets: readonly SpeakerGateTarget[];
  readonly current: boolean;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly requirementId: string;
}
export interface SpeakerScheduleFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly speakerRoleId: string;
  readonly state: "APPROVED" | "PENDING" | "REJECTED";
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
}
export interface SpeakerPublicationFact {
  readonly id: string;
  readonly fingerprint: string;
  readonly speakerRoleId: string;
  readonly state: "APPROVED" | "PENDING" | "REJECTED";
  readonly current: boolean;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly occurredAt: string;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
}
export interface SpeakerReadinessFacts {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly asOf: string;
  readonly locale: string;
  readonly selection: SpeakerSelectionFact;
  readonly selectedSpeakerRoles: readonly SpeakerRoleFact[];
  readonly applicableRequirements: readonly SpeakerSourceRef[];
  readonly conditions: readonly SpeakerConditionFact[];
  readonly offers: readonly SpeakerOfferFact[];
  readonly commitments: readonly SpeakerCommitmentFact[];
  readonly requirements: readonly SpeakerRequirementFact[];
  readonly findings: readonly SpeakerFindingFact[];
  readonly schedules: readonly SpeakerScheduleFact[];
  readonly publications: readonly SpeakerPublicationFact[];
  readonly sourceRecords: readonly SpeakerSourceRecord[];
  readonly authorities: readonly SpeakerAuthorityFact[];
}

export interface SpeakerBlocker {
  readonly code: "SELECTION_NOT_CURRENT" | "SOURCE_INVALID" | "CONDITION_NOT_SATISFIED" | "OFFER_MISSING" | "COMMITMENT_NOT_ACCEPTED" | "REQUIREMENT_NOT_READY" | "CURRENT_VERSION_NOT_APPROVED" | "SCHEDULE_NOT_APPROVED" | "PUBLICATION_NOT_APPROVED" | "CURRENT_BLOCKER_FINDING";
  readonly truth: SpeakerTruthKind;
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly detail: string;
}
export interface SpeakerGateResult {
  readonly gate: SpeakerGateTarget;
  readonly eligible: boolean;
  readonly blockers: readonly SpeakerBlocker[];
  readonly waivers: readonly SpeakerSourceRef[];
  readonly sourceRecords: readonly SpeakerSourceRef[];
  readonly computationFingerprint: string;
}
export interface SpeakerReadinessResult {
  readonly schema: typeof SPEAKER_READINESS_SCHEMA;
  readonly fingerprintAlgorithm: typeof SPEAKER_FINGERPRINT_ALGORITHM;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly asOf: string;
  readonly locale: string;
  readonly selectionDecision: SpeakerSourceRef;
  readonly gates: readonly SpeakerGateResult[];
  readonly eligible: boolean;
  readonly computationFingerprint: string;
}
export class SpeakerReadinessInputError extends Error {
  readonly code = "INVALID_SPEAKER_READINESS_FACTS" as const;
  constructor(message = "Speaker readiness facts are invalid.") { super(message); this.name = "SpeakerReadinessInputError"; }
}

const MAX_NODES = 24000;
const MAX_DEPTH = 32;
const MAX_AGGREGATE_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_NESTED_ROWS = 12000;
const MAX_ARRAY = 4096;
const MAX_ROW = 512;
const MAX_TEXT = 512;
const HEX = /^[0-9a-f]{64}$/u;
const ID = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OWN = Object.prototype.hasOwnProperty;
const OBJECT_PROTO = Object.prototype;

function fail(message = "Speaker readiness facts are invalid."): never { throw new SpeakerReadinessInputError(message); }
function safeCall<T>(work: () => T): T { try { return work(); } catch (error) { if (error instanceof SpeakerReadinessInputError) throw error; fail(); } }
function isProxy(value: object): boolean { try { return utilTypes.isProxy(value); } catch { return fail(); } }
function preflight(input: unknown): void {
  const activePath = new WeakSet<object>(); let nodes = 0; let bytes = 0; let nestedRows = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) fail("Input nesting exceeds the finite bound.");
    if (value === null || (typeof value !== "object" && typeof value !== "function")) { if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8"); return; }
    if (isProxy(value)) fail();
    if (activePath.has(value)) fail("Cyclic input graph."); activePath.add(value); nodes += 1; if (nodes > MAX_NODES) fail("Input node bound exceeded.");
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) { if (prototype !== Array.prototype || value.length > MAX_ARRAY) fail("Invalid or oversized array."); nestedRows += value.length; if (nestedRows > MAX_AGGREGATE_NESTED_ROWS) fail("Nested row bound exceeded."); }
    else if (prototype !== OBJECT_PROTO && prototype !== null) fail("Custom prototypes are not accepted.");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail("Symbol keys are not accepted.");
      bytes += Buffer.byteLength(key, "utf8"); if (bytes > MAX_AGGREGATE_BYTES) fail("Aggregate UTF-8 byte bound exceeded.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail("Accessors and hostile getters are not accepted.");
      visit(descriptor.value, depth + 1);
    }
    activePath.delete(value);
  };
  visit(input, 0); if (bytes > MAX_AGGREGATE_BYTES) fail("Aggregate UTF-8 byte bound exceeded.");
}
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(); const r = value as Record<string, unknown>; if (Object.getPrototypeOf(r) !== OBJECT_PROTO && Object.getPrototypeOf(r) !== null) fail(); return r; }
function prop(r: Record<string, unknown>, key: string): unknown { const d = Object.getOwnPropertyDescriptor(r, key); if (!d || !("value" in d)) fail(); return d.value; }
function optional(r: Record<string, unknown>, key: string): unknown { return OWN.call(r, key) ? prop(r, key) : undefined; }
function exact(r: Record<string, unknown>, required: readonly string[], optionalKeys: readonly string[] = []): void { const allowed = new Set([...required, ...optionalKeys, ...(required.includes("decidedByAccountId") ? ["supersedesDecisionId"] : [])]); const keys = Reflect.ownKeys(r); if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) || required.some((key) => !OWN.call(r, key))) fail("Unexpected or missing input key."); }
function text(value: unknown, limit = MAX_TEXT): string { if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(); return value; }
function id(value: unknown): string { const v = text(value, 128); if (!ID.test(v)) fail(); return v; }
function hash(value: unknown): string { if (typeof value !== "string" || !HEX.test(value)) fail(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail(); return value; }
function date(value: unknown): string { const v = text(value, 24); if (!ISO.test(v) || new Date(v).toISOString() !== v) fail(); return v; }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) fail(); return value; }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== "string" || !choices.includes(value as T)) fail(); return value as T; }
function list(value: unknown, max = MAX_ARRAY): readonly unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function gates(value: unknown): readonly SpeakerGateTarget[] { const result = list(value, SPEAKER_GATE_TARGETS.length).map((v) => oneOf(v, SPEAKER_GATE_TARGETS)); if (new Set(result).size !== result.length) fail(); return result; }
function refs(value: unknown): readonly SpeakerSourceRef[] { const result = list(value, MAX_ROW).map((raw) => { const r = record(raw); exact(r, ["type", "id", "fingerprint"]); return { type: text(prop(r, "type")), id: id(prop(r, "id")), fingerprint: hash(prop(r, "fingerprint")) }; }); uniqueRefs(result); return result; }
function freeze<T>(value: T): T { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function codeUnitCompare(a: string, b: string): number { const length = Math.min(a.length, b.length); for (let i = 0; i < length; i += 1) { const delta = a.charCodeAt(i) - b.charCodeAt(i); if (delta !== 0) return delta; } return a.length - b.length; }
function refCompare(a: SpeakerSourceRef, b: SpeakerSourceRef): number { return codeUnitCompare(a.type, b.type) || codeUnitCompare(a.id, b.id) || codeUnitCompare(a.fingerprint, b.fingerprint); }
function sortedRefs(values: readonly SpeakerSourceRef[]): readonly SpeakerSourceRef[] { return [...values].sort(refCompare); }
function tupleKey(type: string, recordId: string): string { return JSON.stringify([type, recordId]); }
function uniqueRefs(values: readonly SpeakerSourceRef[]): void { const seen = new Set<string>(); for (const ref of values) { const key = tupleKey(ref.type, ref.id); if (seen.has(key)) fail("Duplicate source binding."); seen.add(key); } }
function uniqueIds(values: readonly { readonly id: string }[]): void { const seen = new Set<string>(); for (const value of values) { if (seen.has(value.id)) fail("Duplicate immutable fact."); seen.add(value.id); } }
function validateSupersession(supersededById: string | null, supersededAt: string | null, occurredAt: string): void { if ((supersededAt === null) !== (supersededById === null)) fail("Supersession identity and timestamp must be paired."); if (supersededAt !== null && Date.parse(supersededAt) <= Date.parse(occurredAt)) fail("Supersession must occur after the immutable fact."); }
function validateFindingCurrency(current: boolean, supersededById: string | null, supersededAt: string | null, occurredAt: string): void { validateSupersession(supersededById, supersededAt, occurredAt); if (current && (supersededById !== null || supersededAt !== null)) fail("Current finding cannot carry supersession metadata."); if (!current && (supersededById === null || supersededAt === null)) fail("Non-current finding requires supersession metadata."); }
function validateFindingSourceBinding(finding: SpeakerFindingFact, sourceRecords: readonly SpeakerSourceRecord[]): void { const source = sourceRecords.find((item) => item.type === "EDITORIAL" && item.id === finding.id); if (!source || source.fingerprint !== finding.fingerprint) fail("Finding is not bound to its exact authoritative editorial source."); if (source.current !== finding.current || source.supersededById !== finding.supersededById || source.supersededAt !== finding.supersededAt) fail("Finding currency does not match its authoritative editorial source."); }
function validateVerificationSourceBinding(verification: SpeakerConditionVerificationFact, sourceRecords: readonly SpeakerSourceRecord[]): void { const candidates = sourceRecords.filter((item) => item.type === "VERIFICATION" && item.id === verification.id); if (candidates.length !== 1 || candidates[0].fingerprint !== verification.fingerprint) fail("Verification is not bound to exactly one authoritative VERIFICATION source."); const source = candidates[0]; if (source.occurredAt !== verification.occurredAt) fail("Verification occurredAt does not match its authoritative source."); if (source.current !== verification.current) fail("Verification currency does not match its authoritative source."); }

function normalizeFacts(input: unknown): SpeakerReadinessFacts {
  preflight(input); const r = record(input); exact(r, ["workspaceId", "eventId", "asOf", "locale", "selection", "selectedSpeakerRoles", "applicableRequirements", "conditions", "offers", "commitments", "requirements", "findings", "schedules", "publications", "sourceRecords", "authorities"]);
  const sourceRecords = list(prop(r, "sourceRecords"), MAX_ARRAY).map((raw): SpeakerSourceRecord => { const x = record(raw); exact(x, ["type", "id", "fingerprint", "current", "supersededById", "quarantined", "occurredAt", "supersededAt"]); return { type: text(prop(x, "type")), id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), current: bool(prop(x, "current")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), quarantined: bool(prop(x, "quarantined")), occurredAt: date(prop(x, "occurredAt")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")) }; });
  const sourceKeys = new Set<string>(); for (const source of sourceRecords) { const key = tupleKey(source.type, source.id); if (sourceKeys.has(key)) fail("Duplicate source record tuple."); sourceKeys.add(key); validateSupersession(source.supersededById, source.supersededAt, source.occurredAt); }
  const authorities = list(prop(r, "authorities"), MAX_ARRAY).map((raw): SpeakerAuthorityFact => { const x = record(raw); exact(x, ["id", "fingerprint", "accountId", "allowedActions", "subjectKind", "subjectId", "subjectFingerprint", "workspaceId", "eventId", "validFrom", "validTo", "current", "supersededById", "supersededAt", "sourceRecords"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), accountId: id(prop(x, "accountId")), allowedActions: list(prop(x, "allowedActions"), 32).map((action) => text(action, 64)), subjectKind: oneOf(prop(x, "subjectKind"), ["REQUIREMENT", "CONDITION", "VERIFICATION", "DECISION", "WAIVER"]), subjectId: id(prop(x, "subjectId")), subjectFingerprint: hash(prop(x, "subjectFingerprint")), workspaceId: id(prop(x, "workspaceId")), eventId: id(prop(x, "eventId")), validFrom: date(prop(x, "validFrom")), validTo: optional(x, "validTo") === null ? null : date(prop(x, "validTo")), current: bool(prop(x, "current")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")), sourceRecords: refs(prop(x, "sourceRecords")) }; }); uniqueIds(authorities); for (const authority of authorities) validateSupersession(authority.supersededById, authority.supersededAt, authority.validFrom);
  const sel = record(prop(r, "selection")); exact(sel, ["id", "fingerprint", "status", "current", "supersededById", "occurredAt", "supersededAt"]); const selection: SpeakerSelectionFact = { id: id(prop(sel, "id")), fingerprint: hash(prop(sel, "fingerprint")), status: oneOf(prop(sel, "status"), ["SELECTED", "NOT_SELECTED", "WAITLISTED"]), current: bool(prop(sel, "current")), supersededById: optional(sel, "supersededById") === null ? null : id(prop(sel, "supersededById")), occurredAt: date(prop(sel, "occurredAt")), supersededAt: optional(sel, "supersededAt") === null ? null : date(prop(sel, "supersededAt")) }; validateSupersession(selection.supersededById, selection.supersededAt, selection.occurredAt);
  const selectedSpeakerRoles = list(prop(r, "selectedSpeakerRoles"), MAX_ARRAY).map((raw): SpeakerRoleFact => { const x = record(raw); exact(x, ["id", "fingerprint", "personId", "applicable", "sourceRecords", "occurredAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), personId: id(prop(x, "personId")), applicable: bool(prop(x, "applicable")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")) }; });
  const applicableRequirements = refs(prop(r, "applicableRequirements"));
  const conditions = list(prop(r, "conditions"), MAX_ARRAY).map((raw): SpeakerConditionFact => { const x = record(raw); exact(x, ["id", "fingerprint", "gateTargets", "waivable", "waiverScope", "transitions", "verifications", "waivers"]); const verifications = list(prop(x, "verifications"), MAX_ROW).map((vRaw): SpeakerConditionVerificationFact => { const v = record(vRaw); exact(v, ["id", "fingerprint", "conditionId", "evidenceRecords", "result", "current", "occurredAt", "verifiedByAccountId", "authorityRecords"]); return { id: id(prop(v, "id")), fingerprint: hash(prop(v, "fingerprint")), conditionId: id(prop(v, "conditionId")), evidenceRecords: refs(prop(v, "evidenceRecords")), result: oneOf(prop(v, "result"), ["SATISFIES", "DOES_NOT_SATISFY", "INCONCLUSIVE"]), current: bool(prop(v, "current")), occurredAt: date(prop(v, "occurredAt")), verifiedByAccountId: id(prop(v, "verifiedByAccountId")), authorityRecords: refs(prop(v, "authorityRecords")) }; }); const waivers = list(prop(x, "waivers"), MAX_ROW).map((wRaw): SpeakerConditionWaiverFact => { const w = record(wRaw); exact(w, ["id", "fingerprint", "conditionId", "scope", "reason", "actorId", "current", "sourceRecords", "occurredAt", "authorityRecords"]); return { id: id(prop(w, "id")), fingerprint: hash(prop(w, "fingerprint")), conditionId: id(prop(w, "conditionId")), scope: gates(prop(w, "scope")), reason: text(prop(w, "reason")), actorId: id(prop(w, "actorId")), current: bool(prop(w, "current")), sourceRecords: refs(prop(w, "sourceRecords")), occurredAt: date(prop(w, "occurredAt")), authorityRecords: refs(prop(w, "authorityRecords")) }; }); const transitions = list(prop(x, "transitions"), MAX_ROW).map((tRaw): SpeakerConditionTransitionFact => { const t = record(tRaw); exact(t, ["id", "sequence", "toState", "verificationId", "sourceRecords", "occurredAt"]); return { id: id(prop(t, "id")), sequence: integer(prop(t, "sequence")), toState: oneOf(prop(t, "toState"), ["OPEN", "EVIDENCE_SUBMITTED", "SATISFIED", "WAIVED", "EXPIRED", "REVOKED"]), verificationId: optional(t, "verificationId") === null ? null : id(prop(t, "verificationId")), sourceRecords: refs(prop(t, "sourceRecords")), occurredAt: date(prop(t, "occurredAt")) }; }); const orderedTransitions = [...transitions].sort((a, b) => a.sequence - b.sequence); if (orderedTransitions.length < 1 || orderedTransitions.some((v, i) => v.sequence !== i + 1) || orderedTransitions[0].toState !== "OPEN") fail("Condition transition sequence or initial state is invalid."); const legal: Record<SpeakerConditionState, readonly SpeakerConditionState[]> = { OPEN: ["OPEN", "EVIDENCE_SUBMITTED", "SATISFIED", "WAIVED", "EXPIRED", "REVOKED"], EVIDENCE_SUBMITTED: ["EVIDENCE_SUBMITTED", "SATISFIED", "WAIVED", "EXPIRED", "REVOKED"], SATISFIED: ["EVIDENCE_SUBMITTED", "REVOKED"], WAIVED: ["EVIDENCE_SUBMITTED", "REVOKED"], EXPIRED: ["OPEN", "EVIDENCE_SUBMITTED", "REVOKED"], REVOKED: [] }; for (let index = 1; index < orderedTransitions.length; index += 1) if (!legal[orderedTransitions[index - 1].toState].includes(orderedTransitions[index].toState)) fail("Illegal condition transition."); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), gateTargets: gates(prop(x, "gateTargets")), waivable: bool(prop(x, "waivable")), waiverScope: gates(prop(x, "waiverScope")), transitions: orderedTransitions, verifications, waivers }; });
  const offers = list(prop(r, "offers"), MAX_ARRAY).map((raw): SpeakerOfferFact => { const x = record(raw); exact(x, ["id", "fingerprint", "selectionDecisionId", "selectionDecisionFingerprint", "personId", "speakerRoleId", "termsFingerprint", "current", "sourceRecords", "occurredAt", "supersededById", "supersededAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), selectionDecisionId: id(prop(x, "selectionDecisionId")), selectionDecisionFingerprint: hash(prop(x, "selectionDecisionFingerprint")), personId: id(prop(x, "personId")), speakerRoleId: id(prop(x, "speakerRoleId")), termsFingerprint: hash(prop(x, "termsFingerprint")), current: bool(prop(x, "current")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")) }; }); for (const offer of offers) validateSupersession(offer.supersededById, offer.supersededAt, offer.occurredAt);
  const commitments = list(prop(r, "commitments"), MAX_ARRAY).map((raw): SpeakerCommitmentFact => { const x = record(raw); exact(x, ["id", "fingerprint", "offerId", "offerFingerprint", "state", "current", "sourceRecords", "occurredAt", "supersededById", "supersededAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), offerId: id(prop(x, "offerId")), offerFingerprint: hash(prop(x, "offerFingerprint")), state: oneOf(prop(x, "state"), ["ACCEPTED", "DECLINED", "PENDING", "REVOKED"]), current: bool(prop(x, "current")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")) }; }); for (const commitment of commitments) validateSupersession(commitment.supersededById, commitment.supersededAt, commitment.occurredAt);
  const requirements = list(prop(r, "requirements"), MAX_ARRAY).map((raw): SpeakerRequirementFact => { const x = record(raw); exact(x, ["id", "fingerprint", "gateTargets", "required", "waivable", "submissions", "decisions", "waivers", "sourceRecords", "occurredAt"]); const requirementId = id(prop(x, "id")); const submissions = list(prop(x, "submissions"), MAX_ROW).map((sRaw): SpeakerSubmissionFact => { const s = record(sRaw); exact(s, ["id", "fingerprint", "requirementId", "version", "supersedesSubmissionId", "kind", "sourceRecords", "current", "quarantined", "occurredAt"]); const boundRequirementId = id(prop(s, "requirementId")); if (boundRequirementId !== requirementId) fail("Submission is bound to another requirement."); return { id: id(prop(s, "id")), fingerprint: hash(prop(s, "fingerprint")), requirementId: boundRequirementId, version: integer(prop(s, "version")), supersedesSubmissionId: optional(s, "supersedesSubmissionId") === null ? null : id(prop(s, "supersedesSubmissionId")), kind: oneOf(prop(s, "kind"), ["ARTIFACT", "PROFILE_SNAPSHOT", "FORM_RESPONSE", "PROGRAM_UNIT_VERSION", "ACKNOWLEDGEMENT", "EXTERNAL_REFERENCE", "MANUAL_EVIDENCE"]), sourceRecords: refs(prop(s, "sourceRecords")), current: bool(prop(s, "current")), quarantined: bool(prop(s, "quarantined")), occurredAt: date(prop(s, "occurredAt")) }; }); const decisions = list(prop(x, "decisions"), MAX_ROW).map((dRaw): SpeakerRequirementDecisionFact => { const d = record(dRaw); exact(d, ["id", "fingerprint", "requirementId", "kind", "submissionId", "current", "sourceRecords", "occurredAt", "decidedByAccountId", "authorityRecords"]); const boundRequirementId = id(prop(d, "requirementId")); if (boundRequirementId !== requirementId) fail("Decision is bound to another requirement."); return { id: id(prop(d, "id")), fingerprint: hash(prop(d, "fingerprint")), requirementId: boundRequirementId, kind: oneOf(prop(d, "kind"), ["APPROVE_VERSION", "REJECT_VERSION", "REVOKE_DECISION"]), submissionId: optional(d, "submissionId") === null ? null : id(prop(d, "submissionId")), current: bool(prop(d, "current")), sourceRecords: refs(prop(d, "sourceRecords")), occurredAt: date(prop(d, "occurredAt")), decidedByAccountId: id(prop(d, "decidedByAccountId")), authorityRecords: refs(prop(d, "authorityRecords")) }; }); const waivers = list(prop(x, "waivers"), MAX_ROW).map((wRaw): SpeakerRequirementWaiverFact => { const w = record(wRaw); exact(w, ["id", "fingerprint", "requirementId", "scope", "reason", "actorId", "current", "sourceRecords", "occurredAt", "authorityRecords"]); const boundRequirementId = id(prop(w, "requirementId")); if (boundRequirementId !== requirementId) fail("Waiver is bound to another requirement."); return { id: id(prop(w, "id")), fingerprint: hash(prop(w, "fingerprint")), requirementId: boundRequirementId, scope: gates(prop(w, "scope")), reason: text(prop(w, "reason")), actorId: id(prop(w, "actorId")), current: bool(prop(w, "current")), sourceRecords: refs(prop(w, "sourceRecords")), occurredAt: date(prop(w, "occurredAt")), authorityRecords: refs(prop(w, "authorityRecords")) }; }); return { id: requirementId, fingerprint: hash(prop(x, "fingerprint")), gateTargets: gates(prop(x, "gateTargets")), required: bool(prop(x, "required")), waivable: bool(prop(x, "waivable")), submissions, decisions, waivers, sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")) }; });
  for (const rawRequirement of list(prop(r, "requirements"), MAX_ARRAY)) { const raw = record(rawRequirement); const normalized = requirements.find((item) => item.id === id(prop(raw, "id"))); if (!normalized) fail("Requirement decision container is invalid."); const mutableDecisions = normalized.decisions as SpeakerRequirementDecisionFact[]; for (const rawDecision of list(prop(raw, "decisions"), MAX_ROW)) { const sourceDecision = record(rawDecision); const normalizedDecision = mutableDecisions.find((item) => item.id === id(prop(sourceDecision, "id"))); if (!normalizedDecision) fail("Requirement decision is not normalized."); const link = optional(sourceDecision, "supersedesDecisionId"); (normalizedDecision as SpeakerRequirementDecisionFact & { supersedesDecisionId: string | null }).supersedesDecisionId = link === undefined || link === null ? null : id(link); } }
  const requestedAsOf = date(prop(r, "asOf")); for (const requirement of requirements) { const decisionsByTime = new Set<string>(); for (const decision of requirement.decisions.filter((item) => Date.parse(item.occurredAt) <= Date.parse(requestedAsOf))) { if (decisionsByTime.has(decision.occurredAt)) fail("Requirement decisions conflict."); decisionsByTime.add(decision.occurredAt); } }
  const findings = list(prop(r, "findings"), MAX_ARRAY).map((raw): SpeakerFindingFact => { const x = record(raw); exact(x, ["id", "fingerprint", "requirementId", "submissionId", "submissionFingerprint", "severity", "blocksGateTargets", "current", "supersededById", "supersededAt", "sourceRecords", "occurredAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), requirementId: id(prop(x, "requirementId")), submissionId: id(prop(x, "submissionId")), submissionFingerprint: hash(prop(x, "submissionFingerprint")), severity: oneOf(prop(x, "severity"), ["INFO", "WARNING", "BLOCKER", "CRITICAL"]), blocksGateTargets: gates(prop(x, "blocksGateTargets")), current: bool(prop(x, "current")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")) }; });
  for (const condition of conditions) for (const verification of condition.verifications) validateVerificationSourceBinding(verification, sourceRecords);
  for (const finding of findings) { validateFindingSourceBinding(finding, sourceRecords); validateFindingCurrency(finding.current, finding.supersededById, finding.supersededAt, finding.occurredAt); const requirement = requirements.find((item) => item.id === finding.requirementId); if (!requirement || !requirement.submissions.some((submission) => submission.id === finding.submissionId && submission.fingerprint === finding.submissionFingerprint)) fail("Finding is not bound to an exact containing requirement submission."); }
  const schedules = list(prop(r, "schedules"), MAX_ARRAY).map((raw): SpeakerScheduleFact => { const x = record(raw); exact(x, ["id", "fingerprint", "speakerRoleId", "state", "current", "sourceRecords", "occurredAt", "supersededById", "supersededAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), speakerRoleId: id(prop(x, "speakerRoleId")), state: oneOf(prop(x, "state"), ["APPROVED", "PENDING", "REJECTED"]), current: bool(prop(x, "current")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")) }; }); for (const schedule of schedules) validateSupersession(schedule.supersededById, schedule.supersededAt, schedule.occurredAt);
  const publications = list(prop(r, "publications"), MAX_ARRAY).map((raw): SpeakerPublicationFact => { const x = record(raw); exact(x, ["id", "fingerprint", "speakerRoleId", "state", "current", "sourceRecords", "occurredAt", "supersededById", "supersededAt"]); return { id: id(prop(x, "id")), fingerprint: hash(prop(x, "fingerprint")), speakerRoleId: id(prop(x, "speakerRoleId")), state: oneOf(prop(x, "state"), ["APPROVED", "PENDING", "REJECTED"]), current: bool(prop(x, "current")), sourceRecords: refs(prop(x, "sourceRecords")), occurredAt: date(prop(x, "occurredAt")), supersededById: optional(x, "supersededById") === null ? null : id(prop(x, "supersededById")), supersededAt: optional(x, "supersededAt") === null ? null : date(prop(x, "supersededAt")) }; }); for (const publication of publications) validateSupersession(publication.supersededById, publication.supersededAt, publication.occurredAt);
  uniqueIds(selectedSpeakerRoles); uniqueIds(conditions); uniqueIds(offers); uniqueIds(commitments); uniqueIds(requirements); uniqueIds(findings); uniqueIds(schedules); uniqueIds(publications); for (const condition of conditions) { uniqueIds(condition.transitions); uniqueIds(condition.verifications); uniqueIds(condition.waivers); } for (const requirement of requirements) { uniqueIds(requirement.submissions); uniqueIds(requirement.decisions); uniqueIds(requirement.waivers); }
  const arrays = [selectedSpeakerRoles, conditions, offers, commitments, requirements, findings, schedules, publications]; if (arrays.reduce((sum, values) => sum + values.length, 0) > MAX_AGGREGATE_NESTED_ROWS) fail("Aggregate nested row bound exceeded.");
  const locale = text(prop(r, "locale"), 64); if (!/^[A-Za-z0-9_-]{2,64}$/u.test(locale)) fail("Locale is invalid."); if (applicableRequirements.some((item) => item.type !== "REQUIREMENT")) fail("Non-requirement inventory item cannot bypass readiness.");
  return { workspaceId: id(prop(r, "workspaceId")), eventId: id(prop(r, "eventId")), asOf: date(prop(r, "asOf")), locale, selection, selectedSpeakerRoles, applicableRequirements, conditions, offers, commitments, requirements, findings, schedules, publications, sourceRecords, authorities };
}

export function evaluateSpeakerReadiness(input: unknown): SpeakerReadinessResult {
  const facts = safeCall(() => normalizeFacts(input)); const asOf = Date.parse(facts.asOf);
  const sourceMap = new Map(facts.sourceRecords.map((source) => [tupleKey(source.type, source.id), source]));
  const selectionRef: SpeakerSourceRef = { type: "SELECTION", id: facts.selection.id, fingerprint: facts.selection.fingerprint };
  const sourceOk = (ref: SpeakerSourceRef): boolean => { const source = sourceMap.get(tupleKey(ref.type, ref.id)); const paired = !!source && ((source.supersededAt === null) === (source.supersededById === null)); const beforeSupersession = !!source && (source.supersededAt === null || asOf < Date.parse(source.supersededAt)); const historicallyCurrent = !!source && (source.current || (source.supersededAt !== null && asOf < Date.parse(source.supersededAt))); const linkValidAtRead = !!source && (source.supersededById === null || beforeSupersession); return !!source && paired && source.fingerprint === ref.fingerprint && historicallyCurrent && linkValidAtRead && !source.quarantined && Date.parse(source.occurredAt) <= asOf && beforeSupersession; };
  const sourceHistoricalAt = (ref: SpeakerSourceRef, instant: string): boolean => { const source = sourceMap.get(tupleKey(ref.type, ref.id)); const time = Date.parse(instant); const paired = !!source && ((source.supersededAt === null) === (source.supersededById === null)); const beforeSupersession = !!source && (source.supersededAt === null || time < Date.parse(source.supersededAt)); const historicallyCurrent = !!source && (source.current || (source.supersededAt !== null && time < Date.parse(source.supersededAt))); return !!source && paired && source.fingerprint === ref.fingerprint && beforeSupersession && historicallyCurrent && (source.supersededById === null || beforeSupersession) && !source.quarantined && Date.parse(source.occurredAt) <= time; };
  const verificationSource = (verification: SpeakerConditionVerificationFact): SpeakerSourceRecord => { const source = sourceMap.get(tupleKey("VERIFICATION", verification.id)); if (!source || source.fingerprint !== verification.fingerprint || source.occurredAt !== verification.occurredAt || source.current !== verification.current) fail("Verification is not reconciled with its authoritative source."); return source; };
  const verificationRef = (verification: SpeakerConditionVerificationFact): SpeakerSourceRef => ({ type: "VERIFICATION", id: verification.id, fingerprint: verification.fingerprint });
  const verificationCurrentAt = (verification: SpeakerConditionVerificationFact): boolean => sourceHistoricalAt(verificationRef(verification), facts.asOf);
  const requireSources = (values: readonly SpeakerSourceRef[], truth: SpeakerTruthKind): SpeakerBlocker | null => { const byKey = new Map<string, SpeakerSourceRef>(); for (const ref of values) { const key = tupleKey(ref.type, ref.id); const prior = byKey.get(key); if (prior && prior.fingerprint !== ref.fingerprint) fail("Conflicting source binding."); byKey.set(key, ref); } const unique = [...byKey.values()]; const bad = unique.filter((ref) => ref.type !== "AUTHORITY" && !sourceOk(ref)); return bad.length === 0 ? null : { code: "SOURCE_INVALID", truth, sourceRecords: sortedRefs(bad), detail: "An authoritative source binding is missing, forged, stale, superseded, quarantined, or after asOf." }; };
  const signerBound = (accountId: string, authorityRecords: readonly SpeakerSourceRef[]): boolean => authorityRecords.some((ref) => ref.type === "AUTHORITY" && facts.authorities.some((authority) => authority.id === ref.id && authority.accountId === accountId && authority.fingerprint === ref.fingerprint));
  const authorityValid = (authorityRecords: readonly SpeakerSourceRef[], action: string, subjectKind: SpeakerAuthorityFact["subjectKind"], subjectId: string, subjectFingerprint: string, occurredAt: string): SpeakerAuthorityFact | null => { const candidates = authorityRecords.filter((ref) => ref.type === "AUTHORITY").map((ref) => facts.authorities.find((authority) => authority.id === ref.id && authority.fingerprint === ref.fingerprint)).filter((authority): authority is SpeakerAuthorityFact => !!authority).filter((authority) => authority.allowedActions.includes(action) && authority.subjectKind === subjectKind && authority.subjectId === subjectId && authority.subjectFingerprint === subjectFingerprint && authority.workspaceId === facts.workspaceId && authority.eventId === facts.eventId && Date.parse(authority.validFrom) <= Date.parse(occurredAt) && (authority.validTo === null || Date.parse(occurredAt) < Date.parse(authority.validTo)) && (authority.supersededAt === null || Date.parse(occurredAt) < Date.parse(authority.supersededAt)) && (authority.current || (authority.supersededAt !== null && Date.parse(occurredAt) < Date.parse(authority.supersededAt)))); if (candidates.length !== 1) return null; const authority = candidates[0]; const authorityRef: SpeakerSourceRef = { type: "AUTHORITY", id: authority.id, fingerprint: authority.fingerprint }; return [authorityRef, ...authority.sourceRecords].every((ref) => sourceHistoricalAt(ref, occurredAt)) ? authority : null; };
  const active = (occurredAt: string): boolean => Date.parse(occurredAt) <= asOf;
  const currentAt = (record: { readonly current: boolean; readonly supersededById: string | null; readonly supersededAt: string | null; readonly occurredAt: string }): boolean => active(record.occurredAt) && (record.current || (record.supersededAt !== null && asOf < Date.parse(record.supersededAt))) && (record.supersededById === null || (record.supersededAt !== null && asOf < Date.parse(record.supersededAt)));
  const findingCurrentAt = (finding: SpeakerFindingFact): boolean => active(finding.occurredAt) && (finding.supersededAt === null || asOf < Date.parse(finding.supersededAt));
  const roles = facts.selectedSpeakerRoles.filter((role) => role.applicable && active(role.occurredAt));
  const currentSubmissionIds = new Set<string>();
  const roleRef = (role: SpeakerRoleFact): SpeakerSourceRef => ({ type: "ROLE", id: role.id, fingerprint: role.fingerprint });
  const currentSubmission = (requirement: SpeakerRequirementFact): SpeakerSubmissionFact | null => { const rows = [...requirement.submissions].filter((row) => active(row.occurredAt)).sort((a, b) => a.version - b.version || codeUnitCompare(a.id, b.id)); if (rows.length === 0) return null; if (rows.some((row, index) => index > 0 && row.version === rows[index - 1].version)) fail("Duplicate submission version."); if (rows[0].version !== 1 || rows[0].supersedesSubmissionId !== null) fail("Submission history lacks a version-one root."); for (let index = 1; index < rows.length; index += 1) if (rows[index].version !== index + 1 || rows[index].supersedesSubmissionId !== rows[index - 1].id) fail("Submission supersession chain is invalid."); return rows[rows.length - 1]; };
  for (const requirement of facts.requirements) { const current = currentSubmission(requirement); if (current) currentSubmissionIds.add(current.id); }
  for (const requirement of facts.requirements) {
    const chain = [...requirement.decisions].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || codeUnitCompare(a.id, b.id));
    const history = chain.filter((item) => active(item.occurredAt));
    for (let index = 0; index < history.length; index += 1) {
      const decision = history[index];
      const prior = index === 0 ? null : history[index - 1];
      const supersedes = decision.supersedesDecisionId ?? null;
      if (index === 0) { if (supersedes !== null) fail("Requirement decision root cannot supersede another decision."); }
      else {
        if (supersedes === null || !prior || supersedes !== prior.id || Date.parse(decision.occurredAt) <= Date.parse(prior.occurredAt)) fail("Requirement decision chain identity is invalid.");
        if (decision.kind === "REVOKE_DECISION" && (prior.kind !== "APPROVE_VERSION" || decision.submissionId !== prior.submissionId)) fail("Requirement revoke does not supersede the compatible approval.");
        if (decision.kind === "APPROVE_VERSION" && (prior.kind !== "REVOKE_DECISION" || decision.submissionId !== prior.submissionId)) fail("Requirement reapproval does not supersede the compatible revoke.");
        if (decision.kind === "REJECT_VERSION" && (prior.kind !== "APPROVE_VERSION" || decision.submissionId !== prior.submissionId)) fail("Requirement rejection does not supersede the compatible approval.");
      }
    }
    let state: "NONE" | "APPROVED" | "REJECTED" | "REVOKED" = "NONE";
    let effective: SpeakerRequirementDecisionFact | null = null;
    for (const decision of history) {
      const action = decision.kind === "APPROVE_VERSION" ? "APPROVE_REQUIREMENT" : decision.kind === "REVOKE_DECISION" ? "REVOKE_REQUIREMENT" : "REJECT_REQUIREMENT";
      const authority = authorityValid(decision.authorityRecords, action, "DECISION", decision.id, decision.fingerprint, decision.occurredAt);
      if (!authority || authority.accountId !== decision.decidedByAccountId) fail("Requirement decision signer is not bound to exact authority.");
      if (decision.kind === "REVOKE_DECISION") { if (state !== "APPROVED") fail("Requirement decision chain is not legal."); state = "REVOKED"; effective = null; }
      else if (decision.kind === "APPROVE_VERSION") { state = "APPROVED"; effective = decision; }
      else { state = "REJECTED"; effective = null; }
    }
    const mutable = requirement as SpeakerRequirementFact & { decisions: SpeakerRequirementDecisionFact[]; sourceRecords: SpeakerSourceRef[] };
    mutable.decisions = effective ? [effective] : [];
    const historyRefs = history.flatMap((decision) => [{ type: "REQUIREMENT_DECISION" as const, id: decision.id, fingerprint: decision.fingerprint }, ...decision.sourceRecords, ...decision.authorityRecords]);
    mutable.sourceRecords = [...mutable.sourceRecords, ...historyRefs];
  }
  for (const condition of facts.conditions) { for (const verification of condition.verifications.filter((item) => active(item.occurredAt))) { const source = verificationSource(verification); const authority = sourceHistoricalAt(verificationRef(verification), source.occurredAt) ? authorityValid(verification.authorityRecords, "VERIFY_CONDITION", "VERIFICATION", verification.id, verification.fingerprint, source.occurredAt) : null; if (!authority || authority.accountId !== verification.verifiedByAccountId) fail("Verification signer is not bound to exact authority at verification occurrence."); } for (const waiver of condition.waivers.filter((item) => item.current && active(item.occurredAt))) { const authority = authorityValid(waiver.authorityRecords, "WAIVE_CONDITION", "WAIVER", waiver.id, waiver.fingerprint, waiver.occurredAt); if (!authority || authority.accountId !== waiver.actorId) fail("Condition waiver signer is not bound to exact authority."); } }
  for (const requirement of facts.requirements) { for (const decision of requirement.decisions.filter((item) => active(item.occurredAt))) { const action = decision.kind === "APPROVE_VERSION" ? "APPROVE_REQUIREMENT" : decision.kind === "REVOKE_DECISION" ? "REVOKE_REQUIREMENT" : "REJECT_REQUIREMENT"; if (!authorityValid(decision.authorityRecords, action, "DECISION", decision.id, decision.fingerprint, decision.occurredAt)) fail("Requirement decision authority is not exact, applicable, or valid at asOf."); } for (const waiver of requirement.waivers.filter((item) => item.current && active(item.occurredAt))) { const authority = authorityValid(waiver.authorityRecords, "WAIVE_REQUIREMENT", "WAIVER", waiver.id, waiver.fingerprint, waiver.occurredAt); if (!authority || authority.accountId !== waiver.actorId) fail("Requirement waiver signer is not bound to exact authority."); } }
  const gatesResult = SPEAKER_GATE_TARGETS.map((gate): SpeakerGateResult => {
    const blockers: SpeakerBlocker[] = []; const waivers: SpeakerSourceRef[] = []; const evidence: SpeakerSourceRef[] = [selectionRef];
    const selectionSource = requireSources([selectionRef], "SELECTION"); if (selectionSource) blockers.push(selectionSource); if (facts.selection.status !== "SELECTED" || !currentAt(facts.selection)) blockers.push({ code: "SELECTION_NOT_CURRENT", truth: "SELECTION", sourceRecords: [selectionRef], detail: "The authoritative selection is not current SELECTED at asOf." });
    for (const role of roles) { evidence.push(roleRef(role)); const invalidRole = requireSources([...role.sourceRecords, roleRef(role)], "ROLE"); if (invalidRole) blockers.push(invalidRole); }
    for (const condition of facts.conditions.filter((item) => item.gateTargets.includes(gate) && item.transitions.some((transition) => active(transition.occurredAt)))) {
      const transitions = [...condition.transitions].filter((transition) => active(transition.occurredAt)).sort((a, b) => a.sequence - b.sequence); if (transitions.length < 1 || transitions.some((transition, index) => transition.sequence !== index + 1)) fail("Condition history is empty or has a sequence gap."); const current = transitions[transitions.length - 1]; const conditionRef: SpeakerSourceRef = { type: "CONDITION", id: condition.id, fingerprint: condition.fingerprint }; evidence.push(conditionRef, ...current.sourceRecords); const bad = requireSources([conditionRef, ...current.sourceRecords], "CONDITION"); if (bad) blockers.push(bad);
      if (current.toState === "SATISFIED") { const verification = current.verificationId && condition.verifications.find((item) => item.id === current.verificationId && active(item.occurredAt)); const source = verification && verificationSource(verification); const authority = verification && source && verificationCurrentAt(verification) ? authorityValid(verification.authorityRecords, "VERIFY_CONDITION", "VERIFICATION", verification.id, verification.fingerprint, source.occurredAt) : null; if (!verification || !source || verification.result !== "SATISFIES" || verification.conditionId !== condition.id || !verificationCurrentAt(verification) || !authority || Date.parse(source.occurredAt) > Date.parse(current.occurredAt)) blockers.push({ code: "CONDITION_NOT_SATISFIED", truth: "VERIFICATION", sourceRecords: [conditionRef], detail: "SATISFIED requires a chronologically valid exact-condition current SATISFIES verification and real signer authority." }); else { const verificationSourceRef = verificationRef(verification); evidence.push(verificationSourceRef, ...verification.evidenceRecords, ...verification.authorityRecords); const badVerification = requireSources([verificationSourceRef, ...verification.evidenceRecords, ...verification.authorityRecords], "VERIFICATION"); if (badVerification) blockers.push(badVerification); } }
      else if (current.toState === "WAIVED" && condition.waivable && condition.waiverScope.includes(gate)) { const waiverRows = condition.waivers.filter((waiver) => waiver.current && active(waiver.occurredAt) && waiver.conditionId === condition.id && waiver.scope.includes(gate)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || codeUnitCompare(b.id, a.id)); if (waiverRows.length !== 1) blockers.push({ code: "CONDITION_NOT_SATISFIED", truth: "REQUIREMENT_WAIVER", sourceRecords: [conditionRef], detail: "A waived condition requires one current scoped waiver authority." }); else { const waiver = waiverRows[0]; const waiverRef: SpeakerSourceRef = { type: "REQUIREMENT_WAIVER", id: waiver.id, fingerprint: waiver.fingerprint }; evidence.push(waiverRef, ...waiver.sourceRecords, ...waiver.authorityRecords); const badWaiver = requireSources([waiverRef, ...waiver.sourceRecords, ...waiver.authorityRecords], "REQUIREMENT_WAIVER"); const authority = authorityValid(waiver.authorityRecords, "WAIVE_CONDITION", "WAIVER", waiver.id, waiver.fingerprint, waiver.occurredAt); if (badWaiver || !authority || authority.accountId !== waiver.actorId) blockers.push(badWaiver ?? { code: "SOURCE_INVALID", truth: "REQUIREMENT_WAIVER", sourceRecords: [waiverRef], detail: "Condition waiver signer is not bound to real authority." }); else waivers.push(waiverRef); } } else blockers.push({ code: "CONDITION_NOT_SATISFIED", truth: "CONDITION", sourceRecords: [conditionRef], detail: `Condition is ${current.toState}, not satisfied or explicitly scoped as waived.` });
    }
    if (gate !== "OFFER" && roles.length === 0) blockers.push({ code: "COMMITMENT_NOT_ACCEPTED", truth: "ROLE", sourceRecords: [selectionRef], detail: "No applicable selected speaker role is available for commitment evaluation." });
    const offersForRole = (role: SpeakerRoleFact): SpeakerOfferFact[] => facts.offers.filter((offer) => currentAt(offer) && offer.speakerRoleId === role.id && offer.personId === role.personId && offer.selectionDecisionId === facts.selection.id && offer.selectionDecisionFingerprint === facts.selection.fingerprint);
    if (gate !== "OFFER") for (const role of roles) { const offersForThisRole = offersForRole(role); if (offersForThisRole.length !== 1) { blockers.push({ code: "OFFER_MISSING", truth: "OFFER", sourceRecords: [roleRef(role)], detail: "Every applicable selected speaker role requires exactly one current exact offer." }); continue; } const offer = offersForThisRole[0]; const offerRef: SpeakerSourceRef = { type: "OFFER", id: offer.id, fingerprint: offer.fingerprint }; evidence.push(offerRef, ...offer.sourceRecords); const badOffer = requireSources([offerRef, ...offer.sourceRecords], "OFFER"); if (badOffer) blockers.push(badOffer); const commitment = facts.commitments.filter((item) => currentAt(item) && item.offerId === offer.id && item.offerFingerprint === offer.fingerprint); if (commitment.length !== 1 || commitment[0].state !== "ACCEPTED") blockers.push({ code: "COMMITMENT_NOT_ACCEPTED", truth: "COMMITMENT", sourceRecords: [offerRef], detail: "Every applicable selected speaker role requires one current accepted exact commitment." }); else { const commitmentRef: SpeakerSourceRef = { type: "COMMITMENT", id: commitment[0].id, fingerprint: commitment[0].fingerprint }; evidence.push(commitmentRef, ...commitment[0].sourceRecords); const badCommitment = requireSources([commitmentRef, ...commitment[0].sourceRecords], "COMMITMENT"); if (badCommitment) blockers.push(badCommitment); } }
    for (const requirementRef of facts.applicableRequirements.filter((ref) => ref.type === "REQUIREMENT")) { const requirement = facts.requirements.find((item) => item.id === requirementRef.id && item.fingerprint === requirementRef.fingerprint); if (!requirement) { blockers.push({ code: "REQUIREMENT_NOT_READY", truth: "REQUIREMENT", sourceRecords: [requirementRef], detail: "Applicable requirement inventory does not resolve exactly." }); continue; } if (!requirement.required || !requirement.gateTargets.includes(gate)) continue; evidence.push(requirementRef, ...requirement.sourceRecords); const badRequirement = requireSources([requirementRef, ...requirement.sourceRecords], "REQUIREMENT"); if (badRequirement) blockers.push(badRequirement); const current = currentSubmission(requirement); const currentFact = current; const currentRef = currentFact ? { type: "SUBMISSION" as const, id: currentFact.id, fingerprint: currentFact.fingerprint } : null; if (currentFact && currentRef) { evidence.push(currentRef, ...currentFact.sourceRecords); const badSubmission = requireSources([currentRef, ...currentFact.sourceRecords], "SUBMISSION"); if (badSubmission || currentFact.quarantined) blockers.push(badSubmission ?? { code: "SOURCE_INVALID", truth: "SUBMISSION", sourceRecords: [currentRef], detail: "Current submission is quarantined." }); }
      const decisions = requirement.decisions.filter((decision) => active(decision.occurredAt)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || codeUnitCompare(b.id, a.id)); const waiverRows = requirement.waivers.filter((waiver) => waiver.current && active(waiver.occurredAt) && waiver.requirementId === requirement.id && waiver.scope.includes(gate)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || codeUnitCompare(b.id, a.id)); if (waiverRows.length > 1 && Date.parse(waiverRows[0].occurredAt) === Date.parse(waiverRows[1].occurredAt)) fail("Requirement waivers conflict."); const waiver = waiverRows[0]; if (waiver) { const authority = authorityValid(waiver.authorityRecords, "WAIVE_REQUIREMENT", "WAIVER", waiver.id, waiver.fingerprint, waiver.occurredAt); if (!requirement.waivable || waiver.reason.length === 0 || waiver.actorId.length === 0 || !authority || authority.accountId !== waiver.actorId) fail("Invalid waiver authority."); const waiverRef: SpeakerSourceRef = { type: "REQUIREMENT_WAIVER", id: waiver.id, fingerprint: waiver.fingerprint }; evidence.push(waiverRef, ...waiver.sourceRecords, ...waiver.authorityRecords); const badWaiver = requireSources([waiverRef, ...waiver.sourceRecords, ...waiver.authorityRecords], "REQUIREMENT_WAIVER"); if (badWaiver) blockers.push(badWaiver); else waivers.push(waiverRef); } else if (!currentRef || decisions.length !== 1 || decisions[0].requirementId !== requirement.id || decisions[0].kind !== "APPROVE_VERSION" || !signerBound(decisions[0].decidedByAccountId, decisions[0].authorityRecords) || decisions[0].submissionId !== currentRef.id || Date.parse(decisions[0].occurredAt) < Date.parse(currentFact?.occurredAt ?? requirement.occurredAt)) blockers.push({ code: currentRef ? "CURRENT_VERSION_NOT_APPROVED" : "REQUIREMENT_NOT_READY", truth: "REQUIREMENT_DECISION", sourceRecords: [requirementRef, ...(currentRef ? [currentRef] : [])], detail: "The exact current submission requires one current chronological approval or scoped waiver." }); else { const decision = decisions[0]; const decisionRef: SpeakerSourceRef = { type: "REQUIREMENT_DECISION", id: decision.id, fingerprint: decision.fingerprint }; evidence.push(decisionRef, ...decision.sourceRecords, ...decision.authorityRecords); const badDecision = requireSources([decisionRef, ...decision.sourceRecords, ...decision.authorityRecords], "REQUIREMENT_DECISION"); if (badDecision) blockers.push(badDecision); }
    }
    if (gate === "SCHEDULING" || gate === "PUBLICATION" || gate === "OPERATOR_RELEASE") for (const role of roles) { const rows = facts.schedules.filter((item) => currentAt(item) && item.speakerRoleId === role.id); if (rows.length !== 1 || rows[0].state !== "APPROVED") blockers.push({ code: "SCHEDULE_NOT_APPROVED", truth: "SCHEDULE", sourceRecords: [roleRef(role)], detail: "Every applicable role requires one current approved schedule fact." }); else { const scheduleRef: SpeakerSourceRef = { type: "SCHEDULE", id: rows[0].id, fingerprint: rows[0].fingerprint }; evidence.push(scheduleRef, ...rows[0].sourceRecords); const badSchedule = requireSources([scheduleRef, ...rows[0].sourceRecords], "SCHEDULE"); if (badSchedule) blockers.push(badSchedule); } }
    if (gate === "PUBLICATION" || gate === "OPERATOR_RELEASE") for (const role of roles) { const rows = facts.publications.filter((item) => currentAt(item) && item.speakerRoleId === role.id); if (rows.length !== 1 || rows[0].state !== "APPROVED") blockers.push({ code: "PUBLICATION_NOT_APPROVED", truth: "PUBLICATION", sourceRecords: [roleRef(role)], detail: "Every applicable role requires one current approved publication fact." }); else { const publicationRef: SpeakerSourceRef = { type: "PUBLICATION", id: rows[0].id, fingerprint: rows[0].fingerprint }; evidence.push(publicationRef, ...rows[0].sourceRecords); const badPublication = requireSources([publicationRef, ...rows[0].sourceRecords], "PUBLICATION"); if (badPublication) blockers.push(badPublication); } }
    for (const finding of facts.findings.filter((item) => findingCurrentAt(item) && currentSubmissionIds.has(item.submissionId) && item.blocksGateTargets.includes(gate) && (item.severity === "BLOCKER" || item.severity === "CRITICAL"))) { const findingRef: SpeakerSourceRef = { type: "EDITORIAL", id: finding.id, fingerprint: finding.fingerprint }; const submissionRef: SpeakerSourceRef = { type: "SUBMISSION", id: finding.submissionId, fingerprint: finding.submissionFingerprint }; evidence.push(findingRef, submissionRef, ...finding.sourceRecords); const badFinding = requireSources([findingRef, submissionRef, ...finding.sourceRecords], "EDITORIAL"); if (badFinding) blockers.push(badFinding); else blockers.push({ code: "CURRENT_BLOCKER_FINDING", truth: "EDITORIAL", sourceRecords: [findingRef, submissionRef], detail: `A blocker finding is current at asOf.` }); }
    const uniqueEvidence = new Map<string, SpeakerSourceRef>(); for (const ref of evidence) uniqueEvidence.set(tupleKey(ref.type, ref.id), ref); const sourceRecords = sortedRefs([...uniqueEvidence.values(), ...waivers]); const normalizedBlockers = [...blockers].sort((a, b) => codeUnitCompare(a.code, b.code) || codeUnitCompare(a.truth, b.truth) || codeUnitCompare(a.sourceRecords[0]?.id ?? "", b.sourceRecords[0]?.id ?? "")); const eligible = normalizedBlockers.length === 0; const payload = { schema: SPEAKER_READINESS_SCHEMA, workspaceId: facts.workspaceId, eventId: facts.eventId, asOf: facts.asOf, locale: facts.locale, gate, eligible, blockers: normalizedBlockers, waivers: sortedRefs(waivers), sourceRecords }; return { gate, eligible, blockers: normalizedBlockers, waivers: sortedRefs(waivers), sourceRecords, computationFingerprint: fingerprintOf(payload) };
  });
  const result = { schema: SPEAKER_READINESS_SCHEMA, fingerprintAlgorithm: SPEAKER_FINGERPRINT_ALGORITHM, workspaceId: facts.workspaceId, eventId: facts.eventId, asOf: facts.asOf, locale: facts.locale, selectionDecision: selectionRef, gates: gatesResult, eligible: gatesResult.every((gate) => gate.eligible), computationFingerprint: fingerprintOf({ schema: SPEAKER_READINESS_SCHEMA, workspaceId: facts.workspaceId, eventId: facts.eventId, asOf: facts.asOf, locale: facts.locale, selectionDecision: selectionRef, gates: gatesResult }) }; return freeze(result);
}
export const evaluateSpeakerOperationsReadiness = evaluateSpeakerReadiness;
export const evaluateSpeakerOperationsGate = evaluateSpeakerReadiness;
