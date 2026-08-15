import { Buffer } from "node:buffer";

import { cookies } from "next/headers";

import { simulatedDeliveryCookieName } from "@/app/cfp/cookie-scope.server";
import type {
  ApplicantVerificationDeliveryMessage,
  ApplicantVerificationDeliveryPort,
  ApplicantVerificationDeliveryScope,
} from "@/server/services/cfp/verification-delivery";

const SIMULATED_DELIVERY_MODE = "simulated";
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

type SimulatedDeliveryCookie = {
  readonly version: 1;
  readonly workspace: string;
  readonly call: string;
  readonly email: string;
  readonly verificationId: string;
  readonly token: string;
  readonly expiresAt: string;
};

export type SimulatedApplicantVerificationDelivery = {
  readonly email: string;
  readonly expiresAt: string;
};

export type OpenableSimulatedApplicantVerificationDelivery =
  SimulatedApplicantVerificationDelivery & {
    readonly verificationId: string;
    readonly token: string;
  };

type MutableCookieStore = {
  get(name: string): { readonly value: string } | undefined;
  set(
    name: string,
    value: string,
    options: Readonly<{
      httpOnly: boolean;
      sameSite: "strict";
      secure: boolean;
      path: string;
      expires?: Date;
      maxAge?: number;
      priority: "high";
    }>,
  ): unknown;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalEmail(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 320 ||
    value !== value.trim().toLowerCase() ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !/^[^\s@]+@[^\s@]+$/u.test(value)
  ) {
    return null;
  }
  return value;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function validScope(scope: ApplicantVerificationDeliveryScope): boolean {
  return (
    scope !== null &&
    typeof scope === "object" &&
    !Array.isArray(scope) &&
    hasExactKeys(scope as unknown as Record<string, unknown>, [
      "workspaceId",
      "workspaceSlug",
      "callId",
      "callSlug",
      "email",
    ]) &&
    IDENTIFIER_PATTERN.test(scope.workspaceId) &&
    SLUG_PATTERN.test(scope.workspaceSlug) &&
    IDENTIFIER_PATTERN.test(scope.callId) &&
    SLUG_PATTERN.test(scope.callSlug) &&
    canonicalEmail(scope.email) === scope.email
  );
}

function validMessage(message: ApplicantVerificationDeliveryMessage): boolean {
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    hasExactKeys(message as unknown as Record<string, unknown>, [
      "workspaceId",
      "workspaceSlug",
      "callId",
      "callSlug",
      "email",
      "verificationId",
      "token",
      "expiresAt",
    ]) &&
    validScope({
      workspaceId: message.workspaceId,
      workspaceSlug: message.workspaceSlug,
      callId: message.callId,
      callSlug: message.callSlug,
      email: message.email,
    }) &&
    IDENTIFIER_PATTERN.test(message.verificationId) &&
    RAW_TOKEN_PATTERN.test(message.token) &&
    canonicalInstant(message.expiresAt) === message.expiresAt &&
    Date.parse(message.expiresAt) > Date.now()
  );
}

function encodeDeliveryCookie(message: ApplicantVerificationDeliveryMessage): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      workspace: message.workspaceSlug,
      call: message.callSlug,
      email: message.email,
      verificationId: message.verificationId,
      token: message.token,
      expiresAt: message.expiresAt,
    } satisfies SimulatedDeliveryCookie),
    "utf8",
  ).toString("base64url");
}

function decodeDeliveryCookie(
  value: string | undefined,
  workspace: string,
  call: string,
): SimulatedDeliveryCookie | null {
  if (
    !value ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    !SLUG_PATTERN.test(workspace) ||
    !SLUG_PATTERN.test(call)
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const expiresAt = canonicalInstant(record.expiresAt);
    if (
      !hasExactKeys(record, [
        "version",
        "workspace",
        "call",
        "email",
        "verificationId",
        "token",
        "expiresAt",
      ]) ||
      record.version !== 1 ||
      record.workspace !== workspace ||
      record.call !== call ||
      canonicalEmail(record.email) !== record.email ||
      typeof record.verificationId !== "string" ||
      !IDENTIFIER_PATTERN.test(record.verificationId) ||
      typeof record.token !== "string" ||
      !RAW_TOKEN_PATTERN.test(record.token) ||
      expiresAt === null ||
      Date.parse(expiresAt) <= Date.now()
    ) {
      return null;
    }
    return record as SimulatedDeliveryCookie;
  } catch {
    return null;
  }
}

export function simulatedApplicantVerificationInboxEnabled(): boolean {
  const configuredMode = process.env.SYMPOSE_APPLICANT_VERIFICATION_DELIVERY;
  return (
    process.env.NODE_ENV !== "production" &&
    (configuredMode === SIMULATED_DELIVERY_MODE ||
      (configuredMode === undefined && process.env.NODE_ENV === "development"))
  );
}

export function simulatedApplicantVerificationInboxPath(
  workspace: string,
  call: string,
  suffix = "",
): string {
  return (
    `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(call)}/local-inbox` + suffix
  );
}

function cookiePath(workspace: string, call: string): string {
  return simulatedApplicantVerificationInboxPath(workspace, call);
}

function expireDeliveryCookie(store: MutableCookieStore, workspace: string, call: string): void {
  store.set(simulatedDeliveryCookieName(workspace, call), "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: cookiePath(workspace, call),
    maxAge: 0,
    priority: "high",
  });
}

function createSimulatedDeliveryPort(): ApplicantVerificationDeliveryPort {
  return Object.freeze({
    async prepareForRequest(scope: ApplicantVerificationDeliveryScope): Promise<void> {
      if (!validScope(scope)) throw new Error("Applicant verification delivery input is invalid.");
      const store = (await cookies()) as MutableCookieStore;
      const currentCookie = store.get(
        simulatedDeliveryCookieName(scope.workspaceSlug, scope.callSlug),
      );
      const existing = decodeDeliveryCookie(
        currentCookie?.value,
        scope.workspaceSlug,
        scope.callSlug,
      );
      if (currentCookie !== undefined && existing?.email !== scope.email) {
        expireDeliveryCookie(store, scope.workspaceSlug, scope.callSlug);
      }
    },

    async deliver(message: ApplicantVerificationDeliveryMessage): Promise<void> {
      if (!validMessage(message)) throw new Error("Applicant verification delivery input is invalid.");
      const store = (await cookies()) as MutableCookieStore;
      store.set(
        simulatedDeliveryCookieName(message.workspaceSlug, message.callSlug),
        encodeDeliveryCookie(message),
        {
          httpOnly: true,
          sameSite: "strict",
          secure: process.env.NODE_ENV === "production",
          path: cookiePath(message.workspaceSlug, message.callSlug),
          expires: new Date(message.expiresAt),
          priority: "high",
        },
      );
    },
  });
}

export function getApplicantVerificationDeliveryPort(): ApplicantVerificationDeliveryPort | null {
  return simulatedApplicantVerificationInboxEnabled() ? createSimulatedDeliveryPort() : null;
}

async function readDeliveryCookie(
  workspace: string,
  call: string,
): Promise<SimulatedDeliveryCookie | null> {
  if (!simulatedApplicantVerificationInboxEnabled()) return null;
  const store = await cookies();
  return decodeDeliveryCookie(
    store.get(simulatedDeliveryCookieName(workspace, call))?.value,
    workspace,
    call,
  );
}

export async function readSimulatedApplicantVerificationDelivery(
  workspace: string,
  call: string,
): Promise<SimulatedApplicantVerificationDelivery | null> {
  const delivery = await readDeliveryCookie(workspace, call);
  return delivery
    ? Object.freeze({ email: delivery.email, expiresAt: delivery.expiresAt })
    : null;
}

export async function readOpenableSimulatedApplicantVerificationDelivery(
  workspace: string,
  call: string,
): Promise<OpenableSimulatedApplicantVerificationDelivery | null> {
  const delivery = await readDeliveryCookie(workspace, call);
  return delivery
    ? Object.freeze({
        email: delivery.email,
        expiresAt: delivery.expiresAt,
        verificationId: delivery.verificationId,
        token: delivery.token,
      })
    : null;
}

export function clearSimulatedApplicantVerificationDelivery(
  store: MutableCookieStore,
  workspace: string,
  call: string,
): void {
  expireDeliveryCookie(store, workspace, call);
}
