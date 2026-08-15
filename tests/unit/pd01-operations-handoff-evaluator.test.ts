import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import {
  buildOperationsHandoffManifest,
  canonicalOperationsHandoffManifestJson,
  classifyOperationsHandoffDrift,
  deriveSafeFilename,
  deriveSealedLocator,
  evaluateOperationsHandoffEligibility,
  fingerprintOperationsHandoffManifest,
  OPERATIONS_HANDOFF_LIMITS,
  type OperationsHandoffLoaderInput,
} from "../../src/server/adapters/operations-handoff-evaluator";

const hash = (value: unknown) => fingerprintOf(value);
const id = (value: string) => value;
const requiredSpeakerRoleFingerprint = (role: Record<string, unknown>) => hash({ schema: "pd01-required-speaker-role/v1", id: role.id, workspaceId: role.workspaceId, eventId: role.eventId, selectionId: role.selectionId, programUnitId: role.programUnitId, programUnitVersionId: role.programUnitVersionId, selectionDecisionId: role.selectionDecisionId, selectionDecisionFingerprint: role.selectionDecisionFingerprint, personId: role.personId, speakerRoleId: role.speakerRoleId, role: role.role, offerId: role.offerId, offerTermsFingerprint: role.offerTermsFingerprint });
function evidence<T extends Record<string, unknown>>(workspaceId: string, eventId: string, content: T) { return { workspaceId, eventId, id: content.id as string, fingerprint: hash(content), content }; }

function fixture(): OperationsHandoffLoaderInput {
  const workspaceId = "ws-1"; const eventId = "event-1";
  const eventContent = { id: eventId, workspaceId, name: "Synthetic Event", timezone: "UTC", startsAt: "2026-09-15T13:00:00.000Z", endsAt: "2026-09-15T21:00:00.000Z" };
  const policyContent = { id: "policy-1", workspaceId, eventId, versionNumber: 1, fieldAllowlist: ["title", "unitKind", "locationLabel", "cue", "avPreset", "speaker.displayName"], prohibitedFields: ["internalNoteRef", "speaker.operatorContactRef"], sensitiveFields: [], requiredArtifactPurposes: ["PRESENTATION_DECK"], participantPublicationRequirement: "REQUIRED" as const, redactionProfileFingerprints: { "redaction-1": "1".repeat(64) } };
  const requiredSpeakerRole = { id: "required-role-1", fingerprint: "", workspaceId, eventId, selectionId: "selection-1", programUnitId: "unit-1", programUnitVersionId: "unit-v1", speakerRoleId: "role-1", role: "PRIMARY_SPEAKER", personId: "person-1", selectionDecisionId: "decision-selection-1", selectionDecisionFingerprint: "f".repeat(64), offerId: "offer-1", offerTermsFingerprint: "a".repeat(64) };
  requiredSpeakerRole.fingerprint = requiredSpeakerRoleFingerprint(requiredSpeakerRole);
  const selectionContent = { id: "selection-1", workspaceId, eventId, state: "CURRENT" as const, selectedProgramUnitIds: ["unit-1"], decisionFingerprints: { "decision-selection-1": "f".repeat(64) }, requiredSpeakerRoles: [requiredSpeakerRole] };
  const assignment = { id: "assignment-1", workspaceId, eventId, planVersionId: "plan-1", programUnitId: "unit-1", programUnitVersionId: "unit-v1", resourceId: "room-1", resourceVersionId: "room-v1", startsAt: "2026-09-15T13:00:00.000Z", endsAt: "2026-09-15T13:30:00.000Z", timezone: "UTC", fingerprint: "2".repeat(64) };
  const planContent = { id: "plan-1", workspaceId, eventId, selectionBatchId: selectionContent.id, selectionBatchFingerprint: hash(selectionContent), state: "APPROVED" as const, versionNumber: 1, assignments: [assignment] };
  const response = { id: "response-1", workspaceId, eventId, offerId: "offer-1", offerTermsFingerprint: "a".repeat(64), state: "ACCEPTED" as const };
  const commitmentsContent = { id: "commitments-1", workspaceId, eventId, sequence: 3, responses: [response] };
  const readinessContent = { id: "readiness-1", workspaceId, eventId, asOf: "2026-09-14T18:00:00.000Z", conditions: [{ id: "condition-1", code: "AV_READY", state: "SATISFIED" as const, waiverId: null }] };
  const publicationCurrent = { id: "publication-1", workspaceId, eventId, channelKey: "operators", state: "CURRENT" as const, fingerprint: "b".repeat(64) };
  const publicationContent = { id: "publication-source-1", workspaceId, eventId, requirement: "REQUIRED" as const, current: { ...publicationCurrent, publishedItemFingerprints: ["e".repeat(64)] } };
  const artifact = { purpose: "PRESENTATION_DECK", requirementInstanceId: "requirement-1", submissionVersionId: "submission-v1", requirementDecisionId: "decision-1", decisionState: "APPROVED" as const, approvedSubmissionVersionId: "submission-v1", artifactId: "artifact-1", artifactFingerprint: "c".repeat(64), fileEntryId: "file-1", sha256: "d".repeat(64), byteSize: 12, mediaType: "application/pdf", scanState: "CLEAN" as const };
  const rowContent = { id: "row-1", workspaceId, eventId, ordinal: 1, programUnitId: "unit-1", programUnitVersionId: "unit-v1", scheduleBindingId: "assignment-1", scheduleBindingFingerprint: assignment.fingerprint, startsAt: assignment.startsAt, endsAt: assignment.endsAt, timezone: "UTC", resourceId: "room-1", resourceVersionId: "room-v1", publicationReleaseId: publicationCurrent.id, publicationItemFingerprint: "e".repeat(64), speakers: [{ requiredSpeakerRoleId: requiredSpeakerRole.id, requiredSpeakerRoleFingerprint: requiredSpeakerRole.fingerprint, personId: "person-1", speakerRoleId: "role-1", role: "PRIMARY_SPEAKER", selectionDecisionId: "decision-selection-1", selectionDecisionFingerprint: "f".repeat(64), offerId: response.offerId, offerTermsFingerprint: response.offerTermsFingerprint, responseId: response.id, responseState: "ACCEPTED" as const }], artifacts: [artifact], operatorFields: { title: "Opening Talk", unitKind: "TALK", locationLabel: "Room A", cue: "OPEN", avPreset: "PRESENTATION", internalNoteRef: null, "speaker.displayName": "Speaker", "speaker.operatorContactRef": null } };
  const fileContent = { id: "file-1", workspaceId, eventId, purpose: artifact.purpose, sourceArtifactId: artifact.artifactId, sourceArtifactFingerprint: artifact.artifactFingerprint, storageKind: "LOCAL_FIXTURE" as const, sha256: artifact.sha256, byteSize: artifact.byteSize, mediaType: artifact.mediaType, classification: "OPERATOR_INTERNAL" as const, scanState: "CLEAN" as const, accessibility: "ACCESSIBLE" as const, redactionProfileVersionId: "redaction-1", redactionProfileFingerprint: "1".repeat(64), derivedFromArtifactId: null };
  return { workspaceId, event: evidence(workspaceId, eventId, eventContent), channel: { id: "channel-1", workspaceId, eventId, key: "operators", audienceKind: "INTERNAL_OPERATOR", policy: evidence(workspaceId, eventId, policyContent) }, selection: evidence(workspaceId, eventId, selectionContent), plan: evidence(workspaceId, eventId, planContent), commitments: evidence(workspaceId, eventId, commitmentsContent), readiness: evidence(workspaceId, eventId, readinessContent), publication: evidence(workspaceId, eventId, publicationContent), rows: [evidence(workspaceId, eventId, rowContent)], files: [evidence(workspaceId, eventId, fileContent)] } as OperationsHandoffLoaderInput;
}
function twoRowFixture(): OperationsHandoffLoaderInput {
  const input = fixture() as any;
  input.selection.content.selectedProgramUnitIds = ["unit-1", "unit-2"];
  const firstRole = input.selection.content.requiredSpeakerRoles[0];
  const secondRole = { ...firstRole, id: "required-role-2", fingerprint: "", programUnitId: "unit-2", speakerRoleId: "role-2", personId: "person-2", offerId: "offer-2", offerTermsFingerprint: "5".repeat(64) };
  secondRole.fingerprint = requiredSpeakerRoleFingerprint(secondRole);
  input.selection.content.requiredSpeakerRoles = [firstRole, secondRole];
  input.commitments.content.responses.push({ id: "response-2", workspaceId: input.workspaceId, eventId: input.event.id, offerId: secondRole.offerId, offerTermsFingerprint: secondRole.offerTermsFingerprint, state: "ACCEPTED" });
  input.commitments.fingerprint = hash(input.commitments.content);
  input.selection.fingerprint = hash(input.selection.content);
  const firstAssignment = input.plan.content.assignments[0];
  const secondAssignment = { ...firstAssignment, id: "assignment-2", programUnitId: "unit-2", startsAt: "2026-09-15T13:30:00.000Z", endsAt: "2026-09-15T14:00:00.000Z", fingerprint: "3".repeat(64) };
  input.plan.content.assignments = [firstAssignment, secondAssignment];
  input.plan.content.selectionBatchFingerprint = input.selection.fingerprint;
  input.plan.fingerprint = hash(input.plan.content);
  const firstRow = input.rows[0];
  const secondSpeaker = { ...firstRow.content.speakers[0], requiredSpeakerRoleId: secondRole.id, requiredSpeakerRoleFingerprint: secondRole.fingerprint, personId: secondRole.personId, speakerRoleId: secondRole.speakerRoleId, offerId: secondRole.offerId, offerTermsFingerprint: secondRole.offerTermsFingerprint, responseId: "response-2" };
  const secondArtifact = { ...structuredClone(firstRow.content.artifacts[0]), artifactId: "artifact-2", artifactFingerprint: "6".repeat(64), fileEntryId: "file-2", sha256: "7".repeat(64) };
  const secondRowContent = { ...firstRow.content, id: "row-2", ordinal: 2, programUnitId: "unit-2", scheduleBindingId: secondAssignment.id, scheduleBindingFingerprint: secondAssignment.fingerprint, startsAt: secondAssignment.startsAt, endsAt: secondAssignment.endsAt, operatorFields: structuredClone(firstRow.content.operatorFields), speakers: [secondSpeaker], artifacts: [secondArtifact] };
  input.rows = [firstRow, { ...firstRow, id: secondRowContent.id, content: secondRowContent, fingerprint: hash(secondRowContent) }];
  const secondFileContent = { ...input.files[0].content, id: "file-2", sourceArtifactId: secondArtifact.artifactId, sourceArtifactFingerprint: secondArtifact.artifactFingerprint, sha256: secondArtifact.sha256 };
  input.files.push(evidence(input.workspaceId, input.event.id, secondFileContent));
  return input as OperationsHandoffLoaderInput;
}
function baseline(input: OperationsHandoffLoaderInput) { const sealedManifest = buildOperationsHandoffManifest(input); return { sealedEvidence: structuredClone(input), sealedManifest }; }
function expectSealedBaselineRejects(input: OperationsHandoffLoaderInput, mutate: (manifest: Record<string, any>) => void, matcher: RegExp): void { const trusted = baseline(input); const forged = structuredClone(trusted) as { sealedEvidence: OperationsHandoffLoaderInput; sealedManifest: Record<string, any> }; mutate(forged.sealedManifest); expect(() => classifyOperationsHandoffDrift(forged, input)).toThrow(matcher); }
function mutateRequiredRoleKeepingOldFingerprint(input: OperationsHandoffLoaderInput): void { const candidate = input as any; const role = candidate.selection.content.requiredSpeakerRoles[0]; role.personId = "person-mutated"; candidate.rows[0].content.speakers[0].personId = role.personId; candidate.selection.fingerprint = hash(candidate.selection.content); candidate.plan.content.selectionBatchFingerprint = candidate.selection.fingerprint; candidate.plan.fingerprint = hash(candidate.plan.content); candidate.rows[0].fingerprint = hash(candidate.rows[0].content); }
function multiRoleFixture(): OperationsHandoffLoaderInput { const input = fixture() as any; const firstRole = input.selection.content.requiredSpeakerRoles[0]; const secondRole = { ...firstRole, id: "required-role-2", fingerprint: "", speakerRoleId: "role-2", personId: "person-2", offerId: "offer-2", offerTermsFingerprint: "5".repeat(64) }; secondRole.fingerprint = requiredSpeakerRoleFingerprint(secondRole); input.selection.content.requiredSpeakerRoles = [firstRole, secondRole]; input.selection.fingerprint = hash(input.selection.content); input.plan.content.selectionBatchFingerprint = input.selection.fingerprint; input.plan.fingerprint = hash(input.plan.content); input.commitments.content.responses.push({ id: "response-2", workspaceId: input.workspaceId, eventId: input.event.id, offerId: secondRole.offerId, offerTermsFingerprint: secondRole.offerTermsFingerprint, state: "ACCEPTED" }); input.commitments.fingerprint = hash(input.commitments.content); const firstSpeaker = input.rows[0].content.speakers[0]; const secondSpeaker = { ...firstSpeaker, requiredSpeakerRoleId: secondRole.id, requiredSpeakerRoleFingerprint: secondRole.fingerprint, personId: secondRole.personId, speakerRoleId: secondRole.speakerRoleId, offerId: secondRole.offerId, offerTermsFingerprint: secondRole.offerTermsFingerprint, responseId: "response-2" }; input.rows[0].content.speakers = [firstSpeaker, secondSpeaker]; input.rows[0].fingerprint = hash(input.rows[0].content); return input as OperationsHandoffLoaderInput; }
function largeCombinedBaselineFixture(rowCount = 70, fieldBytes = 4000): OperationsHandoffLoaderInput {
  const input = fixture() as any;
  const largeValue = "x".repeat(fieldBytes);
  const title = "t".repeat(Math.min(fieldBytes, 500));
  const fieldNames = Object.keys(input.rows[0].content.operatorFields);
  input.channel.policy.content.fieldAllowlist = fieldNames;
  input.channel.policy.content.prohibitedFields = [];
  input.channel.policy.content.sensitiveFields = [];
  input.channel.policy.fingerprint = hash(input.channel.policy.content);

  const selectedProgramUnitIds: string[] = [];
  const decisionFingerprints: Record<string, string> = {};
  const requiredSpeakerRoles: Record<string, unknown>[] = [];
  const assignments: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const rows: ReturnType<typeof evidence>[] = [];
  const files: ReturnType<typeof evidence>[] = [];
  const publishedItemFingerprints: string[] = [];
  const eventStart = Date.parse(input.event.content.startsAt);

  for (let index = 0; index < rowCount; index += 1) {
    const ordinal = index + 1;
    const suffix = String(ordinal);
    const programUnitId = `unit-${suffix}`;
    const programUnitVersionId = `unit-v${suffix}`;
    const decisionId = `decision-selection-${suffix}`;
    const decisionFingerprint = hash({ kind: "selection-decision", ordinal });
    const offerTermsFingerprint = hash({ kind: "offer-terms", ordinal });
    const assignmentFingerprint = hash({ kind: "assignment", ordinal });
    const artifactFingerprint = hash({ kind: "artifact", ordinal });
    const fileSha256 = hash({ kind: "file", ordinal });
    const publishedItemFingerprint = hash({ kind: "publication-item", ordinal });
    const startsAt = new Date(eventStart + index * 5 * 60_000).toISOString();
    const endsAt = new Date(eventStart + (index * 5 + 4) * 60_000).toISOString();
    const assignmentId = `assignment-${suffix}`;
    const requiredRoleId = `required-role-${suffix}`;
    const speakerRoleId = `role-${suffix}`;
    const personId = `person-${suffix}`;
    const offerId = `offer-${suffix}`;
    const responseId = `response-${suffix}`;
    const artifactId = `artifact-${suffix}`;
    const fileId = `file-${suffix}`;
    const role: Record<string, unknown> = { id: requiredRoleId, fingerprint: "", workspaceId: input.workspaceId, eventId: input.event.id, selectionId: input.selection.id, programUnitId, programUnitVersionId, speakerRoleId, role: "PRIMARY_SPEAKER", personId, selectionDecisionId: decisionId, selectionDecisionFingerprint: decisionFingerprint, offerId, offerTermsFingerprint };
    role.fingerprint = requiredSpeakerRoleFingerprint(role);
    const assignment = { id: assignmentId, workspaceId: input.workspaceId, eventId: input.event.id, planVersionId: input.plan.id, programUnitId, programUnitVersionId, resourceId: "room-1", resourceVersionId: "room-v1", startsAt, endsAt, timezone: "UTC", fingerprint: assignmentFingerprint };
    const response = { id: responseId, workspaceId: input.workspaceId, eventId: input.event.id, offerId, offerTermsFingerprint, state: "ACCEPTED" };
    const artifact = { purpose: "PRESENTATION_DECK", requirementInstanceId: `requirement-${suffix}`, submissionVersionId: `submission-v${suffix}`, requirementDecisionId: `decision-${suffix}`, decisionState: "APPROVED", approvedSubmissionVersionId: `submission-v${suffix}`, artifactId, artifactFingerprint, fileEntryId: fileId, sha256: fileSha256, byteSize: ordinal, mediaType: "application/pdf", scanState: "CLEAN" };
    const rowContent = { id: `row-${suffix}`, workspaceId: input.workspaceId, eventId: input.event.id, ordinal, programUnitId, programUnitVersionId, scheduleBindingId: assignmentId, scheduleBindingFingerprint: assignmentFingerprint, startsAt, endsAt, timezone: "UTC", resourceId: "room-1", resourceVersionId: "room-v1", publicationReleaseId: input.publication.content.current.id, publicationItemFingerprint: publishedItemFingerprint, speakers: [{ requiredSpeakerRoleId: requiredRoleId, requiredSpeakerRoleFingerprint: role.fingerprint, personId, speakerRoleId, role: "PRIMARY_SPEAKER", selectionDecisionId: decisionId, selectionDecisionFingerprint: decisionFingerprint, offerId, offerTermsFingerprint, responseId, responseState: "ACCEPTED" }], artifacts: [artifact], operatorFields: { title, unitKind: largeValue, locationLabel: largeValue, cue: largeValue, avPreset: largeValue, internalNoteRef: largeValue, "speaker.displayName": largeValue, "speaker.operatorContactRef": largeValue } };
    const fileContent = { id: fileId, workspaceId: input.workspaceId, eventId: input.event.id, purpose: artifact.purpose, sourceArtifactId: artifactId, sourceArtifactFingerprint: artifactFingerprint, storageKind: "LOCAL_FIXTURE", sha256: fileSha256, byteSize: ordinal, mediaType: "application/pdf", classification: "OPERATOR_INTERNAL", scanState: "CLEAN", accessibility: "ACCESSIBLE", redactionProfileVersionId: "redaction-1", redactionProfileFingerprint: "1".repeat(64), derivedFromArtifactId: null };

    selectedProgramUnitIds.push(programUnitId);
    decisionFingerprints[decisionId] = decisionFingerprint;
    requiredSpeakerRoles.push(role);
    assignments.push(assignment);
    responses.push(response);
    rows.push(evidence(input.workspaceId, input.event.id, rowContent));
    files.push(evidence(input.workspaceId, input.event.id, fileContent));
    publishedItemFingerprints.push(publishedItemFingerprint);
  }

  input.selection.content.selectedProgramUnitIds = selectedProgramUnitIds;
  input.selection.content.decisionFingerprints = decisionFingerprints;
  input.selection.content.requiredSpeakerRoles = requiredSpeakerRoles;
  input.selection.fingerprint = hash(input.selection.content);
  input.plan.content.assignments = assignments;
  input.plan.content.selectionBatchFingerprint = input.selection.fingerprint;
  input.plan.fingerprint = hash(input.plan.content);
  input.commitments.content.responses = responses;
  input.commitments.fingerprint = hash(input.commitments.content);
  input.publication.content.current.publishedItemFingerprints = publishedItemFingerprints;
  input.publication.fingerprint = hash(input.publication.content);
  input.rows = rows;
  input.files = files;
  return input as OperationsHandoffLoaderInput;
}
function maxRowsOptionalPublicationFixture(): OperationsHandoffLoaderInput {
  const input = fixture() as any;
  const fieldNames = Object.keys(input.rows[0].content.operatorFields);
  const eventStart = Date.parse(input.event.content.startsAt);
  const policyContent = { ...input.channel.policy.content, fieldAllowlist: [], prohibitedFields: [], sensitiveFields: [], requiredArtifactPurposes: [], participantPublicationRequirement: "OPTIONAL" as const };
  input.channel.policy.content = policyContent;
  input.channel.policy.fingerprint = hash(policyContent);
  const publicationContent = { ...input.publication.content, requirement: "OPTIONAL" as const, current: null };
  input.publication.content = publicationContent;
  input.publication.fingerprint = hash(publicationContent);

  const selectedProgramUnitIds: string[] = [];
  const decisionFingerprints: Record<string, string> = {};
  const requiredSpeakerRoles: Record<string, unknown>[] = [];
  const assignments: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const rows: ReturnType<typeof evidence>[] = [];

  for (let index = 0; index < OPERATIONS_HANDOFF_LIMITS.maxRows; index += 1) {
    const ordinal = index + 1;
    const suffix = String(ordinal);
    const programUnitId = `unit-${suffix}`;
    const programUnitVersionId = `unit-v${suffix}`;
    const decisionId = `decision-selection-${suffix}`;
    const decisionFingerprint = hash({ kind: "selection-decision", ordinal });
    const offerTermsFingerprint = hash({ kind: "offer-terms", ordinal });
    const assignmentFingerprint = hash({ kind: "assignment", ordinal });
    const assignmentId = `assignment-${suffix}`;
    const requiredRoleId = `required-role-${suffix}`;
    const speakerRoleId = `role-${suffix}`;
    const personId = `person-${suffix}`;
    const offerId = `offer-${suffix}`;
    const responseId = `response-${suffix}`;
    const startsAt = new Date(eventStart).toISOString();
    const endsAt = new Date(eventStart + 60_000).toISOString();
    const role: Record<string, unknown> = { id: requiredRoleId, fingerprint: "", workspaceId: input.workspaceId, eventId: input.event.id, selectionId: input.selection.id, programUnitId, programUnitVersionId, speakerRoleId, role: "PRIMARY_SPEAKER", personId, selectionDecisionId: decisionId, selectionDecisionFingerprint: decisionFingerprint, offerId, offerTermsFingerprint };
    role.fingerprint = requiredSpeakerRoleFingerprint(role);
    const assignment = { id: assignmentId, workspaceId: input.workspaceId, eventId: input.event.id, planVersionId: input.plan.id, programUnitId, programUnitVersionId, resourceId: `room-${suffix}`, resourceVersionId: `room-v${suffix}`, startsAt, endsAt, timezone: "UTC", fingerprint: assignmentFingerprint };
    const response = { id: responseId, workspaceId: input.workspaceId, eventId: input.event.id, offerId, offerTermsFingerprint, state: "ACCEPTED" as const };
    const rowContent = { id: `row-${suffix}`, workspaceId: input.workspaceId, eventId: input.event.id, ordinal, programUnitId, programUnitVersionId, scheduleBindingId: assignmentId, scheduleBindingFingerprint: assignmentFingerprint, startsAt, endsAt, timezone: "UTC", resourceId: assignment.resourceId, resourceVersionId: assignment.resourceVersionId, publicationReleaseId: null, publicationItemFingerprint: null, speakers: [{ requiredSpeakerRoleId: requiredRoleId, requiredSpeakerRoleFingerprint: role.fingerprint, personId, speakerRoleId, role: "PRIMARY_SPEAKER", selectionDecisionId: decisionId, selectionDecisionFingerprint: decisionFingerprint, offerId, offerTermsFingerprint, responseId, responseState: "ACCEPTED" as const }], artifacts: [], operatorFields: Object.fromEntries(fieldNames.map((field) => [field, null])) };

    selectedProgramUnitIds.push(programUnitId);
    decisionFingerprints[decisionId] = decisionFingerprint;
    requiredSpeakerRoles.push(role);
    assignments.push(assignment);
    responses.push(response);
    rows.push(evidence(input.workspaceId, input.event.id, rowContent));
  }

  input.selection.content.selectedProgramUnitIds = selectedProgramUnitIds;
  input.selection.content.decisionFingerprints = decisionFingerprints;
  input.selection.content.requiredSpeakerRoles = requiredSpeakerRoles;
  input.selection.fingerprint = hash(input.selection.content);
  input.plan.content.assignments = assignments;
  input.plan.content.selectionBatchFingerprint = input.selection.fingerprint;
  input.plan.fingerprint = hash(input.plan.content);
  input.commitments.content.responses = responses;
  input.commitments.fingerprint = hash(input.commitments.content);
  input.rows = rows;
  input.files = [];
  return input as OperationsHandoffLoaderInput;
}
function oversizedAggregateChild(): Record<string, string> { return Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`padding-${index}`, "x".repeat(4096)])); }

describe("pure P9 operations handoff evaluator", () => {
  it("rejects waived readiness without a durable waiver identifier before manifest production", () => {
    for (const waiverId of [null, "", "waiver id", "../waiver"]) {
      const input = fixture() as any;
      input.readiness.content.conditions[0] = { ...input.readiness.content.conditions[0], state: "WAIVED", waiverId };
      input.readiness.fingerprint = hash(input.readiness.content);

      expect(() => buildOperationsHandoffManifest(input)).toThrow(/INVALID_(?:STRING|ID): readiness\.conditions\[0\]\.waiverId/);
    }
  });

  it("preserves null waiver semantics for satisfied and blocked readiness", () => {
    expect(buildOperationsHandoffManifest(fixture()).eligibility.waivers).toEqual([]);

    const blocked = fixture() as any;
    blocked.readiness.content.conditions[0].state = "BLOCKED";
    blocked.readiness.fingerprint = hash(blocked.readiness.content);
    const blockedManifest = buildOperationsHandoffManifest(blocked);
    expect(blockedManifest.eligibility.eligible).toBe(false);
    expect(blockedManifest.eligibility.waivers).toEqual([]);
    expect(classifyOperationsHandoffDrift({ sealedEvidence: structuredClone(blocked), sealedManifest: blockedManifest }, blocked).state).toBe("NONE");

    for (const state of ["SATISFIED", "BLOCKED"] as const) {
      const contradictory = fixture() as any;
      contradictory.readiness.content.conditions[0] = { ...contradictory.readiness.content.conditions[0], state, waiverId: "waiver-contradictory" };
      contradictory.readiness.fingerprint = hash(contradictory.readiness.content);
      expect(() => buildOperationsHandoffManifest(contradictory)).toThrow(/INVALID_BINDING: readiness\.conditions\[0\]\.waiverId/);
    }
  });

  it("round-trips every accepted waiver through sealed drift validation", () => {
    const input = fixture() as any;
    input.readiness.content.conditions = [
      { id: "condition-1", code: "AV_READY", state: "WAIVED", waiverId: "waiver-1" },
      { id: "condition-2", code: "LIGHTING_READY", state: "WAIVED", waiverId: "waiver.scope:2026_v1" },
    ];
    input.readiness.fingerprint = hash(input.readiness.content);

    const manifest = buildOperationsHandoffManifest(input);
    expect(manifest.eligibility.eligible).toBe(true);
    expect(manifest.eligibility.waivers).toEqual([
      { id: "waiver-1", code: "AV_READY" },
      { id: "waiver.scope:2026_v1", code: "LIGHTING_READY" },
    ]);
    expect(classifyOperationsHandoffDrift({ sealedEvidence: structuredClone(input), sealedManifest: manifest }, input).state).toBe("NONE");

    const forged = { sealedEvidence: structuredClone(input), sealedManifest: structuredClone(manifest) } as any;
    forged.sealedManifest.sources.readiness.conditions[0].waiverId = null;
    expect(() => classifyOperationsHandoffDrift(forged, input)).toThrow(/INVALID_STRING: sealedManifest\.sources\.readiness\.conditions\[0\]\.waiverId/);
  });

  it("rejects duplicate artifact and file bindings before manifest construction", () => {
    const duplicateObject = fixture() as any;
    duplicateObject.rows[0].content.artifacts.push(structuredClone(duplicateObject.rows[0].content.artifacts[0]));
    duplicateObject.rows[0].fingerprint = hash(duplicateObject.rows[0].content);
    expect(() => buildOperationsHandoffManifest(duplicateObject)).toThrow(/DUPLICATE_BINDING: artifact\.file/);

    const duplicateArtifactId = twoRowFixture() as any;
    duplicateArtifactId.rows[1].content.artifacts[0].artifactId = duplicateArtifactId.rows[0].content.artifacts[0].artifactId;
    duplicateArtifactId.rows[1].fingerprint = hash(duplicateArtifactId.rows[1].content);
    expect(() => buildOperationsHandoffManifest(duplicateArtifactId)).toThrow(/DUPLICATE_BINDING: artifact\.file/);

    const duplicateFileEntryId = twoRowFixture() as any;
    duplicateFileEntryId.rows[1].content.artifacts[0].fileEntryId = duplicateFileEntryId.rows[0].content.artifacts[0].fileEntryId;
    duplicateFileEntryId.rows[1].fingerprint = hash(duplicateFileEntryId.rows[1].content);
    expect(() => buildOperationsHandoffManifest(duplicateFileEntryId)).toThrow(/DUPLICATE_BINDING: artifact\.file/);
  });

  it("round-trips valid distinct artifacts across the complete package", () => {
    const input = twoRowFixture();
    const manifest = buildOperationsHandoffManifest(input);
    const projectedArtifacts = (manifest.runOfShow as readonly any[]).flatMap((row) => row.artifacts as readonly any[]);
    expect(projectedArtifacts.map((artifact) => artifact.artifactId)).toEqual(["artifact-1", "artifact-2"]);
    expect(new Set(projectedArtifacts.map((artifact) => artifact.safeFilename)).size).toBe(2);
    expect(classifyOperationsHandoffDrift({ sealedEvidence: structuredClone(input), sealedManifest: manifest }, input).state).toBe("NONE");
  });

  it("derives eligibility and a complete frozen allowlist projection", () => { const input = fixture(); const before = canonicalJson(input); const manifest = buildOperationsHandoffManifest(input); expect(manifest.eligibility.eligible).toBe(true); expect(manifest.eligibility.facts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SELECTION_CURRENT", state: "PASS" })])); expect(manifest.redaction.decisions.some((d) => d.field === "internalNoteRef" && d.action === "EXCLUDE")).toBe(true); expect(JSON.stringify(manifest)).not.toContain("secret"); expect(Object.isFrozen(manifest)).toBe(true); expect(canonicalJson(input)).toBe(before); expect(fingerprintOperationsHandoffManifest(input)).toBe(fingerprintOperationsHandoffManifest(structuredClone(input))); });
  it("cross-validates purposes, source content fingerprints, foreign bindings, and orphan files", () => { const input = fixture(); const bad = structuredClone(input) as any; bad.files[0].content.purpose = "WRONG_PURPOSE"; bad.files[0].fingerprint = hash(bad.files[0].content); expect(() => buildOperationsHandoffManifest(bad)).toThrow(/INVALID_BINDING|REQUIREMENT_MISSING/); const orphan = structuredClone(input) as any; const extra = structuredClone(orphan.files[0]); extra.content.id = "file-2"; extra.id = "file-2"; extra.content = { ...extra.content, id: "file-2" }; extra.fingerprint = hash(extra.content); orphan.files.push(extra); expect(() => buildOperationsHandoffManifest(orphan)).toThrow(/ORPHAN_FILE/); });
  it("blocks stale authority, required evidence, chronology, and redaction leakage", () => { const stale = structuredClone(fixture()) as any; stale.selection.content.state = "SUPERSEDED"; stale.selection.fingerprint = hash(stale.selection.content); expect(() => buildOperationsHandoffManifest(stale)).toThrow(/INVALID_BINDING|STALE/); const hidden = structuredClone(fixture()) as any; hidden.rows[0].content.operatorFields.internalNoteRef = "secret"; hidden.rows[0].fingerprint = hash(hidden.rows[0].content); expect(buildOperationsHandoffManifest(hidden).eligibility.eligible).toBe(false); expect(JSON.stringify(buildOperationsHandoffManifest(hidden))).not.toContain("secret"); const late = structuredClone(fixture()) as any; late.readiness.content.asOf = "2026-09-15T14:00:00.000Z"; late.readiness.fingerprint = hash(late.readiness.content); expect(() => buildOperationsHandoffManifest(late)).toThrow(/READINESS_STALE/); });
  it("rejects extra keys, accessors, proxies, cycles, malformed hashes, and bounds", () => { const extra = structuredClone(fixture()) as any; extra.rows[0].content.extra = 1; extra.rows[0].fingerprint = hash(extra.rows[0].content); expect(() => buildOperationsHandoffManifest(extra)).toThrow(/EXTRA_OR_MISSING_KEY/); const getter = fixture() as any; Object.defineProperty(getter, "workspaceId", { get: () => "ws-1", enumerable: true }); expect(() => buildOperationsHandoffManifest(getter)).toThrow(/UNSAFE_INPUT/); const cyclic = fixture() as any; cyclic.cycle = cyclic; expect(() => buildOperationsHandoffManifest(cyclic)).toThrow(); expect(() => deriveSealedLocator("../file")).toThrow(); expect(() => deriveSafeFilename("title", 1, "application/pdf", id("a"))).not.toThrow(); });
  it("uses unique deterministic names and distinguishes delivery-only and material drift", () => { expect(deriveSafeFilename("A/B", 1, "application/pdf", "artifact-1")).not.toBe(deriveSafeFilename("A B", 1, "application/pdf", "artifact-2")); const input = fixture(); const delivery = classifyOperationsHandoffDrift(baseline(input), structuredClone(input), [{ path: "export.sha256", prior: "a", current: "b" }]); expect(delivery.state).toBe("DELIVERY_EXPORT_ONLY"); expect(delivery.deliveryDrift).toHaveLength(1); const changed = structuredClone(input) as any; changed.rows[0].content.artifacts[0].submissionVersionId = "submission-v2"; changed.rows[0].fingerprint = hash(changed.rows[0].content); expect(classifyOperationsHandoffDrift(baseline(input), changed).state).toBe("MATERIAL"); });
  it("rejects duplicate files, assignment/publication chain forgery, and delivery getter traps", () => { const input = fixture(); const duplicate = structuredClone(input) as any; duplicate.files.push(structuredClone(duplicate.files[0])); expect(() => buildOperationsHandoffManifest(duplicate)).toThrow(/DUPLICATE_BINDING/); const assignment = structuredClone(input) as any; assignment.rows[0].content.scheduleBindingFingerprint = "0".repeat(64); assignment.rows[0].fingerprint = hash(assignment.rows[0].content); expect(() => buildOperationsHandoffManifest(assignment)).toThrow(/INVALID_BINDING/); const publication = structuredClone(input) as any; publication.publication.content.current.channelKey = "foreign"; publication.publication.fingerprint = hash(publication.publication.content); expect(() => buildOperationsHandoffManifest(publication)).toThrow(/PUBLICATION_STALE/); let touched = false; const trapped = [{ path: "export.bytes", get prior() { touched = true; return "a"; }, current: "b" }] as any; expect(() => classifyOperationsHandoffDrift(baseline(input), input, trapped)).toThrow(/UNSAFE_INPUT/); expect(touched).toBe(false); });
  it("rejects forged manifests against unchanged trusted evidence and protects forbidden prior text", () => { const input = fixture(); const trusted = baseline(input); const forged = structuredClone(trusted) as any; forged.sealedManifest.event.name = "forged"; expect(() => classifyOperationsHandoffDrift(forged, input)).toThrow(/SEALED_REDACTION_VIOLATION|SEALED_CONTENT_FINGERPRINT_MISMATCH|SEALED_BASELINE_MISMATCH/); const forbidden = structuredClone(trusted) as any; forbidden.sealedManifest.runOfShow[0].operatorFields.internalNoteRef = "PRIVATE-PRIOR"; expect(() => classifyOperationsHandoffDrift(forbidden, input)).toThrow(/SEALED_REDACTION_VIOLATION|SEALED_BASELINE_MISMATCH/); });
  it("rejects forged sealed source chains and locator/file substitutions", () => { const input = fixture(); const sourceForgery = structuredClone(baseline(input)) as any; sourceForgery.sealedEvidence.rows[0].content.scheduleBindingFingerprint = "0".repeat(64); sourceForgery.sealedEvidence.rows[0].fingerprint = hash(sourceForgery.sealedEvidence.rows[0].content); expect(() => classifyOperationsHandoffDrift(sourceForgery, input)).toThrow(/INVALID_BINDING/); const locatorForgery = structuredClone(baseline(input)) as any; locatorForgery.sealedManifest.files[0].sealedLocator = "handoff/files/foreign"; expect(() => classifyOperationsHandoffDrift(locatorForgery, input)).toThrow(/SEALED_LOCATOR_MISMATCH|SEALED_BASELINE_MISMATCH/); const fileForgery = structuredClone(baseline(input)) as any; fileForgery.sealedManifest.files[0].sha256 = "e".repeat(64); expect(() => classifyOperationsHandoffDrift(fileForgery, input)).toThrow(/SEALED_BASELINE_MISMATCH/); });
  it("deep-validates sealed nested records and detaches the public timestamp", () => { const input = fixture(); const trusted = baseline(input); const forged = structuredClone(trusted) as any; forged.sealedManifest.runOfShow[0].speakers[0].extra = "forged"; expect(() => classifyOperationsHandoffDrift(forged, input)).toThrow(/EXTRA_OR_MISSING_KEY|SEALED_BASELINE_MISMATCH/); let touched = false; const evaluatedAt = { toString() { touched = true; return "2026-09-14T18:00:00.000Z"; } } as any; expect(() => buildOperationsHandoffManifest(input, evaluatedAt)).toThrow(/UNSAFE_INPUT/); expect(touched).toBe(false); });
  it("rejects a shared nested condition object across sealed baseline children", () => {
    const trusted = structuredClone(baseline(fixture())) as any;
    trusted.sealedManifest.sources.readiness.conditions[0] = trusted.sealedEvidence.readiness.content.conditions[0];

    expect(() => classifyOperationsHandoffDrift(trusted, fixture())).toThrow(/UNSAFE_INPUT/);
  });
  it("rejects a shared conditions array across sealed baseline children", () => {
    const trusted = structuredClone(baseline(fixture())) as any;
    trusted.sealedManifest.sources.readiness.conditions = trusted.sealedEvidence.readiness.content.conditions;

    expect(() => classifyOperationsHandoffDrift(trusted, fixture())).toThrow(/UNSAFE_INPUT/);
  });
  it("round-trips a normally independently cloned valid sealed baseline with no drift", () => {
    const input = fixture();
    const sealedEvidence = structuredClone(input);
    const sealedManifest = structuredClone(buildOperationsHandoffManifest(input));

    expect(classifyOperationsHandoffDrift({ sealedEvidence, sealedManifest }, input).state).toBe("NONE");
  });
  it("round-trips a valid baseline whose independently bounded children exceed 4 MiB together", () => {
    const input = largeCombinedBaselineFixture();
    const sealedManifest = structuredClone(buildOperationsHandoffManifest(input));
    const sealedEvidence = structuredClone(input);
    const evidenceBytes = Buffer.byteLength(canonicalJson(sealedEvidence), "utf8");
    const manifestBytes = Buffer.byteLength(canonicalJson(sealedManifest), "utf8");

    expect(evidenceBytes).toBeLessThan(OPERATIONS_HANDOFF_LIMITS.maxInputBytes);
    expect(manifestBytes).toBeLessThan(OPERATIONS_HANDOFF_LIMITS.maxManifestBytes);
    expect(evidenceBytes + manifestBytes).toBeGreaterThan(OPERATIONS_HANDOFF_LIMITS.maxInputBytes);
    expect(classifyOperationsHandoffDrift({ sealedEvidence, sealedManifest }, input).state).toBe("NONE");
  });
  it("supports the exact max-row redaction capacity through sealed baseline round trips", () => {
    const input = maxRowsOptionalPublicationFixture();
    const fieldCount = Object.keys(input.rows[0].content.operatorFields).length;
    const manifest = buildOperationsHandoffManifest(input);
    const expectedDecisions = 1 + OPERATIONS_HANDOFF_LIMITS.maxRows * fieldCount;

    expect(OPERATIONS_HANDOFF_LIMITS.maxDecisions).toBe(expectedDecisions);
    expect(input.rows).toHaveLength(OPERATIONS_HANDOFF_LIMITS.maxRows);
    expect(input.files).toHaveLength(0);
    expect(manifest.runOfShow).toHaveLength(OPERATIONS_HANDOFF_LIMITS.maxRows);
    expect(manifest.redaction.decisions).toHaveLength(expectedDecisions);
    expect(manifest.eligibility.eligible).toBe(true);
    expect(Buffer.byteLength(canonicalJson(input), "utf8")).toBeLessThan(OPERATIONS_HANDOFF_LIMITS.maxInputBytes);
    expect(Buffer.byteLength(canonicalJson(manifest), "utf8")).toBeLessThan(OPERATIONS_HANDOFF_LIMITS.maxManifestBytes);

    const sealedEvidence = structuredClone(input);
    const drift = classifyOperationsHandoffDrift({ sealedEvidence, sealedManifest: manifest }, input);
    expect(drift.state).toBe("NONE");
    expect(drift.sealedManifestFingerprint).toBe(fingerprintOf(manifest));
    expect(drift.currentCandidateFingerprint).toBe(fingerprintOf(manifest));

    const oneOver = structuredClone(manifest) as any;
    oneOver.redaction.decisions.push(structuredClone(oneOver.redaction.decisions[0]));
    expect(() => classifyOperationsHandoffDrift({ sealedEvidence, sealedManifest: oneOver }, input)).toThrow(/UNSAFE_INPUT: array/);

    const tooManyRows = { ...input, rows: [...input.rows, structuredClone(input.rows[0])] };
    expect(() => buildOperationsHandoffManifest(tooManyRows)).toThrow(/UNSAFE_INPUT: array/);
  });
  it("rejects hostile sealed-baseline roots without invoking root or child traps", () => {
    const input = fixture();
    const trusted = baseline(input);
    let proxyTrapTouched = false;
    const proxyRoot = new Proxy({}, {
      get() { proxyTrapTouched = true; throw new Error("root get trap"); },
      getOwnPropertyDescriptor() { proxyTrapTouched = true; throw new Error("root descriptor trap"); },
      getPrototypeOf() { proxyTrapTouched = true; throw new Error("root prototype trap"); },
      ownKeys() { proxyTrapTouched = true; throw new Error("root ownKeys trap"); },
    });
    expect(() => classifyOperationsHandoffDrift(proxyRoot, input)).toThrow(/UNSAFE_INPUT: sealedBaseline root/);
    expect(proxyTrapTouched).toBe(false);
    const revokedRoot = Proxy.revocable({}, {});
    revokedRoot.revoke();
    expect(() => classifyOperationsHandoffDrift(revokedRoot.proxy, input)).toThrow(/UNSAFE_INPUT: sealedBaseline root/);

    let accessorTouched = false;
    const accessorRoot: Record<string, unknown> = {};
    Object.defineProperty(accessorRoot, "sealedEvidence", { enumerable: true, get() { accessorTouched = true; return trusted.sealedEvidence; } });
    Object.defineProperty(accessorRoot, "sealedManifest", { enumerable: true, value: trusted.sealedManifest });
    expect(() => classifyOperationsHandoffDrift(accessorRoot, input)).toThrow(/UNSAFE_INPUT: sealedBaseline descriptor/);
    expect(accessorTouched).toBe(false);

    let childTrapTouched = false;
    const trappedChild = new Proxy({}, { ownKeys() { childTrapTouched = true; throw new Error("child trap"); } });
    expect(() => classifyOperationsHandoffDrift({ sealedEvidence: trappedChild, sealedManifest: trusted.sealedManifest, extra: true }, input)).toThrow(/EXTRA_OR_MISSING_KEY: sealedBaseline/);
    expect(childTrapTouched).toBe(false);

    const cyclicRoot: Record<string, unknown> = { sealedEvidence: null, sealedManifest: trusted.sealedManifest };
    cyclicRoot.sealedEvidence = cyclicRoot;
    expect(() => classifyOperationsHandoffDrift(cyclicRoot, input)).toThrow(/UNSAFE_INPUT: sealedBaseline cycle/);
    expect(() => classifyOperationsHandoffDrift(Object.assign(Object.create({ hostile: true }), trusted), input)).toThrow(/UNSAFE_INPUT: sealedBaseline root/);
  });
  it("preflights each sealed child under its own limit before semantic validation", () => {
    const input = fixture();
    const trusted = baseline(input);
    const oversized = oversizedAggregateChild();
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(OPERATIONS_HANDOFF_LIMITS.maxInputBytes);

    expect(() => classifyOperationsHandoffDrift({ sealedEvidence: oversized, sealedManifest: trusted.sealedManifest }, input)).toThrow(/INPUT_LIMIT: sealedEvidence aggregate bytes/);

    const semanticallyInvalidEvidence = structuredClone(trusted.sealedEvidence) as any;
    semanticallyInvalidEvidence.workspaceId = "";
    expect(() => classifyOperationsHandoffDrift({ sealedEvidence: semanticallyInvalidEvidence, sealedManifest: oversized }, input)).toThrow(/INPUT_LIMIT: sealedManifest aggregate bytes/);
  });
  it("blocks unsafe current delivery changes and preserves detached delivery evidence", () => { const input = fixture(); const current = structuredClone(input) as any; current.files[0].content.accessibility = "INACCESSIBLE"; current.files[0].fingerprint = hash(current.files[0].content); const drift = classifyOperationsHandoffDrift(baseline(input), current, [{ path: "export.bytes", prior: "a", current: "b" }]); expect(drift.eligibilityNow).toBe(false); expect(drift.changes.some((change) => change.materiality === "BLOCKING")).toBe(true); expect(drift.state).toBe("MATERIAL"); expect(Object.isFrozen(drift.deliveryDrift)).toBe(true); });
  it("requires exact selected-unit, assignment, and row coverage", () => { const valid = fixture(); expect(buildOperationsHandoffManifest(valid).eligibility.eligible).toBe(true); const omittedRow = structuredClone(valid) as any; omittedRow.rows = []; expect(() => buildOperationsHandoffManifest(omittedRow)).toThrow(/PLAN_COVERAGE/); const omittedAssignment = structuredClone(valid) as any; omittedAssignment.plan.content.assignments = []; omittedAssignment.plan.fingerprint = hash(omittedAssignment.plan.content); expect(() => buildOperationsHandoffManifest(omittedAssignment)).toThrow(/PLAN_COVERAGE/); const extraAssignment = structuredClone(valid) as any; extraAssignment.plan.content.assignments.push({ ...extraAssignment.plan.content.assignments[0], id: "assignment-2" }); extraAssignment.plan.fingerprint = hash(extraAssignment.plan.content); expect(() => buildOperationsHandoffManifest(extraAssignment)).toThrow(/PLAN_COVERAGE/); const duplicateUnit = structuredClone(valid) as any; const secondAssignment = { ...duplicateUnit.plan.content.assignments[0], id: "assignment-2" }; duplicateUnit.plan.content.assignments.push(secondAssignment); duplicateUnit.plan.fingerprint = hash(duplicateUnit.plan.content); const secondRow = structuredClone(duplicateUnit.rows[0]); secondRow.id = "row-2"; secondRow.content = { ...secondRow.content, id: "row-2", ordinal: 2, scheduleBindingId: "assignment-2", scheduleBindingFingerprint: secondAssignment.fingerprint }; secondRow.fingerprint = hash(secondRow.content); duplicateUnit.rows.push(secondRow); expect(() => buildOperationsHandoffManifest(duplicateUnit)).toThrow(/PLAN_COVERAGE/); });
  it("binds publication eligibility to channel policy and rejects weaker or missing required evidence", () => { const bypass = structuredClone(fixture()) as any; bypass.rows[0].content.publicationReleaseId = null; bypass.rows[0].content.publicationItemFingerprint = null; bypass.rows[0].fingerprint = hash(bypass.rows[0].content); bypass.publication.content.requirement = "OPTIONAL"; bypass.publication.content.current = null; bypass.publication.fingerprint = hash(bypass.publication.content); expect(() => buildOperationsHandoffManifest(bypass)).toThrow(/INVALID_BINDING/); const missing = structuredClone(fixture()) as any; missing.publication.content.current = null; missing.publication.fingerprint = hash(missing.publication.content); missing.rows[0].content.publicationReleaseId = null; missing.rows[0].content.publicationItemFingerprint = null; missing.rows[0].fingerprint = hash(missing.rows[0].content); expect(() => buildOperationsHandoffManifest(missing)).toThrow(/PUBLICATION_STALE/); const optional = structuredClone(missing) as any; optional.channel.policy.content.participantPublicationRequirement = "OPTIONAL"; optional.channel.policy.fingerprint = hash(optional.channel.policy.content); optional.publication.content.requirement = "OPTIONAL"; optional.publication.fingerprint = hash(optional.publication.content); const manifest = buildOperationsHandoffManifest(optional); expect(manifest.eligibility.eligible).toBe(true); expect(manifest.eligibility.facts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PUBLICATION_CURRENT", state: "PASS", evidence: expect.arrayContaining([expect.objectContaining({ type: "policy" })]) })])); });
  it("requires canonical contiguous show-flow ordinals in package and sealed-manifest validation", () => { const valid = twoRowFixture(); const manifest = buildOperationsHandoffManifest(valid); expect(manifest.runOfShow.map((row) => (row as { ordinal: number }).ordinal)).toEqual([1, 2]); expect(fingerprintOperationsHandoffManifest(valid)).toBe(fingerprintOperationsHandoffManifest(structuredClone(valid))); expect(classifyOperationsHandoffDrift(baseline(valid), valid).state).toBe("NONE"); const zero = structuredClone(valid) as any; zero.rows[0].content.ordinal = 0; zero.rows[0].fingerprint = hash(zero.rows[0].content); expect(() => fingerprintOperationsHandoffManifest(zero)).toThrow(/NONCANONICAL_ORDINAL/); const gap = structuredClone(valid) as any; gap.rows[1].content.ordinal = 3; gap.rows[1].fingerprint = hash(gap.rows[1].content); expect(() => buildOperationsHandoffManifest(gap)).toThrow(/NONCANONICAL_ORDINAL/); const reordered = structuredClone(valid) as any; reordered.rows.reverse(); expect(() => buildOperationsHandoffManifest(reordered)).toThrow(/NONCANONICAL_ORDINAL/); const forged = structuredClone(baseline(valid)) as any; forged.sealedManifest.runOfShow[1].ordinal = 3; expect(() => classifyOperationsHandoffDrift(forged, valid)).toThrow(/NONCANONICAL_ORDINAL/); const reorderedSealed = structuredClone(baseline(valid)) as any; reorderedSealed.sealedManifest.runOfShow.reverse(); expect(() => classifyOperationsHandoffDrift(reorderedSealed, valid)).toThrow(/NONCANONICAL_ORDINAL/); });
  it("requires authoritative exact role coverage and rejects the empty-speaker bypass", () => { const emptySpeakers = structuredClone(fixture()) as any; emptySpeakers.rows[0].content.speakers = []; emptySpeakers.rows[0].fingerprint = hash(emptySpeakers.rows[0].content); expect(() => buildOperationsHandoffManifest(emptySpeakers)).toThrow(/SPEAKER_COVERAGE/); const emptyInventory = structuredClone(fixture()) as any; emptyInventory.selection.content.requiredSpeakerRoles = []; emptyInventory.selection.fingerprint = hash(emptyInventory.selection.content); emptyInventory.plan.content.selectionBatchFingerprint = emptyInventory.selection.fingerprint; emptyInventory.plan.fingerprint = hash(emptyInventory.plan.content); expect(() => buildOperationsHandoffManifest(emptyInventory)).toThrow(/SPEAKER_COVERAGE/); const complete = multiRoleFixture(); const manifest = buildOperationsHandoffManifest(complete); expect(manifest.eligibility.eligible).toBe(true); expect((manifest.runOfShow[0] as any).speakers).toHaveLength(2); expect(manifest.sources.selection.requiredSpeakerRoles).toHaveLength(2); });
  it("rejects duplicate, extra, foreign, stale, and mismatched role bindings", () => { const duplicate = multiRoleFixture() as any; duplicate.rows[0].content.speakers[1] = structuredClone(duplicate.rows[0].content.speakers[0]); duplicate.rows[0].fingerprint = hash(duplicate.rows[0].content); expect(() => buildOperationsHandoffManifest(duplicate)).toThrow(/DUPLICATE_BINDING|SPEAKER_COVERAGE/); const extra = multiRoleFixture() as any; extra.rows[0].content.speakers[1].requiredSpeakerRoleId = "required-role-foreign"; extra.rows[0].fingerprint = hash(extra.rows[0].content); expect(() => buildOperationsHandoffManifest(extra)).toThrow(/SPEAKER_COVERAGE/); const foreignInventory = structuredClone(fixture()) as any; foreignInventory.selection.content.requiredSpeakerRoles[0].workspaceId = "ws-foreign"; foreignInventory.selection.fingerprint = hash(foreignInventory.selection.content); foreignInventory.plan.content.selectionBatchFingerprint = foreignInventory.selection.fingerprint; foreignInventory.plan.fingerprint = hash(foreignInventory.plan.content); expect(() => buildOperationsHandoffManifest(foreignInventory)).toThrow(/FOREIGN_BINDING/); const stale = structuredClone(fixture()) as any; stale.rows[0].content.speakers[0].requiredSpeakerRoleFingerprint = "0".repeat(64); stale.rows[0].fingerprint = hash(stale.rows[0].content); expect(() => buildOperationsHandoffManifest(stale)).toThrow(/INVALID_BINDING/); const mismatched = structuredClone(fixture()) as any; mismatched.rows[0].content.speakers[0].personId = "person-foreign"; mismatched.rows[0].fingerprint = hash(mismatched.rows[0].content); expect(() => buildOperationsHandoffManifest(mismatched)).toThrow(/INVALID_BINDING/); });
  it("requires exactly one accepted response for each authoritative role offer", () => { const missing = structuredClone(fixture()) as any; missing.rows[0].content.speakers[0].responseId = null; missing.rows[0].content.speakers[0].responseState = "PENDING"; missing.rows[0].fingerprint = hash(missing.rows[0].content); expect(() => buildOperationsHandoffManifest(missing)).toThrow(/COMMITMENT_MISSING/); const duplicateResponse = structuredClone(fixture()) as any; duplicateResponse.commitments.content.responses.push({ id: "response-duplicate", workspaceId: duplicateResponse.workspaceId, eventId: duplicateResponse.event.id, offerId: "offer-1", offerTermsFingerprint: "a".repeat(64), state: "ACCEPTED" }); duplicateResponse.commitments.fingerprint = hash(duplicateResponse.commitments.content); expect(() => buildOperationsHandoffManifest(duplicateResponse)).toThrow(/COMMITMENT_DRIFT/); const wrongOffer = structuredClone(fixture()) as any; wrongOffer.rows[0].content.speakers[0].offerId = "offer-foreign"; wrongOffer.rows[0].fingerprint = hash(wrongOffer.rows[0].content); expect(() => buildOperationsHandoffManifest(wrongOffer)).toThrow(/INVALID_BINDING/); });
  it("gives prohibition precedence and keeps prohibited values out of all projections", () => { const eventConflict = structuredClone(fixture()) as any; eventConflict.channel.policy.content.fieldAllowlist.push("event.name"); eventConflict.channel.policy.content.prohibitedFields.push("event.name"); eventConflict.channel.policy.fingerprint = hash(eventConflict.channel.policy.content); const eventManifest = buildOperationsHandoffManifest(eventConflict); expect(eventManifest.event.name).toBe(""); expect(eventManifest.redaction.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ path: "event.name", field: "event.name", action: "EXCLUDE", reason: "PROHIBITED" })])); expect(JSON.stringify(eventManifest)).not.toContain("Synthetic Event"); const operatorConflict = structuredClone(fixture()) as any; operatorConflict.channel.policy.content.prohibitedFields.push("title"); operatorConflict.rows[0].content.operatorFields.title = "PRIVATE-TITLE"; operatorConflict.channel.policy.fingerprint = hash(operatorConflict.channel.policy.content); operatorConflict.rows[0].fingerprint = hash(operatorConflict.rows[0].content); const operatorManifest = buildOperationsHandoffManifest(operatorConflict); expect((operatorManifest.runOfShow[0] as any).operatorFields.title).toBeUndefined(); expect((operatorManifest.runOfShow[0] as any).artifacts[0].safeFilename).not.toContain("PRIVATE-TITLE"); expect((operatorManifest.files[0] as any).sealedLocator).not.toContain("PRIVATE-TITLE"); expect(operatorManifest.redaction.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ field: "title", action: "EXCLUDE", reason: "PROHIBITED" })])); expect(JSON.stringify(operatorManifest)).not.toContain("PRIVATE-TITLE"); });
  it("rejects retained required-role fingerprints at package and sealed boundaries", () => {
    const mutated = fixture();
    mutateRequiredRoleKeepingOldFingerprint(mutated);
    expect(() => buildOperationsHandoffManifest(mutated)).toThrow(/CONTENT_FINGERPRINT_MISMATCH/);

    const trusted = baseline(fixture());
    const sealedEvidenceMutation = structuredClone(trusted) as any;
    mutateRequiredRoleKeepingOldFingerprint(sealedEvidenceMutation.sealedEvidence);
    expect(() => classifyOperationsHandoffDrift(sealedEvidenceMutation, fixture())).toThrow(/CONTENT_FINGERPRINT_MISMATCH/);

    const sealedManifestMutation = structuredClone(trusted) as any;
    sealedManifestMutation.sealedManifest.sources.selection.requiredSpeakerRoles[0].personId = "person-mutated";
    expect(() => classifyOperationsHandoffDrift(sealedManifestMutation, fixture())).toThrow(/CONTENT_FINGERPRINT_MISMATCH/);
  });

  it("rejects accepted responses outside the exact required-role offer set", () => {
    const extra = fixture() as any;
    extra.commitments.content.responses.push({ id: "response-unrelated", workspaceId: extra.workspaceId, eventId: extra.event.id, offerId: "offer-unrelated", offerTermsFingerprint: "b".repeat(64), state: "ACCEPTED" });
    extra.commitments.fingerprint = hash(extra.commitments.content);
    expect(() => buildOperationsHandoffManifest(extra)).toThrow(/COMMITMENT_DRIFT/);
  });

  it("accepts a multi-role exact accepted-response set", () => {
    const input = multiRoleFixture();
    const manifest = buildOperationsHandoffManifest(input);
    expect(manifest.eligibility.eligible).toBe(true);
    expect(manifest.sources.commitments.responseIds).toEqual(["response-1", "response-2"]);
    expect((manifest.runOfShow[0] as any).speakers.map((speaker: any) => speaker.requiredSpeakerRoleId)).toEqual(["required-role-1", "required-role-2"]);
  });
  it("projects only accepted responses and retains pending commitments for an identical sealed round trip", () => {
    const input = multiRoleFixture() as any;
    const pending = { id: "response-pending", workspaceId: input.workspaceId, eventId: input.event.id, offerId: "offer-unrelated", offerTermsFingerprint: "b".repeat(64), state: "PENDING" as const };
    input.commitments.content.responses.splice(1, 0, pending);
    input.commitments.fingerprint = hash(input.commitments.content);

    const manifest = buildOperationsHandoffManifest(input);
    expect(manifest.sources.commitments.responseIds).toEqual(["response-1", "response-2"]);
    expect(manifest.sources.commitments.fingerprint).toBe(input.commitments.fingerprint);
    expect(classifyOperationsHandoffDrift({ sealedEvidence: structuredClone(input), sealedManifest: manifest }, input).state).toBe("NONE");
  });
  it("independently cross-checks exact sealed speaker coverage across roles and selected units", () => {
    expectSealedBaselineRejects(multiRoleFixture(), (manifest) => { manifest.runOfShow[0].speakers.pop(); }, /SPEAKER_COVERAGE/);
    expectSealedBaselineRejects(multiRoleFixture(), (manifest) => { manifest.runOfShow[0].speakers.push(structuredClone(manifest.runOfShow[0].speakers[0])); }, /SPEAKER_COVERAGE/);
    expectSealedBaselineRejects(multiRoleFixture(), (manifest) => { manifest.runOfShow[0].speakers[1] = structuredClone(manifest.runOfShow[0].speakers[0]); }, /DUPLICATE_BINDING/);
    expectSealedBaselineRejects(multiRoleFixture(), (manifest) => { manifest.runOfShow[0].speakers[0].personId = "person-mutated"; }, /INVALID_BINDING/);
    expectSealedBaselineRejects(twoRowFixture(), (manifest) => { manifest.runOfShow[1].programUnitVersionId = "unit-v2"; }, /INVALID_BINDING/);
    expectSealedBaselineRejects(twoRowFixture(), (manifest) => { manifest.runOfShow.pop(); }, /SPEAKER_COVERAGE/);
    expectSealedBaselineRejects(twoRowFixture(), (manifest) => { manifest.runOfShow[1].programUnitId = "unit-extra"; }, /SPEAKER_COVERAGE/);
  });

  it("independently requires the exact accepted sealed response set", () => {
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.sources.commitments.responseIds.pop(); }, /COMMITMENT_DRIFT/);
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.sources.commitments.responseIds.push("response-extra"); }, /COMMITMENT_DRIFT/);
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.sources.commitments.responseIds.push("response-1"); }, /DUPLICATE_BINDING/);
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.runOfShow[0].speakers[0].responseId = null; }, /COMMITMENT_MISSING/);
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.runOfShow[0].speakers[0].responseState = "PENDING"; }, /COMMITMENT_MISSING/);
    expectSealedBaselineRejects(fixture(), (manifest) => { manifest.runOfShow[0].speakers[0].responseId = "response-extra"; }, /COMMITMENT_DRIFT/);
    expectSealedBaselineRejects(multiRoleFixture(), (manifest) => { manifest.runOfShow[0].speakers[1].responseId = manifest.runOfShow[0].speakers[0].responseId; }, /DUPLICATE_BINDING/);
  });

  it("recomputes sealed safe filenames from redacted row titles and preserves baseline drift", () => {
    const multiRole = multiRoleFixture();
    const multiRoleBaseline = baseline(multiRole);
    expect(classifyOperationsHandoffDrift(multiRoleBaseline, multiRole).state).toBe("NONE");
    const multiRow = twoRowFixture();
    const multiRowBaseline = baseline(multiRow);
    expect(classifyOperationsHandoffDrift(multiRowBaseline, multiRow).state).toBe("NONE");
    const artifact = (multiRowBaseline.sealedManifest.runOfShow[0] as any).artifacts[0];
    expect(artifact.safeFilename).toBe(deriveSafeFilename("Opening Talk", 1, artifact.mediaType, artifact.artifactId));

    expectSealedBaselineRejects(multiRow, (manifest) => { manifest.runOfShow[0].artifacts[0].safeFilename = "001-Synthetic-Event-injected.pdf"; }, /INVALID_BINDING/);

    const prohibitedOperator = fixture() as any;
    prohibitedOperator.channel.policy.content.prohibitedFields.push("title");
    prohibitedOperator.channel.policy.fingerprint = hash(prohibitedOperator.channel.policy.content);
    prohibitedOperator.rows[0].content.operatorFields.title = "PRIVATE-TITLE";
    prohibitedOperator.rows[0].fingerprint = hash(prohibitedOperator.rows[0].content);
    const prohibitedBaseline = baseline(prohibitedOperator);
    const fallbackArtifact = (prohibitedBaseline.sealedManifest.runOfShow[0] as any).artifacts[0];
    expect(fallbackArtifact.safeFilename).toBe(deriveSafeFilename("artifact", 1, fallbackArtifact.mediaType, fallbackArtifact.artifactId));
    expect(classifyOperationsHandoffDrift(prohibitedBaseline, prohibitedOperator).state).toBe("NONE");
    expectSealedBaselineRejects(prohibitedOperator, (manifest) => { manifest.runOfShow[0].artifacts[0].safeFilename = deriveSafeFilename("PRIVATE-TITLE", 1, "application/pdf", "artifact-1"); }, /INVALID_BINDING/);
  });
});
