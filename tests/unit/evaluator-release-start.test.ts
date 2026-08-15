import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createEvaluatorReleasePlan,
  EvaluatorReleaseStartError,
  isExactEvaluatorHealth,
} from "../../scripts/start-evaluator-release.mjs";

const root = resolve("/tmp/sympose-evaluator-release-test");
const firstSha = "a".repeat(40);
const secondSha = "b".repeat(40);
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly scripts: Readonly<Record<string, string>> };

type PlanInput = {
  readonly root: string;
  readonly requestedSha: string | undefined;
  readonly currentHead: string | undefined;
  readonly trackedChanges?: boolean;
  readonly untrackedPaths?: readonly string[];
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly nodeExecutable?: string;
};

type ReleasePlan = {
  readonly buildSha: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly origin: string;
  readonly healthUrl: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
};

const buildPlan = createEvaluatorReleasePlan as unknown as (input: PlanInput) => ReleasePlan;

function plan(overrides: Partial<PlanInput> = {}): ReleasePlan {
  return buildPlan({
    root,
    requestedSha: firstSha,
    currentHead: firstSha,
    sourceEnvironment: { PATH: "/usr/bin", LANG: "C.UTF-8" },
    nodeExecutable: "/usr/bin/node",
    ...overrides,
  });
}

describe("exact-candidate evaluator release start", () => {
  it("exposes exactly the repository-owned package entry for this launcher", () => {
    expect(packageJson.scripts["evaluator:release:start"]).toBe(
      "node scripts/start-evaluator-release.mjs",
    );
    expect(
      Object.values(packageJson.scripts)
        .filter((command) => command.includes("start-evaluator-release.mjs")),
    ).toHaveLength(1);
  });

  it.each([undefined, "", "unbound", "a".repeat(39), "g".repeat(40)])(
    "rejects a missing, abbreviated, or malformed SHA: %s",
    (requestedSha) => {
      expect(() => plan({ requestedSha })).toThrow(EvaluatorReleaseStartError);
      expect(() => plan({ requestedSha })).toThrow(/full 40-character Git commit SHA/u);
    },
  );

  it("normalizes a full SHA but rejects an exact-HEAD mismatch", () => {
    expect(plan({ requestedSha: firstSha.toUpperCase() }).buildSha).toBe(firstSha);
    expect(() => plan({ currentHead: secondSha })).toThrow(/does not match the current exact HEAD/u);
  });

  it("refuses tracked and untracked candidate edits without treating dependencies as source", () => {
    expect(() => plan({ trackedChanges: true })).toThrow(/uncommitted files/u);
    expect(() => plan({ untrackedPaths: ["src/uncommitted.ts"] })).toThrow(/uncommitted files/u);
    expect(() => plan({ untrackedPaths: ["node_modules"] })).not.toThrow();
    expect(() => plan({ untrackedPaths: ["node_modules/injected.js"] })).toThrow(/uncommitted files/u);
  });

  it("forces loopback development mode and excludes undeclared inherited variables", () => {
    const release = plan({
      sourceEnvironment: {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        TZ: "Pacific/Honolulu",
        SYMPOSE_DB_PATH: "/shared/sympose.db",
        SYMPOSE_ARTIFACT_STORE_ROOT: "/shared/artifacts",
        PROVIDER_API_TOKEN: "must-not-reach-child",
      },
    });

    expect(release.origin).toBe("http://127.0.0.1:3000");
    expect(release.healthUrl).toBe("http://127.0.0.1:3000/health");
    expect(release.args).toEqual([
      resolve(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "-p",
      "3000",
    ]);
    expect(release.environment).toMatchObject({
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: "3000",
      SYMPOSE_APPLICANT_VERIFICATION_DELIVERY: "simulated",
      SYMPOSE_BUILD_SHA: firstSha,
      SYMPOSE_DATA_MODE: "synthetic-evaluator",
      SYMPOSE_EVALUATOR_PROFILE: "local",
      TZ: "UTC",
    });
    expect(release.environment).not.toHaveProperty("PROVIDER_API_TOKEN");
    expect(release.environment.SYMPOSE_DB_PATH).toBe(release.databasePath);
    expect(release.environment.SYMPOSE_ARTIFACT_STORE_ROOT).toBe(release.artifactRoot);
    expect(release.environment.SYMPOSE_DB_PATH).not.toBe("/shared/sympose.db");
    expect(release.environment.SYMPOSE_ARTIFACT_STORE_ROOT).not.toBe("/shared/artifacts");
  });

  it("uses deterministic per-SHA database and artifact roots and preserves same-SHA paths", () => {
    const first = plan();
    const restart = plan();
    const next = plan({ requestedSha: secondSha, currentHead: secondSha });

    expect(restart.databasePath).toBe(first.databasePath);
    expect(restart.artifactRoot).toBe(first.artifactRoot);
    expect(first.databasePath).toBe(
      resolve(root, ".tmp", "evaluator-release", firstSha, "sympose.db"),
    );
    expect(first.artifactRoot).toBe(
      resolve(root, ".tmp", "evaluator-release", firstSha, "artifacts"),
    );
    expect(next.databasePath).not.toBe(first.databasePath);
    expect(next.artifactRoot).not.toBe(first.artifactRoot);
  });

  it("accepts only the exact three-field health payload", () => {
    expect(isExactEvaluatorHealth({
      status: "ok",
      buildSha: firstSha,
      dataMode: "synthetic-evaluator",
    }, firstSha)).toBe(true);
    expect(isExactEvaluatorHealth({
      status: "ok",
      buildSha: "unbound",
      dataMode: "synthetic-evaluator",
    }, firstSha)).toBe(false);
    expect(isExactEvaluatorHealth({
      status: "ok",
      buildSha: firstSha,
      dataMode: "synthetic-evaluator",
      leaked: "unexpected",
    }, firstSha)).toBe(false);
  });
});
