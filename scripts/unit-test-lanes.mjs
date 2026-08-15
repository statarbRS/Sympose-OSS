import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

export const unitTestInclude = Object.freeze(["tests/unit/**/*.test.ts"]);

const LANE_WORKER_CAPS = Object.freeze({
  risk: 1,
  fast: 8,
});
const CI_FAST_WORKER_CAP = 4;

export function selectLaneWorkerCount(
  lane,
  logicalCpuCount = availableParallelism(),
  ci = process.env.CI === "1" || process.env.CI === "true",
) {
  if (lane !== "risk" && lane !== "fast") {
    throw new Error(`unknown unit-test lane ${JSON.stringify(lane)}`);
  }
  if (!Number.isInteger(logicalCpuCount) || logicalCpuCount < 1) {
    throw new Error("logical CPU count must be a positive integer");
  }

  // Leave one logical CPU for the host. A one-CPU runner still receives one worker so that the
  // gate remains executable, and the receipt records the constrained choice.
  const reservedHostCapacity = Math.max(1, logicalCpuCount - 1);
  const laneCap = lane === "fast" && ci ? CI_FAST_WORKER_CAP : LANE_WORKER_CAPS[lane];
  return Math.max(1, Math.min(reservedHostCapacity, laneCap));
}

function stableOrderKey(seed, file) {
  return createHash("sha256").update(`${seed}\u0000${file}`).digest("hex");
}

export function orderUnitTestFiles(files, mode = "canonical", timingWeights = undefined) {
  const canonical = [...files].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("unit-test schedule cannot contain duplicate files");
  }
  if (mode === "canonical") return canonical;
  if (mode === "reverse") return canonical.reverse();
  if (mode === "seeded") {
    return canonical.sort((left, right) =>
      stableOrderKey("sympose-unit-order-v1", left).localeCompare(
        stableOrderKey("sympose-unit-order-v1", right),
        "en",
      ));
  }
  if (mode === "timing") {
    const weights = timingWeights instanceof Map
      ? timingWeights
      : new Map(Object.entries(timingWeights ?? {}));
    const known = canonical
      .map((file) => Number(weights.get(file)))
      .filter((weight) => Number.isFinite(weight) && weight >= 0);
    const conservativeUnknownWeight = Math.max(1, ...known);
    return canonical.sort((left, right) => {
      const leftWeight = Number(weights.get(left));
      const rightWeight = Number(weights.get(right));
      const normalizedLeft = Number.isFinite(leftWeight) && leftWeight >= 0
        ? leftWeight
        : conservativeUnknownWeight;
      const normalizedRight = Number.isFinite(rightWeight) && rightWeight >= 0
        ? rightWeight
        : conservativeUnknownWeight;
      return normalizedRight - normalizedLeft || left.localeCompare(right, "en");
    });
  }
  throw new Error(`unknown unit-test order mode ${JSON.stringify(mode)}`);
}

export const sqliteUnitTestFiles = Object.freeze([
  "tests/unit/artifact-atomicity-r3.test.ts",
  "tests/unit/canonical-token.test.ts",
  "tests/unit/cfp-11-organizer-review-detail.test.ts",
  "tests/unit/cfp-14-decision-communications.test.ts",
  "tests/unit/cfp-15-session-handoff.test.ts",
  "tests/unit/cfp-applicant-access.test.ts",
  "tests/unit/cfp-applicant-dashboard.test.ts",
  "tests/unit/cfp-applicant-portal.test.ts",
  "tests/unit/cfp-co-presenters.test.ts",
  "tests/unit/cfp-evaluator-microbundle.test.ts",
  "tests/unit/cfp-form-persistence.test.ts",
  "tests/unit/cfp-organizer.test.ts",
  "tests/unit/cfp-review-domain.test.ts",
  "tests/unit/cfp-review-sealing.test.ts",
  "tests/unit/cfp-schema.test.ts",
  "tests/unit/cfp-submission-confirmation.test.ts",
  "tests/unit/cfp-submissions.test.ts",
  "tests/unit/connector-credentials-connections.test.ts",
  "tests/unit/connector-credentials-schema.test.ts",
  "tests/unit/connector-hub-export.test.ts",
  "tests/unit/connector-hub-service.test.ts",
  "tests/unit/connector-orchestration.test.ts",
  "tests/unit/content-library-service.test.ts",
  "tests/unit/crm-event-communications.test.ts",
  "tests/unit/crm-import-merge.test.ts",
  "tests/unit/crm-service.test.ts",
  "tests/unit/db-migrations.test.ts",
  "tests/unit/delivery-center-service.test.ts",
  "tests/unit/eval-shared-foundation.test.ts",
  "tests/unit/evaluator-demo.test.ts",
  "tests/unit/evaluator-login-boundary.test.ts",
  "tests/unit/evaluator-second-event.test.ts",
  "tests/unit/event-portfolio.test.ts",
  "tests/unit/login-rejection.test.ts",
  "tests/unit/mvp-domain.test.ts",
  "tests/unit/operations-observation-actions.test.ts",
  "tests/unit/operations-timeline.test.ts",
  "tests/unit/operator-proof-experience.test.ts",
  "tests/unit/outcomes-correction.test.ts",
  "tests/unit/pd01-foundation-schema.test.ts",
  "tests/unit/pd01-institutional-memory.test.ts",
  "tests/unit/pd01-product-surfaces-ui.test.ts",
  "tests/unit/pd01-program-capacity.test.ts",
  "tests/unit/pd01-program-decision-schema.test.ts",
  "tests/unit/pd01-proposal-lineage.test.ts",
  "tests/unit/person-history.test.ts",
  "tests/unit/production-release-kit.test.ts",
  "tests/unit/production-runtime-auth.test.ts",
  "tests/unit/public-agenda-durable.test.ts",
  "tests/unit/public-widgets-artifact-binding.test.ts",
  "tests/unit/public-widgets-embed-config.test.ts",
  "tests/unit/publication-audience-matrix.test.ts",
  "tests/unit/publication-audience-schema.test.ts",
  "tests/unit/publication-schedule-compatibility.test.ts",
  "tests/unit/returner-lens.test.ts",
  "tests/unit/review-blind-control.test.ts",
  "tests/unit/review-organizer-console.test.ts",
  "tests/unit/review-organizer-workflow.test.ts",
  "tests/unit/review-reminder-action.test.ts",
  "tests/unit/review-round-schedule-migration.test.ts",
  "tests/unit/review-setup-actions.test.ts",
  "tests/unit/reviewer-access-schema.test.ts",
  "tests/unit/reviewer-provisioning.test.ts",
  "tests/unit/schedule-approval-authority.test.ts",
  "tests/unit/scheduling-persistence.test.ts",
  "tests/unit/scheduling-route-auth.test.ts",
  "tests/unit/sealed-headshot-authority-r3.test.ts",
  "tests/unit/speaker-actions-access.test.ts",
  "tests/unit/speaker-approval-actions.test.ts",
  "tests/unit/speaker-artifact-records.test.ts",
  "tests/unit/speaker-communications-actions.test.ts",
  "tests/unit/speaker-communications-outbox.test.ts",
  "tests/unit/speaker-content-durability-r3.test.ts",
  "tests/unit/speaker-csv-import.test.ts",
  "tests/unit/speaker-delivery-batch.test.ts",
  "tests/unit/speaker-devflow-portal-continuity.test.ts",
  "tests/unit/speaker-manual-management.test.ts",
  "tests/unit/speaker-portal-access.test.ts",
  "tests/unit/speaker-shared-action-reminders.test.ts",
  "tests/unit/speaker-task-assignment-authority.test.ts",
  "tests/unit/stage3-devflow-continuity.test.ts",
]);

export const sharedStateUnitTests = Object.freeze([
  Object.freeze({
    file: "tests/unit/artifact-store.test.ts",
    reason: "mutates temporary artifact storage",
    evidence: Object.freeze(["mkdtempSync", "rmSync"]),
  }),
  Object.freeze({
    file: "tests/unit/cfp-verification-delivery.test.ts",
    reason: "stubs process environment delivery gates",
    evidence: Object.freeze(["vi.stubEnv", "vi.unstubAllEnvs"]),
  }),
  Object.freeze({
    file: "tests/unit/connector-credentials-vault.test.ts",
    reason: "mutates the connector vault key process environment",
    evidence: Object.freeze([
      "process.env[CONNECTOR_VAULT_KEY_ENV] =",
      "delete process.env[CONNECTOR_VAULT_KEY_ENV]",
    ]),
  }),
  Object.freeze({
    file: "tests/unit/health-route.test.ts",
    reason: "mutates the build SHA process environment",
    evidence: Object.freeze([
      "process.env.SYMPOSE_BUILD_SHA =",
      "delete process.env.SYMPOSE_BUILD_SHA",
    ]),
  }),
  Object.freeze({
    file: "tests/unit/security-headers.test.ts",
    reason: "stubs NODE_ENV while evaluating shared Next configuration",
    evidence: Object.freeze(["vi.stubEnv", "vi.unstubAllEnvs"]),
  }),
  Object.freeze({
    file: "tests/unit/speaker-portal-page.test.ts",
    reason: "mutates the real-IP-header process environment",
    evidence: Object.freeze([
      "process.env.SYMPOSE_REAL_IP_HEADER =",
      "delete process.env.SYMPOSE_REAL_IP_HEADER",
    ]),
  }),
  Object.freeze({
    file: "tests/unit/speaker-reminder-job-route.test.ts",
    reason: "stubs an environment-selected SQLite path and mutates temporary storage",
    evidence: Object.freeze(["vi.stubEnv(\"SYMPOSE_DB_PATH\"", "mkdtempSync"]),
  }),
]);

export const databaseOrSharedStateUnitTestFiles = Object.freeze(
  [
    ...sqliteUnitTestFiles,
    ...sharedStateUnitTests.map(({ file }) => file),
  ].sort(),
);

export const sourceSafeUnitTestFiles = Object.freeze([
  "tests/unit/action-errors.test.ts",
  "tests/unit/authority-purpose-kernel.test.ts",
  "tests/unit/bounded-presentation-polish.test.ts",
  "tests/unit/capacity-flight-deck.test.ts",
  "tests/unit/cfp-applicant-ui.test.ts",
  "tests/unit/cfp-co-presenters-ui.test.ts",
  "tests/unit/cfp-form-contracts.test.ts",
  "tests/unit/cfp-form-evaluator.test.ts",
  "tests/unit/cfp-form-field-contract.test.ts",
  "tests/unit/cfp-organizer-ui.test.ts",
  "tests/unit/cfp-review-artifacts.test.ts",
  "tests/unit/cfp-review-rubric-semantics.test.ts",
  "tests/unit/change-radius-core.test.ts",
  "tests/unit/commitment-offer-contract.test.ts",
  "tests/unit/connector-hub-route.test.ts",
  "tests/unit/connector-hub-ui.test.ts",
  "tests/unit/connector-provider-airtable.test.ts",
  "tests/unit/connector-provider-hubspot.test.ts",
  "tests/unit/connector-provider-salesforce.test.ts",
  "tests/unit/content-library-page.test.ts",
  "tests/unit/content-library-route.test.ts",
  "tests/unit/content-library-ui.test.ts",
  "tests/unit/content-publication-gate.test.ts",
  "tests/unit/crm-pagination.test.ts",
  "tests/unit/crm-route-auth.test.ts",
  "tests/unit/cross-event-analytics.test.ts",
  "tests/unit/csv-export-safety.test.ts",
  "tests/unit/curatorial-separation-core.test.ts",
  "tests/unit/decision-intelligence-experience.test.ts",
  "tests/unit/decision-replay-core.test.ts",
  "tests/unit/delivery-center-route.test.ts",
  "tests/unit/delivery-center-ui.test.ts",
  "tests/unit/evaluator-copy-truthfulness.test.ts",
  "tests/unit/evaluator-proof-capsule.test.ts",
  "tests/unit/evaluator-release-start.test.ts",
  "tests/unit/evaluator-walkthrough.test.ts",
  "tests/unit/event-readiness.test.ts",
  "tests/unit/final-ux-release.test.ts",
  "tests/unit/getting-started.test.ts",
  "tests/unit/near-miss-proof.test.ts",
  "tests/unit/operations-observation.test.ts",
  "tests/unit/operator-release-core-adversarial.test.ts",
  "tests/unit/operator-release-core.test.ts",
  "tests/unit/organizer-route-auth.test.ts",
  "tests/unit/pd01-operations-handoff-evaluator.test.ts",
  "tests/unit/pd01-selection-solver.test.ts",
  "tests/unit/pd01-speaker-readiness.test.ts",
  "tests/unit/phase0-consumption.test.ts",
  "tests/unit/plan-studio-ui.test.ts",
  "tests/unit/portal-shell-accessibility.test.ts",
  "tests/unit/public-agenda-brand.test.ts",
  "tests/unit/public-agenda-release.test.ts",
  "tests/unit/public-artifact-traversal-regression.test.ts",
  "tests/unit/public-widget-gallery.test.ts",
  "tests/unit/public-widget-routes.test.ts",
  "tests/unit/public-widget-session-card.test.ts",
  "tests/unit/public-widgets-embed.test.ts",
  "tests/unit/public-widgets-itinerary-ics.test.ts",
  "tests/unit/public-widgets-projection.test.ts",
  "tests/unit/public-widgets-queries.test.ts",
  "tests/unit/public-widgets-schedule-binding.test.ts",
  "tests/unit/publication-action.test.ts",
  "tests/unit/publication-console-ui.test.ts",
  "tests/unit/readiness-proof-graph-core.test.ts",
  "tests/unit/review-evaluator-microbundle.test.ts",
  "tests/unit/review-setup-ui.test.ts",
  "tests/unit/reviewer-auth.test.ts",
  "tests/unit/reviewer-provisioning-action.test.ts",
  "tests/unit/reviewer-provisioning-ui.test.ts",
  "tests/unit/reviewer-queue-polish.test.ts",
  "tests/unit/route-boundaries.test.ts",
  "tests/unit/scheduling-deterministic.test.ts",
  "tests/unit/shared-action-tasks-ui.test.ts",
  "tests/unit/speaker-artifact-routes.test.ts",
  "tests/unit/speaker-communications-ui.test.ts",
  "tests/unit/speaker-content-operations.test.ts",
  "tests/unit/speaker-csv-browser.test.ts",
  "tests/unit/speaker-event-isolation.test.ts",
  "tests/unit/speaker-manual-ui.test.ts",
  "tests/unit/speaker-shared-action-actions.test.ts",
  "tests/unit/surgical-reconfirmation-core.test.ts",
  "tests/unit/workspace-dashboard-ui.test.ts",
]);

const classifiedUnitTestFiles = Object.freeze(
  [...databaseOrSharedStateUnitTestFiles, ...sourceSafeUnitTestFiles].sort(),
);

export const realSchemaUnitTestFiles = Object.freeze([
  "tests/unit/cfp-schema.test.ts",
  "tests/unit/connector-credentials-schema.test.ts",
  "tests/unit/db-migrations.test.ts",
  "tests/unit/pd01-foundation-schema.test.ts",
  "tests/unit/pd01-program-decision-schema.test.ts",
  "tests/unit/publication-audience-schema.test.ts",
  "tests/unit/review-round-schedule-migration.test.ts",
  "tests/unit/reviewer-access-schema.test.ts",
  "tests/unit/speaker-task-assignment-authority.test.ts",
]);

const realSchemaUnitTestSet = new Set(realSchemaUnitTestFiles);

export const templateUnitTestFiles = Object.freeze(
  classifiedUnitTestFiles.filter((file) => !realSchemaUnitTestSet.has(file)),
);

export const timeoutRiskUnitTests = Object.freeze([
  Object.freeze({
    file: "tests/unit/cfp-applicant-access.test.ts",
    reason: "persistent actor startup timed out in the exact V19 seven-worker fast gate",
  }),
  Object.freeze({
    file: "tests/unit/cfp-form-persistence.test.ts",
    reason: "two-process race exceeded its unchanged 15 s bound in the exact V19 two-worker risk gate",
  }),
  Object.freeze({
    file: "tests/unit/cfp-review-sealing.test.ts",
    reason: "persistent actor convergence timed out in the exact V19 seven-worker fast gate",
  }),
  Object.freeze({
    file: "tests/unit/cfp-submissions.test.ts",
    reason: "persistent actor startup timed out in the exact V19 seven-worker fast gate",
  }),
  Object.freeze({
    file: "tests/unit/db-migrations.test.ts",
    reason: "unchanged 5 s timeout observed in the rejected all-file 8-fork, full 4-worker, and concurrent 2+6 experiments",
  }),
  Object.freeze({
    file: "tests/unit/evaluator-demo.test.ts",
    reason: "unchanged 5 s timeout observed in the rejected all-file 8-fork and concurrent 2+6 experiments",
  }),
  Object.freeze({
    file: "tests/unit/outcomes-correction.test.ts",
    reason: "unchanged 5 s timeout observed in the exact 13e06bf seven-worker fast gate; passes unchanged in serial isolation",
  }),
  Object.freeze({
    file: "tests/unit/speaker-artifact-records.test.ts",
    reason: "unchanged 5 s timeout observed in the rejected all-file 8-fork and concurrent 2+6 experiments",
  }),
  Object.freeze({
    file: "tests/unit/speaker-content-durability-r3.test.ts",
    reason: "persistent actor startup timed out in the exact V19 seven-worker fast gate",
  }),
]);

export const timeoutRiskUnitTestFiles = Object.freeze(
  timeoutRiskUnitTests.map(({ file }) => file),
);

const timeoutRiskUnitTestSet = new Set(timeoutRiskUnitTestFiles);

export const fastUnitTestFiles = Object.freeze(
  classifiedUnitTestFiles.filter((file) => !timeoutRiskUnitTestSet.has(file)),
);

export const riskTemplateUnitTestFiles = Object.freeze(
  templateUnitTestFiles.filter((file) => timeoutRiskUnitTestSet.has(file)),
);

export const riskRealSchemaUnitTestFiles = Object.freeze(
  realSchemaUnitTestFiles.filter((file) => timeoutRiskUnitTestSet.has(file)),
);

export const fastTemplateUnitTestFiles = Object.freeze(
  templateUnitTestFiles.filter((file) => !timeoutRiskUnitTestSet.has(file)),
);

export const fastRealSchemaUnitTestFiles = Object.freeze(
  realSchemaUnitTestFiles.filter((file) => !timeoutRiskUnitTestSet.has(file)),
);
