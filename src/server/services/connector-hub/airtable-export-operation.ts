const OPERATION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Validate the same-origin, bodyless, idempotent browser command before resolving export data. */
export function connectorExportOperation(request: Request): string | null {
  const url = new URL(request.url);
  const operationKey = request.headers.get("x-sympose-export-operation");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const contentLength = request.headers.get("content-length");
  if (
    url.search.length > 0 ||
    origin !== url.origin ||
    (fetchSite !== null && fetchSite !== "same-origin") ||
    request.body !== null ||
    (contentLength !== null && contentLength !== "0") ||
    !operationKey ||
    !OPERATION_KEY.test(operationKey)
  ) {
    return null;
  }
  return operationKey;
}
