import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EvaluatorWalkthrough } from "../../src/components/evaluator-walkthrough/evaluator-walkthrough";
import {
  createEvaluatorWalkthroughContent,
  requiredCriterionCount,
} from "../../src/components/evaluator-walkthrough/route-map";
import {
  DEVFLOW_EVALUATOR_PROFILE,
  EVALUATOR_ASSIGNMENT_ID,
  EVALUATOR_CALL_SLUG,
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_SLUG,
} from "../../src/server/evaluator-demo";
import { publicReleaseReference } from "../../src/server/services/public-reference";

const releaseReference = publicReleaseReference({
  workspaceId: "walkthrough-workspace",
  eventId: "walkthrough-event",
  releaseId: "walkthrough-release",
});

describe("public evaluator walkthrough", () => {
  it("starts Playwright web servers in the local evaluator profile", () => {
    const playwrightConfig = readFileSync(resolve("playwright.config.ts"), "utf8");

    expect(playwrightConfig).toContain('SYMPOSE_EVALUATOR_PROFILE: "local",');
  });

  it("derives the required route map from evaluator and public fixture constants", () => {
    const {
      routes,
      compatibilityJourney,
      publicWidgetSurfaces,
      publisherTool,
    } = createEvaluatorWalkthroughContent(releaseReference);

    expect(routes.publicCfp).toBe(
      `/cfp/${EVALUATOR_WORKSPACE_SLUG}/${EVALUATOR_CALL_SLUG}`,
    );
    expect(routes.speakerCheckpoint).toBe(
      "/speaker/entry",
    );
    expect(routes.attendeeAgenda).toBe(
      `/events/${releaseReference}/agenda`,
    );
    expect(routes.organizer.program).toBe(
      `/w/${EVALUATOR_WORKSPACE_SLUG}/events/${EVALUATOR_EVENT_ID}/program`,
    );
    expect(routes.reviewerAssignment).toBe(
      `/review/${EVALUATOR_WORKSPACE_SLUG}/assignments/${EVALUATOR_ASSIGNMENT_ID}`,
    );

    expect(publicWidgetSurfaces).toHaveLength(5);
    expect(new Set(publicWidgetSurfaces.map((surface) => surface.href)).size).toBe(5);
    expect(publicWidgetSurfaces.map((surface) => surface.label)).toEqual([
      "Sessions",
      "Speakers",
      "Gallery",
      "Agenda",
      "Itinerary",
    ]);
    expect(publicWidgetSurfaces.map((surface) => surface.href)).toEqual([
      `/embed/${releaseReference}/sessions`,
      `/embed/${releaseReference}/speakers`,
      `/embed/${releaseReference}/gallery`,
      `/embed/${releaseReference}/agenda`,
      `/embed/${releaseReference}/itinerary`,
    ]);
    expect(publicWidgetSurfaces.every((surface) => surface.href.includes(releaseReference))).toBe(true);
    expect(publisherTool).toEqual({
      label: "Configure portable embed",
      href: `/embed/${releaseReference}/configure`,
      note: expect.stringContaining("not a content surface"),
    });
    expect(publicWidgetSurfaces.map((surface) => surface.href)).not.toContain(publisherTool?.href);
    expect(routes.compatibility.publicCfp).toBe(
      `/cfp/devflow/devflow-conf-2027`,
    );
    expect(routes.compatibility.organizerDashboard).toBe(
      "/#workspace-entry",
    );
    expect(routes.compatibility.reviewerQueue).toBe(
      "/#reviewer-entry",
    );
    expect(routes.compatibility.reviewerAssignment).toBe(
      "/#reviewer-session-required",
    );
    expect(Object.values(routes.compatibility)).not.toContain(
      "/w/devflow/dashboard",
    );
    expect(Object.values(routes.compatibility)).not.toContain(
      "/review/devflow/queue",
    );
    expect(compatibilityJourney).toHaveLength(6);
  });

  it("renders all required areas, route anchors, personas, and honest status language", () => {
    const {
      routes,
      compatibilityJourney,
      evaluationAreas,
      publicWidgetSurfaces,
      publisherTool,
    } = createEvaluatorWalkthroughContent(releaseReference);
    const html = renderToStaticMarkup(createElement(EvaluatorWalkthrough, { releaseReference }));

    expect(html).toContain('data-testid="evaluator-walkthrough"');
    expect(html).toContain("Every named person is synthetic");
    expect(html).toContain("Acme Organizer");
    expect(html).toContain("Acme Demo Reviewer");
    expect(html).toContain(DEVFLOW_EVALUATOR_PROFILE.eventName);
    expect(html).toContain(DEVFLOW_EVALUATOR_PROFILE.organizer.fullName);
    expect(html).toContain(DEVFLOW_EVALUATOR_PROFILE.reviewer.fullName);
    expect(html).toContain("Priya Raman");
    expect(html).toContain("Marcus Okafor");
    expect(html).toContain("continue Mina’s accepted proposal through the primary speaker preview");
    expect(html).toContain("Mina Park’s accepted-session workspace");
    expect(html).toContain("neither event is relabeled as the other");
    expect(html).toContain('data-testid="devflow-walkthrough-profile"');
    expect(html).toContain(`>${requiredCriterionCount}<`);
    expect(html).toContain("required matrix checks");
    expect(requiredCriterionCount).toBe(86);

    for (const area of evaluationAreas) {
      expect(html).toContain(`id="${area.id}"`);
      expect(html).toContain(area.title);
      expect(html).toContain(`${area.count} checks`);
      for (const criterion of area.criteria) expect(html).toContain(criterion);
      for (const route of area.routeLinks) expect(html).toContain(`href="${route.href}"`);
    }

    for (const route of [
      routes.publicCfp,
      routes.speakerCheckpoint,
      routes.attendeeAgenda,
      ...publicWidgetSurfaces.map((surface) => surface.href),
      publisherTool?.href,
      ...Object.values(routes.organizer),
      ...compatibilityJourney.map((route) => route.href),
    ].filter((route): route is string => typeof route === "string")) {
      expect(html).toContain(`href="${route}"`);
    }

    expect(html).toContain("Pending in matrix");
    expect(html).toContain("does not pre-prove every matrix criterion");
    expect(html).toContain("No AI result is implied");
    expect(html).toContain("bounded PNG/PDF bytes");
    expect(html).toContain("metadata CSV intentionally omits file bytes");
    expect(html).toContain("profile and text versions");
    expect(html).toContain("Program schedule drafts, exact organizer approvals");
    expect(html).toContain("Public agendas and widgets resolve only a validated scoped sealed release");
    expect(html).toContain('data-testid="walkthrough-publisher-tool"');
    expect(html).toContain("Publisher configuration remains a separate tool");
    expect(html).not.toContain("demo-public");
    expect(html).not.toContain("workspace-synthetic-public");
    expect(html).not.toContain("does not model speaker tasks, deliverables, files, or content records");
    expect(html).not.toContain("no real upload");
    expect(html).not.toContain("All criteria pass");
  });

  it("shows an unavailable state instead of manufacturing public widget links", () => {
    const content = createEvaluatorWalkthroughContent(null);
    const html = renderToStaticMarkup(createElement(EvaluatorWalkthrough, { releaseReference: null }));

    expect(content.publicWidgetSurfaces).toEqual([]);
    expect(content.publisherTool).toBeNull();
    expect(content.routes.publicWidgets).toBeNull();
    expect(content.routes.attendeeAgenda).toBe("/#attendee-agenda-status");
    expect(html).toContain('data-testid="walkthrough-public-widget-unavailable"');
    expect(html).toContain("does not manufacture fallback links or content");
    expect(html).not.toContain("/embed/");
  });
});
