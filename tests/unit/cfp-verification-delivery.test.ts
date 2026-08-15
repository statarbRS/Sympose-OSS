import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  const set = vi.fn(
    (
      name: string,
      value: string,
      options: Readonly<{ maxAge?: number }>,
    ) => {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  );
  const store = {
    get: vi.fn((name: string) => {
      const value = values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set,
  };
  return { values, set, store, cookies: vi.fn(async () => store) };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import {
  simulatedDeliveryCookieName,
  verificationCookieName,
} from "../../src/app/cfp/cookie-scope.server";
import { GET as openSimulatedDelivery } from "../../src/app/cfp/[workspace]/[callSlug]/local-inbox/open/route";
import {
  getApplicantVerificationDeliveryPort,
  readOpenableSimulatedApplicantVerificationDelivery,
  readSimulatedApplicantVerificationDelivery,
  simulatedApplicantVerificationInboxEnabled,
  simulatedApplicantVerificationInboxPath,
} from "../../src/app/cfp/verification-delivery.server";

const WORKSPACE_ID = "workspace_northstar";
const WORKSPACE = "northstar";
const CALL_ID = "call_community_stage";
const CALL = "community-stage";
const EMAIL = "applicant@example.test";
const TOKEN = "verification-token-that-is-long-enough-123456789";
const EXPIRES_AT = "2099-08-11T12:49:56.000Z";

const scope = Object.freeze({
  workspaceId: WORKSPACE_ID,
  workspaceSlug: WORKSPACE,
  callId: CALL_ID,
  callSlug: CALL,
  email: EMAIL,
});

const message = Object.freeze({
  ...scope,
  verificationId: "verification_delivery_1",
  token: TOKEN,
  expiresAt: EXPIRES_AT,
});

function expectCredentialFreeLocation(response: Response, expectedLocation: string): void {
  const location = response.headers.get("location");
  expect(location).toBe(expectedLocation);
  expect(location).not.toContain(message.verificationId);
  expect(location).not.toContain(TOKEN);

  const destination = new URL(location!, "https://sympose.test");
  expect(destination.searchParams.has("verification")).toBe(false);
  expect(destination.searchParams.has("token")).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SYMPOSE_APPLICANT_VERIFICATION_DELIVERY", "simulated");
  mocks.values.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("applicant verification delivery", () => {
  it("requires the explicit non-production simulator gate", () => {
    expect(simulatedApplicantVerificationInboxEnabled()).toBe(true);
    expect(getApplicantVerificationDeliveryPort()).not.toBeNull();

    vi.stubEnv("SYMPOSE_APPLICANT_VERIFICATION_DELIVERY", "");
    expect(simulatedApplicantVerificationInboxEnabled()).toBe(false);
    expect(getApplicantVerificationDeliveryPort()).toBeNull();

    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "development");
    expect(simulatedApplicantVerificationInboxEnabled()).toBe(true);
    expect(getApplicantVerificationDeliveryPort()).not.toBeNull();

    vi.stubEnv("SYMPOSE_APPLICANT_VERIFICATION_DELIVERY", "simulated");
    vi.stubEnv("NODE_ENV", "production");
    expect(simulatedApplicantVerificationInboxEnabled()).toBe(false);
    expect(getApplicantVerificationDeliveryPort()).toBeNull();
  });

  it("stores one httpOnly exact-path delivery and exposes no secret in the inbox projection", async () => {
    const port = getApplicantVerificationDeliveryPort();
    expect(port).not.toBeNull();
    await port!.prepareForRequest(scope);
    await port!.deliver(message);

    const projection = await readSimulatedApplicantVerificationDelivery(WORKSPACE, CALL);
    expect(projection).toEqual({ email: EMAIL, expiresAt: EXPIRES_AT });
    expect(JSON.stringify(projection)).not.toContain(TOKEN);
    expect(JSON.stringify(projection)).not.toContain(message.verificationId);
    expect(await readSimulatedApplicantVerificationDelivery("foreign", CALL)).toBeNull();
    expect(await readSimulatedApplicantVerificationDelivery(WORKSPACE, "foreign-call")).toBeNull();

    const openable = await readOpenableSimulatedApplicantVerificationDelivery(WORKSPACE, CALL);
    expect(openable).toEqual({
      email: EMAIL,
      expiresAt: EXPIRES_AT,
      verificationId: message.verificationId,
      token: TOKEN,
    });
    const deliveryWrite = mocks.set.mock.calls.at(-1);
    expect(deliveryWrite?.[0]).toBe(simulatedDeliveryCookieName(WORKSPACE, CALL));
    expect(deliveryWrite?.[2]).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: simulatedApplicantVerificationInboxPath(WORKSPACE, CALL),
      expires: new Date(EXPIRES_AT),
      priority: "high",
    });
  });

  it("preserves only a same-email retry and clears a mismatched email scope", async () => {
    const port = getApplicantVerificationDeliveryPort();
    expect(port).not.toBeNull();
    await port!.deliver(message);
    const cookieName = simulatedDeliveryCookieName(WORKSPACE, CALL);
    const original = mocks.values.get(cookieName);

    mocks.set.mockClear();
    await port!.prepareForRequest(scope);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.values.get(cookieName)).toBe(original);

    await port!.prepareForRequest({ ...scope, email: "other@example.test" });
    expect(mocks.set).toHaveBeenCalledWith(
      cookieName,
      "",
      expect.objectContaining({
        httpOnly: true,
        path: simulatedApplicantVerificationInboxPath(WORKSPACE, CALL),
        maxAge: 0,
      }),
    );
    expect(mocks.values.has(cookieName)).toBe(false);
  });

  it("rejects malformed delivery input without persisting it", async () => {
    const port = getApplicantVerificationDeliveryPort();
    expect(port).not.toBeNull();
    await expect(
      port!.deliver({ ...message, token: "short" }),
    ).rejects.toThrow("delivery input is invalid");
    expect(mocks.values.size).toBe(0);
  });

  it("hands an exact scoped delivery to verification without putting credentials in Location", async () => {
    const port = getApplicantVerificationDeliveryPort();
    expect(port).not.toBeNull();
    await port!.deliver(message);
    const beforeOpen = Date.now();

    const response = await openSimulatedDelivery(
      new Request(`https://sympose.test/cfp/${WORKSPACE}/${CALL}/local-inbox/open`),
      { params: Promise.resolve({ workspace: WORKSPACE, callSlug: CALL }) },
    );

    expect(response.status).toBe(303);
    expectCredentialFreeLocation(response, `/cfp/${WORKSPACE}/${CALL}/verify`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const pendingName = verificationCookieName(WORKSPACE, CALL);
    const expectedPendingValue = Buffer.from(
      JSON.stringify({
        version: 1,
        workspace: WORKSPACE,
        call: CALL,
        verificationId: message.verificationId,
        token: TOKEN,
      }),
      "utf8",
    ).toString("base64url");
    const pending = response.cookies.get(pendingName);
    expect(pending).toMatchObject({
      name: pendingName,
      value: expectedPendingValue,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/cfp",
      maxAge: 15 * 60,
      priority: "high",
    });
    expect(Object.keys(pending ?? {}).sort()).toEqual(
      [
        "expires",
        "httpOnly",
        "maxAge",
        "name",
        "path",
        "priority",
        "sameSite",
        "secure",
        "value",
      ].sort(),
    );
    expect(pending?.expires).toBeInstanceOf(Date);
    if (!(pending?.expires instanceof Date)) throw new Error("pending cookie expiry is not a Date");
    expect(pending.expires.getTime()).toBeGreaterThanOrEqual(beforeOpen + 15 * 60 * 1_000);
    expect(pending.expires.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1_000);
    expect(JSON.parse(Buffer.from(pending!.value, "base64url").toString("utf8"))).toEqual({
      version: 1,
      workspace: WORKSPACE,
      call: CALL,
      verificationId: message.verificationId,
      token: TOKEN,
    });

    const deliveryName = simulatedDeliveryCookieName(WORKSPACE, CALL);
    expect(response.cookies.get(deliveryName)).toEqual({
      name: deliveryName,
      value: "",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: simulatedApplicantVerificationInboxPath(WORKSPACE, CALL),
      maxAge: 0,
      priority: "high",
    });
    expect(response.cookies.getAll().map((cookie) => cookie.name).sort()).toEqual(
      [deliveryName, pendingName].sort(),
    );
  });

  it("rejects a missing or differently scoped delivery with only a credential-free Location", async () => {
    const port = getApplicantVerificationDeliveryPort();
    expect(port).not.toBeNull();
    await port!.deliver(message);
    const otherCall = "other-call";

    const response = await openSimulatedDelivery(
      new Request(`https://sympose.test/cfp/${WORKSPACE}/${otherCall}/local-inbox/open`),
      { params: Promise.resolve({ workspace: WORKSPACE, callSlug: otherCall }) },
    );

    expect(response.status).toBe(303);
    expectCredentialFreeLocation(
      response,
      `/cfp/${WORKSPACE}/${otherCall}/local-inbox?delivery=missing`,
    );
    expect(response.cookies.get(verificationCookieName(WORKSPACE, otherCall))).toBeUndefined();
    expect(response.cookies.getAll()).toEqual([
      {
        name: simulatedDeliveryCookieName(WORKSPACE, otherCall),
        value: "",
        httpOnly: true,
        sameSite: "strict",
        secure: false,
        path: simulatedApplicantVerificationInboxPath(WORKSPACE, otherCall),
        maxAge: 0,
        priority: "high",
      },
    ]);
  });
});
