import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PersonHistoryShowcaseView,
  buildPersonHistoryShowcase,
  loadPersonHistoryShowcase,
  type BuildPersonHistoryShowcaseInput,
} from "@/components/person-history/person-relationship-history";
import type { SessionInfo } from "@/server/auth";
import { closeDb, openDb } from "@/server/db";
import {
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
  EVALUATOR_WORKSPACE_SLUG,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import type { EventRow } from "@/server/services/events";
import type {
  InstitutionalMemoryResult,
  MemorySourceRecord,
} from "@/server/services/institutional-memory";

const WORKSPACE_ID = "workspace-history";
const PERSON_ID = "person-history";
const FINGERPRINT = "a".repeat(64);

function event(id: string, name: string, startsAt: string): EventRow {
  return {
    id,
    name,
    timezone: "UTC",
    startsAt,
    endsAt: startsAt.replace("09:00", "17:00"),
    lifecycle: "closed",
    currentPlanVersionId: null,
    currentReleaseId: null,
    createdAt: startsAt,
  };
}

function source(
  family: MemorySourceRecord["family"],
  eventId: string | null,
  ids: Record<string, string>,
  data: Record<string, unknown>,
  recordedAt: string,
  options: Partial<Pick<MemorySourceRecord, "currentUse" | "authority" | "fingerprint" | "fingerprintOrigin">> = {},
): MemorySourceRecord {
  return {
    family,
    eventId,
    ids,
    fingerprint: options.fingerprint ?? FINGERPRINT,
    fingerprintOrigin: options.fingerprintOrigin ?? "stored",
    recordedAt,
    currentUse: options.currentUse ?? "historical",
    authority: options.authority ?? "historical-record",
    carriesAuthorityForward: false,
    data,
  };
}

function memory(sources: readonly MemorySourceRecord[]): InstitutionalMemoryResult {
  return {
    schema: "pd01-institutional-memory/v1",
    workspaceId: WORKSPACE_ID,
    personId: PERSON_ID,
    lineageId: null,
    eventId: null,
    authorityCarryover: false,
    sources,
    unavailableFamilies: [
      {
        family: "attendee-feedback",
        available: false,
        reason: "No authoritative attendee-feedback table exists.",
      },
    ],
  };
}

function build(
  overrides: Partial<BuildPersonHistoryShowcaseInput> = {},
) {
  const events = [
    event("event-old", "Archive Forum", "2025-04-01T09:00:00.000Z"),
    event("event-new", "Evidence Summit", "2026-04-01T09:00:00.000Z"),
  ];
  return buildPersonHistoryShowcase({
    expectedWorkspaceId: WORKSPACE_ID,
    expectedPersonId: PERSON_ID,
    memory: memory([]),
    events,
    programUnits: [{ workspaceId: WORKSPACE_ID, eventId: "event-new", id: "unit-keynote", name: "Opening evidence lab" }],
    speakerRelationships: [],
    ...overrides,
  });
}

describe("person relationship history showcase", () => {
  it("loads the existing workspace-scoped projections without changing persisted state", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      seedWorkspaces(db);
      seedEvaluatorDemo(db);
      const account = db.prepare(
        "SELECT email, display_name AS displayName, role FROM accounts WHERE workspace_id = ? AND id = ?",
      ).get(EVALUATOR_WORKSPACE_ID, EVALUATOR_ORGANIZER_ACCOUNT_ID) as {
        email: string;
        displayName: string;
        role: string;
      };
      const session: SessionInfo = {
        id: "person-history-session",
        tokenHash: "synthetic-session-hash",
        accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
        workspaceId: EVALUATOR_WORKSPACE_ID,
        expiresAt: "2099-01-01T00:00:00.000Z",
        email: account.email,
        displayName: account.displayName,
        role: account.role,
        workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
        workspaceName: "Acme Events",
      };
      db.prepare(
        "INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        session.id,
        session.tokenHash,
        session.accountId,
        session.workspaceId,
        "2026-08-12T00:00:00.000Z",
        session.expiresAt,
      );
      const before = db.prepare("SELECT total_changes() AS count").get() as { count: number };

      const result = loadPersonHistoryShowcase(
        db,
        session,
        EVALUATOR_WORKSPACE_SLUG,
        EVALUATOR_SPEAKER_PERSON_ID,
      );

      const after = db.prepare("SELECT total_changes() AS count").get() as { count: number };
      expect(after).toEqual(before);
      expect(result.eventHistory).toHaveLength(1);
      expect(result.counts.events).toBe(1);
      expect(result.counts.applicationsAndProposals).toBeGreaterThan(0);
      expect(result.eventHistory[0]?.entries.some((entry) => entry.badge === "Application / proposal"))
        .toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("groups only persisted facts by event and keeps their semantics narrow", () => {
    const result = build({
      memory: memory([
        source(
          "submission-revision",
          "event-old",
          { submissionId: "submission-1", submissionRevisionId: "revision-1" },
          { revisionNumber: 1 },
          "2025-01-02T10:00:00.000Z",
          { currentUse: "current" },
        ),
        source(
          "review-history",
          "event-old",
          { assignmentId: "review-assignment-1", reviewRevisionId: "review-1" },
          { revisionNumber: 1, latestRevisionNumber: 1 },
          "2025-01-03T10:00:00.000Z",
        ),
        source(
          "decision-outcome",
          "event-new",
          { observationId: "observation-1", programUnitId: "unit-keynote" },
          { kind: "operational-outcome", observationType: "ROLE_PERFORMED", source: "badge-terminal" },
          "2026-04-01T10:00:00.000Z",
          { fingerprint: null, fingerprintOrigin: "not-stored" },
        ),
        source(
          "person-history",
          null,
          { sourceLinkId: "link-1", sourceRecordId: "source-1" },
          { provider: "fixture-csv", sourceRef: "row-1", version: 2, linkDecision: "CREATE" },
          "2024-12-01T10:00:00.000Z",
          { fingerprintOrigin: "derived-from-immutable-source", authority: "evidence-only" },
        ),
      ]),
      speakerRelationships: [{
        workspaceId: WORKSPACE_ID,
        eventId: "event-new",
        eventSpeakerId: "speaker-relation-1",
        personId: PERSON_ID,
        roleKey: "SPEAKER",
        participationStatus: "CONFIRMED",
        participationStatusTrust: "TRUSTED",
        managementState: "MANUAL_PROVENANCE",
        createdAt: "2026-03-01T10:00:00.000Z",
        provenance: {
          provider: "organizer-manual",
          scope: "event",
          fields: ["organization"],
          sourceRef: "manual-speaker:event-new:person-history",
          sourceRecordId: "speaker-source-1",
          sourceVersion: 1,
          recordedAt: "2026-03-01T10:00:00.000Z",
        },
      }],
    });

    expect(result.eventHistory.map((item) => item.event.id)).toEqual(["event-new", "event-old"]);
    expect(result.counts).toEqual({
      events: 2,
      applicationsAndProposals: 1,
      proposalReviews: 1,
      speakerRelationships: 1,
      sessionObservations: 1,
    });
    expect(result.eventHistory[0]?.entries.map((entry) => entry.badge)).toEqual([
      "Operational evidence",
      "Speaker relationship",
    ]);
    expect(result.eventHistory[0]?.entries[0]?.detail).toContain("Session: Opening evidence lab");
    expect(result.eventHistory[0]?.entries[0]?.detail).toContain("no broader attendance");
    expect(result.eventHistory[1]?.entries.find((entry) => entry.badge === "Proposal reviewed")?.detail)
      .toContain("does not mean the selected person acted as a reviewer");
    expect(result.eventHistory[0]?.entries.find((entry) => entry.badge === "Speaker relationship")?.detail)
      .toContain("does not establish session attendance or role performance");
    expect(result.workspaceEvidence[0]?.title).toContain("fixture-csv");
  });

  it("renders explicit success-empty and unavailable-projection states without inventing involvement", () => {
    const showcase = build({ events: [], programUnits: [] });
    const html = renderToStaticMarkup(
      createElement(PersonHistoryShowcaseView, { showcase, workspaceSlug: "northstar" }),
    );

    expect(html).toContain("No persisted cross-event relationship history is exposed");
    expect(html).toContain("No participation, attendance, reviewer role, or notes are inferred");
    expect(html).toContain("no person-linked reviewer-role projection is available");
    expect(html).toContain("Reviewer comments, evaluation content, and private note bodies are not exposed");
    expect(html).toContain("No authoritative attendee-feedback table exists");
    expect(html).not.toContain("Attended");
  });

  it("fails closed on person, workspace, speaker, and event scope mismatches", () => {
    expect(() => build({
      memory: { ...memory([]), workspaceId: "other-workspace" },
    })).toThrow("scope mismatch");
    expect(() => build({
      memory: { ...memory([]), personId: "other-person" },
    })).toThrow("scope mismatch");
    expect(() => build({
      memory: memory([
        source("submission-revision", "other-event", { submissionId: "submission-1" }, { revisionNumber: 1 }, "2025-01-02T10:00:00.000Z"),
      ]),
    })).toThrow("outside the authorized projection");
    expect(() => build({
      programUnits: [{ workspaceId: "other-workspace", eventId: "event-new", id: "unit-1", name: "Foreign unit" }],
    })).toThrow("Program unit scope mismatch");
    expect(() => build({
      speakerRelationships: [{
        workspaceId: "other-workspace",
        eventId: "event-new",
        eventSpeakerId: "speaker-relation-1",
        personId: PERSON_ID,
        roleKey: "SPEAKER",
        participationStatus: "CONFIRMED",
        participationStatusTrust: "TRUSTED",
        managementState: "MANUAL_PROVENANCE",
        createdAt: "2026-03-01T10:00:00.000Z",
        provenance: {
          provider: "organizer-manual",
          scope: "event",
          fields: [],
          sourceRef: "manual-speaker:event-new:person-history",
          sourceRecordId: null,
          sourceVersion: null,
          recordedAt: null,
        },
      }],
    })).toThrow("Speaker relationship scope mismatch");
  });
});
