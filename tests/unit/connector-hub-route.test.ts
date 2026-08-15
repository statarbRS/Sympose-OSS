import { beforeEach, describe, expect, it, vi } from "vitest";

const routeBoundary = vi.hoisted(() => ({
  getRouteSession: vi.fn(),
  requireConnectorWorkspaceRoute: vi.fn(),
}));

const dataBoundary = vi.hoisted(() => ({
  db: Object.freeze({ name: "inert-route-db" }),
  getDb: vi.fn(),
  exportAirtablePeopleCsv: vi.fn(),
}));

vi.mock("@/server/workspace-session", () => routeBoundary);
vi.mock("@/server/db", () => ({ getDb: dataBoundary.getDb }));
vi.mock("@/server/services/connector-hub", () => ({
  ConnectorHubExportError: class ConnectorHubExportError extends Error {},
  exportAirtablePeopleCsv: dataBoundary.exportAirtablePeopleCsv,
}));

import { POST } from "@/app/w/[workspace]/connectors/airtable/export/route";

const OPERATION = "33333333-3333-4333-8333-333333333333";

function request(): Request {
  return new Request("https://sympose.test/w/alpha/connectors/airtable/export", {
    method: "POST",
    headers: {
      origin: "https://sympose.test",
      "sec-fetch-site": "same-origin",
      "x-sympose-export-operation": OPERATION,
    },
  });
}

describe("Connector Hub export route session boundary", () => {
  beforeEach(() => {
    routeBoundary.getRouteSession.mockReset();
    routeBoundary.requireConnectorWorkspaceRoute.mockReset();
    dataBoundary.getDb.mockReset();
    dataBoundary.exportAirtablePeopleCsv.mockReset();
    dataBoundary.getDb.mockReturnValue(dataBoundary.db);
    dataBoundary.exportAirtablePeopleCsv.mockReturnValue({
      body: "id,email\n",
      fileName: "people.csv",
      byteCount: 9,
      rowCount: 0,
      contentType: "text/csv; charset=utf-8",
      schema: "connector-airtable-people-csv/v1",
      receipt: {
        receiptId: "receipt-route-test",
        contentSha256: "a".repeat(64),
      },
      receiptReplayed: false,
    });
  });

  it("does not authorize or produce a response when session resolution rejects an unauthenticated caller", async () => {
    const redirectSignal = new Error("NEXT_REDIRECT");
    routeBoundary.getRouteSession.mockRejectedValueOnce(redirectSignal);

    await expect(POST(request(), { params: Promise.resolve({ workspace: "alpha" }) }))
      .rejects.toBe(redirectSignal);
    expect(routeBoundary.requireConnectorWorkspaceRoute).not.toHaveBeenCalled();
    expect(dataBoundary.getDb).not.toHaveBeenCalled();
    expect(dataBoundary.exportAirtablePeopleCsv).not.toHaveBeenCalled();
  });

  it.each([
    ["event manager", { role: "event_manager", workspaceSlug: "alpha" }],
    ["reviewer", { role: "reviewer", workspaceSlug: "alpha" }],
    ["cross-workspace organizer", { role: "organizer", workspaceSlug: "bravo" }],
  ])("stops a denied %s before opening the database or assembling an export", async (_label, session) => {
    const denialSignal = new Error("__NOT_FOUND__");
    routeBoundary.getRouteSession.mockResolvedValueOnce(session);
    routeBoundary.requireConnectorWorkspaceRoute.mockImplementationOnce(() => {
      throw denialSignal;
    });

    await expect(POST(request(), { params: Promise.resolve({ workspace: "alpha" }) }))
      .rejects.toBe(denialSignal);
    expect(routeBoundary.requireConnectorWorkspaceRoute).toHaveBeenCalledWith(session, "alpha");
    expect(dataBoundary.getDb).not.toHaveBeenCalled();
    expect(dataBoundary.exportAirtablePeopleCsv).not.toHaveBeenCalled();
  });

  it("opens the database only after the connector-specific route boundary authorizes the session", async () => {
    const session = { role: "organizer", workspaceSlug: "alpha" };
    routeBoundary.getRouteSession.mockResolvedValueOnce(session);

    const response = await POST(request(), { params: Promise.resolve({ workspace: "alpha" }) });
    expect(response.status).toBe(200);
    expect(routeBoundary.requireConnectorWorkspaceRoute).toHaveBeenCalledWith(session, "alpha");
    expect(routeBoundary.requireConnectorWorkspaceRoute.mock.invocationCallOrder[0]).toBeLessThan(
      dataBoundary.getDb.mock.invocationCallOrder[0]!,
    );
    expect(dataBoundary.exportAirtablePeopleCsv).toHaveBeenCalledWith(
      dataBoundary.db,
      session,
      "alpha",
      OPERATION,
    );
  });
});
