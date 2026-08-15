import type { Db } from "../../db";
import {
  CfpApplicantAccessError,
  resolveApplicantSession,
  type ResolveApplicantSessionInput,
} from "./applicant-access";
import {
  readCall,
  readSubmissionRevision,
  type CallReadModel,
  type SubmissionRevision,
} from "./form-documents";
import {
  readCfpSubmissionDecision,
  type CfpSubmissionDecisionProjection,
} from "./decisions";
import {
  readCfpSubmissionConfirmation,
  type CfpSubmissionConfirmationReceipt,
} from "./submission-confirmation";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type SubmissionState = "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";

export type ApplicantSubmissionEditBoundary =
  | {
      readonly available: true;
      readonly mode: "draft" | "submitted-amendment";
      readonly message: string;
    }
  | {
      readonly available: false;
      readonly code:
        | "CALL_CLOSED"
        | "SUBMITTED_EDIT_SCHEMA_REQUIRED"
        | "SUBMISSION_NOT_EDITABLE";
      readonly message: string;
    };

export interface ApplicantDecisionCommunicationProjection {
  readonly receiptId: string;
  readonly decisionEventId: string;
  readonly status: "PENDING";
  readonly channel: "local-inbox-simulation";
  readonly recipientDisplayName: string;
  readonly queuedAt: string;
  readonly simulated: true;
  readonly providerMutation: false;
  readonly message: string;
}

export type ApplicantSubmissionDecisionProjection = Omit<
  CfpSubmissionDecisionProjection,
  "communication"
> & {
  readonly communication: ApplicantDecisionCommunicationProjection | null;
};

export interface ApplicantSubmissionDashboardProjection {
  readonly submissionId: string;
  readonly callId: string;
  readonly state: SubmissionState;
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
  readonly callState: CallReadModel["state"];
  readonly edit: ApplicantSubmissionEditBoundary;
  readonly decision: ApplicantSubmissionDecisionProjection | null;
  readonly confirmation: CfpSubmissionConfirmationReceipt | null;
}

export interface ReadApplicantSubmissionDashboardInput extends ResolveApplicantSessionInput {
  readonly submissionId: string;
}

export interface ReadApplicantSubmissionDashboardOptions {
  readonly now?: () => number;
}

export interface ReadApplicantSubmissionDashboardForPortalInput {
  readonly workspaceSlug: string;
  readonly callSlug: string;
  readonly sessionTokenHash: string;
  readonly submissionId: string;
}

type SubmissionRow = {
  readonly id: unknown;
  readonly call_id: unknown;
  readonly state: unknown;
  readonly current_revision_id: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly lineage_id: unknown;
  readonly revision_id: unknown;
  readonly revision_number: unknown;
  readonly revision_created_at: unknown;
};

function isSubmissionState(value: unknown): value is SubmissionState {
  return (
    value === "DRAFT" ||
    value === "SUBMITTED" ||
    value === "WITHDRAWN" ||
    value === "INVALIDATED"
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && IDENTIFIER_PATTERN.test(value));
}

function isOpenForEditing(call: CallReadModel, nowMs: number): boolean {
  if (call.state !== "OPEN") return false;
  if (call.opensAt && nowMs < Date.parse(call.opensAt)) return false;
  if (call.closesAt && nowMs >= Date.parse(call.closesAt)) return false;
  return true;
}

function applicantDecisionProjection(
  decision: CfpSubmissionDecisionProjection | null,
): ApplicantSubmissionDecisionProjection | null {
  if (!decision) return null;
  const communication = decision.communication;
  return Object.freeze({
    decisionEventId: decision.decisionEventId,
    submissionId: decision.submissionId,
    submissionRevisionId: decision.submissionRevisionId,
    submissionRevisionFingerprint: decision.submissionRevisionFingerprint,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    handoff: decision.handoff,
    communication: communication
      ? Object.freeze({
          receiptId: communication.receiptId,
          decisionEventId: communication.decisionEventId,
          status: communication.status,
          channel: communication.channel,
          recipientDisplayName: communication.recipientDisplayName,
          queuedAt: communication.queuedAt,
          simulated: communication.simulated,
          providerMutation: communication.providerMutation,
          message: `Decision communication is queued for ${communication.recipientDisplayName} in the local inbox simulation; no send or delivery is claimed.`,
        })
      : null,
  });
}

function editBoundary(
  state: SubmissionState,
  call: CallReadModel,
  nowMs: number,
  hasDecision: boolean,
): ApplicantSubmissionEditBoundary {
  if (!isOpenForEditing(call, nowMs)) {
    return {
      available: false,
      code: "CALL_CLOSED",
      message: "Editing is locked because this call is no longer accepting applications.",
    };
  }
  if (state === "DRAFT") {
    return {
      available: true,
      mode: "draft",
      message: "Your saved draft can be edited while the call is open.",
    };
  }
  if (state === "SUBMITTED") {
    if (hasDecision) {
      return {
        available: false,
        code: "SUBMISSION_NOT_EDITABLE",
        message: "This submitted proposal has an organizer decision and cannot be amended.",
      };
    }
    return {
      available: true,
      mode: "submitted-amendment",
      message:
        "This submitted proposal can be amended while the call is open. Saving creates a new immutable revision and preserves the submitted state.",
    };
  }
  return {
    available: false,
    code: "SUBMISSION_NOT_EDITABLE",
    message: "This application state cannot be edited in the applicant portal.",
  };
}

function revisionEvidence(
  db: Db,
  workspaceId: string,
  row: SubmissionRow,
): Pick<
  ApplicantSubmissionDashboardProjection,
  | "currentRevisionId"
  | "revisionNumber"
  | "revisionCreatedAt"
  | "hasConsentReceipt"
  | "formVersionId"
  | "ruleVersionId"
  | "formFingerprint"
  | "policyFingerprint"
> {
  if (row.current_revision_id === null) {
    if (row.revision_id !== null) {
      throw new Error("The submission has an orphaned revision pointer.");
    }
    return {
      currentRevisionId: null,
      revisionNumber: null,
      revisionCreatedAt: null,
      hasConsentReceipt: false,
      formVersionId: null,
      ruleVersionId: null,
      formFingerprint: null,
      policyFingerprint: null,
    };
  }
  if (
    typeof row.current_revision_id !== "string" ||
    !IDENTIFIER_PATTERN.test(row.current_revision_id) ||
    row.revision_id !== row.current_revision_id ||
    typeof row.revision_number !== "number" ||
    !Number.isSafeInteger(row.revision_number) ||
    row.revision_number < 1 ||
    !isIsoDate(row.revision_created_at)
  ) {
    throw new Error("The submission current-revision pointer is invalid.");
  }
  const revision: SubmissionRevision = readSubmissionRevision(
    db,
    workspaceId,
    row.current_revision_id,
  );
  if (revision.submissionId !== row.id || revision.revisionNumber !== row.revision_number) {
    throw new Error("The submission revision lineage is inconsistent.");
  }
  return {
    currentRevisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    revisionCreatedAt: row.revision_created_at,
    hasConsentReceipt: revision.consentReceipt !== null,
    formVersionId: revision.formDocument.formVersionId,
    ruleVersionId: revision.formDocument.ruleVersionId,
    formFingerprint: revision.fingerprint,
    policyFingerprint: revision.callPolicy.fingerprint,
  };
}

export function readApplicantSubmissionDashboard(
  db: Db,
  input: ReadApplicantSubmissionDashboardInput,
  options: ReadApplicantSubmissionDashboardOptions = {},
): ApplicantSubmissionDashboardProjection | null {
  if (
    !IDENTIFIER_PATTERN.test(input.workspaceId) ||
    !IDENTIFIER_PATTERN.test(input.callId) ||
    !IDENTIFIER_PATTERN.test(input.submissionId) ||
    !HASH_PATTERN.test(input.sessionTokenHash)
  ) {
    return null;
  }

  let resolved;
  try {
    resolved = resolveApplicantSession(db, {
      workspaceId: input.workspaceId,
      callId: input.callId,
      sessionTokenHash: input.sessionTokenHash,
    });
  } catch (error) {
    if (error instanceof CfpApplicantAccessError) return null;
    throw error;
  }

  const call = readCall(db, input.workspaceId, input.callId);
  const row = db
    .prepare(
      `SELECT
         s.id,
         s.call_id,
         s.state,
         s.current_revision_id,
         s.created_at,
         s.updated_at,
         s.lineage_id,
         r.id AS revision_id,
         r.revision_number,
         r.created_at AS revision_created_at
       FROM submissions s
       LEFT JOIN submission_revisions r
         ON r.workspace_id = s.workspace_id
        AND r.id = s.current_revision_id
        AND r.submission_id = s.id
       WHERE s.workspace_id = ?
         AND s.call_id = ?
         AND s.id = ?
         AND s.owner_person_id = ?
       LIMIT 1`,
    )
    .get(input.workspaceId, input.callId, input.submissionId, resolved.personId) as
    | SubmissionRow
    | undefined;
  if (!row || row.id !== input.submissionId || row.call_id !== input.callId) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.call_id !== "string" ||
    !isSubmissionState(row.state) ||
    !isIsoDate(row.created_at) ||
    !isIsoDate(row.updated_at) ||
    !isNullableIdentifier(row.current_revision_id) ||
    !isNullableIdentifier(row.lineage_id)
  ) {
    throw new Error("The applicant submission dashboard row is invalid.");
  }

  const evidence = revisionEvidence(db, input.workspaceId, row);
  const nowMs = options.now?.() ?? Date.now();
  const submittedAt = row.state === "SUBMITTED" ? row.updated_at : null;
  const decision = row.state === "SUBMITTED" && evidence.currentRevisionId
    ? readCfpSubmissionDecision(db, {
        workspaceId: input.workspaceId,
        submissionId: row.id,
        currentRevisionId: evidence.currentRevisionId,
      })
    : null;
  const applicantDecision = applicantDecisionProjection(decision);
  const confirmation = row.state === "SUBMITTED"
    ? readCfpSubmissionConfirmation(db, {
        workspaceId: input.workspaceId,
        callId: row.call_id,
        submissionId: row.id,
        personId: resolved.personId,
      })
    : null;
  return Object.freeze({
    submissionId: row.id,
    callId: row.call_id,
    state: row.state,
    ...evidence,
    submittedAt,
    lineageId: row.lineage_id,
    callState: call.state,
    edit: editBoundary(row.state, call, nowMs, applicantDecision !== null),
    decision: applicantDecision,
    confirmation,
  });
}

/**
 * Resolve the route's public slugs to one workspace/call pair before the authenticated applicant
 * read. The session resolver remains the authority for person ownership; slugs only select the
 * tenant-scoped call context and never grant access on their own.
 */
export function readApplicantSubmissionDashboardForPortal(
  db: Db,
  input: ReadApplicantSubmissionDashboardForPortalInput,
  options: ReadApplicantSubmissionDashboardOptions = {},
): ApplicantSubmissionDashboardProjection | null {
  if (
    typeof input.workspaceSlug !== "string" ||
    input.workspaceSlug.length === 0 ||
    input.workspaceSlug.length > 128 ||
    typeof input.callSlug !== "string" ||
    input.callSlug.length === 0 ||
    input.callSlug.length > 128 ||
    !IDENTIFIER_PATTERN.test(input.submissionId) ||
    !HASH_PATTERN.test(input.sessionTokenHash)
  ) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT w.id AS workspace_id, c.id AS call_id
       FROM workspaces w
       JOIN calls c
         ON c.workspace_id = w.id
        AND c.slug = ?
       WHERE w.slug = ?
       ORDER BY c.id ASC`,
    )
    .all(input.callSlug, input.workspaceSlug) as Array<{
      readonly workspace_id: unknown;
      readonly call_id: unknown;
    }>;
  if (rows.length !== 1) return null;
  const workspaceId = rows[0]?.workspace_id;
  const callId = rows[0]?.call_id;
  if (
    typeof workspaceId !== "string" ||
    !IDENTIFIER_PATTERN.test(workspaceId) ||
    typeof callId !== "string" ||
    !IDENTIFIER_PATTERN.test(callId)
  ) {
    return null;
  }
  return readApplicantSubmissionDashboard(
    db,
    {
      workspaceId,
      callId,
      sessionTokenHash: input.sessionTokenHash,
      submissionId: input.submissionId,
    },
    options,
  );
}
