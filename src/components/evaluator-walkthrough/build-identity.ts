const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type EvaluatorBuildIdentity = Readonly<{
  status: "bound" | "unavailable";
  value: string;
}>;

export const UNAVAILABLE_EVALUATOR_BUILD_IDENTITY: EvaluatorBuildIdentity = Object.freeze({
  status: "unavailable",
  value: "unavailable",
});

/**
 * Project the server-only release value into the small, safe shape rendered by the walkthrough.
 * A branch, abbreviated SHA, or arbitrary environment value is never rendered as identity.
 */
export function resolveEvaluatorBuildIdentity(
  configuredValue: string | null | undefined,
): EvaluatorBuildIdentity {
  const normalized = typeof configuredValue === "string"
    ? configuredValue.trim().toLowerCase()
    : "";

  if (!FULL_SHA_PATTERN.test(normalized)) return UNAVAILABLE_EVALUATOR_BUILD_IDENTITY;

  return Object.freeze({
    status: "bound" as const,
    value: normalized,
  });
}
