import type { ReviewerProvisioningReceipt } from "@/server/services/cfp-review/reviewer-provisioning";

export type ReviewerProvisioningActionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "success";
      readonly code: "REVIEWER_ACCESS_SAVED";
      readonly message: string;
      readonly receipt: ReviewerProvisioningReceipt;
      readonly revalidated: boolean;
    };

export const IDLE_REVIEWER_PROVISIONING_ACTION: ReviewerProvisioningActionState = Object.freeze({
  kind: "idle",
});
