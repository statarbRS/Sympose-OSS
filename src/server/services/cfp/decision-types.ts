export type CfpSubmissionDecision = "ACCEPTED" | "REJECTED";

export type CfpDecisionCommunicationStatus = "PENDING";

export type CfpDecisionCommunicationTemplateKey =
  | "cfp-decision-accepted-v1"
  | "cfp-decision-rejected-v1";

export interface CfpDecisionCommunicationMergeValues {
  readonly eventName: string;
  readonly callName: string;
  readonly proposalTitle: string;
}

export type CfpLinkedSessionStatus =
  | "UNSCHEDULED"
  | "SCHEDULED"
  | "DRAFT_UNPUBLISHED"
  | "RELEASED";

export interface CfpLinkedSessionPlacement {
  readonly roomId: string;
  readonly roomName: string;
  readonly trackId: string;
  readonly trackName: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface CfpLinkedSessionProjection {
  readonly programUnitId: string;
  readonly eventId: string;
  readonly proposalLineageId: string | null;
  readonly capacity: number;
  readonly durationMinutes: number;
  readonly trackId: string;
  readonly trackName: string;
  readonly status: CfpLinkedSessionStatus;
  readonly speakerLinkId: string | null;
  readonly placement: CfpLinkedSessionPlacement | null;
  readonly release: {
    readonly sealedAt: string;
    readonly releaseNumber: number | null;
  } | null;
}

export interface CfpAcceptedSessionHandoff {
  readonly status: "READY_FOR_SESSION_HANDOFF";
  readonly title: string;
  readonly abstract: string | null;
  readonly format: string | null;
  readonly track: string | null;
  readonly speaker: {
    readonly personId: string;
    readonly displayName: string;
  };
  readonly linkedSession: CfpLinkedSessionProjection;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly note: string;
}

export interface CfpDecisionCommunicationReceipt {
  readonly receiptId: string;
  readonly decisionEventId: string;
  readonly evidenceVersion: "rendered-v2";
  readonly status: "PENDING";
  readonly channel: "local-inbox-simulation";
  readonly recipientPersonId: string;
  readonly recipientDisplayName: string;
  readonly recipientEmail: string;
  readonly templateKey: CfpDecisionCommunicationTemplateKey;
  readonly mergeValues: CfpDecisionCommunicationMergeValues;
  readonly renderedSubject: string;
  readonly renderedBody: string;
  readonly payloadFingerprint: string;
  readonly queuedAt: string;
  readonly simulated: true;
  readonly providerMutation: false;
  readonly message: string;
}

export interface CfpSubmissionDecisionProjection {
  readonly decisionEventId: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly submissionRevisionFingerprint: string;
  readonly decision: CfpSubmissionDecision;
  readonly decidedAt: string;
  readonly handoff: CfpAcceptedSessionHandoff | null;
  readonly communication: CfpDecisionCommunicationReceipt | null;
}

export interface CfpSubmissionDecisionReceipt extends CfpSubmissionDecisionProjection {
  readonly replayed: boolean;
}
