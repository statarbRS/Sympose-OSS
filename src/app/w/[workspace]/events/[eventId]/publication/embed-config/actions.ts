"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import { validatePublicReleaseForRead } from "@/server/services/publication";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  EmbedConfigurationAuthorizationError,
  EmbedConfigurationConflictError,
  EmbedConfigurationError,
  EmbedConfigurationInputError,
  saveEmbedConfiguration,
  type PersistedEmbedConfiguration,
} from "@/server/services/public-widgets/embed-config";
import {
  parseEmbedConfigurationValue,
  type EmbedConfiguration,
} from "@/server/services/public-widgets/embed";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export type PublicationEmbedConfigurationActionResult =
  | {
      readonly ok: true;
      readonly code: "PUBLICATION_EMBED_CONFIGURATION_SAVED";
      readonly created: boolean;
      readonly configuration: ReturnType<typeof publicConfiguration>;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

function formText(formData: FormData, name: string, maximum: number): string | null {
  const values = formData.getAll(name);
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    values[0].trim().length === 0 ||
    values[0].length > maximum ||
    CONTROL_CHARACTER.test(values[0])
  ) return null;
  return values[0].trim();
}

function formIdentifier(formData: FormData, name: string): string | null {
  const value = formText(formData, name, 240);
  return value && IDENTIFIER.test(value) ? value : null;
}

function parseConfiguration(formData: FormData): EmbedConfiguration | null {
  const search = formText(formData, "search", 8);
  if (!search || !["0", "1"].includes(search)) return null;
  return parseEmbedConfigurationValue({
    mode: formText(formData, "mode", 32),
    theme: formText(formData, "theme", 32),
    accent: formText(formData, "accent", 32),
    search: search === "1",
  });
}

function publicConfiguration(configuration: PersistedEmbedConfiguration) {
  return {
    id: configuration.id,
    label: configuration.label,
    configuration: configuration.configuration,
    savedAt: configuration.savedAt,
  } as const;
}

function actionFailure(error: unknown): PublicationEmbedConfigurationActionResult {
  if (error instanceof EmbedConfigurationInputError) {
    return { ok: false, code: error.code, message: "The embed configuration values are invalid." };
  }
  if (error instanceof EmbedConfigurationConflictError) {
    return { ok: false, code: error.code, message: "That idempotency key was already used for different embed values." };
  }
  if (error instanceof EmbedConfigurationAuthorizationError) {
    return { ok: false, code: error.code, message: "The embed configuration is not available in this event." };
  }
  if (error instanceof EmbedConfigurationError) {
    return { ok: false, code: error.code, message: "The embed configuration could not be saved." };
  }
  return { ok: false, code: "PUBLICATION_EMBED_CONFIGURATION_FAILED", message: "The embed configuration could not be saved." };
}

/**
 * Organizer scope is derived from the authenticated server session. The posted event ID is
 * treated only as a lookup key inside that workspace; the client cannot select a workspace or
 * publication channel by posting ownership fields.
 */
export async function savePublicationEmbedConfiguration(
  formData: FormData,
): Promise<PublicationEmbedConfigurationActionResult> {
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, session.workspaceSlug);
  try {
    const eventId = formIdentifier(formData, "eventId");
    const label = formText(formData, "label", 240);
    const idempotencyKey = formText(formData, "idempotencyKey", 240);
    const configuration = parseConfiguration(formData);
    if (!eventId || !label || !idempotencyKey || !configuration) {
      return { ok: false, code: "INVALID_INPUT", message: "The embed configuration values are invalid." };
    }
    const db = getDb();
    const event = getEvent(db, session.workspaceId, eventId);
    const currentRelease = event?.currentReleaseId
      ? validatePublicReleaseForRead(db, {
          workspaceId: session.workspaceId,
          eventId: event.id,
          releaseId: event.currentReleaseId,
          mode: "CURRENT",
        })
      : null;
    if (!event || !currentRelease) {
      return { ok: false, code: "EMBED_CONFIG_SCOPE_DENIED", message: "The embed configuration is not available in this event." };
    }
    const channelReference = publicReleaseReference({
      workspaceId: currentRelease.workspaceId,
      eventId: currentRelease.eventId,
      releaseId: currentRelease.releaseId,
    });
    const result = saveEmbedConfiguration(db, {
      scope: {
        workspaceId: session.workspaceId,
        eventId: event.id,
        channelReference,
      },
      label,
      configuration,
      idempotencyKey,
      actorAccountId: session.accountId,
    });
    revalidatePath(`/w/${encodeURIComponent(session.workspaceSlug)}/events/${encodeURIComponent(event.id)}/publication`);
    return {
      ok: true,
      code: "PUBLICATION_EMBED_CONFIGURATION_SAVED",
      created: result.created,
      configuration: publicConfiguration(result.configuration),
    };
  } catch (error) {
    return actionFailure(error);
  }
}
