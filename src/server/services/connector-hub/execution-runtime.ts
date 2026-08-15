import "server-only";

import { requireRuntimeDataMode } from "../../runtime-mode";
import type { ConnectorProviderId } from "./contracts";
import {
  assertConnectorFixtureRuntime,
  createSyntheticConnectorFixtureRuntime,
  type ConnectorFixtureRuntime,
} from "./fixture-runtime";
import {
  assertConnectorNetworkRuntime,
  createProductionConnectorNetworkRuntime,
  type ConnectorNetworkRuntime,
} from "./network-runtime";

export type ConnectorExecutionRuntime = ConnectorFixtureRuntime | ConnectorNetworkRuntime;
export type ConnectorExecutionTransport = "synthetic-fixture" | "provider-network";

export interface ConnectorExecutionAvailability {
  readonly enabled: boolean;
  readonly transport: ConnectorExecutionTransport | null;
}

export class ConnectorRuntimeConfigurationError extends Error {
  readonly code = "CONNECTOR_RUNTIME_CONFIGURATION_INVALID" as const;

  constructor() {
    super("CONNECTOR_RUNTIME_CONFIGURATION_INVALID");
    this.name = "ConnectorRuntimeConfigurationError";
  }
}

/** Resolve the only application runtime capability permitted by server-owned configuration. */
export function resolveConnectorExecutionRuntime(
  provider: ConnectorProviderId,
): ConnectorExecutionRuntime {
  try {
    return requireRuntimeDataMode() === "production"
      ? createProductionConnectorNetworkRuntime(provider)
      : createSyntheticConnectorFixtureRuntime(provider);
  } catch {
    throw new ConnectorRuntimeConfigurationError();
  }
}

/** Safe UI projection; it never exposes environment values or a callable transport. */
export function connectorExecutionAvailability(): ConnectorExecutionAvailability {
  try {
    const runtime = resolveConnectorExecutionRuntime("airtable");
    return Object.freeze({
      enabled: true,
      transport: runtime.transportContract === "provider-network/v1"
        ? "provider-network"
        : "synthetic-fixture",
    });
  } catch {
    return Object.freeze({ enabled: false, transport: null });
  }
}

export function assertConnectorExecutionRuntime(
  value: unknown,
  provider: ConnectorProviderId,
): asserts value is ConnectorExecutionRuntime {
  try {
    if (
      value !== null && typeof value === "object" &&
      (value as { readonly transportContract?: unknown }).transportContract === "provider-network/v1"
    ) {
      assertConnectorNetworkRuntime(value, provider);
      return;
    }
    assertConnectorFixtureRuntime(value, provider);
  } catch {
    throw new Error("CONNECTOR_EXECUTION_RUNTIME_DENIED");
  }
}
