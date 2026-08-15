import "server-only";

import {
  productionStorageConfiguration,
  requireRuntimeDataMode,
} from "../../runtime-mode";
import type { ConnectorProviderId } from "./contracts";
import {
  CONNECTOR_EXECUTION_MODE_ENV,
} from "./fixture-runtime";
import {
  PROVIDER_RUNTIME_DEFAULTS,
  type FetchLike,
  type ProviderRuntimeOptions,
} from "./providers";

export const CONNECTOR_NETWORK_EXECUTION_MODE = "provider-network" as const;
export const CONNECTOR_NETWORK_ENABLED_ENV = "SYMPOSE_CONNECTOR_PROVIDER_NETWORK_ENABLED" as const;
export const CONNECTOR_NETWORK_ENABLED = "enabled" as const;

type NetworkRuntimeSource = "test-injected" | "global-fetch";

export interface ConnectorNetworkRuntime extends ProviderRuntimeOptions {
  readonly dataMode: "production";
  readonly fetch: FetchLike;
  readonly provider: ConnectorProviderId;
  readonly transportContract: "provider-network/v1";
  readonly source: NetworkRuntimeSource;
}

const issuedRuntimes = new WeakSet<object>();

function guardedNetworkFetch(fetchImpl: FetchLike): FetchLike {
  return (input, init) => {
    if (init?.redirect !== "error") {
      return Promise.reject(new Error("CONNECTOR_NETWORK_REDIRECT_POLICY_REQUIRED"));
    }
    return fetchImpl(input, { ...init, redirect: "error" });
  };
}

function issueRuntime(
  provider: ConnectorProviderId,
  source: NetworkRuntimeSource,
  fetch: FetchLike,
  options: Omit<ProviderRuntimeOptions, "fetch"> = {},
): ConnectorNetworkRuntime {
  const runtime = Object.freeze({
    ...options,
    dataMode: "production" as const,
    fetch: guardedNetworkFetch(fetch),
    provider,
    source,
    transportContract: "provider-network/v1" as const,
  });
  issuedRuntimes.add(runtime);
  return runtime;
}

/** Test-only network-capability injection. It never makes a real provider request by itself. */
export function createConnectorNetworkRuntime(
  provider: ConnectorProviderId,
  fetch: FetchLike,
  options: Omit<ProviderRuntimeOptions, "fetch"> = {},
): ConnectorNetworkRuntime {
  if (
    typeof fetch !== "function" ||
    (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true")
  ) {
    throw new Error("CONNECTOR_NETWORK_RUNTIME_DENIED");
  }
  return issueRuntime(provider, "test-injected", fetch, options);
}

/**
 * Server-only production transport capability. The provider adapters and HTTP boundary retain
 * exact-origin, redirect-denial, timeout, response-size, retry, and redaction enforcement.
 */
export function createProductionConnectorNetworkRuntime(
  provider: ConnectorProviderId,
): ConnectorNetworkRuntime {
  if (
    requireRuntimeDataMode() !== "production" ||
    process.env[CONNECTOR_EXECUTION_MODE_ENV] !== CONNECTOR_NETWORK_EXECUTION_MODE ||
    process.env[CONNECTOR_NETWORK_ENABLED_ENV] !== CONNECTOR_NETWORK_ENABLED
  ) {
    throw new Error("CONNECTOR_NETWORK_RUNTIME_DENIED");
  }
  productionStorageConfiguration();
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("CONNECTOR_NETWORK_RUNTIME_DENIED");
  }
  return issueRuntime(provider, "global-fetch", fetchImpl.bind(globalThis), {
    maxResponseBytes: PROVIDER_RUNTIME_DEFAULTS.maxResponseBytes,
    maxRetries: PROVIDER_RUNTIME_DEFAULTS.maxRetries,
    timeoutMs: PROVIDER_RUNTIME_DEFAULTS.timeoutMs,
  });
}

export function assertConnectorNetworkRuntime(
  value: unknown,
  provider: ConnectorProviderId,
): asserts value is ConnectorNetworkRuntime {
  if (
    value === null || typeof value !== "object" || !issuedRuntimes.has(value) ||
    (value as ConnectorNetworkRuntime).dataMode !== "production" ||
    (value as ConnectorNetworkRuntime).provider !== provider ||
    (value as ConnectorNetworkRuntime).transportContract !== "provider-network/v1" ||
    ((value as ConnectorNetworkRuntime).source !== "test-injected" &&
      (value as ConnectorNetworkRuntime).source !== "global-fetch") ||
    typeof (value as ConnectorNetworkRuntime).fetch !== "function"
  ) {
    throw new Error("CONNECTOR_NETWORK_RUNTIME_DENIED");
  }
}
