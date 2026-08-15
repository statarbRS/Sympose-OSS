import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkpointMocks = vi.hoisted(() => ({
  loadApplicantPublicCall: vi.fn(),
}));

vi.mock("@/app/cfp/actions", () => ({
  loadApplicantPublicCall: checkpointMocks.loadApplicantPublicCall,
}));

import SpeakerCheckpointPage from "@/app/speaker/[workspace]/[callSlug]/page";
import { SpeakerPortalEntry } from "@/components/speaker-portal/portal-entry";
import { EVALUATOR_CALL_SLUG, EVALUATOR_WORKSPACE_SLUG } from "@/server/evaluator-demo";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const handoff = readFileSync(
  new URL("../../docs/testing/evaluator-release-handoff.md", import.meta.url),
  "utf8",
);
const evaluationMatrix = readFileSync(
  new URL("../../docs/testing/external-eval-matrix.md", import.meta.url),
  "utf8",
);
const criterionMatrix = JSON.parse(
  readFileSync(new URL("../fixtures/external-eval/criterion-matrix.json", import.meta.url), "utf8"),
) as {
  readonly criteria: ReadonlyArray<{ readonly status: string }>;
  readonly deferredCriteria: ReadonlyArray<{ readonly status: string }>;
};

describe("evaluator copy truthfulness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkpointMocks.loadApplicantPublicCall.mockResolvedValue({ name: "Stagecraft 2026 CFP" });
  });

  it("binds the live handoff to exact health without treating its ephemeral URL as identity", () => {
    expect(readme).toContain("SYMPOSE_BUILD_SHA=<full-40-character-HEAD> pnpm evaluator:release:start");
    expect(readme).toContain("Current hosted evaluator:** <https://ethical-opera-murphy-somewhere.trycloudflare.com>");
    expect(readme).toContain("not a named,");
    expect(readme).toContain("uptime-backed hostname");
    expect(readme).toContain("An `unbound` response");
    expect(readme).toContain("docs/testing/evaluator-release-handoff.md");
    expect(handoff).toContain("## Exact SHA, URL, and health record");
    expect(handoff).toContain("## Five-role ten-minute route");
    expect(handoff).toContain("## Persistence contract");
    expect(handoff).toContain("## Known limits");
    expect(handoff).toContain("intentionally does not embed the SHA of the commit");
    expect(handoff).toContain("contains it: doing so would be self-referential");
    expect(handoff).toContain("not a stable named hostname or candidate identity");
    expect(handoff).toContain("Reconfirm its external `/health` body");
    expect(readme).not.toContain("merge request !9");
    expect(readme).not.toContain("branch `integration/eval-mvp`");
  });

  it("replaces the obsolete speaker placeholder without weakening pending rubric status", () => {
    expect(evaluationMatrix).toContain("scoped speaker tasks and durable content/version evidence");
    expect(evaluationMatrix).toContain("Every required criterion remains pending");
    expect(evaluationMatrix).not.toContain(
      "Speaker task, deliverable, file, and content records are not represented",
    );
    expect(criterionMatrix.criteria).toHaveLength(86);
    expect(criterionMatrix.criteria.every((criterion) => criterion.status === "pending")).toBe(true);
    expect(criterionMatrix.deferredCriteria).toHaveLength(12);
    expect(criterionMatrix.deferredCriteria.every((criterion) => criterion.status === "deferred")).toBe(true);
  });

  it("states the partial speaker durability boundary without denying real uploads", async () => {
    const html = renderToStaticMarkup(await SpeakerCheckpointPage({
      params: Promise.resolve({
        workspace: EVALUATOR_WORKSPACE_SLUG,
        callSlug: EVALUATOR_CALL_SLUG,
      }),
    }));

    expect(html).toContain("Current evidence boundary");
    expect(html).toContain("bounded PNG/PDF artifact uploads");
    expect(html).toContain("profile/text versions");
    expect(html).toContain("persist in");
    expect(html).toContain("local SQLite");
    expect(html).toContain("local filesystem storage");
    expect(html).toContain("no malware scanner");
    expect(html).not.toContain("not modeled in the current S0 schema");
  });

  it("keeps real artifact bytes distinct from process-local workflow and absent providers", () => {
    const html = renderToStaticMarkup(createElement(SpeakerPortalEntry));

    expect(html).toContain("real local artifact bytes");
    expect(html).toContain("Task changes");
    expect(html).toContain("profile and text versions");
    expect(html).toContain("reviews persist in local SQLite");
    expect(html).toContain("exact bytes in scoped local filesystem storage");
    expect(html).toContain("No malware scanner");
    expect(html).toContain("object-storage provider");
    expect(html).toContain("SMTP");
    expect(html).toContain("provider delivery");
  });
});
