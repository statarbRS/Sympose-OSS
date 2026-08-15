"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

import styles from "./connector-hub.module.css";

type ExportState =
  | { readonly kind: "idle"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function responseFilename(contentDisposition: string | null): string {
  const match = /filename="([A-Za-z0-9][A-Za-z0-9._-]{0,127})"/u.exec(
    contentDisposition ?? "",
  );
  return match?.[1] ?? "sympose-people-events-airtable.csv";
}

function safeNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function exportFailureMessage(code: string, maximumRows: number, maximumBytes: number): string {
  const messages: Readonly<Record<string, string>> = {
    CONNECTOR_EXPORT_ROW_LIMIT: `Export stopped at the ${maximumRows}-row safety boundary. Narrow the workspace data before retrying. No provider was contacted.`,
    CONNECTOR_EXPORT_BYTE_LIMIT: `Export exceeded the ${maximumBytes}-byte safety boundary. Reduce large fields before retrying. No provider was contacted.`,
    CONNECTOR_EXPORT_DATA_INVALID: "Export stopped because a stored field is not safe for this CSV contract. No provider was contacted.",
    CONNECTOR_EXPORT_OPERATION_CONFLICT: "Workspace export data changed during a retry. Start a fresh download; no provider was contacted.",
    CONNECTOR_EXPORT_REQUEST_INVALID: "The local export request was rejected before data was read. Reload before retrying.",
    CONNECTOR_WORKSPACE_NOT_FOUND: "The authorized workspace is unavailable. Reload before retrying.",
  };
  return messages[code] ?? "The local export could not be completed. No provider was contacted.";
}

export function AirtableExportButton({
  workspaceSlug,
  expectedRows,
  maximumRows,
  maximumBytes,
}: {
  readonly workspaceSlug: string;
  readonly expectedRows: number;
  readonly maximumRows: number;
  readonly maximumBytes: number;
}) {
  const router = useRouter();
  const pendingOperation = useRef<string | null>(null);
  const blocked = expectedRows > maximumRows;
  const [state, setState] = useState<ExportState>({
    kind: "idle",
    message: blocked
      ? `This workspace has ${expectedRows} export rows, above the ${maximumRows}-row safety limit.`
      : "Ready. The download writes a local audit receipt and makes no provider request.",
  });

  async function download(): Promise<void> {
    if (blocked || state.kind === "loading") return;
    const operationKey = pendingOperation.current ?? crypto.randomUUID();
    pendingOperation.current = operationKey;
    setState({ kind: "loading", message: "Building the authenticated local CSV…" });

    try {
      const response = await fetch(
        `/w/${encodeURIComponent(workspaceSlug)}/connectors/airtable/export`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "text/csv",
            "X-Sympose-Export-Operation": operationKey,
          },
        },
      );

      if (!response.ok) {
        const code = (await response.text()).trim().slice(0, 128);
        pendingOperation.current = null;
        setState({
          kind: "error",
          message: exportFailureMessage(code, maximumRows, maximumBytes),
        });
        router.refresh();
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const rowCount = safeNonNegativeInteger(response.headers.get("x-sympose-export-rows"));
      const byteCount = safeNonNegativeInteger(response.headers.get("x-sympose-export-bytes"));
      const receiptId = response.headers.get("x-sympose-receipt-id") ?? "";
      const noProviderMutation = response.headers.get("x-sympose-provider-mutation") === "false";
      const idempotentReplay = response.headers.get("x-sympose-idempotent-replay");
      const schema = response.headers.get("x-sympose-export-schema");
      if (
        response.redirected ||
        !contentType.toLowerCase().startsWith("text/csv;") ||
        rowCount === null ||
        byteCount === null ||
        !/^[0-9a-f-]{36}$/u.test(receiptId) ||
        !noProviderMutation ||
        (idempotentReplay !== "true" && idempotentReplay !== "false") ||
        schema !== "sympose-airtable-people-event-involvement/v1"
      ) {
        setState({
          kind: "error",
          message: "The download response did not satisfy the local export receipt contract. Reload and sign in before retrying.",
        });
        router.refresh();
        return;
      }

      const blob = await response.blob();
      if (blob.size !== byteCount || blob.size > maximumBytes) {
        setState({
          kind: "error",
          message: "The downloaded bytes did not match the local receipt. The file was not opened and no provider was contacted.",
        });
        router.refresh();
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = responseFilename(response.headers.get("content-disposition"));
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      pendingOperation.current = null;

      setState({
        kind: "success",
        message: `${rowCount} CSV row${rowCount === 1 ? "" : "s"} downloaded (${byteCount} bytes). Local receipt ${receiptId.slice(0, 8)}… records providerMutation: false.`,
      });
      router.refresh();
    } catch {
      setState({
        kind: "error",
        message: "The browser could not complete the local download. No provider was contacted.",
      });
    }
  }

  return (
    <div className={styles.exportAction}>
      <button
        type="button"
        className={styles.exportButton}
        disabled={blocked || state.kind === "loading"}
        onClick={() => void download()}
        aria-describedby="airtable-export-status"
      >
        <Download aria-hidden="true" size={17} strokeWidth={1.9} />
        {state.kind === "loading"
          ? "Building CSV…"
          : `Download ${expectedRows} Airtable row${expectedRows === 1 ? "" : "s"}`}
      </button>
      <p
        id="airtable-export-status"
        className={`${styles.exportStatus} ${styles[`exportStatus_${state.kind}`]}`}
        role={state.kind === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {state.message}
      </p>
    </div>
  );
}
