import { fingerprintOf, nowIso } from "../../canonical";
import type { SessionInfo } from "../../auth";
import type { Db } from "../../db";
import { writeAudit } from "../audit";
import {
  OrganizerReviewServiceError,
  organizerReviewReminderSubject,
  readOrganizerReviewSurface,
} from "./organizer-console";
import {
  ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
  type OrganizerReviewLocalEvidence,
  type OrganizerReviewReminderReceipt,
  type RecordOrganizerReviewRemindersInput,
} from "./organizer-types";

export {
  OrganizerSealingError,
  OrganizerSealingFatalError,
  sealBlindReviewArtifact,
  sealRubricSemantics,
  type BlindReviewArtifactSealReceipt,
  type OrganizerSealingErrorCode,
  type RubricSemanticsSealReceipt,
  type SealBlindReviewArtifactInput,
  type SealRubricSemanticsInput,
} from "./organizer-sealing";

export {
  OrganizerReviewServiceError,
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  distributeOrganizerReviewAssignments,
  exportOrganizerReview,
  organizerReviewRoundFingerprint,
  organizerReviewScheduleSummary,
  recuseOrganizerReviewAssignment,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundSchedule,
  setOrganizerReviewRoundState,
  type OrganizerReviewServiceErrorCode,
} from "./organizer-console";

export type {
  CreateOrganizerReviewRoundInput,
  CreateOrganizerReviewRubricInput,
  DistributeOrganizerReviewAssignmentsInput,
  ExportOrganizerReviewInput,
  OrganizerReviewCall,
  OrganizerReviewAssignment,
  OrganizerReviewAssignmentPlanEntry,
  OrganizerReviewBlindArtifactDecisionSet,
  OrganizerReviewDistributionPlan,
  OrganizerReviewDistributionReceipt,
  OrganizerReviewExport,
  OrganizerReviewLocalEvidence,
  OrganizerReviewReminderReceipt,
  OrganizerReviewReminder,
  OrganizerReviewRecusalReceipt,
  OrganizerReviewProgress,
  OrganizerReviewRubricChoice,
  OrganizerReviewRubricDocument,
  OrganizerReviewRubricField,
  OrganizerReviewRubricFieldInput,
  OrganizerReviewRubricSummary,
  OrganizerReviewRound,
  OrganizerReviewRoundProjection,
  OrganizerReviewRoundReceipt,
  OrganizerReviewRoundScheduleReceipt,
  OrganizerReviewRoundStateReceipt,
  OrganizerReviewRoundState,
  OrganizerReviewSort,
  OrganizerReviewSurface,
  RecordOrganizerReviewRemindersInput,
  RecuseOrganizerReviewAssignmentInput,
  ReadOrganizerReviewSurfaceInput,
  SetOrganizerReviewRoundScheduleInput,
  SetOrganizerReviewRoundStateInput,
} from "./organizer-types";

/**
 * Records local-evidence reminder plans for currently outstanding assignments.
 * This command never sends email or changes reviewer, assignment, or review state.
 */
export function recordOrganizerReviewReminders(
  db: Db,
  session: SessionInfo,
  input: RecordOrganizerReviewRemindersInput,
): OrganizerReviewReminderReceipt {
  if (input === null || typeof input !== "object") {
    throw new OrganizerReviewServiceError("INPUT_INVALID");
  }
  if (db.isTransaction) {
    throw new OrganizerReviewServiceError("OUTER_TRANSACTION_DENIED");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const surface = readOrganizerReviewSurface(db, session, {
      workspaceSlug: input.workspaceSlug,
      eventId: input.eventId,
      roundId: input.roundId,
    });
    const round = surface.rounds[0];
    if (!round || round.eventId !== input.eventId) {
      throw new OrganizerReviewServiceError("ROUND_NOT_AVAILABLE");
    }

    const outstandingAssignmentIds = round.reminders.map((reminder) => reminder.assignmentId);
    const existingReminderEvidence = new Set(
      round.localEvidence
        .filter((evidence) => evidence.kind === "REMINDER_PLANNED")
        .map((evidence) => evidence.subjectId),
    );
    const recordedAssignmentIds: string[] = [];
    const localEvidence: OrganizerReviewLocalEvidence[] = [];
    const scheduleVersion = round.schedule.version ?? 1;

    for (const reminder of round.reminders) {
      const subjectId = organizerReviewReminderSubject(round.id, reminder.assignmentId, {
        version: scheduleVersion,
        timezone: round.schedule.timezone,
        closesAt: round.schedule.closesAt,
      });
      if (existingReminderEvidence.has(subjectId)) continue;

      const recordedAt = nowIso();
      const payload = {
        assignmentId: reminder.assignmentId,
        reviewerAccountId: reminder.reviewerAccountId,
        dueAt: reminder.dueAt,
        scheduleVersion,
        timezone: round.schedule.timezone,
        channel: "local-evidence" as const,
        providerMutation: false as const,
        trigger: "organizer-action" as const,
      };
      const fingerprint = fingerprintOf({
        schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
        kind: "REMINDER_PLANNED" as const,
        workspaceId: surface.workspaceId,
        roundId: round.id,
        subjectId,
        payload,
        recordedAt,
      });
      const evidence = Object.freeze({
        schema: ORGANIZER_REVIEW_EVIDENCE_SCHEMA,
        kind: "REMINDER_PLANNED" as const,
        workspaceId: surface.workspaceId,
        roundId: round.id,
        subjectId,
        fingerprint,
        recordedAt,
      });
      writeAudit(db, surface.workspaceId, {
        actorKind: "account",
        actorRef: session.accountId,
        action: "cfp.review.local-evidence",
        targetType: "review_round",
        targetId: round.id,
        details: { ...evidence, payload },
      });
      existingReminderEvidence.add(subjectId);
      recordedAssignmentIds.push(reminder.assignmentId);
      localEvidence.push(evidence);
    }

    db.exec("COMMIT");
    return Object.freeze({
      schema: "cfp-organizer-review-reminder/v1" as const,
      workspaceId: surface.workspaceId,
      eventId: round.eventId,
      roundId: round.id,
      outstandingAssignmentIds: Object.freeze(outstandingAssignmentIds),
      recordedAssignmentIds: Object.freeze(recordedAssignmentIds),
      localEvidence: Object.freeze(localEvidence),
      providerMutation: false as const,
      replayed: recordedAssignmentIds.length === 0,
    });
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      // Preserve the opaque service boundary if transaction cleanup is unavailable.
    }
    if (error instanceof OrganizerReviewServiceError) throw error;
    throw new OrganizerReviewServiceError("WRITE_FAILED");
  }
}
