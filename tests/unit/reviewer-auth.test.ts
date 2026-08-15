import { describe, expect, it, vi } from "vitest";
import {
  capabilitiesForSession,
  hasCapability,
  requireCapability,
  roleHasCapability,
  DenialError,
  type SessionInfo,
} from "@/server/auth";
import {
  requireConnectorWorkspaceRoute,
  requireOrganizerWorkspaceRoute,
  requireReviewerWorkspaceRoute,
  requireWorkspaceShellRoute,
} from "@/server/workspace-session";
import { authorizedProductShellDestinationIds } from "@/components/product-shell/product-shell";
import type { Db } from "@/server/db";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("@/server/services/audit", () => ({
  writeAudit: vi.fn(),
  writeDenialAudit: vi.fn(),
}));

import { writeDenialAudit } from "@/server/services/audit";

function makeSession(role: string, workspaceSlug = "northstar"): SessionInfo {
  return {
    id: "session-test-1",
    tokenHash: "token-hash-1",
    accountId: "account-test-1",
    workspaceId: "ws-test-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: "user@example.test",
    displayName: "Test User",
    role,
    workspaceSlug,
    workspaceName: "Northstar",
  };
}

const mockDb = {} as Db;

describe("Reviewer Capability Seam (cfp.review)", () => {
  describe("roleHasCapability and hasCapability", () => {
    it("grants cfp.review strictly to reviewer role", () => {
      expect(roleHasCapability("reviewer", "cfp.review")).toBe(true);
      expect(roleHasCapability("organizer", "cfp.review")).toBe(false);
      expect(roleHasCapability("workspace_admin", "cfp.review")).toBe(false);
      expect(roleHasCapability("event_manager", "cfp.review")).toBe(false);
      expect(roleHasCapability("program_manager", "cfp.review")).toBe(false);
      expect(roleHasCapability("communications_manager", "cfp.review")).toBe(false);
      expect(roleHasCapability("read_only", "cfp.review")).toBe(false);
    });

    it("denies phase0.pipeline.manage to reviewer role while preserving existing roles", () => {
      expect(roleHasCapability("reviewer", "phase0.pipeline.manage")).toBe(false);
      expect(roleHasCapability("organizer", "phase0.pipeline.manage")).toBe(true);
      expect(roleHasCapability("workspace_admin", "phase0.pipeline.manage")).toBe(true);
      expect(roleHasCapability("event_manager", "phase0.pipeline.manage")).toBe(true);
      expect(roleHasCapability("program_manager", "phase0.pipeline.manage")).toBe(true);
      expect(roleHasCapability("communications_manager", "phase0.pipeline.manage")).toBe(false);
      expect(roleHasCapability("read_only", "phase0.pipeline.manage")).toBe(false);
    });

    it("evaluates hasCapability correctly against session", () => {
      const reviewerSession = makeSession("reviewer");
      const organizerSession = makeSession("organizer");

      expect(hasCapability(reviewerSession, "cfp.review")).toBe(true);
      expect(hasCapability(reviewerSession, "phase0.pipeline.manage")).toBe(false);

      expect(hasCapability(organizerSession, "cfp.review")).toBe(false);
      expect(hasCapability(organizerSession, "phase0.pipeline.manage")).toBe(true);
    });
  });

  describe("requireCapability with cfp.review", () => {
    it("allows reviewer for cfp.review without writing denial audit", () => {
      const reviewerSession = makeSession("reviewer");
      expect(() => requireCapability(mockDb, reviewerSession, "cfp.review")).not.toThrow();
      expect(writeDenialAudit).not.toHaveBeenCalled();
    });

    it("denies organizer for cfp.review with audit and DenialError", () => {
      const organizerSession = makeSession("organizer");
      expect(() => requireCapability(mockDb, organizerSession, "cfp.review")).toThrow(DenialError);
      expect(writeDenialAudit).toHaveBeenCalledWith(
        mockDb,
        organizerSession.workspaceId,
        expect.objectContaining({
          code: "CAPABILITY_DENIED",
          targetId: "cfp.review",
          details: { role: "organizer" },
        }),
      );
    });

    it("denies reviewer for phase0.pipeline.manage with audit and DenialError", () => {
      const reviewerSession = makeSession("reviewer");
      expect(() => requireCapability(mockDb, reviewerSession, "phase0.pipeline.manage")).toThrow(
        DenialError,
      );
      expect(writeDenialAudit).toHaveBeenCalledWith(
        mockDb,
        reviewerSession.workspaceId,
        expect.objectContaining({
          code: "CAPABILITY_DENIED",
          targetId: "phase0.pipeline.manage",
          details: { role: "reviewer" },
        }),
      );
    });
  });

  describe("requireReviewerWorkspaceRoute vs requireOrganizerWorkspaceRoute", () => {
    it("allows reviewer on requireReviewerWorkspaceRoute, denies on requireOrganizerWorkspaceRoute", () => {
      const reviewerSession = makeSession("reviewer", "northstar");

      // Reviewer allowed on reviewer guard
      const result = requireReviewerWorkspaceRoute(reviewerSession, "northstar");
      expect(result).toBe(reviewerSession);

      // Reviewer denied on organizer guard (calls notFound -> throws __NOT_FOUND__)
      expect(() => requireOrganizerWorkspaceRoute(reviewerSession, "northstar")).toThrow(
        "__NOT_FOUND__",
      );
    });

    it("denies organizer on requireReviewerWorkspaceRoute, allows on requireOrganizerWorkspaceRoute", () => {
      const organizerSession = makeSession("organizer", "northstar");

      // Organizer denied on reviewer guard
      expect(() => requireReviewerWorkspaceRoute(organizerSession, "northstar")).toThrow(
        "__NOT_FOUND__",
      );

      // Organizer allowed on organizer guard
      const result = requireOrganizerWorkspaceRoute(organizerSession, "northstar");
      expect(result).toBe(organizerSession);
    });

    it("denies non-reviewer and non-organizer roles on reviewer guard", () => {
      for (const role of [
        "workspace_admin",
        "event_manager",
        "program_manager",
        "communications_manager",
        "read_only",
      ]) {
        const session = makeSession(role, "northstar");
        expect(() => requireReviewerWorkspaceRoute(session, "northstar")).toThrow(
          "__NOT_FOUND__",
        );
      }
    });
  });

  describe("Foreign workspace slug denial", () => {
    it("denies reviewer guard when requested slug does not match session workspace slug", () => {
      const reviewerSession = makeSession("reviewer", "northstar");
      expect(() => requireReviewerWorkspaceRoute(reviewerSession, "foreign-slug")).toThrow(
        "__NOT_FOUND__",
      );
    });

    it("denies organizer guard when requested slug does not match session workspace slug", () => {
      const organizerSession = makeSession("organizer", "northstar");
      expect(() => requireOrganizerWorkspaceRoute(organizerSession, "foreign-slug")).toThrow(
        "__NOT_FOUND__",
      );
    });
  });

  describe("server-authorized workspace capability projection", () => {
    it("projects organizer and event-manager destinations from capabilities, including Connector Hub only for its capability", () => {
      const organizer = makeSession("organizer");
      const eventManager = makeSession("event_manager");

      expect(capabilitiesForSession(organizer)).toEqual([
        "phase0.pipeline.manage",
        "connectors.manage",
      ]);
      expect(authorizedProductShellDestinationIds(capabilitiesForSession(organizer))).toEqual([
        "home",
        "events",
        "crm",
        "memory",
        "connectors",
        "analytics",
      ]);
      expect(requireWorkspaceShellRoute(organizer, "northstar")).toBe(organizer);
      expect(requireConnectorWorkspaceRoute(organizer, "northstar")).toBe(organizer);

      expect(capabilitiesForSession(eventManager)).toEqual(["phase0.pipeline.manage"]);
      expect(authorizedProductShellDestinationIds(capabilitiesForSession(eventManager))).toEqual([
        "home",
        "events",
        "crm",
        "memory",
        "analytics",
      ]);
      expect(requireWorkspaceShellRoute(eventManager, "northstar")).toBe(eventManager);
      expect(() => requireConnectorWorkspaceRoute(eventManager, "northstar")).toThrow("__NOT_FOUND__");
    });

    it("does not project the organizer shell, commands, or Connector Hub for reviewer, applicant, or speaker identities", () => {
      for (const role of ["reviewer", "applicant", "speaker"]) {
        const identity = makeSession(role);
        const capabilities = capabilitiesForSession(identity);
        expect(authorizedProductShellDestinationIds(capabilities)).toEqual([]);
        expect(() => requireWorkspaceShellRoute(identity, "northstar")).toThrow("__NOT_FOUND__");
        expect(() => requireConnectorWorkspaceRoute(identity, "northstar")).toThrow("__NOT_FOUND__");
      }
      expect(capabilitiesForSession(makeSession("reviewer"))).toEqual(["cfp.review"]);
      expect(capabilitiesForSession(makeSession("applicant"))).toEqual([]);
      expect(capabilitiesForSession(makeSession("speaker"))).toEqual([]);
    });

    it("denies both shell and connector projection for a capable account crossing workspace scope", () => {
      const organizer = makeSession("organizer", "northstar");
      expect(() => requireWorkspaceShellRoute(organizer, "foreign-slug")).toThrow("__NOT_FOUND__");
      expect(() => requireConnectorWorkspaceRoute(organizer, "foreign-slug")).toThrow("__NOT_FOUND__");
    });
  });
});
