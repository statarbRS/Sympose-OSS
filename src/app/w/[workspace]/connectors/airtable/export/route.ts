import {
  ConnectorHubExportError,
  exportAirtablePeopleCsv,
} from "@/server/services/connector-hub";
import { connectorExportOperation } from "@/server/services/connector-hub/airtable-export-operation";
import { getDb } from "@/server/db";
import {
  getRouteSession,
  requireConnectorWorkspaceRoute,
} from "@/server/workspace-session";

export const dynamic = "force-dynamic";

function errorStatus(code: ConnectorHubExportError["code"]): number {
  if (code === "CONNECTOR_EXPORT_ROW_LIMIT" || code === "CONNECTOR_EXPORT_BYTE_LIMIT") return 413;
  if (code === "CONNECTOR_EXPORT_DATA_INVALID") return 422;
  if (code === "CONNECTOR_EXPORT_OPERATION_INVALID") return 400;
  if (code === "CONNECTOR_EXPORT_OPERATION_CONFLICT") return 409;
  return 404;
}

function errorResponse(error: ConnectorHubExportError): Response {
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-type": "text/plain; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-sympose-provider-mutation": "false",
  });
  if (error.receipt) headers.set("x-sympose-receipt-id", error.receipt.receiptId);
  return new Response(error.code, { status: errorStatus(error.code), headers });
}

function invalidRequestResponse(): Response {
  return new Response("CONNECTOR_EXPORT_REQUEST_INVALID", {
    status: 400,
    headers: {
      "cache-control": "private, no-store, max-age=0",
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-sympose-provider-mutation": "false",
    },
  });
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ workspace: string }> },
): Promise<Response> {
  const operationKey = connectorExportOperation(request);
  if (!operationKey) return invalidRequestResponse();

  try {
    const { workspace } = await params;
    const session = await getRouteSession();
    requireConnectorWorkspaceRoute(session, workspace);
    const result = exportAirtablePeopleCsv(getDb(), session, workspace, operationKey);
    return new Response(result.body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": `attachment; filename="${result.fileName}"`,
        "content-length": String(result.byteCount),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": result.contentType,
        "cross-origin-resource-policy": "same-origin",
        expires: "0",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        vary: "Cookie",
        "x-content-type-options": "nosniff",
        "x-sympose-content-sha256": result.receipt.contentSha256,
        "x-sympose-export-bytes": String(result.byteCount),
        "x-sympose-export-rows": String(result.rowCount),
        "x-sympose-export-schema": result.schema,
        "x-sympose-idempotent-replay": String(result.receiptReplayed),
        "x-sympose-provider-mutation": "false",
        "x-sympose-receipt-id": result.receipt.receiptId,
      },
    });
  } catch (error) {
    if (error instanceof ConnectorHubExportError) return errorResponse(error);
    throw error;
  }
}
