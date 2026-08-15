import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

import {
  fastRealSchemaUnitTestFiles,
  fastTemplateUnitTestFiles,
  selectLaneWorkerCount,
  riskRealSchemaUnitTestFiles,
  riskTemplateUnitTestFiles,
  unitTestInclude,
} from "./scripts/unit-test-lanes.mjs";

const sourceAlias = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyTestShim = fileURLToPath(new URL("./tests/fixtures/server-only.ts", import.meta.url));
const unitTestMode = process.env.SYMPOSE_UNIT_TEST_MODE ?? "serial";

if (unitTestMode !== "serial" && unitTestMode !== "accelerated") {
  throw new Error(
    `SYMPOSE_UNIT_TEST_MODE must be "serial" or "accelerated"; received ${JSON.stringify(unitTestMode)}`,
  );
}

function acceleratedLane() {
  const lane = process.env.SYMPOSE_UNIT_TEST_LANE;
  if (lane !== "risk" && lane !== "fast") {
    throw new Error(`SYMPOSE_UNIT_TEST_LANE must be "risk" or "fast"; received ${JSON.stringify(lane)}`);
  }
  return lane;
}

const selectedLane = unitTestMode === "accelerated" ? acceleratedLane() : undefined;
const laneWorkerCount = selectedLane === undefined ? undefined : selectLaneWorkerCount(selectedLane);
const laneTemplateFiles = selectedLane === "risk"
  ? riskTemplateUnitTestFiles
  : fastTemplateUnitTestFiles;
const laneRealSchemaFiles = selectedLane === "risk"
  ? riskRealSchemaUnitTestFiles
  : fastRealSchemaUnitTestFiles;

function scheduledLaneFiles(files: readonly string[], project: "template" | "realSchema"): string[] {
  const schedulePath = process.env.SYMPOSE_UNIT_TEST_SCHEDULE_PATH;
  if (!schedulePath) return [...files];
  if (!isAbsolute(schedulePath)) {
    throw new Error("SYMPOSE_UNIT_TEST_SCHEDULE_PATH must be absolute");
  }

  let schedule: unknown;
  try {
    schedule = JSON.parse(readFileSync(schedulePath, "utf8")) as unknown;
  } catch {
    throw new Error("unit-test schedule is unreadable");
  }
  const scheduled = (schedule as {
    lanes?: Record<string, Record<string, { files?: unknown }>>;
  }).lanes?.[selectedLane ?? ""]?.[project]?.files;
  if (!Array.isArray(scheduled) || scheduled.some((file) => typeof file !== "string")) {
    throw new Error("unit-test schedule is malformed");
  }
  const expected = new Set(files);
  const actual = new Set(scheduled);
  if (actual.size !== files.length || actual.size !== scheduled.length) {
    throw new Error("unit-test schedule changes the lane inventory");
  }
  for (const file of expected) {
    if (!actual.has(file)) throw new Error("unit-test schedule changes the lane inventory");
  }
  return [...scheduled];
}

export default defineConfig({
  resolve: {
    alias: {
      "@": sourceAlias,
      "server-only": serverOnlyTestShim,
    },
  },
  test: unitTestMode === "serial"
    ? {
        environment: "node",
        env: { SYMPOSE_UNIT_DB_TEMPLATE: "0" },
        include: [...unitTestInclude],
        fileParallelism: false,
        pool: "threads",
        maxWorkers: 1,
      }
    : {
        projects: [
          {
            resolve: { alias: { "@": sourceAlias, "server-only": serverOnlyTestShim } },
            test: {
              name: `${selectedLane}-template`,
              environment: "node",
              env: { SYMPOSE_UNIT_DB_TEMPLATE: "1" },
              include: scheduledLaneFiles(laneTemplateFiles, "template"),
              fileParallelism: true,
              pool: "forks",
              maxWorkers: laneWorkerCount,
            },
          },
          {
            resolve: { alias: { "@": sourceAlias, "server-only": serverOnlyTestShim } },
            test: {
              name: `${selectedLane}-real-schema`,
              environment: "node",
              env: { SYMPOSE_UNIT_DB_TEMPLATE: "0" },
              include: scheduledLaneFiles(laneRealSchemaFiles, "realSchema"),
              fileParallelism: true,
              pool: "forks",
              maxWorkers: laneWorkerCount,
            },
          },
        ],
      },
});
