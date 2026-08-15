import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../src/server/auth";
import {
  approvePlanAction,
  compilePlanAction,
  createEventAction,
  deliverOffersAction,
  freezeSnapshotAction,
  importFixtureAction,
  loginAction,
  proveCrossWorkspaceDenialAction,
  recordAttendanceAction,
  revokeTokenAction,
  sealReleaseAction,
  signOutAction,
  simulateAcceptanceAction,
  simulateDeclineAction,
} from "../../src/server/actions";

const mocks = vi.hoisted(() => {
  class SyntheticDenialError extends Error {
    readonly code: string;
    readonly target: string;

    constructor(code: string, message: string, target: string) {
      super(message);
      this.name = "DenialError";
      this.code = code;
      this.target = target;
    }
  }

  const cookieStore = {
    get: vi.fn(() => ({ value: "bearer-test-token" })),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const inertDb = {};

  return {
    cookieStore,
    inertDb,
    cookies: vi.fn(async () => cookieStore),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    getDb: vi.fn(() => inertDb),
    assertWorkspaceMatch: vi.fn(),
    DenialError: SyntheticDenialError,
    describeDenial: vi.fn((error: SyntheticDenialError) => ({
      code: error.code,
      message: error.message,
      target: error.target,
    })),
    isDenialError: vi.fn((error: unknown) => error instanceof SyntheticDenialError),
    requireCapability: vi.fn(() => undefined),
    roleHasCapability: vi.fn(() => true),
    resolveSession: vi.fn(),
    revokeSession: vi.fn(),
    rotateSession: vi.fn(),
    SESSION_COOKIE: "sympose_session",
    importFixtureEvidence: vi.fn(),
    freezeCohortSnapshot: vi.fn(),
    createEventWithUnit: vi.fn(),
    approvePlan: vi.fn(),
    compilePlan: vi.fn(),
    deliverOffers: vi.fn(),
    respondToOfferCommand: vi.fn(),
    revokePortalToken: vi.fn(),
    sealRelease: vi.fn(),
    recordAttendance: vi.fn(),
    getDashboardState: vi.fn(),
    getWorkspaceBySlug: vi.fn(),
    writeDenialAudit: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../src/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("../../src/server/auth", () => ({
  assertWorkspaceMatch: mocks.assertWorkspaceMatch,
  DenialError: mocks.DenialError,
  describeDenial: mocks.describeDenial,
  isDenialError: mocks.isDenialError,
  requireCapability: mocks.requireCapability,
  roleHasCapability: mocks.roleHasCapability,
  resolveSession: mocks.resolveSession,
  revokeSession: mocks.revokeSession,
  rotateSession: mocks.rotateSession,
  SESSION_COOKIE: mocks.SESSION_COOKIE,
}));
vi.mock("../../src/server/services/sources", () => ({
  importFixtureEvidence: mocks.importFixtureEvidence,
}));
vi.mock("../../src/server/services/cohorts", () => ({
  freezeCohortSnapshot: mocks.freezeCohortSnapshot,
}));
vi.mock("../../src/server/services/events", () => ({
  createEventWithUnit: mocks.createEventWithUnit,
}));
vi.mock("../../src/server/services/planning", () => ({
  approvePlan: mocks.approvePlan,
  compilePlan: mocks.compilePlan,
}));
vi.mock("../../src/server/services/commitments", () => ({
  deliverOffers: mocks.deliverOffers,
  respondToOfferCommand: mocks.respondToOfferCommand,
}));
vi.mock("../../src/server/services/publication", () => ({
  revokePortalToken: mocks.revokePortalToken,
  sealRelease: mocks.sealRelease,
}));
vi.mock("../../src/server/services/outcomes", () => ({
  recordAttendance: mocks.recordAttendance,
}));
vi.mock("../../src/server/services/queries", () => ({
  getDashboardState: mocks.getDashboardState,
  getWorkspaceBySlug: mocks.getWorkspaceBySlug,
}));
vi.mock("../../src/server/services/audit", () => ({
  writeDenialAudit: mocks.writeDenialAudit,
}));

const session: SessionInfo = {
  id: "session-1",
  tokenHash: "token-hash",
  accountId: "account-1",
  workspaceId: "workspace-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer",
  role: "organizer",
  workspaceSlug: "alpha",
  workspaceName: "Alpha Workspace",
};

const SENTINEL =
  "SENTINEL postgres://u:hunter2@10.0.0.5 ECONNREFUSED /opt/private/provider.ts sympose_session=cookie-secret portal-token payload@example.test";
const offerId = "123e4567-e89b-12d3-a456-426614174000";
const commandKey = "a".repeat(64);

function makeForm(entries: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    form.set(key, value);
  }
  return form;
}

const errorCases = [
  {
    name: "importFixtureAction",
    action: importFixtureAction,
    dependency: mocks.importFixtureEvidence,
    code: "IMPORT_FAILED",
    message: "Import could not be completed. Try again or contact an organizer.",
    formData: () => makeForm(),
  },
  {
    name: "freezeSnapshotAction",
    action: freezeSnapshotAction,
    dependency: mocks.freezeCohortSnapshot,
    code: "SNAPSHOT_FAILED",
    message: "Snapshot could not be frozen. Try again or contact an organizer.",
    formData: () => makeForm(),
  },
  {
    name: "createEventAction",
    action: createEventAction,
    dependency: mocks.createEventWithUnit,
    code: "EVENT_FAILED",
    message: "Event operation could not be completed. Try again or contact an organizer.",
    formData: () =>
      makeForm({ eventName: "Demo Event", unitName: "Main Unit", capacity: "10" }),
  },
  {
    name: "compilePlanAction",
    action: compilePlanAction,
    dependency: mocks.compilePlan,
    code: "COMPILE_FAILED",
    message: "Plan compilation could not be completed. Try again or contact an organizer.",
    formData: () => makeForm(),
  },
  {
    name: "approvePlanAction",
    action: approvePlanAction,
    dependency: mocks.approvePlan,
    code: "APPROVE_FAILED",
    message: "Plan approval could not be completed. Try again or contact an organizer.",
    formData: () => makeForm({ planVersionId: "plan-1", expectedCurrentPlanVersionId: "" }),
  },
  {
    name: "deliverOffersAction",
    action: deliverOffersAction,
    dependency: mocks.deliverOffers,
    code: "DELIVERY_FAILED",
    message: "Offer delivery could not be completed. Try again or contact an organizer.",
    formData: () => makeForm(),
  },
  {
    name: "simulateAcceptanceAction",
    action: simulateAcceptanceAction,
    dependency: mocks.respondToOfferCommand,
    code: "RESPONSE_FAILED",
    message: "Offer response could not be recorded. Try again or contact an organizer.",
    formData: () => makeForm({ offerId, commandKey }),
  },
  {
    name: "simulateDeclineAction",
    action: simulateDeclineAction,
    dependency: mocks.respondToOfferCommand,
    code: "RESPONSE_FAILED",
    message: "Offer response could not be recorded. Try again or contact an organizer.",
    formData: () => makeForm({ offerId, commandKey }),
  },
  {
    name: "sealReleaseAction",
    action: sealReleaseAction,
    dependency: mocks.sealRelease,
    code: "SEAL_FAILED",
    message: "Release could not be sealed. Try again or contact an organizer.",
    formData: () => makeForm(),
  },
  {
    name: "revokeTokenAction",
    action: revokeTokenAction,
    dependency: mocks.revokePortalToken,
    code: "REVOKE_FAILED",
    message: "Token revocation could not be completed. Try again or contact an organizer.",
    formData: () => makeForm({ tokenId: "token-1", reason: "Test revocation" }),
  },
  {
    name: "recordAttendanceAction",
    action: recordAttendanceAction,
    dependency: mocks.recordAttendance,
    code: "OBSERVATION_FAILED",
    message: "Attendance could not be recorded. Try again or contact an organizer.",
    formData: () =>
      makeForm({
        personId: "person-1",
        eventId: "event-1",
        programUnitId: "unit-1",
        observedAt: "2026-09-01T09:00:00.000Z",
      }),
  },
  {
    name: "proveCrossWorkspaceDenialAction",
    action: proveCrossWorkspaceDenialAction,
    dependency: mocks.assertWorkspaceMatch,
    code: "DENIAL_PROOF_FAILED",
    message: "Denial proof could not be completed. Try again or contact an organizer.",
    formData: () => makeForm({ targetSlug: "alpha" }),
  },
] as const;

describe("action error boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const serviceMock of [
      mocks.importFixtureEvidence,
      mocks.freezeCohortSnapshot,
      mocks.createEventWithUnit,
      mocks.approvePlan,
      mocks.compilePlan,
      mocks.deliverOffers,
      mocks.respondToOfferCommand,
      mocks.revokePortalToken,
      mocks.sealRelease,
      mocks.recordAttendance,
      mocks.getDashboardState,
      mocks.getWorkspaceBySlug,
      mocks.writeDenialAudit,
    ]) {
      serviceMock.mockReset();
    }
    mocks.assertWorkspaceMatch.mockReset();
    mocks.requireCapability.mockReset();
    mocks.resolveSession.mockReset();
    mocks.cookies.mockReset();
    mocks.getDb.mockReset();
    mocks.cookies.mockResolvedValue(mocks.cookieStore);
    mocks.getDb.mockReturnValue(mocks.inertDb);
    mocks.resolveSession.mockReturnValue(session);
    mocks.requireCapability.mockImplementation(() => undefined);
    mocks.getDashboardState.mockReturnValue({
      event: { event: { id: "event-1" } },
    });
  });

  it.each(errorCases)(
    "$name returns a stable redacted failure for plain dependency errors",
    async ({ action, dependency, code, message, formData }) => {
      dependency.mockImplementation(() => {
        throw new Error(SENTINEL);
      });

      const result = await action(null, formData());

      expect(dependency).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({ ok: false, code, message });
      expect(result.denial).toBeUndefined();

      const serialized = JSON.stringify(result) ?? "";
      for (const fragment of [
        "postgres://",
        "hunter2",
        "10.0.0.5",
        "ECONNREFUSED",
        "/opt/private/provider.ts",
        "sympose_session",
        "cookie-secret",
        "portal-token",
        "payload@example.test",
      ]) {
        expect(serialized).not.toContain(fragment);
      }
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(mocks.writeDenialAudit).not.toHaveBeenCalled();
    },
  );

  it.each(errorCases)(
    "$name returns the exact denial for a controlled dependency denial",
    async ({ action, dependency, formData }) => {
      dependency.mockImplementation(() => {
        throw new mocks.DenialError(
          "CAPABILITY_DENIED",
          "Controlled denial copy.",
          "phase0.pipeline.manage",
        );
      });

      const result = await action(null, formData());

      expect(dependency).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({
        ok: false,
        code: "CAPABILITY_DENIED",
        message: "Controlled denial copy.",
        denial: {
          code: "CAPABILITY_DENIED",
          message: "Controlled denial copy.",
          target: "phase0.pipeline.manage",
        },
      });
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(mocks.writeDenialAudit).not.toHaveBeenCalled();
    },
  );

  it("returns a session denial before importing for an unauthenticated request", async () => {
    mocks.resolveSession.mockReturnValue(null);

    const result = await importFixtureAction(null, makeForm());

    expect(result).toStrictEqual({
      ok: false,
      code: "SESSION_REQUIRED",
      message: "Sign in to continue.",
      denial: {
        code: "SESSION_REQUIRED",
        message: "Sign in to continue.",
        target: "session",
      },
    });
    expect(mocks.importFixtureEvidence).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.writeDenialAudit).not.toHaveBeenCalled();
  });

  it("returns and audits a controlled cross-workspace denial", async () => {
    const result = await proveCrossWorkspaceDenialAction(
      null,
      makeForm({ targetSlug: "beta" }),
    );

    expect(result).toStrictEqual({
      ok: false,
      code: "CROSS_WORKSPACE_DENIED",
      message: "The requested workspace is not available in this session.",
      denial: {
        code: "CROSS_WORKSPACE_DENIED",
        message: "The requested workspace is not available in this session.",
        target: "workspace",
      },
    });
    expect(mocks.writeDenialAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeDenialAudit).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      {
        actorKind: "account",
        actorRef: "account-1",
        code: "CROSS_WORKSPACE_DENIED",
        targetType: "workspace",
        targetId: "workspace",
      },
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("denies a foreign slug before any target lookup or side effect", async () => {
    mocks.getWorkspaceBySlug.mockImplementation(() => {
      throw new Error(SENTINEL);
    });

    const result = await proveCrossWorkspaceDenialAction(
      null,
      makeForm({ targetSlug: "invented-or-real" }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "CROSS_WORKSPACE_DENIED",
      message: "The requested workspace is not available in this session.",
    });
    expect(mocks.getWorkspaceBySlug).not.toHaveBeenCalled();
    expect(mocks.assertWorkspaceMatch).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps a denial-audit failure inside the stable action boundary", async () => {
    mocks.writeDenialAudit.mockImplementation(() => {
      throw new Error(SENTINEL);
    });

    await expect(
      proveCrossWorkspaceDenialAction(null, makeForm({ targetSlug: "beta" })),
    ).resolves.toStrictEqual({
      ok: false,
      code: "DENIAL_PROOF_FAILED",
      message: "Denial proof could not be completed. Try again or contact an organizer.",
    });
  });

  it("reports cache invalidation failure separately after the domain result committed", async () => {
    let committed = false;
    mocks.importFixtureEvidence.mockImplementation(() => {
      committed = true;
      return { imported: [], skipped: 0, personsCreated: 0 };
    });
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error(SENTINEL);
    });

    await expect(importFixtureAction(null, makeForm())).resolves.toStrictEqual({
      ok: false,
      code: "CACHE_INVALIDATION_FAILED",
      message: "The change was committed, but the page could not be refreshed. Reload to continue.",
    });
    expect(committed).toBe(true);
    expect(mocks.importFixtureEvidence).toHaveBeenCalledTimes(1);
  });

  it("returns the portfolio creation flow to the authenticated workspace event list", async () => {
    mocks.createEventWithUnit.mockReturnValue({
      eventId: "event-2",
      programUnitId: "unit-2",
      eventCreated: true,
      programUnitCreated: true,
    });
    mocks.redirect.mockImplementationOnce(() => {
      throw new Error("__PORTFOLIO_REDIRECT__");
    });

    await expect(
      createEventAction(
        null,
        makeForm({
          eventName: "Acme Evaluator Workshop",
          unitName: "Second synthetic session",
          capacity: "24",
          returnToPortfolio: "true",
        }),
      ),
    ).rejects.toThrow("__PORTFOLIO_REDIRECT__");

    expect(mocks.createEventWithUnit).toHaveBeenCalledWith(
      mocks.inertDb,
      "workspace-1",
      { kind: "account", ref: "account-1" },
      { eventName: "Acme Evaluator Workshop", unitName: "Second synthetic session", capacity: 24 },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/w/alpha/events");
    expect(mocks.redirect).toHaveBeenCalledWith("/w/alpha/events");
  });

  it("redacts login and sign-out dependency failures", async () => {
    mocks.getDb.mockImplementationOnce(() => {
      throw new Error(SENTINEL);
    });
    await expect(loginAction(null, makeForm({ accountId: "account-1" }))).resolves.toStrictEqual({
      ok: false,
      code: "LOGIN_FAILED",
      message: "Sign-in could not be completed. Try again or contact an organizer.",
    });

    mocks.revokeSession.mockImplementationOnce(() => {
      throw new Error(SENTINEL);
    });
    await expect(signOutAction(null, makeForm())).resolves.toStrictEqual({
      ok: false,
      code: "SIGN_OUT_FAILED",
      message: "Sign-out could not be completed. Try again or contact an organizer.",
    });
  });
});
