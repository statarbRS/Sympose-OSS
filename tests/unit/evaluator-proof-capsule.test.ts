import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  resolveEvaluatorBuildIdentity,
  UNAVAILABLE_EVALUATOR_BUILD_IDENTITY,
} from "@/components/evaluator-walkthrough/build-identity";
import { EvaluatorWalkthrough } from "@/components/evaluator-walkthrough/evaluator-walkthrough";
import { createEvaluatorWalkthroughContent } from "@/components/evaluator-walkthrough/route-map";
import { publicReleaseReference } from "@/server/services/public-reference";

const releaseReference = publicReleaseReference({
  workspaceId: "proof-capsule-workspace",
  eventId: "proof-capsule-event",
  releaseId: "proof-capsule-release",
});
const boundSha = "a".repeat(40);

describe("exact-SHA evaluator proof capsule", () => {
  it("renders only a validated full SHA and has an explicit unavailable fallback", () => {
    expect(resolveEvaluatorBuildIdentity("  " + boundSha.toUpperCase() + "  ")).toEqual({
      status: "bound",
      value: boundSha,
    });

    for (const value of [undefined, null, "", "unbound", "a".repeat(39), "g".repeat(40), "feature/main"]) {
      expect(resolveEvaluatorBuildIdentity(value)).toEqual(UNAVAILABLE_EVALUATOR_BUILD_IDENTITY);
    }
  });

  it("keeps the DevFlow golden path ordered on existing role-entry routes", () => {
    const content = createEvaluatorWalkthroughContent(releaseReference);

    expect(content.devflowGoldenPath).toEqual(content.compatibilityJourney);
    expect(content.devflowGoldenPath.map((step) => step.href)).toEqual([
      "/#workspace-entry",
      "/cfp/devflow/devflow-conf-2027",
      "/#reviewer-entry",
      "/#reviewer-session-required",
      "/speaker/entry",
      "/events/" + releaseReference + "/agenda",
    ]);
    expect(content.devflowGoldenPath.map((step) => step.href).join("\\n")).not.toMatch(
      /(?:token|password|credential|secret)/iu,
    );
  });

  it("renders identity, deterministic proof instructions, and visible returnability", () => {
    const html = renderToStaticMarkup(createElement(EvaluatorWalkthrough, {
      buildIdentity: resolveEvaluatorBuildIdentity(boundSha),
      releaseReference,
    }));

    expect(html).toContain('data-testid="evaluator-proof-capsule"');
    expect(html).toContain('data-testid="evaluator-build-identity"');
    expect(html).toContain('data-testid="evaluator-build-sha">' + boundSha + "</code>");
    expect(html).toContain('href="/health"');
    expect(html).toContain("git rev-parse HEAD");
    expect(html).toContain("pnpm exec tsc --noEmit --incremental false");
    expect(html).toContain("SYMPOSE_BUILD_SHA=&lt;full-40-character-HEAD&gt; pnpm evaluator:release:start");
    expect(html).toContain("DevFlow golden path");
    expect(html).toContain('data-testid="devflow-golden-path"');
    expect(html).toContain('data-testid="walkthrough-return-home"');
    expect(html).toContain("Return to root entry");
  });

  it("renders an honest identity fallback without fabricating a candidate", () => {
    const html = renderToStaticMarkup(createElement(EvaluatorWalkthrough, {
      releaseReference: null,
    }));

    expect(html).toContain('data-testid="evaluator-build-sha">unavailable</code>');
    expect(html).toContain("not exact-candidate evidence");
    expect(html).toContain("Public widgets unavailable");
    expect(html).not.toContain(boundSha);
    expect(html).not.toContain("/embed/");
  });

  it("documents the same exact-candidate commands and boundaries as the route", () => {
    const capsule = readFileSync(
      new URL("../../docs/testing/exact-sha-proof-capsule.md", import.meta.url),
      "utf8",
    );

    expect(capsule).toContain("git rev-parse HEAD");
    expect(capsule).toContain("pnpm exec tsc --noEmit --incremental false");
    expect(capsule).toContain("SYMPOSE_BUILD_SHA=<full-40-character-HEAD> pnpm evaluator:release:start");
    expect(capsule).toContain("/walkthrough");
    expect(capsule).toContain("unavailable");
    expect(capsule).toContain("does not issue");
    expect(capsule).toContain("Return to root entry");
  });
});
