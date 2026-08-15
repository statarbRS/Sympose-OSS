export type OperatorReleaseErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SCHEMA"
  | "SCOPE_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "VERSION_MISMATCH"
  | "FINGERPRINT_MISMATCH"
  | "COMMON_FINGERPRINT_MISMATCH"
  | "CROSS_AUDIENCE_LEAKAGE"
  | "CALLER_AUTHORITY_FORBIDDEN"
  | "FORBIDDEN_FIELD"
  | "DUPLICATE_SOURCE"
  | "DUPLICATE_FIELD"
  | "CONFLICTING_FIELD"
  | "FIELD_NOT_FOUND"
  | "FIELD_NOT_ALLOWLISTED"
  | "REDACTION_REASON_REQUIRED"
  | "INCLUDE_REASON_REQUIRED"
  | "STALE_SOURCE"
  | "SOURCE_UNAVAILABLE"
  | "NON_CANONICAL_INPUT"
  | "SUPERSESSION_INVALID"
  | "SUPERSESSION_CYCLE"
  | "MANIFEST_TOO_LARGE"
  | "VECTOR_TOO_LARGE"
  | "LIMIT_EXCEEDED"
  | "INCOMPLETE_PROJECTION";

export class OperatorReleaseCoreError extends Error {
  readonly code: OperatorReleaseErrorCode;

  constructor(code: OperatorReleaseErrorCode, message: string) {
    super(message);
    this.name = "OperatorReleaseCoreError";
    this.code = code;
  }
}

export function fail(code: OperatorReleaseErrorCode, message: string): never {
  throw new OperatorReleaseCoreError(code, message);
}
