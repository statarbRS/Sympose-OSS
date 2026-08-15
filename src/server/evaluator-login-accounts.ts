import { deterministicUuid } from "./canonical";

export type EvaluatorLoginAccount = Readonly<{
  accountId: string;
  workspaceId: string;
  role: "organizer" | "reviewer";
  email: string;
}>;

/**
 * Dependency-light login identities for the synthetic evaluator entry page.
 *
 * The full evaluator seed modules import CFP, review, planning, and publication
 * services. Auth and root-query modules must not pull that graph in merely to
 * compare four frozen account tuples.
 */
export const EVALUATOR_ORGANIZER_LOGIN_ALLOWLIST: readonly EvaluatorLoginAccount[] =
  Object.freeze([
    Object.freeze({
      accountId: deterministicUuid("account:acme-organizer"),
      workspaceId: deterministicUuid("workspace:acme"),
      role: "organizer" as const,
      email: "organizer@acme.example",
    }),
    Object.freeze({
      accountId: deterministicUuid("account:devflow-organizer"),
      workspaceId: deterministicUuid("workspace:devflow"),
      role: "organizer" as const,
      email: "jordan.alvarez@devflow.example",
    }),
  ]);

export const EVALUATOR_REVIEWER_LOGIN_ALLOWLIST: readonly EvaluatorLoginAccount[] =
  Object.freeze([
    Object.freeze({
      accountId: deterministicUuid("account:evaluator-acme-reviewer"),
      workspaceId: deterministicUuid("workspace:acme"),
      role: "reviewer" as const,
      email: "reviewer@acme.example",
    }),
    Object.freeze({
      accountId: deterministicUuid("account:evaluator-devflow-reviewer"),
      workspaceId: deterministicUuid("workspace:devflow"),
      role: "reviewer" as const,
      email: "sam.whitfield@devflow.example",
    }),
  ]);
