#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ReleaseKitError,
  acquireOperationLock,
  canonicalJson,
  createBackup,
  exactFullSha,
  initializeState,
  loadReleaseConfig,
  recoverInterruptedRestore,
  recordRunningVerification,
  releaseOperationLock,
  restoreBackup,
  restoreConfirmationToken,
  runPreflight,
  runProductionBuild,
  startProductionRelease,
  validateStateLayout,
  verifyBackupDirectory,
  verifyDependencies,
  verifyGitCandidate,
  verifyProductionBuild,
  verifyRunningRelease,
} from "./lib.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = new Set([
  "backup",
  "build",
  "confirmation",
  "init",
  "preflight",
  "recover",
  "restore",
  "start",
  "verify",
]);

function usage() {
  return [
    "Sympose production evaluator release kit",
    "",
    "Commands:",
    "  init         --config <absolute-config>",
    "  build        --config <absolute-config>",
    "  preflight    --config <absolute-config>",
    "  recover      --config <absolute-config>",
    "  start        --config <absolute-config>",
    "  verify       --config <absolute-config> [--wait-ms <0..120000>]",
    "               [--record-kind <restart-verified|rollback-verified> --operation-id <uuid>]",
    "  backup       --config <absolute-config> --output <absolute-new-directory>",
    "  confirmation --config <absolute-config> --backup <absolute-backup-directory>",
    "  restore      --config <absolute-config> --backup <absolute-backup-directory>",
    "               --from-sha <full-lowercase-sha> --operation-id <uuid>",
    "               [--confirm-replace <confirmation-token>]",
  ].join("\n");
}

function parseOptions(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      typeof key !== "string" ||
      !/^--[a-z][a-z-]{0,31}$/u.test(key) ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(key)
    ) throw new ReleaseKitError("CONFIG_INVALID");
    options.set(key, value);
  }
  return options;
}

function exactOptionSet(options, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new ReleaseKitError("CONFIG_INVALID");
  }
  for (const key of required) {
    if (!options.has(key)) throw new ReleaseKitError("CONFIG_INVALID");
  }
}

function waitMilliseconds(value) {
  if (value === undefined) return 0;
  if (!/^\d{1,6}$/u.test(value)) throw new ReleaseKitError("CONFIG_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 120_000) {
    throw new ReleaseKitError("CONFIG_INVALID");
  }
  return parsed;
}

function printResult(value) {
  process.stdout.write(canonicalJson(value));
}

async function main() {
  process.umask(0o077);
  const [command, ...rawOptions] = process.argv.slice(2);
  if (command === "--help" || command === "help" || command === undefined) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!COMMANDS.has(command)) throw new ReleaseKitError("CONFIG_INVALID");
  const options = parseOptions(rawOptions);
  const commonOptional = [];
  if (command === "backup") exactOptionSet(options, ["--config", "--output"], commonOptional);
  else if (command === "confirmation") exactOptionSet(options, ["--backup", "--config"], commonOptional);
  else if (command === "restore") {
    exactOptionSet(
      options,
      ["--backup", "--config", "--from-sha", "--operation-id"],
      ["--confirm-replace"],
    );
  } else if (command === "verify") {
    exactOptionSet(options, ["--config"], ["--operation-id", "--record-kind", "--wait-ms"]);
    if (options.has("--record-kind") !== options.has("--operation-id")) {
      throw new ReleaseKitError("CONFIG_INVALID");
    }
  } else {
    exactOptionSet(options, ["--config"], commonOptional);
  }

  const config = loadReleaseConfig(options.get("--config"), { repositoryRoot: REPOSITORY_ROOT });

  if (command === "init") {
    verifyGitCandidate(REPOSITORY_ROOT, config.releaseSha);
    verifyDependencies(REPOSITORY_ROOT);
    const state = initializeState(config);
    printResult({
      schema: "sympose-production-state-initialization/v1",
      status: "ok",
      releaseSha: config.releaseSha,
      schemaVersion: Number(config.applicationSchemaVersion),
      databaseState: state.sqlite.state,
      dataClassification: config.dataClassification,
    });
    return;
  }

  if (command === "recover") {
    verifyGitCandidate(REPOSITORY_ROOT, config.releaseSha);
    const dependencies = verifyDependencies(REPOSITORY_ROOT);
    const build = verifyProductionBuild(REPOSITORY_ROOT, config.releaseSha, dependencies);
    printResult(recoverInterruptedRestore(config, {
      buildReceiptSha256: build.receiptSha256,
    }));
    return;
  }

  if (command === "build") {
    const lock = acquireOperationLock(config, "build");
    try {
      const result = runProductionBuild(REPOSITORY_ROOT, config.releaseSha);
      printResult({
        schema: "sympose-production-build-result/v1",
        status: "ok",
        releaseSha: config.releaseSha,
        schemaVersion: result.receipt.schemaVersion,
        buildId: result.receipt.buildId,
        buildReceiptSha256: result.receiptSha256,
        files: result.receipt.totals.files,
        bytes: result.receipt.totals.bytes,
      });
    } finally {
      releaseOperationLock(config, lock);
    }
    return;
  }

  if (command === "preflight") {
    printResult(await runPreflight(REPOSITORY_ROOT, config));
    return;
  }

  if (command === "start") {
    const code = await startProductionRelease(REPOSITORY_ROOT, config, { onReady: printResult });
    process.exitCode = code;
    return;
  }

  if (command === "verify") {
    const result = await verifyRunningRelease(REPOSITORY_ROOT, config, {
      waitMs: waitMilliseconds(options.get("--wait-ms")),
    });
    if (options.has("--record-kind")) {
      recordRunningVerification(
        config,
        result.buildReceiptSha256,
        options.get("--record-kind"),
        options.get("--operation-id"),
      );
    }
    printResult(result);
    return;
  }

  if (command === "backup") {
    const result = createBackup(REPOSITORY_ROOT, config, options.get("--output"));
    printResult({
      schema: "sympose-production-backup-result/v1",
      status: "ok",
      releaseSha: config.releaseSha,
      backupId: result.manifest.backupId,
      manifestSha256: result.manifestSha256,
      files: result.manifest.totals.files,
      bytes: result.manifest.totals.bytes,
    });
    return;
  }

  if (command === "confirmation") {
    verifyGitCandidate(REPOSITORY_ROOT, config.releaseSha);
    const dependencies = verifyDependencies(REPOSITORY_ROOT);
    verifyProductionBuild(REPOSITORY_ROOT, config.releaseSha, dependencies);
    validateStateLayout(config, { allowEmptyDatabase: true });
    const backup = verifyBackupDirectory(options.get("--backup"), {
      expectedReleaseSha: config.releaseSha,
    });
    printResult({
      schema: "sympose-production-restore-confirmation/v1",
      status: "confirmation-required",
      releaseSha: config.releaseSha,
      manifestSha256: backup.manifestSha256,
      confirmation: restoreConfirmationToken(config, backup.manifestSha256),
    });
    return;
  }

  const result = restoreBackup(REPOSITORY_ROOT, config, options.get("--backup"), {
    confirmReplace: options.get("--confirm-replace") ?? null,
    fromSha: exactFullSha(options.get("--from-sha")),
    operationId: options.get("--operation-id"),
  });
  printResult(result);
}

main().catch((error) => {
  const failure = error instanceof ReleaseKitError
    ? error
    : new ReleaseKitError("STARTUP_FAILED");
  process.stderr.write(`Sympose release kit refused [${failure.code}]: ${failure.message}\n`);
  process.exitCode = 1;
});
