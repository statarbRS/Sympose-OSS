import { timingSafeEqual } from "node:crypto";

const JOB_TOKEN = /^[a-f0-9]{64}$/u;
const AUTHORIZATION = /^Bearer ([a-f0-9]{64})$/u;

/** Fail closed without returning or logging either secret-bearing value. */
export function isAuthorizedAutomaticReminderJobRequest(
  request: Request,
  configuredToken: string | undefined,
): boolean {
  if (typeof configuredToken !== "string" || !JOB_TOKEN.test(configuredToken)) return false;
  const match = AUTHORIZATION.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const supplied = Buffer.from(match[1]!, "ascii");
  const expected = Buffer.from(configuredToken, "ascii");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
