import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_WORKSPACE_ID,
  EVALUATOR_WORKSPACE_SLUG,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { EVALUATOR_ARTIFACT_PERSON_ID } from "../../src/server/services/evaluator-speaker-identity";
import {
  issueSpeakerPortalToken,
  resetSpeakerPortalAccessRateLimitForTest,
  SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY,
} from "../../src/server/services/speaker-portal-access";
import {
  createSyntheticSpeakerOperationsRepository,
  getSyntheticSpeakerOperationsRepository,
  SpeakerOperationsConflictError,
  SpeakerOperationsInputError,
} from "../../src/server/services/speaker-operations";

const mocks = vi.hoisted(() => ({
  db: null as Db | null,
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
  getRouteSession: vi.fn(),
  headers: vi.fn(async () => new Headers({ "cf-connecting-ip": "caller-controlled" })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(), set: mocks.cookieSet, delete: mocks.cookieDelete })),
  headers: mocks.headers,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return { ...actual, getDb: () => mocks.db };
});
vi.mock("@/server/workspace-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workspace-session")>();
  return {
    ...actual,
    getRouteSession: mocks.getRouteSession,
  };
});

import {
  openAcmeSpeakerPortal,
  openSpeakerPortal,
  openSyntheticEvaluatorSpeakerPortal,
} from "@/app/speaker/actions";
import {
  createSpeakerTask,
  openSyntheticSpeakerPortalPreview,
} from "@/app/w/[workspace]/events/[eventId]/speakers/actions";

describe("synthetic evaluator speaker portal access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSpeakerPortalAccessRateLimitForTest();
    delete process.env.SYMPOSE_REAL_IP_HEADER;
    delete process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO;
    process.env.SYMPOSE_EVALUATOR_PROFILE = "local";
    vi.stubEnv("NODE_ENV", "test");
    mocks.db = openDb({ path: ":memory:", seed: false });
    seedWorkspaces(mocks.db);
    seedEvaluatorDemo(mocks.db);
    const persistedSession = mocks.db.prepare(
      `SELECT session_row.id AS id,
              session_row.token_hash AS tokenHash,
              session_row.expires_at AS expiresAt,
              account.email AS email,
              account.display_name AS displayName,
              account.role AS role,
              workspace.slug AS workspaceSlug,
              workspace.name AS workspaceName
         FROM sessions session_row
         JOIN accounts account
           ON account.id = session_row.account_id
          AND account.workspace_id = session_row.workspace_id
         JOIN workspaces workspace
           ON workspace.id = session_row.workspace_id
        WHERE session_row.account_id = ?
          AND session_row.workspace_id = ?
        ORDER BY session_row.created_at DESC, session_row.rowid DESC
        LIMIT 1`,
    ).get(EVALUATOR_ORGANIZER_ACCOUNT_ID, EVALUATOR_WORKSPACE_ID) as {
      id: string;
      tokenHash: string;
      expiresAt: string;
      email: string;
      displayName: string;
      role: "organizer";
      workspaceSlug: string;
      workspaceName: string;
    } | undefined;
    if (!persistedSession) throw new Error("test organizer session unavailable");
    mocks.getRouteSession.mockResolvedValue({
      ...persistedSession,
      accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      workspaceId: EVALUATOR_WORKSPACE_ID,
    });
  });

  afterEach(() => {
    if (mocks.db) closeDb(mocks.db);
    mocks.db = null;
    resetSpeakerPortalAccessRateLimitForTest();
    delete process.env.SYMPOSE_REAL_IP_HEADER;
    delete process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO;
    delete process.env.SYMPOSE_EVALUATOR_PROFILE;
    vi.unstubAllEnvs();
  });

  it("denies before token insertion when the production requester budget is exhausted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = "1";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(openSyntheticEvaluatorSpeakerPortal()).resolves.toBeUndefined();
    }

    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 8 });
    await expect(openSyntheticEvaluatorSpeakerPortal()).rejects.toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 8 });
    expect(mocks.cookieSet).toHaveBeenCalledTimes(8);
  });

  it("denies the production evaluator shortcut by default with no durable or cookie side effects", async () => {
    const before = {
      tokens: mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get(),
      speakers: mocks.db!.prepare("SELECT COUNT(*) AS count FROM event_speakers").get(),
      events: mocks.db!.prepare("SELECT COUNT(*) AS count FROM domain_events").get(),
      outbox: mocks.db!.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    };
    vi.stubEnv("NODE_ENV", "production");

    for (const configuredValue of [undefined, "", "0", "true"]) {
      if (configuredValue === undefined) delete process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO;
      else process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = configuredValue;
      await expect(openSyntheticEvaluatorSpeakerPortal()).rejects.toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    }

    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual(before.tokens);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM event_speakers").get()).toEqual(before.speakers);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual(before.events);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual(before.outbox);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("allows only the fixed production synthetic preview after the exact opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = "1";

    await expect(openSyntheticEvaluatorSpeakerPortal()).resolves.toBeUndefined();

    expect(mocks.db!.prepare(
      "SELECT workspace_id, event_id, person_id FROM speaker_portal_tokens",
    ).get()).toEqual({
      workspace_id: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      event_id: EVALUATOR_COMPATIBILITY_EVENT_ID,
      person_id: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "sympose_speaker_portal",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/speaker",
        maxAge: 1800,
      },
    );
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sympose_speaker_support_preview");
  });

  it("opens the primary Acme walkthrough on Mina's exact accepted assignment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = "1";

    await expect(openAcmeSpeakerPortal()).resolves.toBeUndefined();

    expect(mocks.db!.prepare(
      "SELECT workspace_id, event_id, person_id FROM speaker_portal_tokens",
    ).get()).toEqual({
      workspace_id: EVALUATOR_WORKSPACE_ID,
      event_id: EVALUATOR_EVENT_ID,
      person_id: EVALUATOR_ARTIFACT_PERSON_ID,
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "sympose_speaker_portal",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.objectContaining({ httpOnly: true, path: "/speaker", secure: true }),
    );
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sympose_speaker_support_preview");
  });

  it("denies the production opt-in outside the local evaluator profile with no side effects", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = "1";
    const before = {
      tokens: mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get(),
      speakers: mocks.db!.prepare("SELECT COUNT(*) AS count FROM event_speakers").get(),
      events: mocks.db!.prepare("SELECT COUNT(*) AS count FROM domain_events").get(),
      outbox: mocks.db!.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    };

    for (const profile of [undefined, "remote"]) {
      if (profile === undefined) delete process.env.SYMPOSE_EVALUATOR_PROFILE;
      else process.env.SYMPOSE_EVALUATOR_PROFILE = profile;
      await expect(openSyntheticEvaluatorSpeakerPortal()).rejects.toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");
    }

    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual(before.tokens);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM event_speakers").get()).toEqual(before.speakers);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual(before.events);
    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual(before.outbox);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("does not turn an arbitrary token into speaker access when the production preview is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO = "1";
    const formData = new FormData();
    formData.set("token", "a".repeat(64));

    await expect(openSpeakerPortal(formData)).rejects.toThrow("SPEAKER_PORTAL_ACCESS_UNAVAILABLE");

    expect(mocks.db!.prepare("SELECT COUNT(*) AS count FROM speaker_portal_tokens").get()).toEqual({ count: 0 });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("issues an organizer support preview for the exact accepted evaluator moderator", async () => {
    const formData = new FormData();
    formData.set("workspace", EVALUATOR_WORKSPACE_SLUG);
    formData.set("eventId", EVALUATOR_EVENT_ID);
    formData.set("personId", EVALUATOR_ARTIFACT_PERSON_ID);

    await expect(openSyntheticSpeakerPortalPreview(formData)).resolves.toBeUndefined();

    expect(mocks.db!.prepare("SELECT workspace_id, event_id, person_id FROM speaker_portal_tokens").get()).toEqual({
      workspace_id: EVALUATOR_WORKSPACE_ID,
      event_id: EVALUATOR_EVENT_ID,
      person_id: EVALUATOR_ARTIFACT_PERSON_ID,
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith("sympose_speaker_portal", expect.stringMatching(/^[a-f0-9]{64}$/u), expect.objectContaining({
      httpOnly: true,
      path: "/speaker",
    }));
    expect(mocks.cookieSet).toHaveBeenCalledWith("sympose_speaker_support_preview", "synthetic-local", expect.objectContaining({
      httpOnly: true,
      path: "/speaker",
    }));
  });

  it("derives canonical task templates and rejects hostile profile authority with no durable side effects", async () => {
    const repository = getSyntheticSpeakerOperationsRepository(mocks.db!);
    const organizer = {
      kind: "organizer" as const,
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    };
    const durableCounts = () => mocks.db!.prepare(
      `SELECT
         (SELECT COUNT(*) FROM domain_events) AS events,
         (SELECT COUNT(*) FROM outbox_messages) AS outbox,
         (SELECT COUNT(*) FROM audit_events) AS audit,
         (SELECT COUNT(*) FROM speaker_content_versions) AS versions`,
    ).get();
    const taskInput = {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      title: "Profile and public bio",
      description: "Confirm the reusable profile and event-facing override.",
      required: true,
      gate: "CONFIRMATION" as const,
      dueAt: "2026-09-12T17:00:00.000Z",
      owner: "SPEAKER" as const,
    };

    const beforeInvalidPair = durableCounts();
    expect(() => repository.createTask(organizer, {
      ...taskInput,
      kind: "PROFILE",
      contentKind: "BIO",
      idempotencyKey: "hostile-profile-pair",
    })).toThrow(SpeakerOperationsInputError);
    expect(durableCounts()).toEqual(beforeInvalidPair);

    const event = mocks.db!.prepare(
      `SELECT id, name, timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events
        WHERE workspace_id = ? AND id = ?`,
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as {
      id: string;
      name: string;
      timezone: string;
      startsAt: string;
      endsAt: string;
    };
    const competingRepository = createSyntheticSpeakerOperationsRepository({ db: mocks.db! });
    expect(competingRepository.getOrganizerProjection(organizer, event).roster
      .find((record) => record.person.personId === EVALUATOR_ARTIFACT_PERSON_ID)?.tasks
      .some((task) => task.kind === "PROFILE" && task.contentKind === "PROFILE")).toBe(false);

    const formData = new FormData();
    formData.set("workspace", EVALUATOR_WORKSPACE_SLUG);
    formData.set("eventId", EVALUATOR_EVENT_ID);
    formData.set("personId", EVALUATOR_ARTIFACT_PERSON_ID);
    formData.set("taskTemplate", "PROFILE");
    formData.set("kind", "BRIEFING");
    formData.set("contentKind", "BIO");
    formData.set("title", taskInput.title);
    formData.set("description", taskInput.description);
    formData.set("required", "true");
    formData.set("gate", taskInput.gate);
    formData.set("dueAt", taskInput.dueAt);
    formData.set("idempotencyKey", "canonical-profile-template");
    await expect(createSpeakerTask(formData)).resolves.toBeUndefined();

    const createdPayload = mocks.db!.prepare(
      `SELECT payload_json AS payloadJson
         FROM domain_events
        WHERE workspace_id = ?
          AND event_type = 'speaker.task.created'
          AND json_extract(payload_json, '$.idempotencyKey') = ?`,
    ).get(EVALUATOR_WORKSPACE_ID, "canonical-profile-template") as { payloadJson: string } | undefined;
    expect(createdPayload).toBeDefined();
    expect(JSON.parse(createdPayload!.payloadJson)).toMatchObject({
      operation: "create-task",
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      task: { kind: "PROFILE", contentKind: "PROFILE" },
    });

    const beforeDuplicate = durableCounts();
    expect(() => competingRepository.createTask(organizer, {
      ...taskInput,
      kind: "PROFILE",
      contentKind: "PROFILE",
      idempotencyKey: "duplicate-profile",
    })).toThrow(SpeakerOperationsConflictError);
    expect(durableCounts()).toEqual(beforeDuplicate);

    expect(repository.createTask(organizer, {
      ...taskInput,
      kind: "BRIEFING",
      contentKind: null,
      title: "Briefing attendance",
      description: "Confirm attendance at the local speaker briefing.",
      gate: null,
      required: false,
      idempotencyKey: "hostile-profile-pair",
    })).toMatchObject({ kind: "BRIEFING", contentKind: null });

    const actor = mocks.db!.prepare(
      `SELECT id AS sessionId, account_id AS accountId
         FROM sessions
        WHERE workspace_id = ? AND account_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_ORGANIZER_ACCOUNT_ID) as { sessionId: string; accountId: string };
    const issued = issueSpeakerPortalToken(mocks.db!, {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
    }, actor);
    const revision = repository.updateProfile(issued.token, {
      bio: "A durable canonical profile revision.",
      publicTitle: "Evaluation Lead",
      organization: "Signal Garden",
      socialLinks: [],
      headshot: null,
      idempotencyKey: "canonical-profile-revision",
    }, SPEAKER_PORTAL_TEST_LOOKUP_BUDGET_KEY);
    expect(revision.task).toMatchObject({ kind: "PROFILE", contentKind: "PROFILE" });
    expect(revision.version.payload).toMatchObject({ kind: "PROFILE", bio: "A durable canonical profile revision." });

    const reloaded = createSyntheticSpeakerOperationsRepository({ db: mocks.db! });
    const reloadedPortal = reloaded.getPortalProjection(issued.token, "speaker-content:canonical-profile-reload");
    const reloadedProfileTask = reloadedPortal?.tasks.find((task) => task.kind === "PROFILE" && task.contentKind === "PROFILE");
    expect(reloadedProfileTask?.review?.versions.at(-1)?.payload).toMatchObject({
      kind: "PROFILE",
      bio: "A durable canonical profile revision.",
    });
  });
});
