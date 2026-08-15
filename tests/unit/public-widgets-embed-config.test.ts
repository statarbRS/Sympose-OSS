import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicWidgetBackLink, PublicWidgetShell } from "../../src/components/public-widgets/public-widget-shell";
import { SessionDetail } from "../../src/components/public-widgets/session-surfaces";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EmbedConfigurationAuthorizationError,
  EmbedConfigurationConflictError,
  getEmbedConfiguration,
  getPublicEmbedConfiguration,
  listEmbedConfigurations,
  saveEmbedConfiguration,
} from "../../src/server/services/public-widgets/embed-config";
import {
  buildEmbedSnippet,
  embedQuery,
  type EmbedConfiguration,
} from "../../src/server/services/public-widgets/embed";
import {
  SYNTHETIC_PUBLIC_PROJECTION,
  toPublicWidgetProjection,
} from "../../src/server/services/public-widgets/contracts";
import { publicReleaseReference } from "../../src/server/services/public-reference";
import { createSyntheticPublicationState } from "../../src/server/services/public-agenda";
import { bindPublicAgendaRelease } from "../../src/server/services/public-widgets/binding";
import {
  SYNTHETIC_PUBLIC_EVENT_ID,
  SYNTHETIC_PUBLIC_WORKSPACE_ID,
} from "../../src/server/services/scheduling";

const syntheticPublication = createSyntheticPublicationState({
  workspaceId: SYNTHETIC_PUBLIC_WORKSPACE_ID,
  eventId: SYNTHETIC_PUBLIC_EVENT_ID,
});
const syntheticReleaseReference = publicReleaseReference({
  workspaceId: syntheticPublication.currentRelease.workspaceId,
  eventId: syntheticPublication.currentRelease.eventId,
  releaseId: syntheticPublication.currentRelease.id,
});
const syntheticWidget = toPublicWidgetProjection(
  bindPublicAgendaRelease(syntheticPublication.currentRelease, syntheticReleaseReference),
);
const syntheticSessionReference = syntheticWidget.sessions.find((session) => session.title.includes("Operations without surprises"))?.publicReference;
if (!syntheticSessionReference) throw new Error("synthetic public session fixture missing");

const SESSION_CONFIGURATION: EmbedConfiguration = {
  mode: "sessions",
  theme: "light",
  accent: "teal",
  search: true,
};

const AGENDA_CONFIGURATION: EmbedConfiguration = {
  mode: "agenda",
  theme: "dark",
  accent: "violet",
  search: false,
};

function seedEvent(db: Db, workspaceId: string, eventId: string, suffix: string): void {
  const createdAt = "2026-08-12T10:00:00.000Z";
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(workspaceId, `${suffix}-workspace`, `${suffix} workspace`, createdAt);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle,
                         current_plan_version_id, current_release_id, created_at)
     VALUES (?, ?, ?, 'UTC', '2026-10-01T09:00:00.000Z', '2026-10-01T13:00:00.000Z',
             'planning', NULL, NULL, ?)`,
  ).run(eventId, workspaceId, `${suffix} draft event`, createdAt);
  const runId = `${eventId}-run`;
  const planVersionId = `${eventId}-plan`;
  db.prepare(
    `INSERT INTO plan_runs (id, workspace_id, event_id, status, input_fingerprint,
                            input_manifest_json, compiler, compiler_version, created_at)
     VALUES (?, ?, ?, 'FEASIBLE', ?, '{}', 'embed-test', '1', ?)`,
  ).run(runId, workspaceId, eventId, `${eventId}-input`, createdAt);
  db.prepare(
    `INSERT INTO plan_versions (id, workspace_id, event_id, run_id, version_number,
                                fingerprint, content_json, created_at)
     VALUES (?, ?, ?, ?, 1, ?, '{"assignments":[]}', ?)`,
  ).run(planVersionId, workspaceId, eventId, runId, `${eventId}-plan-fingerprint`, createdAt);
}

function sealEvent(
  db: Db,
  workspaceId: string,
  eventId: string,
  eventName: string,
  releaseId = `${eventId}-release`,
  sealedAt = "2026-08-12T10:05:00.000Z",
): void {
  const planVersionId = `${eventId}-plan`;
  const contentJson = canonicalJson({
    event: { name: eventName },
    sessions: [],
    speakers: [],
  });
  db.prepare(
    `INSERT INTO publication_releases
       (id, workspace_id, event_id, plan_version_id, audience_policy_version,
        commitment_watermark, fingerprint, content_json, sealed_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).run(
    releaseId,
    workspaceId,
    eventId,
    planVersionId,
    fingerprintOf({ releaseId, contentJson }),
    contentJson,
    sealedAt,
  );
  db.prepare("UPDATE events SET current_release_id = ? WHERE workspace_id = ? AND id = ?").run(
    releaseId,
    workspaceId,
    eventId,
  );
}

function scope(workspaceId: string, eventId: string) {
  return {
    workspaceId,
    eventId,
    channelReference: publicReleaseReference({
      workspaceId,
      eventId,
      releaseId: `${eventId}-release`,
    }),
  } as const;
}

describe("server-persisted public embed configurations", () => {
  it("persists event-scoped configurations, supports stable replay, and keeps tenants isolated", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedEvent(db, "workspace-a", "event-a", "alpha");
      seedEvent(db, "workspace-b", "event-b", "bravo");
      const eventScope = scope("workspace-a", "event-a");

      const first = saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Main sessions",
        configuration: SESSION_CONFIGURATION,
        idempotencyKey: "save-main-sessions",
      });
      const replay = saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Main sessions",
        configuration: SESSION_CONFIGURATION,
        idempotencyKey: "save-main-sessions",
      });
      const second = saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Compact agenda",
        configuration: AGENDA_CONFIGURATION,
        idempotencyKey: "save-compact-agenda",
      });

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.configuration).toEqual(first.configuration);
      expect(second.created).toBe(true);
      expect(second.configuration.id).not.toBe(first.configuration.id);
      expect(listEmbedConfigurations(db, eventScope)).toHaveLength(2);
      expect(getEmbedConfiguration(db, eventScope, first.configuration.id)).toEqual(first.configuration);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ?").get("workspace-a"),
      ).toEqual({ count: 2 });

      expect(() => saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Conflicting stable ID",
        configuration: AGENDA_CONFIGURATION,
        idempotencyKey: "save-conflicting-id",
        configurationId: first.configuration.id,
      })).toThrowError(EmbedConfigurationConflictError);

      const stored = db.prepare(
        `SELECT payload_json AS payloadJson, payload_fingerprint AS payloadFingerprint
         FROM domain_events WHERE workspace_id = ? ORDER BY created_at, rowid LIMIT 1`,
      ).get("workspace-a") as { payloadJson: string; payloadFingerprint: string };
      const payload = JSON.parse(stored.payloadJson) as Record<string, unknown>;
      expect(stored.payloadJson).toBe(canonicalJson(payload));
      expect(stored.payloadFingerprint).toBe(fingerprintOf(payload));

      expect(() => saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Changed after replay",
        configuration: SESSION_CONFIGURATION,
        idempotencyKey: "save-main-sessions",
      })).toThrowError(EmbedConfigurationConflictError);

      expect(() => saveEmbedConfiguration(db, {
        scope: scope("workspace-a", "event-b"),
        label: "Cross-tenant attempt",
        configuration: SESSION_CONFIGURATION,
        idempotencyKey: "cross-tenant",
      })).toThrowError(EmbedConfigurationAuthorizationError);
      expect(() => listEmbedConfigurations(db, scope("workspace-a", "event-b"))).toThrowError(
        EmbedConfigurationAuthorizationError,
      );
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE workspace_id = ?").get("workspace-a"),
      ).toEqual({ count: 2 });
    } finally {
      closeDb(db);
    }
  });

  it("fails closed before publication and binds a saved config to its exact current release reference", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedEvent(db, "workspace-a", "event-a", "alpha");
      const eventScope = scope("workspace-a", "event-a");
      const saved = saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Public agenda",
        configuration: AGENDA_CONFIGURATION,
        idempotencyKey: "public-agenda",
      });

      expect(getPublicEmbedConfiguration(db, eventScope.channelReference, saved.configuration.id)).toBeNull();

      sealEvent(db, "workspace-a", "event-a", "Sealed event name");
      const publicConfiguration = getPublicEmbedConfiguration(db, eventScope.channelReference, saved.configuration.id);
      expect(publicConfiguration).toMatchObject({
        ...saved.configuration,
        sealedReleaseId: "event-a-release",
        sealedEventName: "Sealed event name",
      });

      db.prepare("UPDATE events SET name = ? WHERE workspace_id = ? AND id = ?").run(
        "Draft-only event rename",
        "workspace-a",
        "event-a",
      );
      expect(getPublicEmbedConfiguration(db, eventScope.channelReference, saved.configuration.id)?.sealedEventName).toBe(
        "Sealed event name",
      );

      const replacementReleaseId = "event-a-release-v2";
      const replacementReference = publicReleaseReference({
        workspaceId: "workspace-a",
        eventId: "event-a",
        releaseId: replacementReleaseId,
      });
      sealEvent(
        db,
        "workspace-a",
        "event-a",
        "Replacement sealed event name",
        replacementReleaseId,
        "2026-08-12T10:10:00.000Z",
      );

      expect(getPublicEmbedConfiguration(db, eventScope.channelReference, saved.configuration.id)).toBeNull();
      expect(getPublicEmbedConfiguration(db, replacementReference, saved.configuration.id)).toBeNull();
      expect(getEmbedConfiguration(db, eventScope, saved.configuration.id)).toEqual(saved.configuration);

      const replacement = saveEmbedConfiguration(db, {
        scope: { ...eventScope, channelReference: replacementReference },
        label: "Replacement public agenda",
        configuration: AGENDA_CONFIGURATION,
        idempotencyKey: "replacement-public-agenda",
      });
      expect(getPublicEmbedConfiguration(db, replacementReference, replacement.configuration.id)).toMatchObject({
        ...replacement.configuration,
        sealedReleaseId: replacementReleaseId,
        sealedEventName: "Replacement sealed event name",
      });
    } finally {
      closeDb(db);
    }
  });

  it("rejects malformed values and produces an absolute stable-ID iframe", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedEvent(db, "workspace-a", "event-a", "alpha");
      expect(() => saveEmbedConfiguration(db, {
        scope: scope("workspace-a", "event-a"),
        label: "Malformed",
        configuration: {
          ...SESSION_CONFIGURATION,
          mode: "not-a-mode",
        } as unknown as EmbedConfiguration,
        idempotencyKey: "malformed",
      })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      closeDb(db);
    }

    const query = embedQuery(AGENDA_CONFIGURATION, "stable-config-1");
    expect(query).toContain("configId=stable-config-1");
    expect(buildEmbedSnippet(syntheticReleaseReference, AGENDA_CONFIGURATION, "https://widgets.example.test", "stable-config-1"))
      .toContain(`src="https://widgets.example.test/embed/${syntheticReleaseReference}?mode=agenda&theme=dark&accent=violet&search=0&configId=stable-config-1"`);
  });

  it("enforces the bounded event configuration set and preserves agenda origin on detail return", async () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedEvent(db, "workspace-a", "event-a", "alpha");
      const eventScope = scope("workspace-a", "event-a");
      for (let index = 0; index < 12; index += 1) {
        saveEmbedConfiguration(db, {
          scope: eventScope,
          label: `Configuration ${index}`,
          configuration: index % 2 === 0 ? SESSION_CONFIGURATION : AGENDA_CONFIGURATION,
          idempotencyKey: `bounded-${index}`,
        });
      }
      expect(() => saveEmbedConfiguration(db, {
        scope: eventScope,
        label: "Configuration 13",
        configuration: SESSION_CONFIGURATION,
        idempotencyKey: "bounded-12",
      })).toThrowError(expect.objectContaining({ code: "EMBED_CONFIG_LIMIT_REACHED" }));
    } finally {
      closeDb(db);
    }

    const syntheticSession = syntheticWidget.sessions.find(
      (session) => session.publicReference === syntheticSessionReference,
    );
    if (!syntheticSession) throw new Error("synthetic public session fixture missing");
    const backHref = `/embed/${syntheticReleaseReference}/agenda/2026-09-16?${embedQuery(AGENDA_CONFIGURATION)}`;
    const markup = renderToStaticMarkup(createElement(
      PublicWidgetShell,
      {
        widget: syntheticWidget,
        active: "sessions",
        configuration: AGENDA_CONFIGURATION,
        configurationId: null,
        children: [
          createElement(PublicWidgetBackLink, { key: "back", href: backHref, children: "← Back to agenda" }),
          createElement(SessionDetail, {
            key: "detail",
            widget: syntheticWidget,
            session: syntheticSession,
            configuration: AGENDA_CONFIGURATION,
            configurationId: null,
          }),
        ],
      },
    ));
    expect(markup).toContain("← Back to agenda");
    expect(markup).toContain(`/embed/${syntheticReleaseReference}/agenda/2026-09-16?mode=agenda&amp;theme=dark&amp;accent=violet&amp;search=0`);
  });
});
