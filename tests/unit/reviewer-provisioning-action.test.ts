import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ServiceError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(`internal-${code}-detail`);
      this.name = "ReviewerProvisioningServiceError";
      this.code = code;
    }
  }

  return {
    db: { reviewerProvisioningActionDb: true },
    session: {
      id: "session-organizer-action",
      tokenHash: "a".repeat(64),
      accountId: "account:devflow-organizer",
      workspaceId: "workspace:devflow",
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: "jordan.alvarez@devflow.example",
      displayName: "Jordan Alvarez",
      role: "organizer",
      workspaceSlug: "devflow",
      workspaceName: "DevFlow Conf 2027",
    },
    getDb: vi.fn(),
    getRouteSession: vi.fn(),
    requireOrganizerWorkspaceRoute: vi.fn(),
    provisionPinnedReviewer: vi.fn(),
    revalidatePath: vi.fn(),
    ServiceError,
  };
});

vi.mock("../../src/server/db", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/db")>("../../src/server/db");
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("../../src/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
}));
vi.mock("../../src/server/services/cfp-review/reviewer-provisioning", () => ({
  ReviewerProvisioningServiceError: mocks.ServiceError,
  provisionPinnedReviewer: mocks.provisionPinnedReviewer,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import * as reviewActions from "../../src/app/w/[workspace]/events/[eventId]/review/actions";
import { IDLE_REVIEWER_PROVISIONING_ACTION } from "../../src/components/cfp-review/reviewer-provisioning-action-state";

const { provisionPinnedReviewerAction } = reviewActions;

function validForm(): FormData {
  const form = new FormData();
  form.set("eventId", "evaluator-compatibility:event:devflow");
  form.set("roundId", "evaluator-compatibility:review-round:devflow");
  form.set("intent", "PROVISION");
  form.set("idempotencyKey", "sam-provision-action-v1");
  return form;
}

const receipt = {
  schema: "cfp-reviewer-access-receipt/v1",
  workspaceId: "workspace:devflow",
  eventId: "evaluator-compatibility:event:devflow",
  roundId: "evaluator-compatibility:review-round:devflow",
  assignmentId: "evaluator-compatibility:assignment:devflow",
  eventReviewerAssignmentId: "evaluator-compatibility:event-reviewer-assignment:devflow",
  reviewerAccountId: "account:evaluator-devflow-reviewer",
  reviewerPersonId: "evaluator-compatibility:person:sam-whitfield",
  accountPersonBindingId: "evaluator-compatibility:binding:sam-whitfield",
  actorAccountId: "account:devflow-organizer",
  intent: "PROVISION",
  state: "PROVISIONED",
  sequenceNumber: 1,
  receiptId: "reviewer-access-receipt-action",
  effectStateId: "reviewer-access-state-action",
  requestFingerprint: "b".repeat(64),
  idempotencyKey: "sam-provision-action-v1",
  createdAt: "2026-08-13T00:00:00.000Z",
  transitioned: true,
  replayed: false,
  providerMutation: false,
  credentialIssued: false,
} as const;

describe("organizer reviewer provisioning action", () => {
  it("keeps the client idle value outside the use-server runtime boundary", () => {
    expect(IDLE_REVIEWER_PROVISIONING_ACTION).toEqual({ kind: "idle" });
    expect(Object.isFrozen(IDLE_REVIEWER_PROVISIONING_ACTION)).toBe(true);
    expect(reviewActions).not.toHaveProperty("IDLE_REVIEWER_PROVISIONING_ACTION");
  });

  it("derives the target from the route/session and exposes only the durable receipt", async () => {
    mocks.getDb.mockReturnValue(mocks.db);
    mocks.getRouteSession.mockResolvedValue(mocks.session);
    mocks.provisionPinnedReviewer.mockReturnValue(receipt);

    const result = await provisionPinnedReviewerAction(
      IDLE_REVIEWER_PROVISIONING_ACTION,
      validForm(),
    );

    expect(result).toMatchObject({
      kind: "success",
      code: "REVIEWER_ACCESS_SAVED",
      receipt,
      revalidated: true,
    });
    expect(mocks.requireOrganizerWorkspaceRoute).toHaveBeenCalledWith(mocks.session, "devflow");
    expect(mocks.provisionPinnedReviewer).toHaveBeenCalledWith(
      mocks.db,
      mocks.session,
      {
        eventId: "evaluator-compatibility:event:devflow",
        roundId: "evaluator-compatibility:review-round:devflow",
        intent: "PROVISION",
        idempotencyKey: "sam-provision-action-v1",
      },
    );
    expect(Object.keys(mocks.provisionPinnedReviewer.mock.calls[0]![2]).sort()).toEqual([
      "eventId",
      "idempotencyKey",
      "intent",
      "roundId",
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/w/devflow/events/evaluator-compatibility%3Aevent%3Adevflow/review",
    );
  });

  it("rejects caller-supplied identity fields and sanitizes service denial responses", async () => {
    mocks.getDb.mockReturnValue(mocks.db);
    mocks.getRouteSession.mockResolvedValue(mocks.session);
    mocks.provisionPinnedReviewer.mockReset();
    const hostile = validForm();
    hostile.set("workspace", "devflow");
    hostile.set("reviewerAccountId", "arbitrary-account");

    const invalid = await provisionPinnedReviewerAction(
      IDLE_REVIEWER_PROVISIONING_ACTION,
      hostile,
    );
    expect(invalid).toEqual({
      kind: "error",
      code: "INPUT_INVALID",
      message: "The reviewer access request is invalid.",
    });
    expect(mocks.provisionPinnedReviewer).not.toHaveBeenCalled();

    mocks.provisionPinnedReviewer.mockImplementationOnce(() => {
      throw new mocks.ServiceError("ACCESS_DENIED");
    });
    const denied = await provisionPinnedReviewerAction(
      IDLE_REVIEWER_PROVISIONING_ACTION,
      validForm(),
    );
    expect(denied).toEqual({
      kind: "error",
      code: "ACCESS_DENIED",
      message: "Reviewer provisioning is unavailable for this workspace.",
    });
    expect(JSON.stringify(denied)).not.toContain("internal-ACCESS_DENIED-detail");
  });
});
