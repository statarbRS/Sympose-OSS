export interface ApplicantVerificationDeliveryScope {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly callId: string;
  readonly callSlug: string;
  readonly email: string;
}

export interface ApplicantVerificationDeliveryMessage
  extends ApplicantVerificationDeliveryScope {
  readonly verificationId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Transport boundary for applicant verification messages. Implementations must
 * keep the raw token server-side until the recipient opens the delivered link.
 */
export interface ApplicantVerificationDeliveryPort {
  prepareForRequest(scope: ApplicantVerificationDeliveryScope): Promise<void>;
  deliver(message: ApplicantVerificationDeliveryMessage): Promise<void>;
}
