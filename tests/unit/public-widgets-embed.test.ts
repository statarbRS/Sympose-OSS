import { describe, expect, it } from "vitest";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import {
  buildEmbedSnippet,
  buildPublicWidgetFeed,
  embedConfigurationStorageKey,
  embedQuery,
  parseSavedEmbedConfigurations,
  parseEmbedConfiguration,
  parseStoredEmbedConfiguration,
  serializeSavedEmbedConfigurations,
} from "@/server/services/public-widgets/embed";

const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);
const releaseReference = widget.release.releaseReference;

describe("public widget configuration, snippet, and feed", () => {
  it("allowlists configuration values and falls back for hostile input", () => {
    const configuration = parseEmbedConfiguration(new URLSearchParams({
      mode: "<script>alert(1)</script>",
      theme: "javascript:alert(2)",
      accent: "url(https://evil.test)",
      search: "false",
    }));
    expect(configuration).toEqual({ mode: "sessions", theme: "light", accent: "teal", search: false });
    expect(embedQuery(configuration)).toBe("mode=sessions&theme=light&accent=teal&search=0");
  });

  it("builds a stable iframe snippet without accepting HTML as configuration", () => {
    const snippet = buildEmbedSnippet(releaseReference, {
      mode: "agenda",
      theme: "dark",
      accent: "violet",
      search: false,
    }, "https://widgets.example.test");
    expect(snippet).toContain(`src="https://widgets.example.test/embed/${releaseReference}?mode=agenda&theme=dark&accent=violet&search=0"`);
    expect(snippet).toContain('loading="lazy"');
    expect(snippet).not.toContain("<script");
    expect(snippet).not.toContain("dangerouslySetInnerHTML");
    expect(() => buildEmbedSnippet('demo" onload="alert(1)', {
      mode: "sessions",
      theme: "light",
      accent: "teal",
      search: true,
    })).toThrow("EMBED_CHANNEL_REFERENCE_INVALID");
  });

  it("rejects non-http, credential-bearing, and injected base origins", () => {
    const configuration = {
      mode: "sessions",
      theme: "light",
      accent: "teal",
      search: true,
    } as const;
    const invalidOrigins = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:password@example.test",
      "https://example.test/embed?next=javascript:alert(1)",
      'https://example.test" onload="alert(1)',
    ];

    for (const origin of invalidOrigins) {
      expect(() => buildEmbedSnippet(releaseReference, configuration, origin)).toThrow("EMBED_BASE_ORIGIN_INVALID");
    }
  });

  it("exposes only public feed fields and keeps the sealed release identity stable", () => {
    const feed = buildPublicWidgetFeed(widget);
    expect(feed.schema).toBe("public-widget-feed/v1");
    expect(feed.channelReference).toBe(releaseReference);
    expect(feed.releaseNumber).toBe(1);
    expect(JSON.stringify(feed)).not.toContain("workspace-synthetic-public");
    expect(JSON.stringify(feed)).not.toContain("release-synthetic-public-v1");
    expect(JSON.stringify(feed)).not.toContain("organizer-only");
    expect(feed.sessions.map((session) => session.publicReference)).toEqual(widget.sessions.map((session) => session.publicReference));
    expect(feed.releaseReference).toBe(widget.release.releaseReference);
  });

  it("round-trips allowlisted saved configurations and supports the itinerary surface", () => {
    const configuration = parseEmbedConfiguration(new URLSearchParams({ mode: "itinerary", theme: "dark", accent: "coral", search: "0" }));
    const saved = [{
      id: "itinerary-dark-coral-compact",
      label: "itinerary · dark · coral · compact",
      configuration,
      savedAt: "2026-08-12T10:00:00.000Z",
    }] as const;
    const raw = serializeSavedEmbedConfigurations(saved);

    expect(parseSavedEmbedConfigurations(raw)).toEqual(saved);
    expect(parseStoredEmbedConfiguration(JSON.stringify(configuration))).toEqual(configuration);
    expect(embedConfigurationStorageKey(releaseReference)).toBe(`sympose:public-embed-config:${releaseReference}`);
    expect(parseSavedEmbedConfigurations(JSON.stringify([{ ...saved[0], configuration: { ...configuration, mode: "<script>" } }]))).toEqual([]);
  });
});
