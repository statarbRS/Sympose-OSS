import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ConnectorHub } from "@/components/connector-hub/connector-hub";
import type { ConnectorHubView, ConnectorProviderCard } from "@/server/services/connector-hub";

const unavailableProvider = (
  id: "hubspot" | "salesforce",
  name: "HubSpot" | "Salesforce",
): ConnectorProviderCard => ({
  id,
  name,
  connectionStatus: "NOT_CONFIGURED",
  connectionDetail: `No supported ${name} credential, adapter, or workspace connection is configured.`,
  capabilities: [
    { label: `Read from ${name}`, state: "UNAVAILABLE", detail: "No authenticated provider adapter is present." },
    { label: `Write or sync to ${name}`, state: "DISABLED", detail: `This hub performs no ${name} network requests or mutations.` },
  ],
  fieldMappings: [],
  mappingDetail: `No ${name} field mapping has been configured or inferred.`,
  setupRequirements: ["Approved connection", "Explicit canonical Person mapping"],
  activityLabel: "Provider run",
  lastRun: null,
  lastFailure: null,
  evidenceWarning: false,
});

const view: ConnectorHubView = {
  workspace: { id: "workspace-1", slug: "northstar", name: "Northstar" },
  peopleCount: 3,
  eventInvolvementCount: 4,
  exportRowCount: 5,
  providers: [
    unavailableProvider("hubspot", "HubSpot"),
    unavailableProvider("salesforce", "Salesforce"),
    {
      id: "airtable",
      name: "Airtable",
      connectionStatus: "NOT_CONFIGURED",
      connectionDetail: "No Airtable API credential or base connection is configured. Local CSV export is available without one.",
      capabilities: [
        { label: "Airtable-compatible CSV", state: "AVAILABLE", detail: "Authenticated local download." },
        { label: "Airtable API mutation", state: "DISABLED", detail: "The export does not call Airtable." },
      ],
      fieldMappings: [{ source: "people.id", destination: "person_id", detail: "Stable canonical Person identifier" }],
      mappingDetail: "Stable ordered headers.",
      setupRequirements: ["None for CSV download and manual Airtable import"],
      activityLabel: "Local CSV export",
      lastRun: null,
      lastFailure: null,
      evidenceWarning: false,
    },
  ],
};

describe("Connector Hub hierarchy", () => {
  it("leads with the usable local export and keeps unavailable providers explicit and compact", () => {
    const html = renderToStaticMarkup(createElement(ConnectorHub, { view }));
    const exportPanel = html.indexOf('data-testid="connector-primary-export"');
    const boundary = html.indexOf('id="connector-truth-boundary"');
    const providerStatus = html.indexOf('id="provider-status-heading"');

    expect(exportPanel).toBeGreaterThan(-1);
    expect(exportPanel).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(providerStatus);
    expect(html).toContain("Download 5 Airtable rows");
    expect(html).toContain("Airtable API not configured");
    expect(html).toContain("Airtable API mutation");
    expect(html).toContain('data-provider="hubspot"');
    expect(html).toContain('data-provider="salesforce"');
    expect(html).not.toContain('data-provider="airtable"');
    expect(html).toContain("Inspect setup and evidence");
    expect(html).toContain("No connector execution transport is configured");
    expect(html).toContain("will not fall back to a fixture or network transport");

    const syntheticHtml = renderToStaticMarkup(createElement(ConnectorHub, {
      view,
      executionTransport: "synthetic-fixture",
    }));
    expect(syntheticHtml).toContain("public synthetic fixture");
    expect(syntheticHtml).toContain("performs no provider network request");
    expect(syntheticHtml).toContain("Test with synthetic fixture");

    const productionHtml = renderToStaticMarkup(createElement(ConnectorHub, {
      view,
      executionTransport: "provider-network",
    }));
    expect(productionHtml).toContain("Production provider-network routing is explicitly enabled");
    expect(productionHtml).toContain("separately authorized real-provider smoke test");
    expect(productionHtml).toContain("Test provider connection");
    expect(productionHtml).toContain("Export canonical People to provider");

    const activeView: ConnectorHubView = {
      ...view,
      providers: view.providers.map((provider) => ({
        ...provider,
        connectionStatus: "ACTIVE" as const,
      })),
    };
    const activeSyntheticHtml = renderToStaticMarkup(createElement(ConnectorHub, {
      view: activeView,
      executionTransport: "synthetic-fixture",
    }));
    expect(activeSyntheticHtml).toContain("Available only against the in-process public synthetic fixture");
    expect(activeSyntheticHtml).toContain("no provider network request is made");

    const activeProductionHtml = renderToStaticMarkup(createElement(ConnectorHub, {
      view: activeView,
      executionTransport: "provider-network",
    }));
    expect(activeProductionHtml).toContain("Production-routable through the bounded provider adapter");
    expect(activeProductionHtml).toContain("deterministic mocks do not establish live interoperability");
    expect(activeProductionHtml).not.toContain("no live provider transport");
  });

  it("contains narrow-screen reflow and bounded technical overflow", () => {
    const css = readFileSync(resolve("src/components/connector-hub/connector-hub.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("prefers-reduced-motion");
  });
});
