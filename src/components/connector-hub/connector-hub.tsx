import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Database,
  FileDown,
  ShieldCheck,
} from "lucide-react";

import {
  AIRTABLE_CSV_HEADERS,
  AIRTABLE_CSV_MAX_BYTES,
  AIRTABLE_CSV_MAX_ROWS,
  AIRTABLE_CSV_SCHEMA,
  type ConnectorActivityEvidence,
  type ConnectorCapability,
  type ConnectorHubView,
  type ConnectorProviderCard,
  type ConnectorProviderId,
} from "@/server/services/connector-hub/contracts";
import type {
  ConnectorPreviewRow,
  ConnectorRunSummary,
} from "@/server/services/connector-hub/orchestration";

import { AirtableExportButton } from "./airtable-export-button";
import { ConnectorConnectionForm } from "./connector-connection-form";
import { ConnectorRunControls } from "./connector-run-controls";
import styles from "./connector-hub.module.css";

function CapabilityState({ state }: { readonly state: ConnectorCapability["state"] }) {
  const Icon = state === "AVAILABLE" ? CircleCheck : state === "DISABLED" ? CircleMinus : CircleX;
  return (
    <span className={`${styles.capabilityState} ${styles[`capabilityState_${state.toLowerCase()}`]}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2} />
      {state === "AVAILABLE" ? "Available" : state === "DISABLED" ? "Disabled" : "Unavailable"}
    </span>
  );
}

function Evidence({
  label,
  evidence,
  empty,
}: {
  readonly label: string;
  readonly evidence: ConnectorActivityEvidence | null;
  readonly empty: string;
}) {
  if (!evidence) {
    return (
      <div className={styles.evidenceItem}>
        <dt>{label}</dt>
        <dd>{empty}</dd>
      </div>
    );
  }
  return (
    <div className={styles.evidenceItem}>
      <dt>{label}</dt>
      <dd>
        <time dateTime={evidence.occurredAt}>{evidence.occurredAt}</time>
        <small>
          Receipt {evidence.receiptId.slice(0, 8)}… · provider mutation: no
          {evidence.outcome === "SUCCEEDED"
            ? ` · ${evidence.rowCount ?? 0} rows · ${evidence.byteCount ?? 0} bytes`
            : ` · ${evidence.failureCode ?? "recorded failure"}`}
        </small>
      </dd>
    </div>
  );
}

function CapabilityList({ capabilities }: { readonly capabilities: readonly ConnectorCapability[] }) {
  return (
    <ul className={styles.capabilityList}>
      {capabilities.map((capability) => (
        <li key={capability.label}>
          <div>
            <strong>{capability.label}</strong>
            <CapabilityState state={capability.state} />
          </div>
          <p>{capability.detail}</p>
        </li>
      ))}
    </ul>
  );
}

type ConnectorExecutionTransport = "synthetic-fixture" | "provider-network" | null;

function executionCapabilities(
  provider: ConnectorProviderCard,
  transport: ConnectorExecutionTransport,
): readonly ConnectorCapability[] {
  return provider.capabilities.map((capability) => {
    if (provider.id === "airtable" && capability.label === "Airtable-compatible CSV") {
      return capability;
    }
    if (provider.connectionStatus !== "ACTIVE") {
      return {
        ...capability,
        state: "DISABLED" as const,
        detail: `Save an active ${provider.name} connection before any configured execution transport can run.`,
      };
    }
    if (transport === "synthetic-fixture") {
      return {
        ...capability,
        state: "AVAILABLE" as const,
        detail: "Available only against the in-process public synthetic fixture; no provider network request is made.",
      };
    }
    if (transport === "provider-network") {
      return {
        ...capability,
        state: "AVAILABLE" as const,
        detail: "Production-routable through the bounded provider adapter; deterministic mocks do not establish live interoperability.",
      };
    }
    return {
      ...capability,
      state: "DISABLED" as const,
      detail: "No explicit connector execution transport is configured, and no fallback transport is permitted.",
    };
  });
}

function ConnectionBadge({ provider }: { readonly provider: ConnectorProviderCard }) {
  const subject = provider.id === "airtable" ? "Airtable API" : provider.name;
  const label = provider.connectionStatus === "ACTIVE"
    ? `${subject} connection active`
    : provider.connectionStatus === "REVOKED"
      ? `${subject} connection revoked`
      : provider.id === "airtable" ? `${subject} not configured` : "Not configured";
  return (
    <span className={styles.notConfigured}>
      <span aria-hidden="true" /> {label}
    </span>
  );
}

function ProviderDetails({ provider }: { readonly provider: ConnectorProviderCard }) {
  return (
    <details className={styles.providerDetails}>
      <summary>Inspect setup and evidence</summary>
      <div className={styles.providerDetailGrid}>
        <section>
          <h4>Field mapping</h4>
          <p>{provider.mappingDetail}</p>
          {provider.fieldMappings.length > 0 ? (
            <div className={styles.mappingWrap}>
              <table className={styles.mappingTable}>
                <thead><tr><th scope="col">Canonical source</th><th scope="col">Export field</th></tr></thead>
                <tbody>
                  {provider.fieldMappings.map((mapping) => (
                    <tr key={mapping.destination}>
                      <td><code>{mapping.source}</code></td>
                      <td><code>{mapping.destination}</code><small>{mapping.detail}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className={styles.emptyMapping}>No saved mapping evidence.</p>}
        </section>
        <section>
          <h4>Run evidence</h4>
          <dl className={styles.evidenceList}>
            <Evidence
              label={`Last ${provider.activityLabel.toLowerCase()}`}
              evidence={provider.lastRun}
              empty={`No recorded ${provider.activityLabel.toLowerCase()} evidence.`}
            />
            <Evidence
              label="Last failure"
              evidence={provider.lastFailure}
              empty="No recorded failure evidence."
            />
          </dl>
          {provider.evidenceWarning ? (
            <p className={styles.evidenceWarning} role="status">
              Some local connector audit rows failed receipt validation and are not shown.
            </p>
          ) : null}
        </section>
        <section>
          <h4>Setup required</h4>
          <ul className={styles.requirementList}>
            {provider.setupRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}
          </ul>
        </section>
      </div>
    </details>
  );
}

export function ConnectorHub({
  view,
  runs = [],
  previews = { airtable: null, hubspot: null, salesforce: null },
  executionTransport = null,
  operationKeySeed = "connector-ui-disabled-seed",
}: {
  readonly view: ConnectorHubView;
  readonly runs?: readonly ConnectorRunSummary[];
  readonly previews?: Readonly<Record<ConnectorProviderId, {
    readonly run: ConnectorRunSummary;
    readonly rows: readonly ConnectorPreviewRow[];
  } | null>>;
  readonly executionTransport?: ConnectorExecutionTransport;
  readonly operationKeySeed?: string;
}) {
  const airtable = view.providers.find((provider) => provider.id === "airtable");
  if (!airtable) throw new Error("CONNECTOR_HUB_AIRTABLE_CARD_MISSING");
  const unavailableProviders = view.providers.filter((provider) => provider.id !== "airtable");

  return (
    <div className={styles.hub} data-testid="connector-hub">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Workspace integrations</p>
          <h1>Connector Hub</h1>
          <p className={styles.lede}>
            Export canonical workspace People now, then inspect the provider capabilities that are
            genuinely configured—and those that are not.
          </p>
        </div>
        <dl className={styles.summary} aria-label="Export source summary">
          <div><dt>People</dt><dd>{view.peopleCount}</dd></div>
          <div><dt>Event involvements</dt><dd>{view.eventInvolvementCount}</dd></div>
          <div><dt>CSV rows</dt><dd>{view.exportRowCount}</dd></div>
        </dl>
      </header>

      <section className={styles.exportPanel} aria-labelledby="airtable-export-heading" data-testid="connector-primary-export">
        <div className={styles.exportLead}>
          <div className={styles.exportIntro}>
            <span className={styles.exportIcon}><FileDown aria-hidden="true" size={22} strokeWidth={1.8} /></span>
            <div>
              <p className={styles.eyebrow}>Immediately usable</p>
              <h2 id="airtable-export-heading">Airtable-compatible People export</h2>
              <p>
                One row per canonical Person and current event-role involvement. People without
                event involvement receive one row with blank event fields. Import the CSV into a
                new or existing Airtable table.
              </p>
            </div>
          </div>
          <div className={styles.exportCta}>
            <CapabilityState state="AVAILABLE" />
            <ConnectionBadge provider={airtable} />
            <AirtableExportButton
              workspaceSlug={view.workspace.slug}
              expectedRows={view.exportRowCount}
              maximumRows={AIRTABLE_CSV_MAX_ROWS}
              maximumBytes={AIRTABLE_CSV_MAX_BYTES}
            />
          </div>
        </div>

        <p className={styles.connectionDetail}>{airtable.connectionDetail}</p>
        <ConnectorConnectionForm
          workspaceSlug={view.workspace.slug}
          provider="airtable"
          connection={airtable.connection ?? null}
        />
        <ConnectorRunControls
          workspaceSlug={view.workspace.slug}
          provider="airtable"
          connectionActive={airtable.connectionStatus === "ACTIVE"}
          executionTransport={executionTransport}
          recentRuns={runs.filter((run) => run.provider === "airtable")}
          preview={previews.airtable}
          operationKeySeed={operationKeySeed}
        />

        {view.peopleCount === 0 ? (
          <div className={styles.emptyState}>
            <Database aria-hidden="true" size={20} strokeWidth={1.8} />
            <div>
              <strong>No canonical People yet</strong>
              <p>The CSV remains available as a header-only Airtable template; no synthetic contacts are inserted.</p>
            </div>
          </div>
        ) : null}

        <div className={styles.exportEvidence}>
          <div>
            <p className={styles.eyebrow}>Local receipt evidence</p>
            <dl className={styles.evidenceList}>
              <Evidence label="Last local CSV export" evidence={airtable.lastRun} empty="No recorded local CSV export evidence." />
              <Evidence label="Last failure" evidence={airtable.lastFailure} empty="No recorded failure evidence." />
            </dl>
            {airtable.evidenceWarning ? (
              <p className={styles.evidenceWarning} role="status">
                Some local connector audit rows failed receipt validation and are not shown.
              </p>
            ) : null}
          </div>
          <div className={styles.noMutationReceipt}>
            <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.8} />
            <p>
              Each completed download stores a local workspace audit receipt with row count, byte
              count, SHA-256, and <code>providerMutation: false</code>. Reloading reads that receipt;
              it does not infer a provider result. The file contains workspace names, email
              addresses, organization/title fields, and event involvement, so it remains subject to
              workspace export policy.
            </p>
          </div>
        </div>

        <details className={styles.technicalDisclosure}>
          <summary>Inspect schema, field mapping, and safety bounds</summary>
          <div className={styles.technicalBody}>
            <div className={styles.exportContract}>
              <div><h3>Stable schema</h3><code>{AIRTABLE_CSV_SCHEMA}</code></div>
              <div><h3>Deterministic order</h3><p>Person name, Person ID, event start, event ID, role, then involvement ID; binary text order.</p></div>
              <div><h3>Safety bounds</h3><p>{AIRTABLE_CSV_MAX_ROWS} rows · {AIRTABLE_CSV_MAX_BYTES} UTF-8 bytes · RFC4180 CRLF records · spreadsheet formulas neutralized.</p></div>
            </div>
            <div className={styles.airtableCapabilityGrid}>
              <section>
                <h3>Capabilities</h3>
                <CapabilityList capabilities={executionCapabilities(airtable, executionTransport)} />
              </section>
              <section>
                <h3>Setup requirements</h3>
                <ul className={styles.requirementList}>
                  {airtable.setupRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}
                </ul>
              </section>
            </div>
            <div className={styles.mappingWrap}>
              <table className={styles.mappingTable}>
                <thead><tr><th scope="col">Canonical source</th><th scope="col">Export field</th></tr></thead>
                <tbody>
                  {airtable.fieldMappings.map((mapping) => (
                    <tr key={mapping.destination}>
                      <td><code>{mapping.source}</code></td>
                      <td><code>{mapping.destination}</code><small>{mapping.detail}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.headerContract}>
              <h3>Headers, in order</h3>
              <ol>{AIRTABLE_CSV_HEADERS.map((header) => <li key={header}><code>{header}</code></li>)}</ol>
            </div>
          </div>
        </details>
      </section>

      <section className={styles.truthBoundary} aria-labelledby="connector-truth-boundary">
        <ShieldCheck aria-hidden="true" size={21} strokeWidth={1.8} />
        <div>
          <h2 id="connector-truth-boundary">Provider truth boundary</h2>
          {executionTransport === "synthetic-fixture" ? (
            <p>
              Provider adapters, durable preview/confirmation, canonical import, and bounded outbound
              receipts are exercised only against the in-process public synthetic fixture. This mode
              performs no provider network request and makes no live interoperability claim.
            </p>
          ) : executionTransport === "provider-network" ? (
            <p>
              Production provider-network routing is explicitly enabled through the bounded adapters.
              Exact provider interoperability still requires an owner-supplied credential and a separately
              authorized real-provider smoke test; deterministic mocks alone do not establish it.
            </p>
          ) : (
            <p>
              No connector execution transport is configured. Test, import-preview, and provider-export
              controls remain disabled, and the application will not fall back to a fixture or network transport.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="provider-status-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Connection inventory</p>
            <h2 id="provider-status-heading">Provider connection status</h2>
          </div>
          <p>Connection state is explicit; storing credentials does not claim a provider run or sync.</p>
        </div>
        <div className={styles.providerGrid}>
          {unavailableProviders.map((provider) => (
            <article key={provider.id} className={styles.providerCard} data-provider={provider.id}>
              <header className={styles.providerHeader}>
                <div>
                  <p className={styles.providerKind}>Provider</p>
                  <h3>{provider.name}</h3>
                </div>
                <ConnectionBadge provider={provider} />
              </header>
              <p className={styles.providerConnection}>{provider.connectionDetail}</p>
              <ConnectorConnectionForm
                workspaceSlug={view.workspace.slug}
                provider={provider.id}
                connection={provider.connection ?? null}
              />
              <ConnectorRunControls
                workspaceSlug={view.workspace.slug}
                provider={provider.id}
                connectionActive={provider.connectionStatus === "ACTIVE"}
                executionTransport={executionTransport}
                recentRuns={runs.filter((run) => run.provider === provider.id)}
                preview={previews[provider.id]}
                operationKeySeed={operationKeySeed}
              />
              <CapabilityList capabilities={executionCapabilities(provider, executionTransport)} />
              <ProviderDetails provider={provider} />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
