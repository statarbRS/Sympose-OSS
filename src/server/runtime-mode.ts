import { isAbsolute, relative, resolve } from "node:path";

export const RUNTIME_DATA_MODES = ["synthetic-evaluator", "production"] as const;
export type RuntimeDataMode = (typeof RUNTIME_DATA_MODES)[number];
export type RuntimeModeState = RuntimeDataMode | "unconfigured";

export const RUNTIME_MODE_ENV = "SYMPOSE_DATA_MODE" as const;
export const PRODUCTION_DB_PATH_ENV = "SYMPOSE_PRODUCTION_DB_PATH" as const;
export const PRODUCTION_ARTIFACT_ROOT_ENV = "SYMPOSE_PRODUCTION_ARTIFACT_STORE_ROOT" as const;

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

/**
 * Runtime mode is explicit outside tests. Tests retain the evaluator mode so isolated in-memory
 * fixtures do not need process-global environment mutation.
 */
export function runtimeModeState(): RuntimeModeState {
  const configured = process.env[RUNTIME_MODE_ENV]?.trim();
  if (configured === "synthetic-evaluator" || configured === "production") return configured;
  return isTestRuntime() ? "synthetic-evaluator" : "unconfigured";
}

export function requireRuntimeDataMode(): RuntimeDataMode {
  const mode = runtimeModeState();
  if (mode === "unconfigured") {
    throw new Error("RUNTIME_DATA_MODE_REQUIRED");
  }
  return mode;
}

function requiredAbsolutePath(environmentName: string): string {
  const configured = process.env[environmentName]?.trim();
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured || configured.includes("\0")) {
    throw new Error("RUNTIME_STORAGE_CONFIGURATION_INVALID");
  }
  return configured;
}

export interface ProductionStorageConfiguration {
  readonly databasePath: string;
  readonly artifactRoot: string;
}

/** Resolve production storage without ever returning it through a client/runtime diagnostic. */
export function productionStorageConfiguration(): ProductionStorageConfiguration {
  const databasePath = requiredAbsolutePath(PRODUCTION_DB_PATH_ENV);
  const artifactRoot = requiredAbsolutePath(PRODUCTION_ARTIFACT_ROOT_ENV);
  const databaseWithinArtifacts = relative(artifactRoot, databasePath);
  const artifactsWithinDatabase = relative(databasePath, artifactRoot);
  const isContained = (candidate: string): boolean =>
    candidate === "" || (!candidate.startsWith("../") && candidate !== ".." && !isAbsolute(candidate));
  if (isContained(databaseWithinArtifacts) || isContained(artifactsWithinDatabase)) {
    throw new Error("RUNTIME_STORAGE_CONFIGURATION_INVALID");
  }
  return Object.freeze({ databasePath, artifactRoot });
}

export function configuredDatabasePath(): string {
  return requireRuntimeDataMode() === "production"
    ? productionStorageConfiguration().databasePath
    : process.env.SYMPOSE_DB_PATH ?? "data/sympose.db";
}

export function configuredArtifactRoot(): string | null {
  if (requireRuntimeDataMode() === "production") {
    return productionStorageConfiguration().artifactRoot;
  }
  const configured = process.env.SYMPOSE_ARTIFACT_STORE_ROOT?.trim();
  return configured && configured.length > 0 ? resolve(configured) : null;
}

export function runtimeConfigurationReady(): boolean {
  try {
    const mode = requireRuntimeDataMode();
    if (mode === "production") productionStorageConfiguration();
    return true;
  } catch {
    return false;
  }
}
