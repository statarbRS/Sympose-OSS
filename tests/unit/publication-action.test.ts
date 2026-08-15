import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/server/auth";

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

  class SyntheticAudienceError extends Error {
    readonly code: string;

    constructor(code: string, message = "safe audience failure") {
      super(message);
      this.name = "PublicationAudienceServiceError";
      this.code = code;
    }
  }

  const inertDb = {};
  return {
    cookieStore: { get: vi.fn(() => ({ value: "session-token" })) },
    cookies: vi.fn(async () => ({ get: vi.fn(() => ({ value: "session-token" })) })),
    inertDb,
    getDb: vi.fn(() => inertDb),
    getEvent: vi.fn(),
    assertWorkspaceMatch: vi.fn(),
    bindAudience: vi.fn(),
    catalogCurrentRelease: vi.fn(),
    createAudienceChannel: vi.fn(),
    createAudiencePolicy: vi.fn(),
    disableAudienceBinding: vi.fn(),
    disableAudienceChannel: vi.fn(),
    isDenialError: vi.fn((error: unknown) => error instanceof SyntheticDenialError),
    requireCapability: vi.fn(),
    resolveSession: vi.fn(),
    sealRelease: vi.fn(),
    supersedeAudiencePolicy: vi.fn(),
    revalidatePath: vi.fn(),
    SyntheticAudienceError,
    SyntheticDenialError,
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));
vi.mock("@/server/services/publication", () => ({ sealRelease: mocks.sealRelease }));
vi.mock("@/server/services/publication-audience", () => ({
  bindPublicationAudienceRelease: mocks.bindAudience,
  catalogCurrentPublicationRelease: mocks.catalogCurrentRelease,
  createPublicationAudienceChannel: mocks.createAudienceChannel,
  createPublicationAudiencePolicyVersion: mocks.createAudiencePolicy,
  disablePublicationAudienceBinding: mocks.disableAudienceBinding,
  disablePublicationAudienceChannel: mocks.disableAudienceChannel,
  PublicationAudienceServiceError: mocks.SyntheticAudienceError,
  supersedePublicationAudiencePolicy: mocks.supersedeAudiencePolicy,
}));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "sympose_session",
  assertWorkspaceMatch: mocks.assertWorkspaceMatch,
  isDenialError: mocks.isDenialError,
  requireCapability: mocks.requireCapability,
  resolveSession: mocks.resolveSession,
}));

import {
  publicationAudienceCommandAction,
  sealPublicationReleaseAction,
  type SealPublicationActionState,
} from "@/app/w/[workspace]/events/[eventId]/publication/actions";

const session: SessionInfo = {
  id: "session-1",
  tokenHash: "token-hash",
  accountId: "account-1",
  workspaceId: "workspace-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer",
  role: "organizer",
  workspaceSlug: "northstar",
  workspaceName: "Northstar",
};
const event = { id: "event-1", name: "Authority event" };
const scope = { workspaceSlug: "northstar", eventId: event.id } as const;
const idle: SealPublicationActionState = { ok: true, code: "IDLE", message: "", release: null };
const audienceIdle = { ok: true, code: "IDLE", message: "", receipt: null };

function actionForm(...fields: readonly [string, string][]): FormData {
  const form = new FormData();
  form.set("$ACTION_ID", "publication-action");
  for (const [name, value] of fields) form.set(name, value);
  return form;
}

const audienceReceipt = {
  id: "audience-receipt-1",
  action: "CHANNEL_CREATED" as const,
  resultState: "ACTIVE",
  replayed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSession.mockReturnValue(session);
  mocks.getEvent.mockReturnValue(event);
  mocks.sealRelease.mockReturnValue({
    releaseId: "release-1",
    fingerprint: "a".repeat(64),
    agendaCount: 1,
    tokenCount: 1,
    created: true,
    tokens: [],
  });
  mocks.createAudienceChannel.mockReturnValue({
    channel: { id: "channel-1" },
    receipt: audienceReceipt,
  });
});

describe("durable publication organizer action", () => {
  it("rejects unauthenticated, wrong-workspace, and malformed requests without sealing", async () => {
    mocks.resolveSession.mockReturnValueOnce(null);
    await expect(sealPublicationReleaseAction(scope, idle, actionForm())).resolves.toMatchObject({
      ok: false,
      code: "SESSION_REQUIRED",
    });
    expect(mocks.sealRelease).not.toHaveBeenCalled();

    mocks.resolveSession.mockReturnValue(session);
    mocks.assertWorkspaceMatch.mockImplementationOnce(() => {
      throw new mocks.SyntheticDenialError("CROSS_WORKSPACE_DENIED", "private denial", "workspace");
    });
    await expect(sealPublicationReleaseAction({ ...scope, workspaceSlug: "acme" }, idle, actionForm())).resolves.toMatchObject({
      ok: false,
      code: "PUBLICATION_DENIED",
    });
    expect(mocks.sealRelease).not.toHaveBeenCalled();

    await expect(sealPublicationReleaseAction({ workspaceSlug: "bad slug", eventId: event.id }, idle, actionForm())).resolves.toEqual({
      ok: false,
      code: "INVALID_INPUT",
      message: "The publication request is invalid.",
      release: null,
    });
    await expect(sealPublicationReleaseAction(scope, idle, actionForm(["forgedEventId", "event-foreign"]))).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(mocks.sealRelease).not.toHaveBeenCalled();
  });

  it("binds organizer audience commands to route scope and rejects forged or denied writes", async () => {
    const create = actionForm(
      ["intent", "CREATE_CHANNEL"],
      ["idempotencyKey", "create-public-agenda"],
      ["key", "public-agenda"],
      ["label", "Public agenda"],
      ["purpose", "EVENT_AGENDA"],
      ["audience", "PUBLIC"],
      ["visibility", "PUBLIC"],
    );
    await expect(publicationAudienceCommandAction(scope, audienceIdle, create)).resolves.toEqual({
      ok: true,
      code: "CHANNEL_CREATED",
      message: "The append-only publication audience receipt was recorded.",
      receipt: audienceReceipt,
    });
    expect(mocks.createAudienceChannel).toHaveBeenCalledWith(mocks.inertDb, session, {
      eventId: event.id,
      key: "public-agenda",
      label: "Public agenda",
      purpose: "EVENT_AGENDA",
      audience: "PUBLIC",
      visibility: "PUBLIC",
      idempotencyKey: "create-public-agenda",
    });

    const forged = actionForm(
      ["intent", "CREATE_CHANNEL"],
      ["idempotencyKey", "forged"],
      ["key", "forged"],
      ["label", "Forged"],
      ["purpose", "EVENT_AGENDA"],
      ["audience", "PUBLIC"],
      ["visibility", "PUBLIC"],
      ["eventId", "event-foreign"],
    );
    await expect(publicationAudienceCommandAction(scope, audienceIdle, forged)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(mocks.createAudienceChannel).toHaveBeenCalledTimes(1);

    mocks.requireCapability.mockImplementationOnce(() => {
      throw new mocks.SyntheticDenialError("CAPABILITY_DENIED", "private role detail", "capability");
    });
    await expect(publicationAudienceCommandAction(scope, audienceIdle, create)).resolves.toEqual({
      ok: false,
      code: "PUBLICATION_AUDIENCE_DENIED",
      message: "This publication audience action is not available for the current account and event.",
      receipt: null,
    });
    expect(mocks.createAudienceChannel).toHaveBeenCalledTimes(1);
  });

  it("preserves a committed audience receipt when cache revalidation fails", async () => {
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("cache refresh unavailable");
    });
    const create = actionForm(
      ["intent", "CREATE_CHANNEL"],
      ["idempotencyKey", "create-public-agenda-cache-failure"],
      ["key", "public-agenda"],
      ["label", "Public agenda"],
      ["purpose", "EVENT_AGENDA"],
      ["audience", "PUBLIC"],
      ["visibility", "PUBLIC"],
    );

    await expect(publicationAudienceCommandAction(scope, audienceIdle, create)).resolves.toEqual({
      ok: true,
      code: "CHANNEL_CREATED",
      message: "The append-only publication audience receipt was recorded.",
      receipt: audienceReceipt,
    });
    expect(mocks.createAudienceChannel).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("returns a truthful idempotent replay receipt and redacts unexpected failures", async () => {
    mocks.sealRelease.mockReturnValueOnce({
      releaseId: "release-1",
      fingerprint: "b".repeat(64),
      agendaCount: 1,
      tokenCount: 1,
      created: false,
      tokens: [],
    });
    const replay = await sealPublicationReleaseAction(scope, idle, actionForm());
    expect(replay).toEqual({
      ok: true,
      code: "PUBLICATION_RELEASE_REPLAYED",
      message: "That approved plan already has the same durable sealed release; no duplicate release or token was created.",
      release: { releaseId: "release-1", fingerprint: "b".repeat(64), agendaCount: 1, created: false },
    });
    expect(mocks.requireCapability).toHaveBeenCalledWith(mocks.inertDb, session, "phase0.pipeline.manage");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/w/northstar/events/event-1/publication");

    mocks.sealRelease.mockImplementationOnce(() => {
      throw new Error("postgres://secret/path");
    });
    const failure = await sealPublicationReleaseAction(scope, idle, actionForm());
    expect(failure).toEqual({
      ok: false,
      code: "PUBLICATION_FAILED",
      message: "The durable publication release could not be sealed.",
      release: null,
    });
    expect(JSON.stringify(failure)).not.toContain("postgres://");
  });

  it("returns the executed immutable receipt when cache revalidation fails after commit", async () => {
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("cache refresh unavailable");
    });

    await expect(sealPublicationReleaseAction(scope, idle, actionForm())).resolves.toEqual({
      ok: true,
      code: "PUBLICATION_RELEASE_SEALED",
      message: "The approved plan was sealed as the event's durable current release.",
      release: {
        releaseId: "release-1",
        fingerprint: "a".repeat(64),
        agendaCount: 1,
        created: true,
      },
    });
    expect(mocks.sealRelease).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("maps artifact readiness and integrity denials to one safe retryable response", async () => {
    for (const code of [
      "PUBLICATION_ARTIFACT_NOT_READY",
      "PUBLICATION_ARTIFACT_CARDINALITY_INVALID",
      "PUBLICATION_ARTIFACT_INTEGRITY_INVALID",
    ]) {
      mocks.sealRelease.mockImplementationOnce(() => {
        throw new Error(`${code}: private storage detail`);
      });
      await expect(sealPublicationReleaseAction(scope, idle, actionForm())).resolves.toEqual({
        ok: false,
        code: "PUBLICATION_ARTIFACT_NOT_READY",
        message: "Every required publication artifact must have one current committed byte-verified version with exact publication approval.",
        release: null,
      });
    }
  });
});
