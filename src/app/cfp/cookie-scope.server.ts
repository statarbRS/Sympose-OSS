import { sha256Hex } from "@/server/canonical";

const APPLICANT_SESSION_COOKIE_PREFIX = "sympose_cfp_applicant";
const APPLICANT_SUBMISSION_COOKIE_PREFIX = "sympose_cfp_submission";
const APPLICANT_VERIFICATION_COOKIE_PREFIX = "sympose_cfp_verification";
const APPLICANT_CREATE_HOLD_COOKIE_PREFIX = "sympose_cfp_create_hold";
const APPLICANT_SIMULATED_DELIVERY_COOKIE_PREFIX = "sympose_cfp_simulated_delivery";

function scopedCookieName(prefix: string, workspace: string, call: string): string {
  const scope = sha256Hex(`${workspace}\u0000${call}`).slice(0, 24);
  return `${prefix}_${scope}`;
}

export function sessionCookieName(workspace: string, call: string): string {
  return scopedCookieName(APPLICANT_SESSION_COOKIE_PREFIX, workspace, call);
}

export function submissionCookieName(workspace: string, call: string): string {
  return scopedCookieName(APPLICANT_SUBMISSION_COOKIE_PREFIX, workspace, call);
}

export function verificationCookieName(workspace: string, call: string): string {
  return scopedCookieName(APPLICANT_VERIFICATION_COOKIE_PREFIX, workspace, call);
}

export function createHoldCookieName(workspace: string, call: string): string {
  return scopedCookieName(APPLICANT_CREATE_HOLD_COOKIE_PREFIX, workspace, call);
}

export function simulatedDeliveryCookieName(workspace: string, call: string): string {
  return scopedCookieName(APPLICANT_SIMULATED_DELIVERY_COOKIE_PREFIX, workspace, call);
}
