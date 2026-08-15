import { resolveCurrentPublicAgendaReleaseByChannel, resolveSavedPublicAgendaRelease } from "@/server/services/public-widgets/binding";
import { toPublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { getDb } from "@/server/db";
import {
  getPublicEmbedConfiguration,
  isEmbedConfigurationId,
  type PersistedEmbedConfiguration,
} from "@/server/services/public-widgets";
import { parseEmbedConfiguration, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import type { PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedPath } from "./_paths";

export { embedBasePath, embedPath } from "./_paths";

export type EmbedSearchParams = Record<string, string | string[] | undefined>;

export type EmbedQueryInput = URLSearchParams | EmbedSearchParams;

type PublicPersistedEmbedConfiguration = PersistedEmbedConfiguration & {
  readonly sealedReleaseId: string;
  readonly sealedEventName: string | null;
};

export interface EmbedRequest {
  readonly widget: PublicWidgetProjection;
  readonly configuration: EmbedConfiguration;
  readonly configurationId: string | null;
  readonly savedConfiguration: PublicPersistedEmbedConfiguration | null;
}

function firstQueryValue(input: EmbedQueryInput, key: string): string {
  if (input instanceof URLSearchParams) return input.get(key) ?? "";
  const value = input[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function embedConfigurationId(input: EmbedQueryInput): string | null {
  const value = firstQueryValue(input, "configId") || firstQueryValue(input, "config");
  return value || null;
}

function widgetForSavedConfiguration(
  channelReference: string,
  savedConfiguration: PublicPersistedEmbedConfiguration,
): PublicWidgetProjection | null {
  const durable = resolveSavedPublicAgendaRelease(
    getDb(),
    { ...savedConfiguration.scope, releaseId: savedConfiguration.sealedReleaseId },
    channelReference,
  );
  if (durable) return toPublicWidgetProjection(durable);
  return null;
}

function getDurableEmbedWidget(channelReference: string): PublicWidgetProjection | null {
  try {
    const projection = resolveCurrentPublicAgendaReleaseByChannel(getDb(), channelReference);
    return projection ? toPublicWidgetProjection(projection) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a public request in this order: current sealed release, then an optional durable
 * presentation configuration. Query-string settings remain a compatibility fallback when no
 * saved configuration ID is supplied.
 */
export function resolveEmbedRequest(
  channelReference: string,
  input: EmbedQueryInput,
): EmbedRequest | null {
  const configurationId = embedConfigurationId(input);
  if (!configurationId) {
    const widget = getDurableEmbedWidget(channelReference);
    return widget
      ? { widget, configuration: parseEmbedConfiguration(input), configurationId: null, savedConfiguration: null }
      : null;
  }
  if (!isEmbedConfigurationId(configurationId)) return null;
  let savedConfiguration: PublicPersistedEmbedConfiguration | null;
  try {
    savedConfiguration = getPublicEmbedConfiguration(getDb(), channelReference, configurationId);
  } catch {
    // Public callers receive a generic not-found boundary if the durable state is unavailable.
    return null;
  }
  if (!savedConfiguration) return null;
  const widget = widgetForSavedConfiguration(channelReference, savedConfiguration);
  if (!widget) return null;
  return {
    widget,
    configuration: savedConfiguration.configuration,
    configurationId,
    savedConfiguration,
  };
}

export function getEmbedWidget(
  channelReference: string,
  input?: EmbedQueryInput,
): PublicWidgetProjection | null {
  if (input === undefined) return getDurableEmbedWidget(channelReference);
  return resolveEmbedRequest(channelReference, input)?.widget ?? null;
}

export function queryString(params: EmbedSearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== "") query.set(key, first);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
