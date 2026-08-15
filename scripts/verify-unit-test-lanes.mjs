import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  databaseOrSharedStateUnitTestFiles,
  fastRealSchemaUnitTestFiles,
  fastTemplateUnitTestFiles,
  fastUnitTestFiles,
  realSchemaUnitTestFiles,
  riskRealSchemaUnitTestFiles,
  riskTemplateUnitTestFiles,
  selectLaneWorkerCount,
  sharedStateUnitTests,
  sourceSafeUnitTestFiles,
  sqliteUnitTestFiles,
  templateUnitTestFiles,
  timeoutRiskUnitTestFiles,
  timeoutRiskUnitTests,
} from "./unit-test-lanes.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitRoot = resolve(repositoryRoot, "tests/unit");
const sqliteEvidence = /\b(?:openDb|DatabaseSync)\b/u;
const expectedConditionalSelection = Object.freeze({
  file: "tests/unit/production-release-kit.test.ts",
  marker: "it.runIf(process.env.SYMPOSE_REAL_RELEASE_PROOF === \"1\")(",
});
const forbiddenParallelEvidence = Object.freeze([
  Object.freeze({ label: "SQLite/database use", pattern: sqliteEvidence }),
  Object.freeze({
    label: "process environment stubbing",
    pattern: /\bvi\.(?:stubEnv|unstubAllEnvs)\b/u,
  }),
  Object.freeze({
    label: "process environment mutation",
    pattern: /(?:delete\s+process\.env(?:\.|\[)|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*=)/u,
  }),
  Object.freeze({
    label: "process mutation or mocking",
    pattern: /(?:\bprocess\.(?:chdir|exit|kill)\s*\(|\bvi\.spyOn\(\s*process\b)/u,
  }),
  Object.freeze({
    label: "filesystem mutation",
    pattern: /\b(?:appendFileSync|chmodSync|copyFileSync|mkdirSync|mkdtempSync|renameSync|rmSync|symlinkSync|unlinkSync|writeFileSync)\b/u,
  }),
]);
const forbiddenTestSelection = Object.freeze([
  Object.freeze({
    label: "focused test",
    pattern: /\b(?:describe|it|test)\.only\s*\(/u,
  }),
  Object.freeze({
    label: "skipped test",
    pattern: /\b(?:describe|it|test)\.skip\s*\(/u,
  }),
  Object.freeze({
    label: "todo test",
    pattern: /\b(?:describe|it|test)\.todo\s*\(/u,
  }),
]);
const reservedConfigControls = Object.freeze([
  "allowOnly",
  "bail",
  "coverage",
  "hookTimeout",
  "retry",
  "sequence.shuffle",
  "testNamePattern",
  "testTimeout",
]);
const reservedUnitCliControls = /--(?:bail|changed|coverage|hookTimeout|project|related|retry|shard|testNamePattern|testTimeout)(?:=|\s|$)/u;
const expectedUnitScripts = Object.freeze({
  test: "pnpm test:unit",
  "test:unit": "node scripts/verify-unit-test-lanes.mjs && node scripts/ptg-unit-gate.mjs",
  "test:unit:serial": "node scripts/verify-unit-test-lanes.mjs && SYMPOSE_UNIT_DB_TEMPLATE=0 SYMPOSE_UNIT_TEST_MODE=serial vitest run tests/unit",
  "test:unit:verify-order-collection": "node scripts/verify-unit-test-lanes.mjs && node scripts/ptg-unit-gate.mjs --verify-order-collection",
});
const expectedTimeoutRiskReasons = Object.freeze({
  "tests/unit/cfp-applicant-access.test.ts":
    "persistent actor startup timed out in the exact V19 seven-worker fast gate",
  "tests/unit/cfp-form-persistence.test.ts":
    "two-process race exceeded its unchanged 15 s bound in the exact V19 two-worker risk gate",
  "tests/unit/cfp-review-sealing.test.ts":
    "persistent actor convergence timed out in the exact V19 seven-worker fast gate",
  "tests/unit/cfp-submissions.test.ts":
    "persistent actor startup timed out in the exact V19 seven-worker fast gate",
  "tests/unit/db-migrations.test.ts":
    "unchanged 5 s timeout observed in the rejected all-file 8-fork, full 4-worker, and concurrent 2+6 experiments",
  "tests/unit/evaluator-demo.test.ts":
    "unchanged 5 s timeout observed in the rejected all-file 8-fork and concurrent 2+6 experiments",
  "tests/unit/outcomes-correction.test.ts":
    "unchanged 5 s timeout observed in the exact 13e06bf seven-worker fast gate; passes unchanged in serial isolation",
  "tests/unit/speaker-artifact-records.test.ts":
    "unchanged 5 s timeout observed in the rejected all-file 8-fork and concurrent 2+6 experiments",
  "tests/unit/speaker-content-durability-r3.test.ts":
    "persistent actor startup timed out in the exact V19 seven-worker fast gate",
});
const expectedBaseTaskCount = 2013;
const expectedCollectedTaskCount = 2014;
const expectedBaseTaskDigest =
  "190a4e27ad54e080d5b9efdf7c124ab4aceee967ff179f0e73bdd78df5f819f2";
const persistentRaceActorSource = readFileSync(
  resolve(repositoryRoot, "tests/unit/helpers/persistent-race-actor.ts"),
  "utf8",
);
const unitGateSource = readFileSync(resolve(repositoryRoot, "scripts/ptg-unit-gate.mjs"), "utf8");

if (process.argv.length !== 2) {
  throw new Error("the static unit-lane verifier does not accept test-selection arguments");
}

for (const requiredEvidence of [
  'childEnvironment.SYMPOSE_UNIT_TEST_MODE = "serial"',
  'childEnvironment.SYMPOSE_UNIT_DB_TEMPLATE = "0"',
  '"SYMPOSE_UNIT_DB_TEMPLATE_ROOT"',
  '"SYMPOSE_UNIT_TEST_LANE"',
  '"SYMPOSE_UNIT_TEST_SCHEDULE_PATH"',
]) {
  if (!persistentRaceActorSource.includes(requiredEvidence)) {
    throw new Error("persistent race actors must not inherit accelerated parent harness state");
  }
}

for (const requiredEvidence of [
  "endTimeMs - startTimeMs",
  'gitOutput(["status", "--porcelain=v1", "--untracked-files=all"])',
  "candidateSha",
  "if (completeGreen) {",
  "context.gateSucceeded = orderVerification ? orderGreen : completeGreen",
  "if (!context.gateSucceeded || context.fatalState || forwardedSignal)",
]) {
  if (!unitGateSource.includes(requiredEvidence)) {
    throw new Error("the unit gate must preserve measured timing and fail-closed completion controls");
  }
}

function repositoryPath(absolutePath) {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function discoverUnitTests(directory) {
  const discovered = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) discovered.push(...discoverUnitTests(absolutePath));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      discovered.push(repositoryPath(absolutePath));
    }
  }
  return discovered;
}

function duplicates(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function fail(message, values = []) {
  const detail = values.length === 0 ? "" : `\n  - ${values.join("\n  - ")}`;
  throw new Error(`${message}${detail}`);
}

function assertSorted(label, values) {
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    fail(`${label} must stay sorted for deterministic review`);
  }
}

function assertSameSet(label, actual, expected) {
  const missing = difference(expected, actual);
  const unexpected = difference(actual, expected);
  if (missing.length > 0) fail(`${label} is missing expected entries`, missing);
  if (unexpected.length > 0) fail(`${label} has unexpected entries`, unexpected);
}

function sourceFor(file) {
  return readFileSync(resolve(repositoryRoot, ...file.split("/")), "utf8");
}

async function verifyVitestCollection() {
  const environment = {
    SYMPOSE_UNIT_TEST_MODE: "serial",
    SYMPOSE_UNIT_DB_TEMPLATE: "0",
    SYMPOSE_REAL_RELEASE_PROOF: "1",
    SYMPOSE_UNIT_TEST_SCHEDULE_PATH: "",
    NODE_NO_WARNINGS: "1",
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  let vitest;
  let rows;
  let collectionFailed = false;
  try {
    Object.assign(process.env, environment);
    const { createVitest } = await import("vitest/node");
    vitest = await createVitest("test", {
      configLoader: "runner",
      root: repositoryRoot,
      run: true,
      watch: false,
    });
    const result = await vitest.collect(["tests/unit"]);
    const suiteErrors = result.testModules.flatMap((module) => [
      ...module.errors(),
      ...[...module.children.allSuites()].flatMap((suite) => suite.errors()),
    ]);
    collectionFailed = result.unhandledErrors.length > 0 || suiteErrors.length > 0;
    rows = result.testModules.flatMap((module) =>
      [...module.children.allTests()]
        .filter((test) => test.result().state !== "skipped")
        .map((test) => ({ file: test.module.moduleId, name: test.fullName })),
    );
  } catch {
    collectionFailed = true;
  } finally {
    try {
      await vitest?.close();
    } catch {
      collectionFailed = true;
    }
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (typeof value === "undefined") delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (collectionFailed || !Array.isArray(rows)) {
    fail("Vitest collection-only identity proof failed to execute cleanly");
  }
  if (!Array.isArray(rows)) fail("Vitest collection-only identity proof returned a non-array");
  const files = rows.map(({ file }) => repositoryPath(file));
  const uniqueFiles = [...new Set(files)];
  assertSameSet("Vitest collection-only files", uniqueFiles, discoveredUnitTestFiles);

  const identities = rows.map(({ file, name }) => `${repositoryPath(file)}\u0000${name}`);
  if (duplicates(identities).length > 0) fail("Vitest collection-only tasks contain duplicates");
  const conditionalRows = rows.filter(({ file, name }) =>
    repositoryPath(file) === expectedConditionalSelection.file
    && name === "exact health and startup supervision > proves exact health and conventional SIGINT/SIGTERM shutdown against the pinned real standalone");
  if (conditionalRows.length !== 1) fail("Vitest collection-only conditional task identity changed");
  const baseIdentities = rows
    .filter(({ file, name }) =>
      repositoryPath(file) !== expectedConditionalSelection.file
      || name !== "exact health and startup supervision > proves exact health and conventional SIGINT/SIGTERM shutdown against the pinned real standalone")
    .map(({ file, name }) => `${repositoryPath(file)}\u0000${name}`)
    .sort();
  const digest = createHash("sha256").update(baseIdentities.join("\n")).digest("hex");
  if (
    rows.length !== expectedCollectedTaskCount
    || baseIdentities.length !== expectedBaseTaskCount
    || digest !== expectedBaseTaskDigest
  ) {
    fail(
      `Vitest collection-only task identity changed: ${baseIdentities.length}/${rows.length}/${digest}`,
    );
  }
  return { fileCount: uniqueFiles.length, taskCount: rows.length };
}

const discoveredUnitTestFiles = discoverUnitTests(unitRoot).sort();
const sharedStateFiles = sharedStateUnitTests.map(({ file }) => file);
const classifiedFiles = [
  ...databaseOrSharedStateUnitTestFiles,
  ...sourceSafeUnitTestFiles,
];
const acceleratedFiles = [...templateUnitTestFiles, ...realSchemaUnitTestFiles];
const schedulingFiles = [...timeoutRiskUnitTestFiles, ...fastUnitTestFiles];
const riskCrossProductFiles = [
  ...riskTemplateUnitTestFiles,
  ...riskRealSchemaUnitTestFiles,
];
const fastCrossProductFiles = [
  ...fastTemplateUnitTestFiles,
  ...fastRealSchemaUnitTestFiles,
];

assertSorted("SQLite evidence manifest", sqliteUnitTestFiles);
assertSorted("shared-state evidence manifest", sharedStateFiles);
assertSorted("database/shared-state evidence manifest", databaseOrSharedStateUnitTestFiles);
assertSorted("source-safe evidence manifest", sourceSafeUnitTestFiles);
assertSorted("template project manifest", templateUnitTestFiles);
assertSorted("real-schema project manifest", realSchemaUnitTestFiles);
assertSorted("timeout-risk lane manifest", timeoutRiskUnitTestFiles);
assertSorted("fast lane manifest", fastUnitTestFiles);
assertSorted("risk/template cross-product manifest", riskTemplateUnitTestFiles);
assertSorted("risk/real-schema cross-product manifest", riskRealSchemaUnitTestFiles);
assertSorted("fast/template cross-product manifest", fastTemplateUnitTestFiles);
assertSorted("fast/real-schema cross-product manifest", fastRealSchemaUnitTestFiles);

for (const [label, values] of [
  ["SQLite evidence manifest", sqliteUnitTestFiles],
  ["shared-state evidence manifest", sharedStateFiles],
  ["database/shared-state evidence manifest", databaseOrSharedStateUnitTestFiles],
  ["source-safe evidence manifest", sourceSafeUnitTestFiles],
  ["combined source-evidence manifest", classifiedFiles],
  ["template project manifest", templateUnitTestFiles],
  ["real-schema project manifest", realSchemaUnitTestFiles],
  ["accelerated project partition", acceleratedFiles],
  ["timeout scheduling partition", schedulingFiles],
  ["risk/template-real cross-product", riskCrossProductFiles],
  ["fast/template-real cross-product", fastCrossProductFiles],
]) {
  const repeated = duplicates(values);
  if (repeated.length > 0) fail(`${label} contains duplicate or overlapping entries`, repeated);
}

assertSameSet("unit lane classification", classifiedFiles, discoveredUnitTestFiles);
assertSameSet("accelerated project partition", acceleratedFiles, discoveredUnitTestFiles);
assertSameSet("timeout scheduling partition", schedulingFiles, discoveredUnitTestFiles);
assertSameSet("risk/template-real cross-product", riskCrossProductFiles, timeoutRiskUnitTestFiles);
assertSameSet("fast/template-real cross-product", fastCrossProductFiles, fastUnitTestFiles);
assertSameSet(
  "template scheduling cross-product",
  [...riskTemplateUnitTestFiles, ...fastTemplateUnitTestFiles],
  templateUnitTestFiles,
);
assertSameSet(
  "real-schema scheduling cross-product",
  [...riskRealSchemaUnitTestFiles, ...fastRealSchemaUnitTestFiles],
  realSchemaUnitTestFiles,
);
assertSameSet(
  "SQLite source-evidence classification",
  discoveredUnitTestFiles.filter((file) => sqliteEvidence.test(sourceFor(file))),
  sqliteUnitTestFiles,
);

for (const { file, reason, evidence } of sharedStateUnitTests) {
  const source = sourceFor(file);
  const missingEvidence = evidence.filter((marker) => !source.includes(marker));
  if (missingEvidence.length > 0) {
    fail(`${file} no longer contains its declared ${reason} evidence`, missingEvidence);
  }
}

assertSameSet(
  "timeout-risk evidence files",
  timeoutRiskUnitTestFiles,
  Object.keys(expectedTimeoutRiskReasons),
);
for (const { file, reason } of timeoutRiskUnitTests) {
  if (reason !== expectedTimeoutRiskReasons[file]) {
    fail(`${file} no longer has its fixed observed-timeout reason`);
  }
}

for (const file of sourceSafeUnitTestFiles) {
  const source = sourceFor(file);
  const hazards = forbiddenParallelEvidence
    .filter(({ pattern }) => pattern.test(source))
    .map(({ label }) => label);
  if (hazards.length > 0) fail(`${file} contains serial-only source evidence`, hazards);
}

let conditionalSelectionCount = 0;
for (const file of discoveredUnitTestFiles) {
  const source = sourceFor(file);
  for (const { label, pattern } of forbiddenTestSelection) {
    if (pattern.test(source)) fail(`${file} contains a ${label}`);
  }
  const runIfCount = source.match(/\b(?:describe|it|test)\.runIf\s*\(/gu)?.length ?? 0;
  conditionalSelectionCount += runIfCount;
  if (runIfCount > 0 && (
    file !== expectedConditionalSelection.file
    || runIfCount !== 1
    || !source.includes(expectedConditionalSelection.marker)
  )) {
    fail(`${file} contains an unreserved conditional test selection`);
  }
}
if (conditionalSelectionCount !== 1) {
  fail(`expected exactly one reserved conditional test; found ${conditionalSelectionCount}`);
}

const vitestConfigSource = readFileSync(resolve(repositoryRoot, "vitest.config.ts"), "utf8");
for (const control of reservedConfigControls) {
  if (vitestConfigSource.includes(control)) {
    fail(`vitest.config.ts contains reserved control ${control}`);
  }
}
if (!vitestConfigSource.includes("process.env.SYMPOSE_UNIT_TEST_LANE")) {
  fail("vitest.config.ts no longer requires the internal accelerated lane");
}
if (vitestConfigSource.includes("SYMPOSE_UNIT_TEST_WORKERS")) {
  fail("vitest.config.ts exposes a mutable accelerated worker count");
}
if (!vitestConfigSource.includes("selectLaneWorkerCount(selectedLane)")) {
  fail("vitest.config.ts no longer selects workers from the bounded hardware-adaptive policy");
}
if (!vitestConfigSource.includes('env: { SYMPOSE_UNIT_DB_TEMPLATE: "1" }')) {
  fail("vitest.config.ts no longer enables templates only for template-safe projects");
}
if (!vitestConfigSource.includes('env: { SYMPOSE_UNIT_DB_TEMPLATE: "0" }')) {
  fail("vitest.config.ts no longer keeps real-schema projects on fresh schema");
}
for (const [logicalCpuCount, ci, expected] of [
  [1, false, { risk: 1, fast: 1 }],
  [8, false, { risk: 1, fast: 7 }],
  [8, true, { risk: 1, fast: 4 }],
]) {
  for (const lane of ["risk", "fast"]) {
    if (selectLaneWorkerCount(lane, logicalCpuCount, ci) !== expected[lane]) {
      fail(`worker policy changed unexpectedly for ${logicalCpuCount} CPUs/${ci ? "CI" : "local"}`);
    }
  }
}

const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
for (const [scriptName, expectedCommand] of Object.entries(expectedUnitScripts)) {
  const command = packageJson.scripts?.[scriptName];
  if (typeof command !== "string") fail(`package.json is missing ${scriptName}`);
  if (command !== expectedCommand) fail(`package.json ${scriptName} no longer matches the full-gate contract`);
  if (reservedUnitCliControls.test(command)) {
    fail(`package.json ${scriptName} contains a reserved test control`);
  }
}

const gateRunnerSource = readFileSync(resolve(repositoryRoot, "scripts/ptg-unit-gate.mjs"), "utf8");
if (reservedUnitCliControls.test(gateRunnerSource)) {
  fail("scripts/ptg-unit-gate.mjs contains a reserved test control");
}
if (gateRunnerSource.includes("Promise.all(")) {
  fail("scripts/ptg-unit-gate.mjs must keep risk and fast phases sequential");
}
if (!gateRunnerSource.includes('lane: "risk"') || !gateRunnerSource.includes('lane: "fast"')) {
  fail("scripts/ptg-unit-gate.mjs no longer declares the risk then fast lane order");
}
if (!gateRunnerSource.includes("for (const laneDefinition of laneDefinitions)")) {
  fail("scripts/ptg-unit-gate.mjs no longer executes the lanes through one sequential loop");
}
for (const marker of [
  "vitest", "list", "--verify-order-collection", "sympose.unit-test-gate.receipt.v1",
  "disk-backed-per-user-cache", "timingHints", "handleMarkerCount", "templateDigest",
  "aggregateCpuSeconds", "peakRssBytes", "cacheBytes", "minimumPredictedCriticalPathGainMs",
  "templateEvidencePositive", "collection-order-only", "separate-opt-in-not-run",
]) {
  if (!gateRunnerSource.includes(marker)) fail(`scripts/ptg-unit-gate.mjs lost required ${marker} evidence`);
}

const collectionEvidence = await verifyVitestCollection();

console.log(
  `Unit test lanes verified: ${classifiedFiles.length} files `
    + `(${templateUnitTestFiles.length} template-enabled + ${realSchemaUnitTestFiles.length} real-schema; `
    + `${timeoutRiskUnitTestFiles.length} timeout-risk then ${fastUnitTestFiles.length} fast with one CPU reserved; `
    + `${sqliteUnitTestFiles.length} direct SQLite/database and ${sharedStateFiles.length} shared-state evidence files; `
    + `collection-only proof ${collectionEvidence.fileCount} files/${collectionEvidence.taskCount} tasks).`,
);
