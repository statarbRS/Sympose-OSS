import { cookies } from "next/headers";

import { getDb } from "@/server/db";
import {
  assertWorkspaceMatch,
  isDenialError,
  requireCapability,
  resolveSession,
  SESSION_COOKIE,
  type SessionInfo,
} from "@/server/auth";
import { getEvent } from "@/server/services/events";
import { validatePublicReleaseForRead } from "@/server/services/publication";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  EmbedConfigurationError,
  listEmbedConfigurations,
  saveEmbedConfiguration,
  type PersistedEmbedConfiguration,
} from "@/server/services/public-widgets/embed-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 32 * 1024;

type RouteContext = {
  readonly params: Promise<{ workspace: string; eventId: string }>;
};

function publicConfiguration(configuration: PersistedEmbedConfiguration) {
  return {
    id: configuration.id,
    label: configuration.label,
    configuration: configuration.configuration,
    savedAt: configuration.savedAt,
  } as const;
}

async function organizerContext(
  context: RouteContext,
): Promise<{
  readonly session: SessionInfo;
  readonly eventId: string;
  readonly channelReference: string;
} | null> {
  const { workspace, eventId } = await context.params;
  const db = getDb();
  const store = await cookies();
  const session = resolveSession(db, store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  try {
    assertWorkspaceMatch(session, workspace);
    requireCapability(db, session, "phase0.pipeline.manage");
  } catch (error) {
    if (isDenialError(error)) return null;
    throw error;
  }
  const event = getEvent(db, session.workspaceId, eventId);
  const currentRelease = event?.currentReleaseId
    ? validatePublicReleaseForRead(db, {
        workspaceId: session.workspaceId,
        eventId: event.id,
        releaseId: event.currentReleaseId,
        mode: "CURRENT",
      })
    : null;
  if (!event || !currentRelease) return null;
  return {
    session,
    eventId: event.id,
    channelReference: publicReleaseReference({
      workspaceId: currentRelease.workspaceId,
      eventId: currentRelease.eventId,
      releaseId: currentRelease.releaseId,
    }),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authorized = await organizerContext(context);
  if (!authorized) return response({ error: "PUBLICATION_EMBED_CONFIGURATION_NOT_FOUND" }, 404);
  try {
    const configurations = listEmbedConfigurations(getDb(), {
      workspaceId: authorized.session.workspaceId,
      eventId: authorized.eventId,
      channelReference: authorized.channelReference,
    });
    return response({ configurations: configurations.map(publicConfiguration) });
  } catch {
    return response({ error: "PUBLICATION_EMBED_CONFIGURATION_NOT_FOUND" }, 404);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authorized = await organizerContext(context);
  if (!authorized) return response({ error: "PUBLICATION_EMBED_CONFIGURATION_NOT_FOUND" }, 404);
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > MAX_REQUEST_BYTES) {
      return response({ error: "REQUEST_TOO_LARGE" }, 413);
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
      return response({ error: "REQUEST_TOO_LARGE" }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return response({ error: "INVALID_INPUT" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "INVALID_INPUT" }, 400);
    }
    const value = body as Record<string, unknown>;
    const result = saveEmbedConfiguration(getDb(), {
      scope: {
        workspaceId: authorized.session.workspaceId,
        eventId: authorized.eventId,
        channelReference: authorized.channelReference,
      },
      label: value.label as string,
      configuration: value.configuration as never,
      idempotencyKey: value.idempotencyKey as string,
      configurationId: value.configurationId as string | undefined,
      actorAccountId: authorized.session.accountId,
    });
    return response({
      created: result.created,
      configuration: publicConfiguration(result.configuration),
    }, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof EmbedConfigurationError) {
      const status = error.code === "INVALID_INPUT"
        ? 400
        : error.code === "IDEMPOTENCY_KEY_CONFLICT" || error.code === "EMBED_CONFIG_LIMIT_REACHED"
          ? 409
          : error.code === "PERSISTENCE_FAILED"
            ? 500
            : 404;
      return response({ error: error.code }, status);
    }
    return response({ error: "PUBLICATION_EMBED_CONFIGURATION_FAILED" }, 500);
  }
}
