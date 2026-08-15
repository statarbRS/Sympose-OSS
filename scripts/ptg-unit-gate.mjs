import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  availableParallelism,
  homedir,
  loadavg,
  platform,
  totalmem,
} from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  fastRealSchemaUnitTestFiles,
  fastTemplateUnitTestFiles,
  fastUnitTestFiles,
  orderUnitTestFiles,
  riskRealSchemaUnitTestFiles,
  riskTemplateUnitTestFiles,
  selectLaneWorkerCount,
  timeoutRiskUnitTestFiles,
} from "./unit-test-lanes.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedFiles = [...timeoutRiskUnitTestFiles, ...fastUnitTestFiles].sort();
const expectedBaseTaskCount = 1992;
const expectedConditionalTaskCount = 1;
const expectedCollectedTaskCount = expectedBaseTaskCount + expectedConditionalTaskCount;
const expectedBaseTaskDigest =
  "4d998607c95c29fa6eb4743d10ad1594c5cb9ded4e43c5c20c08c466382560df";
const reservedConditional = Object.freeze({
  file: "tests/unit/production-release-kit.test.ts",
  name: "exact health and startup supervision > proves exact health and conventional SIGINT/SIGTERM shutdown against the pinned real standalone",
});
const laneDefinitions = Object.freeze([
  Object.freeze({ lane: "risk", expectedLaneFiles: timeoutRiskUnitTestFiles }),
  Object.freeze({ lane: "fast", expectedLaneFiles: fastUnitTestFiles }),
]);
const templateEvidenceName = "template-evidence.json";
const templateName = "template.sqlite";
const templateRootPrefix = "sympose-unit-db-template-run-";
const timingHintsSchema = "sympose.unit-test-timing-hints.v1";
const receiptSchema = "sympose.unit-test-gate.receipt.v1";
const timingHintMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const timingObservationLimit = 8;
const receiptMaxBytes = 64 * 1024;
const forbiddenCliSelection = /--(?:bail|changed|coverage|hookTimeout|project|related|retry|shard|testNamePattern|testTimeout)(?:=|\s|$)/u;
const orderVerificationFlag = "--verify-order-collection";
const resourceTimerPath = "/usr/bin/time";
const maxMeasuredCacheBytes = 256 * 1024 * 1024;
const maxMeasuredCacheEntries = 10_000;
const minimumPredictedCriticalPathGainMs = 1_000;
const maximumPredictedP95Regression = 0.05;

const requestedMode = process.argv.slice(2);
const orderVerification = requestedMode.length === 1 && requestedMode[0] === orderVerificationFlag;
if (requestedMode.length > 0 && !orderVerification) {
  throw new Error(`the unit gate accepts only the fixed ${orderVerificationFlag} mode`);
}
if (forbiddenCliSelection.test(process.argv.slice(2).join(" "))) {
  throw new Error("the unit gate does not accept mutable test-selection controls");
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function gitOutput(args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.signal || typeof result.stdout !== "string") {
    fail("unit gate could not bind evidence to the exact Git candidate");
  }
  return result.stdout.trim();
}

function exactCandidate() {
  const sha = gitOutput(["rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail("unit gate received an invalid Git candidate SHA");
  const worktreeState = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (worktreeState !== "") fail("unit gate requires a clean committed candidate");
  return { sha, worktree: "clean" };
}

function repositoryPath(absolutePath) {
  if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
    fail("Vitest JSON contains a non-absolute test file path");
  }
  const path = relative(repositoryRoot, absolutePath).split(sep).join("/");
  if (path === ".." || path.startsWith("../")) {
    fail("Vitest JSON contains a test file outside the repository");
  }
  return path;
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

function assertExactSet(label, actual, expected) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (sortedActual.length !== sortedExpected.length) fail(`${label} changed size`);
  const repeated = duplicates(sortedActual);
  if (repeated.length > 0) fail(`${label} contains duplicates`);
  if (difference(sortedExpected, sortedActual).length > 0) fail(`${label} is missing files`);
  if (difference(sortedActual, sortedExpected).length > 0) fail(`${label} contains unexpected files`);
}

function digestFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const relativeFile = file.split(sep).join("/");
    hash.update(relativeFile).update("\u0000").update(readFileSync(resolve(repositoryRoot, file)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

const inventoryDigest = sha256(JSON.stringify({
  fileCount: expectedFiles.length,
  files: expectedFiles,
  activeTaskCount: expectedBaseTaskCount,
  conditionalTaskCount: expectedConditionalTaskCount,
  collectedTaskCount: expectedCollectedTaskCount,
  activeTaskDigest: expectedBaseTaskDigest,
}));
const configDigest = digestFiles(["package.json", "vitest.config.ts"]);
const harnessDigest = digestFiles([
  "package.json",
  "src/server/db.ts",
  "tests/unit/helpers/persistent-race-actor.ts",
  "vitest.config.ts",
  "scripts/ptg-unit-gate.mjs",
  "scripts/unit-test-lanes.mjs",
  "scripts/verify-unit-test-lanes.mjs",
]);
const schemaSourceDigest = digestFiles(["src/server/schema.ts"]);

function memoryClass() {
  const gib = totalmem() / (1024 ** 3);
  if (gib <= 4) return "<=4GiB";
  if (gib <= 8) return "<=8GiB";
  if (gib <= 16) return "<=16GiB";
  if (gib <= 32) return "<=32GiB";
  return ">32GiB";
}

const logicalCpuCount = availableParallelism();
const ci = process.env.CI === "1" || process.env.CI === "true";
const machineClass = Object.freeze({
  platform: platform(),
  arch: arch(),
  logicalCpuCount,
  memoryClass: memoryClass(),
});
const machineClassDigest = sha256(JSON.stringify(machineClass));
const workerCounts = Object.freeze({
  risk: selectLaneWorkerCount("risk", logicalCpuCount, ci),
  fast: selectLaneWorkerCount("fast", logicalCpuCount, ci),
});

function cacheRoot() {
  const configured = process.env.XDG_CACHE_HOME;
  if (configured && !isAbsolute(configured)) fail("XDG_CACHE_HOME must be absolute");
  const base = resolve(configured ?? join(homedir(), ".cache"));
  const root = join(base, "sympose", "unit-test-gate");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = realpathSync(root);
  const stats = statSync(real);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    fail("unit-test cache root must be an owner-only directory");
  }
  const fileSystemType = Number(statfsSync(real).type);
  if (fileSystemType === 0x01021994 || fileSystemType === 0x858458f6) {
    fail("unit-test cache root must be disk-backed, not tmpfs or ramfs");
  }
  return real;
}

function quietHost() {
  const load1 = loadavg()[0];
  const capacity = Math.max(1, logicalCpuCount - 1);
  return Number.isFinite(load1) && load1 <= capacity;
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function predictedCriticalPathMs(files, durations, workers) {
  const loads = Array.from({ length: Math.max(1, workers) }, () => 0);
  for (const file of files) {
    const duration = Number(durations.get(file));
    const worker = loads.indexOf(Math.min(...loads));
    loads[worker] += Number.isFinite(duration) && duration >= 0 ? duration : 0;
  }
  return Math.max(...loads);
}

function timingGuard(accepted, weights) {
  const canonicalCriticalPaths = [];
  const timingCriticalPaths = [];
  for (const observation of accepted) {
    let canonicalCriticalPath = 0;
    let timingCriticalPath = 0;
    for (const lane of laneDefinitions) {
      const durations = new Map(observation.lanes[lane.lane].map(({ file, durationMs }) => [file, durationMs]));
      canonicalCriticalPath += predictedCriticalPathMs(
        orderUnitTestFiles(lane.expectedLaneFiles, "canonical"),
        durations,
        workerCounts[lane.lane],
      );
      timingCriticalPath += predictedCriticalPathMs(
        orderUnitTestFiles(lane.expectedLaneFiles, "timing", weights),
        durations,
        workerCounts[lane.lane],
      );
    }
    canonicalCriticalPaths.push(canonicalCriticalPath);
    timingCriticalPaths.push(timingCriticalPath);
  }
  const gains = canonicalCriticalPaths.map((value, index) => value - timingCriticalPaths[index]);
  const canonicalP95CriticalPathMs = percentile95(canonicalCriticalPaths);
  const timingP95CriticalPathMs = percentile95(timingCriticalPaths);
  const p95RegressionRatio = canonicalP95CriticalPathMs > 0
    ? (timingP95CriticalPathMs - canonicalP95CriticalPathMs) / canonicalP95CriticalPathMs
    : timingP95CriticalPathMs === 0 ? 0 : Infinity;
  const predictedCriticalPathGainMs = median(gains);
  return {
    predictedCriticalPathGainMs,
    canonicalP95CriticalPathMs,
    timingP95CriticalPathMs,
    p95RegressionRatio,
    minimumPredictedCriticalPathGainMs,
    maximumPredictedP95Regression,
    gainPassed: predictedCriticalPathGainMs >= minimumPredictedCriticalPathGainMs,
    p95Passed: timingP95CriticalPathMs <= canonicalP95CriticalPathMs * (1 + maximumPredictedP95Regression),
  };
}

function readTimingStore(root) {
  const path = join(root, "timing-hints.v1.json");
  if (!existsSync(path)) return { path, store: null };
  try {
    if (statSync(path).size > 256 * 1024) return { path, store: null };
    const store = JSON.parse(readFileSync(path, "utf8"));
    if (store?.schema !== timingHintsSchema || !Array.isArray(store.observations)) {
      return { path, store: null };
    }
    return { path, store };
  } catch {
    return { path, store: null };
  }
}

function completeGreenObservation(observation, now) {
  if (
    observation?.schema !== timingHintsSchema
    || observation.completeGreen !== true
    || observation.inventoryDigest !== inventoryDigest
    || observation.harnessDigest !== harnessDigest
    || observation.machineClassDigest !== machineClassDigest
    || !/^[0-9a-f]{40}$/u.test(observation.candidateSha)
    || typeof observation.recordedAt !== "string"
  ) return false;
  const recordedAt = Date.parse(observation.recordedAt);
  if (!Number.isFinite(recordedAt) || now - recordedAt < 0 || now - recordedAt > timingHintMaxAgeMs) {
    return false;
  }
  for (const lane of laneDefinitions) {
    const rows = observation.lanes?.[lane.lane];
    if (!Array.isArray(rows)) return false;
    const seen = new Set();
    for (const row of rows) {
      if (
        typeof row?.file !== "string"
        || !lane.expectedLaneFiles.includes(row.file)
        || seen.has(row.file)
        || !Number.isFinite(row.durationMs)
        || row.durationMs < 0
      ) return false;
      seen.add(row.file);
    }
    if (seen.size !== lane.expectedLaneFiles.length) return false;
  }
  return true;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function timingPlan(root) {
  const { path, store } = readTimingStore(root);
  const observations = Array.isArray(store?.observations) ? store.observations : [];
  const now = Date.now();
  const accepted = observations
    .filter((observation) => completeGreenObservation(observation, now))
    .slice(-timingObservationLimit);
  if (accepted.length < 3) {
    return {
      path,
      applied: false,
      reason: "fewer_than_three_complete_green_same_class_observations",
      acceptedObservationCount: accepted.length,
      staleObservationCount: observations.length - accepted.length,
      hysteresisApplied: false,
      guard: null,
      weights: new Map(),
    };
  }

  const weights = new Map();
  for (const lane of laneDefinitions) {
    for (const file of lane.expectedLaneFiles) {
      const durations = accepted.flatMap((observation) =>
        observation.lanes[lane.lane]
          .filter((row) => row.file === file)
          .map((row) => row.durationMs));
      const value = median(durations);
      if (value !== null) weights.set(file, value);
    }
  }

  const guard = timingGuard(accepted, weights);
  if (!guard.gainPassed || !guard.p95Passed) {
    return {
      path,
      applied: false,
      reason: !guard.gainPassed && !guard.p95Passed
        ? "predicted_critical_path_gain_and_p95_guard_failed"
        : !guard.gainPassed
          ? "predicted_critical_path_gain_below_one_second"
          : "predicted_p95_regression_above_five_percent",
      acceptedObservationCount: accepted.length,
      staleObservationCount: observations.length - accepted.length,
      hysteresisApplied: false,
      guard,
      weights: new Map(),
    };
  }

  let hysteresisApplied = false;
  const previous = store?.lastApplied;
  if (
    previous?.inventoryDigest === inventoryDigest
    && previous?.harnessDigest === harnessDigest
    && previous?.machineClassDigest === machineClassDigest
    && previous.weights
  ) {
    const previousWeights = new Map(Object.entries(previous.weights));
    const changesWithinHysteresis = [...weights].every(([file, value]) => {
      const prior = Number(previousWeights.get(file));
      return Number.isFinite(prior) && prior > 0 && Math.abs(value - prior) / prior <= 0.2;
    });
    if (changesWithinHysteresis) {
      for (const [file, value] of previousWeights) {
        if (expectedFiles.includes(file) && Number.isFinite(Number(value))) {
          weights.set(file, Number(value));
        }
      }
      hysteresisApplied = true;
    }
  }
  return {
    path,
    applied: true,
    reason: "accepted_complete_green_same_class_observations",
    acceptedObservationCount: accepted.length,
    staleObservationCount: observations.length - accepted.length,
    hysteresisApplied,
    guard,
    weights,
  };
}

function scheduleFile(root, mode, timing) {
  const timingWeights = timing?.applied ? timing.weights : undefined;
  const schedule = {
    schema: "sympose.unit-test-schedule.v1",
    mode,
    lanes: {
      risk: {
        files: orderUnitTestFiles(timeoutRiskUnitTestFiles, mode, timingWeights),
        template: { files: orderUnitTestFiles(riskTemplateUnitTestFiles, mode, timingWeights) },
        realSchema: { files: orderUnitTestFiles(riskRealSchemaUnitTestFiles, mode, timingWeights) },
      },
      fast: {
        files: orderUnitTestFiles(fastUnitTestFiles, mode, timingWeights),
        template: { files: orderUnitTestFiles(fastTemplateUnitTestFiles, mode, timingWeights) },
        realSchema: { files: orderUnitTestFiles(fastRealSchemaUnitTestFiles, mode, timingWeights) },
      },
    },
  };
  const path = join(root, `unit-test-schedule-${mode}.json`);
  writeFileSync(path, JSON.stringify(schedule), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { path, schedule };
}

function readLaneReport(lane, reportPath, expectedLaneFiles) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail(`${lane} lane did not produce a readable Vitest JSON result report`);
  }
  if (!Array.isArray(report.testResults)) fail(`${lane} lane report has no testResults array`);
  const actualFiles = report.testResults.map(({ name }) => repositoryPath(name)).sort();
  assertExactSet(`${lane} lane files`, actualFiles, expectedLaneFiles);

  const rows = [];
  const fileDurations = [];
  for (const result of report.testResults) {
    const file = repositoryPath(result.name);
    if (!Array.isArray(result.assertionResults)) fail(`${file} has no assertionResults array`);
    const reportedDurationMs = Number(result.duration);
    const startTimeMs = Number(result.startTime);
    const endTimeMs = Number(result.endTime);
    const durationMs = Number.isFinite(reportedDurationMs) && reportedDurationMs >= 0
      ? reportedDurationMs
      : Number.isFinite(startTimeMs) && Number.isFinite(endTimeMs) && endTimeMs >= startTimeMs
        ? endTimeMs - startTimeMs
        : Number.NaN;
    if (Number.isFinite(durationMs) && durationMs >= 0) fileDurations.push({ file, durationMs });
    for (const assertion of result.assertionResults) {
      if (!Array.isArray(assertion.ancestorTitles) || typeof assertion.title !== "string") {
        fail(`${file} has a malformed assertion identity`);
      }
      rows.push({
        file,
        name: [...assertion.ancestorTitles, assertion.title].join(" > "),
        status: assertion.status,
      });
    }
  }
  return { actualFiles, rows, fileDurations };
}

function verifyReports(laneRuns) {
  const actualFiles = [];
  const rows = [];
  const fileDurations = { risk: [], fast: [] };
  for (const laneRun of laneRuns) {
    const laneReport = readLaneReport(laneRun.lane, laneRun.reportPath, laneRun.expectedLaneFiles);
    actualFiles.push(...laneReport.actualFiles);
    rows.push(...laneReport.rows);
    fileDurations[laneRun.lane] = laneReport.fileDurations;
  }
  assertExactSet("combined unit files", actualFiles, expectedFiles);
  const conditionalRows = rows.filter(({ file, name }) =>
    file === reservedConditional.file && name === reservedConditional.name);
  if (conditionalRows.length !== 1) fail("reserved conditional task identity changed");
  const baseRows = rows.filter(({ file, name }) =>
    file !== reservedConditional.file || name !== reservedConditional.name);
  const inactive = baseRows.filter(({ status }) =>
    status === "skipped" || status === "todo" || status === "pending");
  if (inactive.length > 0) fail("unit gate contains unexpected inactive active tasks");
  const failed = baseRows.filter(({ status }) => status !== "passed");
  if (failed.length > 0) fail("unit gate contains failed active tasks");
  const identities = baseRows.map(({ file, name }) => `${file}\u0000${name}`).sort();
  if (identities.length !== expectedBaseTaskCount) fail("unit gate active task count changed");
  if (sha256(identities.join("\n")) !== expectedBaseTaskDigest) fail("unit gate active task identity digest changed");
  const allIdentities = rows.map(({ file, name }) => `${file}\u0000${name}`).sort();
  if (allIdentities.length !== expectedCollectedTaskCount || duplicates(allIdentities).length > 0) {
    fail("unit gate collected task identity set changed");
  }
  const outcomeDigest = sha256(rows
    .map(({ file, name, status }) => `${file}\u0000${name}\u0000${status}`)
    .sort()
    .join("\n"));
  return {
    fileCount: actualFiles.length,
    activeTaskCount: baseRows.length,
    conditionalTaskCount: conditionalRows.length,
    collectedTaskCount: rows.length,
    outcomeDigest,
    fileDurations,
  };
}

function unavailableResourceMetric(reason) {
  return { state: "unavailable", value: null, reason };
}

function readLaneResourceMeasurement(path) {
  if (platform() !== "linux" || !existsSync(resourceTimerPath)) {
    return unavailableResourceMetric("linux_gnu_time_unavailable");
  }
  let measurement;
  try {
    measurement = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return unavailableResourceMetric("linux_gnu_time_report_unreadable");
  } finally {
    rmSync(path, { force: true });
  }
  const userCpuSeconds = Number(measurement?.userCpuSeconds);
  const systemCpuSeconds = Number(measurement?.systemCpuSeconds);
  const peakRssKiB = Number(measurement?.peakRssKiB);
  if (
    !Number.isFinite(userCpuSeconds)
    || userCpuSeconds < 0
    || !Number.isFinite(systemCpuSeconds)
    || systemCpuSeconds < 0
    || !Number.isFinite(peakRssKiB)
    || peakRssKiB < 0
    || userCpuSeconds + systemCpuSeconds > 86_400
    || peakRssKiB > 2 ** 31
  ) {
    return unavailableResourceMetric("linux_gnu_time_report_out_of_bounds");
  }
  return {
    state: "measured",
    source: "linux-gnu-time",
    userCpuSeconds,
    systemCpuSeconds,
    cpuSeconds: userCpuSeconds + systemCpuSeconds,
    peakRssBytes: Math.round(peakRssKiB * 1024),
  };
}

function aggregateResourceMeasurements(laneRuns) {
  const measurements = laneRuns.map((run) => run.resourceMeasurement);
  if (measurements.length === 0) {
    return {
      aggregateCpuSeconds: unavailableResourceMetric("collection_only_mode"),
      peakRssBytes: unavailableResourceMetric("collection_only_mode"),
    };
  }
  if (measurements.some((measurement) => measurement?.state !== "measured")) {
    const reason = measurements.find((measurement) => measurement?.state !== "measured")?.reason
      ?? "lane_resource_measurement_unavailable";
    return {
      aggregateCpuSeconds: unavailableResourceMetric(reason),
      peakRssBytes: unavailableResourceMetric(reason),
    };
  }
  return {
    aggregateCpuSeconds: {
      state: "measured",
      value: measurements.reduce((total, measurement) => total + measurement.cpuSeconds, 0),
      unit: "seconds",
      source: "linux-gnu-time",
    },
    peakRssBytes: {
      state: "measured",
      value: Math.max(...measurements.map((measurement) => measurement.peakRssBytes)),
      unit: "bytes",
      source: "linux-gnu-time",
    },
  };
}

function boundedCacheBytes(root) {
  if (!root || !existsSync(root)) return unavailableResourceMetric("command_cache_root_not_present");
  let bytes = 0;
  let entries = 0;
  try {
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > maxMeasuredCacheEntries) throw new Error("entry bound exceeded");
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("symbolic link not measurable");
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.isFile()) throw new Error("non-file entry not measurable");
        bytes += statSync(path).size;
        if (bytes > maxMeasuredCacheBytes) throw new Error("byte bound exceeded");
      }
    }
    walk(root);
    return {
      state: "measured",
      value: bytes,
      unit: "bytes",
      source: "bounded-disk-cache-file-stat",
      entryCount: entries,
    };
  } catch {
    return unavailableResourceMetric("bounded_cache_size_measurement_failed");
  }
}

function tagStream(stream, destination, lane) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex >= 0) {
      destination.write(`[${lane}] ${pending.slice(0, newlineIndex)}\n`);
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }
  });
  stream.once("end", () => {
    if (pending.length > 0) destination.write(`[${lane}] ${pending}\n`);
  });
}

function vitestNodePath(vitestEntry) {
  const vitestDirectory = dirname(vitestEntry);
  const packageNodeModules = dirname(vitestDirectory);
  const pnpmRoot = resolve(packageNodeModules, "..", "..");
  const modulePaths = [join(vitestDirectory, "node_modules"), packageNodeModules];
  if (basename(pnpmRoot) === ".pnpm") modulePaths.push(join(pnpmRoot, "node_modules"));
  return modulePaths.join(delimiter);
}

function spawnLane(laneDefinition, reportPath, schedulePath, temporaryRoot, vitestEntry) {
  const resourcePath = join(temporaryRoot, `${laneDefinition.lane}-resource.json`);
  const vitestArgs = [
    vitestEntry,
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
    "--configLoader=runner",
  ];
  const resourceMeasurementAvailable = platform() === "linux" && existsSync(resourceTimerPath);
  const command = resourceMeasurementAvailable ? resourceTimerPath : process.execPath;
  const args = resourceMeasurementAvailable
    ? [
        "-f",
        "{\"userCpuSeconds\":%U,\"systemCpuSeconds\":%S,\"peakRssKiB\":%M}",
        "-o",
        resourcePath,
        "--",
        process.execPath,
        ...vitestArgs,
      ]
    : vitestArgs;
  const child = spawn(
    command,
    args,
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SYMPOSE_UNIT_TEST_MODE: "accelerated",
        SYMPOSE_UNIT_TEST_LANE: laneDefinition.lane,
        SYMPOSE_UNIT_DB_TEMPLATE_ROOT: temporaryRoot,
        SYMPOSE_UNIT_TEST_SCHEDULE_PATH: schedulePath,
        NODE_PATH: vitestNodePath(vitestEntry),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.stdout) tagStream(child.stdout, process.stdout, laneDefinition.lane);
  if (child.stderr) tagStream(child.stderr, process.stderr, laneDefinition.lane);
  const outcome = new Promise((resolveOutcome) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolveOutcome({ code, signal, error: spawnError });
    });
  });
  return {
    lane: laneDefinition.lane,
    expectedLaneFiles: laneDefinition.expectedLaneFiles,
    reportPath,
    resourcePath,
    child,
    wallStart: Date.now(),
    outcome,
  };
}

function templateRootEvidence(root) {
  if (!root || !existsSync(root)) {
    return {
      state: "not_present",
      templateCount: 0,
      uniqueTemplateDigestCount: 0,
      templateDigest: null,
      schemaDigest: null,
      cloneCount: 0,
      sidecarCount: 0,
      handleMarkerCount: 0,
      unexpectedEntryCount: 0,
    };
  }
  const templateDigests = new Set();
  const schemaDigests = new Set();
  let templateCount = 0;
  let sidecarCount = 0;
  let handleMarkerCount = 0;
  let cloneCount = 0;
  let unexpectedEntryCount = 0;

  function walk(directory, isRoot = false) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        unexpectedEntryCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (isRoot && !entry.name.startsWith("worker-")) unexpectedEntryCount += 1;
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        unexpectedEntryCount += 1;
        continue;
      }
      if (entry.name === templateName) {
        templateCount += 1;
        const stats = statSync(path);
        if ((stats.mode & 0o222) !== 0) unexpectedEntryCount += 1;
        const evidencePath = join(directory, templateEvidenceName);
        if (!existsSync(evidencePath)) {
          unexpectedEntryCount += 1;
        } else {
          try {
            const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
            if (
              evidence.closed !== true
              || evidence.schemaVersion !== 21
              || typeof evidence.schemaDigest !== "string"
              || typeof evidence.templateDigest !== "string"
              || evidence.templateDigest !== sha256File(path)
              || (statSync(evidencePath).mode & 0o222) !== 0
            ) {
              unexpectedEntryCount += 1;
            } else {
              schemaDigests.add(evidence.schemaDigest);
              templateDigests.add(evidence.templateDigest);
            }
          } catch {
            unexpectedEntryCount += 1;
          }
        }
        continue;
      }
      if (entry.name === templateEvidenceName) continue;
      if (entry.name === "risk-results.json" || entry.name === "fast-results.json") continue;
      if (entry.name.startsWith("unit-test-schedule-") && entry.name.endsWith(".json")) continue;
      if (/^clone-.*\.sqlite$/u.test(entry.name)) {
        cloneCount += 1;
        continue;
      }
      if (entry.name.endsWith(".open")) {
        handleMarkerCount += 1;
        continue;
      }
      if (entry.name.endsWith("-journal") || entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) {
        sidecarCount += 1;
        continue;
      }
      unexpectedEntryCount += 1;
    }
  }
  walk(root, true);
  return {
    state: cloneCount === 0 && sidecarCount === 0 && handleMarkerCount === 0 && unexpectedEntryCount === 0
      ? "pass"
      : "fail",
    templateCount,
    uniqueTemplateDigestCount: templateDigests.size,
    templateDigest: templateDigests.size === 1 ? [...templateDigests][0] : null,
    schemaDigest: schemaDigests.size === 1 ? [...schemaDigests][0] : null,
    cloneCount,
    sidecarCount,
    handleMarkerCount,
    unexpectedEntryCount,
  };
}

function writeReceipt(root, receipt) {
  const receiptDirectory = join(cacheRoot(), "receipts");
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const receiptName = `sympose-unit-gate-${Date.now()}-${process.pid}.json`;
  const receiptPath = join(receiptDirectory, receiptName);
  const temporaryPath = `${receiptPath}.tmp`;
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > receiptMaxBytes) fail("unit gate receipt exceeded its bound");
  writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporaryPath, receiptPath);
  return receiptPath;
}

function appendTimingObservation(root, gateEvidence, timing, candidateSha) {
  const { path, store } = readTimingStore(root);
  const observations = Array.isArray(store?.observations) ? store.observations : [];
  const observation = {
    schema: timingHintsSchema,
    completeGreen: true,
    recordedAt: new Date().toISOString(),
    inventoryDigest,
    harnessDigest,
    machineClassDigest,
    candidateSha,
    lanes: gateEvidence.fileDurations,
  };
  const nextStore = {
    schema: timingHintsSchema,
    observations: [...observations, observation].slice(-timingObservationLimit),
    lastApplied: timing?.applied
      ? {
          inventoryDigest,
          harnessDigest,
          machineClassDigest,
          weights: Object.fromEntries(timing.weights),
          guard: timing.guard,
        }
      : store?.lastApplied ?? null,
  };
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(nextStore), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
    return "written";
  } catch {
    try { rmSync(temporaryPath, { force: true }); } catch { /* receipt records the non-authoritative miss */ }
    return "not_written";
  }
}

function vitestEntry() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
}

function verifyOrderCollection(mode, schedulePath, temporaryRoot, entry) {
  const rowsByLane = {};
  for (const laneDefinition of laneDefinitions) {
    const result = spawnSync(
      process.execPath,
      [entry, "list", "--json"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          SYMPOSE_UNIT_TEST_MODE: "accelerated",
          SYMPOSE_UNIT_TEST_LANE: laneDefinition.lane,
          SYMPOSE_UNIT_DB_TEMPLATE_ROOT: temporaryRoot,
          SYMPOSE_REAL_RELEASE_PROOF: "1",
          SYMPOSE_UNIT_TEST_SCHEDULE_PATH: schedulePath,
          NODE_PATH: vitestNodePath(entry),
        },
      },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") {
      fail(`collection-only ${mode}/${laneDefinition.lane} proof failed`);
    }
    let rows;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      fail(`collection-only ${mode}/${laneDefinition.lane} JSON is invalid`);
    }
    if (!Array.isArray(rows)) fail(`collection-only ${mode}/${laneDefinition.lane} result is not an array`);
    const files = rows.map(({ file }) => repositoryPath(file));
    const uniqueFiles = [...new Set(files)];
    assertExactSet(`collection-only ${mode}/${laneDefinition.lane}`, uniqueFiles, laneDefinition.expectedLaneFiles);
    const identities = rows.map(({ file, name }) => `${repositoryPath(file)}\u0000${name}`).sort();
    if (duplicates(identities).length > 0) fail(`collection-only ${mode}/${laneDefinition.lane} has duplicate tasks`);
    rowsByLane[laneDefinition.lane] = {
      fileCount: uniqueFiles.length,
      taskCount: identities.length,
      orderDigest: sha256(uniqueFiles.join("\n")),
    };
  }
  return rowsByLane;
}

const context = {
  candidate: null,
  cacheRoot: null,
  root: null,
  schedule: null,
  timing: null,
  laneRuns: [],
  laneEvidence: null,
  rootEvidence: null,
  cleanupState: "not_attempted",
  timingStoreState: "not_attempted",
  resourceEvidence: null,
  orderEvidence: null,
  fatalState: null,
  gateSucceeded: false,
};
let activeChild = null;
let forwardedSignal = null;
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    forwardedSignal ??= signal;
    activeChild?.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

try {
  context.candidate = exactCandidate();
  const root = cacheRoot();
  context.cacheRoot = root;
  context.root = realpathSync(mkdtempSync(join(root, templateRootPrefix)));
  chmodSync(context.root, 0o700);
  const entry = vitestEntry();

  if (orderVerification) {
    const modes = ["canonical", "reverse", "seeded"];
    const evidence = {};
    for (const mode of modes) {
      const schedule = scheduleFile(context.root, mode, undefined);
      evidence[mode] = verifyOrderCollection(mode, schedule.path, context.root, entry);
    }
    context.orderEvidence = { modes, lanes: evidence };
  } else {
    if (!quietHost()) fail("host is not quiet enough for the bounded candidate gate");
    context.timing = timingPlan(root);
    const scheduleMode = context.timing.applied ? "timing" : "canonical";
    context.schedule = scheduleFile(context.root, scheduleMode, context.timing);
    for (const laneDefinition of laneDefinitions) {
      const run = spawnLane(
        laneDefinition,
        join(context.root, `${laneDefinition.lane}-results.json`),
        context.schedule.path,
        context.root,
        entry,
      );
      context.laneRuns.push(run);
      activeChild = run.child;
      const outcome = await run.outcome;
      run.outcome = outcome;
      run.wallDurationMs = Date.now() - run.wallStart;
      run.resourceMeasurement = readLaneResourceMeasurement(run.resourcePath);
      if (activeChild === run.child) activeChild = null;
      if (forwardedSignal || outcome.signal) break;
    }
    if (!forwardedSignal && context.laneRuns.length === laneDefinitions.length) {
      context.laneEvidence = verifyReports(context.laneRuns);
      if (context.laneRuns.some((run) => run.outcome?.code !== 0 || run.outcome?.signal)) {
        fail("unit gate lane process failed");
      }
    }
  }
} catch (error) {
  context.fatalState = error instanceof Error ? "verification_failure" : "unknown_failure";
} finally {
  if (activeChild) activeChild.kill(forwardedSignal ?? "SIGTERM");
  for (const run of context.laneRuns) rmSync(run.resourcePath, { force: true });
  context.rootEvidence = templateRootEvidence(context.root);
  context.resourceEvidence = {
    ...aggregateResourceMeasurements(context.laneRuns),
    cacheBytes: boundedCacheBytes(context.root),
  };
  if (context.root) {
    try {
      rmSync(context.root, { recursive: true, force: true });
      context.cleanupState = existsSync(context.root) ? "fail" : "pass";
    } catch {
      context.cleanupState = "fail";
    }
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);

  const laneReceipts = context.laneRuns.map((run) => ({
    lane: run.lane,
    fileCount: run.expectedLaneFiles.length,
    workerCount: workerCounts[run.lane],
    wallDurationMs: run.wallDurationMs ?? null,
    exitCode: run.outcome?.code ?? null,
    signal: run.outcome?.signal ?? null,
    resourceMeasurement: run.resourceMeasurement?.state ?? "unavailable",
    cpuSeconds: run.resourceMeasurement?.cpuSeconds ?? null,
    peakRssBytes: run.resourceMeasurement?.peakRssBytes ?? null,
  }));
  const templateExecutionRequired = !orderVerification
    && context.laneRuns.length === laneDefinitions.length;
  const templateEvidencePositive = context.rootEvidence?.state === "pass"
    && (context.rootEvidence?.templateCount ?? 0) > 0
    && context.rootEvidence?.uniqueTemplateDigestCount === 1
    && typeof context.rootEvidence?.schemaDigest === "string";
  const completeGreen = !orderVerification
    && context.fatalState === null
    && context.candidate?.worktree === "clean"
    && context.laneEvidence !== null
    && context.laneRuns.length === laneDefinitions.length
    && context.laneRuns.every((run) => run.outcome?.code === 0 && !run.outcome?.signal)
    && context.cleanupState === "pass"
    && context.rootEvidence?.state === "pass"
    && (!templateExecutionRequired || templateEvidencePositive);
  const orderGreen = orderVerification
    && context.fatalState === null
    && context.cleanupState === "pass"
    && context.rootEvidence?.state === "pass";
  if (completeGreen) {
    context.timingStoreState = appendTimingObservation(
      context.cacheRoot,
      context.laneEvidence,
      context.timing,
      context.candidate.sha,
    );
  }
  context.gateSucceeded = orderVerification ? orderGreen : completeGreen;
  const receipt = {
    schema: receiptSchema,
    version: 1,
    mode: orderVerification ? "order-collection-verification" : "candidate-gate",
    candidate: context.candidate ?? { sha: null, worktree: "unverified" },
    result: {
      state: orderVerification
        ? orderGreen ? "collection_order_green" : "red"
        : completeGreen ? "green" : forwardedSignal ? "interrupted" : "red",
      completeGreen,
      flakeState: completeGreen ? "not_observed" : "not_assessed",
      scope: orderVerification ? "collection-order-only" : "execution-and-outcome",
      leakExecution: orderVerification ? "separate-opt-in-not-run" : "not_applicable",
    },
    inventory: {
      fileCount: expectedFiles.length,
      activeTaskCount: expectedBaseTaskCount,
      conditionalTaskCount: expectedConditionalTaskCount,
      collectedTaskCount: expectedCollectedTaskCount,
      activeTaskDigest: expectedBaseTaskDigest,
      inventoryDigest,
    },
    config: { configDigest, harnessDigest, schemaSourceDigest },
    machine: {
      class: machineClass,
      classDigest: machineClassDigest,
      authority: "metadata-only",
    },
    scheduling: {
      reserveLogicalCpu: 1,
      ciCapApplied: ci,
      workerCounts,
      orderMode: orderVerification ? "canonical-reverse-seeded" : context.timing?.applied ? "timing" : "canonical",
      timingHints: orderVerification
        ? { applied: false, reason: "order-collection-verification-mode", usedFor: "ordering-only" }
        : {
            applied: context.timing?.applied ?? false,
            reason: context.timing?.reason ?? "gate_not_completed",
            acceptedObservationCount: context.timing?.acceptedObservationCount ?? 0,
            staleObservationCount: context.timing?.staleObservationCount ?? 0,
            hysteresisApplied: context.timing?.hysteresisApplied ?? false,
            persistenceState: context.timingStoreState,
            guard: context.timing?.guard ?? null,
            usedFor: "ordering-only",
          },
    },
    lanes: laneReceipts,
    resources: context.resourceEvidence,
    tests: context.laneEvidence
      ? {
          fileCount: context.laneEvidence.fileCount,
          activeTaskCount: context.laneEvidence.activeTaskCount,
          conditionalTaskCount: context.laneEvidence.conditionalTaskCount,
          collectedTaskCount: context.laneEvidence.collectedTaskCount,
          outcomeDigest: context.laneEvidence.outcomeDigest,
        }
      : null,
    orderVerification: orderVerification
      ? {
          scope: "collection-order-only",
          executionRun: false,
          leakExecution: "separate-opt-in-not-run",
          modes: context.orderEvidence?.modes ?? [],
          lanes: context.orderEvidence?.lanes ?? null,
        }
      : null,
    template: {
      requiredForGreen: templateExecutionRequired,
      evidencePositive: templateExecutionRequired ? templateEvidencePositive : false,
      schemaDigest: context.rootEvidence?.schemaDigest ?? null,
      templateDigest: context.rootEvidence?.templateDigest ?? null,
      templateCount: context.rootEvidence?.templateCount ?? 0,
      uniqueTemplateDigestCount: context.rootEvidence?.uniqueTemplateDigestCount ?? 0,
    },
    cleanup: {
      stateBeforeRootCleanup: context.rootEvidence?.state ?? "not_present",
      cloneCount: context.rootEvidence?.cloneCount ?? 0,
      sidecarCount: context.rootEvidence?.sidecarCount ?? 0,
      handleMarkerCount: context.rootEvidence?.handleMarkerCount ?? 0,
      unexpectedEntryCount: context.rootEvidence?.unexpectedEntryCount ?? 0,
      rootCleanup: context.cleanupState,
      rootKind: "disk-backed-per-user-cache",
    },
  };
  try {
    const receiptPath = writeReceipt(context.root, receipt);
    console.log(`Unit gate receipt schema: ${receiptSchema}`);
    console.log(`Unit gate receipt state: ${receipt.result.state}`);
    console.log(`Unit gate receipt file: ${receiptPath}`);
  } catch {
    context.fatalState = "receipt_write_failure";
    context.gateSucceeded = false;
    console.error("Unit gate receipt write failed");
  }
}

if (!context.gateSucceeded || context.fatalState || forwardedSignal) {
  process.exitCode = forwardedSignal === "SIGINT" ? 130 : forwardedSignal === "SIGTERM" ? 143 : 1;
} else {
  process.exitCode = 0;
}
