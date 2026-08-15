import { existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const HOST = "127.0.0.1";
const PORT = "3000";
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_RETRY_MS = 250;
const PASSTHROUGH_ENVIRONMENT = ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM"];

export class EvaluatorReleaseStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvaluatorReleaseStartError";
  }
}

function exactFullSha(value, label) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!FULL_SHA_PATTERN.test(normalized)) {
    throw new EvaluatorReleaseStartError(`${label} must be one full 40-character Git commit SHA.`);
  }
  return normalized;
}

function allowedUntrackedPath(path) {
  return path === "node_modules";
}

/**
 * Build the deterministic launch contract without touching the filesystem or starting a process.
 * Direct tests use this seam so the release server never becomes a test side effect.
 */
export function createEvaluatorReleasePlan({
  root,
  requestedSha,
  currentHead,
  trackedChanges = false,
  untrackedPaths = [],
  sourceEnvironment = {},
  nodeExecutable = process.execPath,
}) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new EvaluatorReleaseStartError("The evaluator repository root must be absolute.");
  }

  const buildSha = exactFullSha(requestedSha, "SYMPOSE_BUILD_SHA");
  const headSha = exactFullSha(currentHead, "Current HEAD");
  if (buildSha !== headSha) {
    throw new EvaluatorReleaseStartError("SYMPOSE_BUILD_SHA does not match the current exact HEAD.");
  }
  if (trackedChanges || untrackedPaths.some((path) => !allowedUntrackedPath(path))) {
    throw new EvaluatorReleaseStartError(
      "The candidate contains uncommitted files; release start requires exact committed source.",
    );
  }

  const stateRoot = resolve(root, ".tmp", "evaluator-release", buildSha);
  const databasePath = resolve(stateRoot, "sympose.db");
  const artifactRoot = resolve(stateRoot, "artifacts");
  const temporaryRoot = resolve(stateRoot, "tmp");
  const nextBin = resolve(root, "node_modules", "next", "dist", "bin", "next");
  const origin = `http://${HOST}:${PORT}`;
  const environment = {};
  for (const key of PASSTHROUGH_ENVIRONMENT) {
    const value = sourceEnvironment[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  Object.assign(environment, {
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT,
    SYMPOSE_APPLICANT_VERIFICATION_DELIVERY: "simulated",
    SYMPOSE_DATA_MODE: "synthetic-evaluator",
    SYMPOSE_ARTIFACT_STORE_ROOT: artifactRoot,
    SYMPOSE_BUILD_SHA: buildSha,
    SYMPOSE_DB_PATH: databasePath,
    SYMPOSE_EVALUATOR_PROFILE: "local",
    TMPDIR: temporaryRoot,
    TZ: "UTC",
  });

  return Object.freeze({
    root,
    buildSha,
    stateRoot,
    databasePath,
    artifactRoot,
    temporaryRoot,
    origin,
    healthUrl: `${origin}/health`,
    executable: nodeExecutable,
    args: Object.freeze([
      nextBin,
      "dev",
      "--webpack",
      "--hostname",
      HOST,
      "-p",
      PORT,
    ]),
    environment: Object.freeze(environment),
  });
}

/** Return true only for the exact public health contract of this candidate. */
export function isExactEvaluatorHealth(payload, buildSha) {
  return payload !== null &&
    typeof payload === "object" &&
    Object.keys(payload).length === 3 &&
    payload.status === "ok" &&
    payload.buildSha === buildSha &&
    payload.dataMode === "synthetic-evaluator";
}

function git(root, args, options = {}) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  });
}

function requireGitText(root, args) {
  const result = git(root, args);
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new EvaluatorReleaseStartError("Unable to verify the evaluator Git candidate.");
  }
  return result.stdout.trim();
}

function readCandidateState(root) {
  const reportedRoot = requireGitText(root, ["rev-parse", "--show-toplevel"]);
  if (resolve(reportedRoot) !== root) {
    throw new EvaluatorReleaseStartError("The release launcher is not at the verified repository root.");
  }

  const currentHead = requireGitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tracked = git(root, ["diff", "--quiet", "HEAD", "--"]);
  if (tracked.status !== 0 && tracked.status !== 1) {
    throw new EvaluatorReleaseStartError("Unable to verify committed candidate files.");
  }

  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.status !== 0 || typeof untracked.stdout !== "string") {
    throw new EvaluatorReleaseStartError("Unable to verify untracked candidate files.");
  }

  return {
    currentHead,
    trackedChanges: tracked.status === 1,
    untrackedPaths: untracked.stdout.split("\0").filter(Boolean),
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requireAvailableLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", () => {
      rejectPort(new EvaluatorReleaseStartError(
        `Loopback port ${PORT} is already in use; stop the existing process before release start.`,
      ));
    });
    server.listen({ host: HOST, port: Number(PORT), exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          rejectPort(new EvaluatorReleaseStartError("Unable to release the evaluator loopback port."));
          return;
        }
        resolvePort();
      });
    });
  });
}

async function waitForExactHealth(plan) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(plan.healthUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new EvaluatorReleaseStartError("The evaluator health response was not valid JSON.");
        }
        if (!isExactEvaluatorHealth(payload, plan.buildSha)) {
          throw new EvaluatorReleaseStartError(
            "The evaluator health response did not match the exact requested build SHA and data mode.",
          );
        }
        return;
      }
    } catch (error) {
      if (error instanceof EvaluatorReleaseStartError) throw error;
    }
    await delay(HEALTH_RETRY_MS);
  }
  throw new EvaluatorReleaseStartError("The evaluator did not become healthy within 90 seconds.");
}

function childExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", () => {
      rejectExit(new EvaluatorReleaseStartError("The evaluator process could not start."));
    });
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function start() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const state = readCandidateState(root);
  const plan = createEvaluatorReleasePlan({
    root,
    requestedSha: process.env.SYMPOSE_BUILD_SHA,
    currentHead: state.currentHead,
    trackedChanges: state.trackedChanges,
    untrackedPaths: state.untrackedPaths,
    sourceEnvironment: process.env,
  });

  if (!existsSync(plan.args[0])) {
    throw new EvaluatorReleaseStartError(
      "Pinned dependencies are unavailable; install them from the unchanged lockfile before release start.",
    );
  }

  mkdirSync(plan.artifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(plan.temporaryRoot, { recursive: true, mode: 0o700 });
  await requireAvailableLoopbackPort();

  console.log(`Starting isolated synthetic evaluator for ${plan.buildSha}.`);
  console.log(`Local URL: ${plan.origin}`);
  console.log(`Health URL: ${plan.healthUrl}`);
  console.log("State policy: preserved for this exact SHA and isolated from every other SHA.");

  const child = spawn(plan.executable, plan.args, {
    cwd: plan.root,
    env: plan.environment,
    stdio: "inherit",
  });
  const exitPromise = childExit(child);
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const first = await Promise.race([
      waitForExactHealth(plan).then(() => ({ kind: "healthy" })),
      exitPromise.then((exit) => ({ kind: "exit", exit })),
    ]);
    if (first.kind === "exit") {
      throw new EvaluatorReleaseStartError("The evaluator exited before exact health was verified.");
    }
    const stability = await Promise.race([
      delay(HEALTH_RETRY_MS).then(() => ({ kind: "stable" })),
      exitPromise.then((exit) => ({ kind: "exit", exit })),
    ]);
    if (stability.kind === "exit") {
      throw new EvaluatorReleaseStartError("The evaluator exited before exact health was stable.");
    }
    console.log(`Ready: exact health verified for ${plan.buildSha} at ${plan.healthUrl}.`);

    const exit = await exitPromise;
    if (exit.signal) {
      process.exitCode = 128 + (osConstants.signals[exit.signal] ?? 1);
    } else {
      process.exitCode = exit.code ?? 1;
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    const message = error instanceof EvaluatorReleaseStartError
      ? error.message
      : "The evaluator release start failed unexpectedly.";
    console.error(`Evaluator release start refused: ${message}`);
    process.exitCode = 1;
  });
}
