import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions", () => ({
  enterPinnedReviewerSessionAction: vi.fn(),
}));
vi.mock("@/app/w/[workspace]/events/[eventId]/review/actions", () => ({
  provisionPinnedReviewerAction: vi.fn(),
}));

import { ReviewerProvisioningPanel } from "../../src/components/cfp-review/reviewer-provisioning";

const baseAccess = {
  schema: "cfp-reviewer-provisioning-evidence/v3" as const,
  workspaceId: "workspace:devflow",
  workspaceSlug: "devflow",
  eventId: "evaluator-compatibility:event:devflow",
  roundId: "evaluator-compatibility:review-round:devflow",
  assignmentId: "evaluator-compatibility:assignment:devflow",
  eventReviewerAssignmentId: "evaluator-compatibility:event-reviewer-assignment:devflow",
  reviewerAccountId: "account:evaluator-devflow-reviewer",
  reviewerPersonId: "evaluator-compatibility:person:sam-whitfield",
  accountPersonBindingId: "evaluator-compatibility:binding:sam-whitfield",
  reviewerName: "Sam Whitfield",
  reviewerEmail: "sam.whitfield@devflow.example",
  providerMutation: false as const,
  credentialIssued: false as const,
  queueReachable: false,
};

describe("reviewer provisioning browser surface", () => {
  it("shows the organizer lifecycle without account, role, password, or token inputs", () => {
    const html = renderToStaticMarkup(createElement(ReviewerProvisioningPanel, {
      access: {
        ...baseAccess,
        status: "READY_TO_PROVISION",
        accessState: null,
        accessSequenceNumber: 0,
      },
    }));
    expect(html).toContain('data-testid="reviewer-provisioning"');
    expect(html).toContain("Sam Whitfield");
    expect(html).toContain("Provision Sam reviewer");
    expect(html).toContain("Provisioned");
    expect(html).toContain("Invited");
    expect(html).toContain("Active");
    expect(html).not.toContain('name="workspace"');
    expect(html).not.toContain('name="reviewerAccountId"');
    expect(html).not.toContain('name="role"');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="token"');
  });

  it("shows exact reviewer queue entry only for the durable ACTIVE projection", () => {
    const html = renderToStaticMarkup(createElement(ReviewerProvisioningPanel, {
      access: {
        ...baseAccess,
        status: "ACTIVE",
        accessState: "ACTIVE",
        accessSequenceNumber: 3,
        queueReachable: true,
      },
    }));
    expect(html).toContain("Enter Sam’s reviewer queue");
    expect(html).toContain('data-testid="reviewer-persona-transition"');
    expect(html).not.toContain('name="workspace"');
    expect(html).not.toContain('name="reviewerAccountId"');
    expect(html).not.toContain('name="role"');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="token"');
  });
});
