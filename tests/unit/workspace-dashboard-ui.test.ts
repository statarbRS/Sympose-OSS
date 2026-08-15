import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const component = readFileSync(resolve("src/components/workspace-dashboard.tsx"), "utf8");
const styles = readFileSync(resolve("src/components/workspace-dashboard.module.css"), "utf8");

describe("workspace dashboard command-center surface", () => {
  it("keeps event operations linkable, truth-layered, accessible, and responsive", () => {
    expect(component).toContain('data-testid="workspace-dashboard"');
    expect(component).toContain('data-testid="evaluator-disclosure"');
    expect(component).toContain('aria-labelledby="evaluator-tools-title"');
    expect(component).toContain("<summary");
    expect(component).toContain("Current event");
    expect(component).toContain("Next actions for this event");
    expect(component).toContain("Candidate truth");
    expect(component).toContain("Commitment truth");
    expect(component).toContain("Operational truth");
    expect(component).toContain("Check speaker readiness");
    expect(component).toContain("Shape the program");
    expect(component).toContain("Review publication");
    expect(component).toContain("/events/${event.id}/speakers");
    expect(component).toContain("/events/${event.id}/program");
    expect(component).toContain("/events/${event.id}/publication");
    expect(component).toContain('const attentionAction = !event');
    expect(component).toContain('const attentionUsesPipeline = attentionAction.href === "#pipeline-controls"');
    expect(component).toContain('href={attentionAction.href}');
    expect(component).toContain('aria-controls={attentionUsesPipeline ? "pipeline-controls" : undefined}');
    expect(component).toContain('id="pipeline-controls"');
    expect(component).toContain("Reference navigation");
    expect(component).toContain("DASHBOARD_PEOPLE_PAGE_SIZE = 100");
    expect(component).toContain('aria-label="People table pages"');
    expect(component).toContain("visiblePeople.map");
    expect(component).toContain(">Intake</h3>");
    expect(component).toContain(">Evaluation</h3>");
    expect(component).toContain(">Commitment</h3>");
    expect(component).toContain(">Program</h3>");
    expect(component).toContain(">Publication</h3>");
    expect(component).toContain("state.release");
    expect(component).toContain("state.approvals");
    expect(component).toContain("Publication checks required");
    expect(component).toContain("Candidate v${candidatePlan.versionNumber} · current approved v${currentPlan.versionNumber}");
    expect(component).toContain("Home does not infer release readiness");
    expect(component).toContain("No validated current release");
    expect(component).not.toContain("Ready to seal");
    expect(component).toContain("role=\"status\"");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain(".evaluatorSummary:focus-visible");
    expect(styles).toContain(".eventSummaryGrid");
    expect(styles).toContain(".eventActionGrid");
    expect(styles).toContain(".peopleColumnHeader");
    expect(styles).toContain(".truth-state--inactive");
    expect(styles).toContain("border-radius: 999px");
    expect(styles).toContain("@media (max-width: 820px)");
    expect(styles).toContain("@media (max-width: 390px)");
  });

  it("orders attention before context and keeps supporting workflow in one collapsed disclosure", () => {
    const queueIndex = component.indexOf('className={styles.eventWorkbench}');
    const contextIndex = component.indexOf('className={styles.eventContext}');
    const truthIndex = component.indexOf('className="dash__strip dash__truth-summary"');
    const secondaryIndex = component.indexOf('className={styles.secondaryRoutes}');
    const peopleIndex = component.indexOf('className="record-section dash__people"');
    const disclosureIndex = component.indexOf(
      '<details\n        id="pipeline-controls"\n        className={styles.evaluatorDisclosure}',
    );
    const disclosureOpeningEnd = component.indexOf(">", disclosureIndex);
    const disclosureEnd = component.lastIndexOf("</details>");

    expect(queueIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeGreaterThan(queueIndex);
    expect(truthIndex).toBeGreaterThan(contextIndex);
    expect(secondaryIndex).toBeGreaterThan(contextIndex);
    expect(peopleIndex).toBeGreaterThan(secondaryIndex);
    expect(disclosureIndex).toBeGreaterThan(peopleIndex);
    expect(disclosureEnd).toBeGreaterThan(disclosureIndex);
    expect(component.slice(disclosureIndex, disclosureOpeningEnd + 1)).not.toMatch(/\sopen(?:=|\s|>)/);
    expect(component.indexOf('className="dash__pipeline"', disclosureIndex)).toBeLessThan(disclosureEnd);
    expect(component.indexOf('className="record-section dash__audit"', disclosureIndex)).toBeLessThan(
      disclosureEnd,
    );
    expect(component.match(/<ActionCard/g)).toHaveLength(11);
    expect(component.match(/className="dash__strip dash__truth-summary"/g)).toHaveLength(1);
    expect(component.match(/<PeopleTruthHeader/g)).toHaveLength(4);
    expect(component).not.toMatch(/Candidate truth\s*—/);
    expect(component).not.toMatch(/Candidate projection\s*—/);
    expect(component).not.toMatch(/Commitment truth\s*—/);
    expect(component).not.toMatch(/Operational truth\s*—/);
  });

  it("preserves all evaluator actions, controls, and loaded-data-only event statuses", () => {
    const disclosureIndex = component.indexOf(
      '<details\n        id="pipeline-controls"\n        className={styles.evaluatorDisclosure}',
    );
    const disclosureEnd = component.lastIndexOf("</details>");
    const disclosure = component.slice(disclosureIndex, disclosureEnd);

    for (const action of [
      "importFixtureAction",
      "freezeSnapshotAction",
      "createEventAction",
      "compilePlanAction",
      "approvePlanAction",
      "deliverOffersAction",
      "simulateAcceptanceAction",
      "sealReleaseAction",
      "revokeTokenAction",
      "recordAttendanceAction",
      "proveCrossWorkspaceDenialAction",
    ]) {
      expect(disclosure).toContain(`action={${action}}`);
    }

    for (const fieldName of [
      "eventName",
      "unitName",
      "capacity",
      "planVersionId",
      "expectedCurrentPlanVersionId",
      "offerId",
      "commandKey",
      "tokenId",
      "reason",
      "eventId",
      "personId",
      "programUnitId",
      "targetSlug",
    ]) {
      expect(disclosure).toContain(`name="${fieldName}"`);
    }

    expect(component).not.toContain("2 submitted");
    expect(component).not.toContain("Accepted checkpoint");
    expect(component).toContain('status={commitmentEvidenceAvailable ? `${acceptedPersons} accepted` : "Commitment evidence unavailable"}');
    expect(component).toContain('aria-label="Evaluator surfaces"');
    expect(component).toContain("Public widgets");

    const navStart = component.indexOf('className={styles.secondaryRoutes}');
    const navEnd = component.indexOf("</nav>", navStart);
    const nav = component.slice(navStart, navEnd);
    expect(nav.match(/<Link/g)).toHaveLength(8);
    expect(nav).toContain("Open event overview");
    expect(nav).toContain("Reference navigation");
  });

  it("keeps absent cohort and plan evidence unknown instead of rendering synthetic zeroes or negatives", () => {
    expect(component).toContain("state.snapshot?.memberCount ?? null");
    expect(component).toContain("state.planDetailView ? assignedPersonIds.size : null");
    expect(component).toContain('available={state.snapshot !== null}');
    expect(component).toContain('available={state.planDetailView !== null}');
    expect(component).toContain("const commitmentEvidenceAvailable = Boolean(currentPlan && state.approvals.length > 0)");
    expect(component).toContain('available={commitmentEvidenceAvailable}');
    expect(component).toContain("Commitment evidence unavailable");
    expect(component).toContain("Not measured");
    expect(component).toContain("Unknown");
    expect(component).not.toContain("state.snapshot?.memberCount ?? 0");
    expect(component).not.toContain('label="Not qualified"');
    expect(component).not.toContain('label="Not assigned"');
    expect(component).toContain('disabled={!event || !state.snapshot || units.length === 0}');
    expect(component).toContain('disabled={!candidatePlan || candidatePlan.runStatus !== "FEASIBLE"}');
  });

  it("makes the current event the primary heading and keeps Today as context", () => {
    const kickerIndex = component.indexOf("<p className={styles.kicker}>Organizer home · Today · workspace attention</p>");
    const headingIndex = component.indexOf('<h1 id="dashboard-title">{event?.name ?? "No current event"}</h1>');

    expect(kickerIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(kickerIndex);
    expect(component).not.toContain('<h1 id="dashboard-title">Today</h1>');
  });
});
