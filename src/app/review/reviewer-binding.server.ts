import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionInfo } from "@/server/auth";
import type {
  OwnReviewAssignmentDetail,
  OwnReviewAssignmentSummary,
} from "@/server/services/cfp-review";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/u;

export interface ReviewActionBinding {
  readonly version: 1;
  readonly kind: "review";
  readonly assignmentId: string;
  readonly assignmentStateSequenceNumber: number;
  readonly conflictStatus: OwnReviewAssignmentDetail["conflictStatus"];
  readonly conflictSequenceNumber: number;
  readonly reviewRevisionNumber: number;
  readonly proposalRevisionSequence: number;
  readonly rubricVersionId: string;
  readonly rubricVersionNumber: number;
}

export interface ConflictActionBinding {
  readonly version: 1;
  readonly kind: "conflict";
  readonly assignmentId: string;
  readonly assignmentStateSequenceNumber: number;
  readonly conflictSequenceNumber: number;
}

export type ReviewerActionBinding = ReviewActionBinding | ConflictActionBinding;

function signingKey(session: SessionInfo): string {
  return `${session.tokenHash}\u0000${session.workspaceId}\u0000${session.accountId}`;
}

function signature(payload: string, session: SessionInfo): string {
  return createHmac("sha256", signingKey(session)).update(payload, "utf8").digest("hex");
}

function encodeBinding(binding: ReviewerActionBinding, session: SessionInfo): string {
  const payload = Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
  return `${payload}.${signature(payload, session)}`;
}

export function issueReviewActionBinding(
  session: SessionInfo,
  detail: OwnReviewAssignmentDetail,
): string {
  return encodeBinding(
    {
      version: 1,
      kind: "review",
      assignmentId: detail.assignmentId,
      assignmentStateSequenceNumber: detail.assignmentStateSequenceNumber,
      conflictStatus: detail.conflictStatus,
      conflictSequenceNumber: detail.conflictSequenceNumber,
      reviewRevisionNumber: detail.latestReviewRevisionNumber,
      proposalRevisionSequence: detail.proposal.revisionSequence,
      rubricVersionId: detail.rubric.versionId,
      rubricVersionNumber: detail.rubric.versionNumber,
    },
    session,
  );
}

export function issueConflictActionBinding(
  session: SessionInfo,
  summary: OwnReviewAssignmentSummary,
): string {
  return encodeBinding(
    {
      version: 1,
      kind: "conflict",
      assignmentId: summary.assignmentId,
      assignmentStateSequenceNumber: summary.assignmentStateSequenceNumber,
      conflictSequenceNumber: summary.conflictSequenceNumber,
    },
    session,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isSequence(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function parseBinding(value: unknown): ReviewerActionBinding | null {
  if (
    !isPlainRecord(value) ||
    value.version !== 1 ||
    typeof value.assignmentId !== "string" ||
    !IDENTIFIER_PATTERN.test(value.assignmentId)
  ) {
    return null;
  }
  if (value.kind === "review") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "assignmentId",
        "assignmentStateSequenceNumber",
        "conflictStatus",
        "conflictSequenceNumber",
        "reviewRevisionNumber",
        "proposalRevisionSequence",
        "rubricVersionId",
        "rubricVersionNumber",
      ]) ||
      !isSequence(value.assignmentStateSequenceNumber, 1) ||
      !["NONE", "CLEARED", "WAIVED"].includes(String(value.conflictStatus)) ||
      !isSequence(value.conflictSequenceNumber, 0) ||
      !isSequence(value.reviewRevisionNumber, 0) ||
      !isSequence(value.proposalRevisionSequence, 1) ||
      typeof value.rubricVersionId !== "string" ||
      !IDENTIFIER_PATTERN.test(value.rubricVersionId) ||
      !isSequence(value.rubricVersionNumber, 1)
    ) {
      return null;
    }
    return value as unknown as ReviewActionBinding;
  }
  if (value.kind === "conflict") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "assignmentId",
        "assignmentStateSequenceNumber",
        "conflictSequenceNumber",
      ]) ||
      !isSequence(value.assignmentStateSequenceNumber, 1) ||
      !isSequence(value.conflictSequenceNumber, 0)
    ) {
      return null;
    }
    return value as unknown as ConflictActionBinding;
  }
  return null;
}

export function verifyReviewerActionBinding(
  token: string,
  session: SessionInfo,
): ReviewerActionBinding | null {
  if (token.length > 2140) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return null;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  if (!PAYLOAD_PATTERN.test(payload) || !SIGNATURE_PATTERN.test(suppliedSignature)) return null;
  const expectedSignature = signature(payload, session);
  if (
    !timingSafeEqual(
      Buffer.from(suppliedSignature, "hex"),
      Buffer.from(expectedSignature, "hex"),
    )
  ) {
    return null;
  }
  try {
    return parseBinding(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

export function reviewBindingMatchesDetail(
  binding: ReviewActionBinding,
  detail: OwnReviewAssignmentDetail,
): boolean {
  return (
    binding.assignmentId === detail.assignmentId &&
    binding.assignmentStateSequenceNumber === detail.assignmentStateSequenceNumber &&
    binding.conflictStatus === detail.conflictStatus &&
    binding.conflictSequenceNumber === detail.conflictSequenceNumber &&
    binding.reviewRevisionNumber === detail.latestReviewRevisionNumber &&
    binding.proposalRevisionSequence === detail.proposal.revisionSequence &&
    binding.rubricVersionId === detail.rubric.versionId &&
    binding.rubricVersionNumber === detail.rubric.versionNumber
  );
}
