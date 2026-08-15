import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

const landing = source("src/app/page.tsx");
const landingStyles = source("src/app/landing.module.css");
const loginForm = source("src/components/login-form.tsx");
const productShell = source("src/components/product-shell/product-shell.tsx");
const productShellStyles = source("src/app/w/[workspace]/shell.css");
const speakerSurfaces = source("src/components/public-widgets/speaker-surfaces.tsx");
const speakerStyles = source("src/components/public-widgets/styles.module.css");
const eventOverview = source("src/app/w/[workspace]/events/[eventId]/overview/page.tsx");

describe("final UX release contract", () => {
  it("keeps four mobile destinations in one protected bottom row", () => {
    expect(productShell).toContain('id === "crm" ? "People" : label');
    expect(productShell).toContain("const mobileMoreItems");
    expect(productShell).toContain('aria-label="More workspace destinations"');
    expect(productShell).toContain("mobileMoreRef.current.open = false");
    expect(productShellStyles).toMatch(/\.productShell__mobile-nav\s*\{[^}]*position: fixed;[^}]*bottom:/su);
    expect(productShellStyles).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(productShellStyles).toContain("bottom: calc(100% + 8px);");
    expect(productShellStyles).toContain("calc(96px + env(safe-area-inset-bottom))");
  });

  it("uses one persona chooser with one organizer form and a compact compatibility disclosure", () => {
    expect(landing.match(/data-testid="persona-chooser"/gu)).toHaveLength(1);
    expect(landing.match(/className=\{styles\.personaGrid\}/gu)).toHaveLength(1);
    expect(landing).toContain('id="workspace-entry"');
    expect(landing).toContain("<LoginForm groups={groups} />");
    expect(landing).not.toContain("personaCardWide");
    expect(landing).not.toContain("className={styles.secondaryLink}");
    expect(landing).toContain("Uses the same visible organizer, reviewer, CFP, and sealed-release mechanisms");
    expect(landingStyles).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(landingStyles).toContain("grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);");
  });

  it("submits the default Acme organizer from the hero and keeps publication truthful", () => {
    expect(loginForm).toContain('id="organizer-login-form"');
    expect(loginForm).toContain('group.workspaceSlug === "acme" && index === 0');
    expect(landing).toContain('type="submit"');
    expect(landing).toContain('form="organizer-login-form"');
    expect(landing).toContain('data-testid="organizer-primary-cta"');
    expect(landing).toContain('data-testid="hero-release-rail"');
    expect(landing).toContain("attendeeRelease.binding.widget.release.releaseNumber");
    expect(landing).toContain("attendeeRelease.projection.release.sealedAt");
    expect(landing).toContain("No current sealed public release can be verified for this fixture.");
    expect(landing.match(/Open current attendee agenda/gu)).toHaveLength(1);
    expect(landing).toContain("Open validated release agenda.");
    expect(landing).toContain(': "#attendee-agenda-status"');
    expect(landing).not.toContain("releaseNumber: 1");
    expect(landingStyles).toMatch(/\.releaseStatusPanel a\s*\{[^}]*min-height: 44px;/su);
  });

  it("bounds gallery cards and renders biography only when real content exists", () => {
    expect(speakerStyles).toContain("minmax(min(100%, 248px), 292px)");
    expect(speakerStyles).toContain("width: min(100%, 292px)");
    expect(speakerStyles).toContain("color: var(--widget-ink)");
    expect(speakerStyles).toContain("-webkit-line-clamp: 3");
    expect(speakerSurfaces).toContain("const biography = speaker.bio?.trim()");
    expect(speakerSurfaces).toContain("biography ? <p");
    expect(speakerSurfaces).not.toMatch(/biography unavailable|bio unavailable/iu);
  });

  it("projects event attention from existing record pointers without inventing readiness", () => {
    expect(eventOverview).toContain("const attentionItems");
    expect(eventOverview).toContain("This overview does not infer a readiness result.");
    expect(eventOverview).toContain('event.currentPlanVersionId ? "Current pointer recorded" : "No current pointer"');
    expect(eventOverview).toContain('event.currentReleaseId ? "Current pointer recorded" : "No current pointer"');
    expect(eventOverview).toContain("Open the record that can answer the question");
    expect(eventOverview).toContain("Current plan pointer");
    expect(eventOverview).toContain("Current release pointer");
    expect(eventOverview).not.toContain("Projection unavailable");
  });
});
