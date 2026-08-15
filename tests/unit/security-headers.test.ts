import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

const expectedProductionBaseline = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
};

async function headersFor(path: string) {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://sympose.example${path}`,
    nextConfig,
  });

  return Object.fromEntries(
    [
      "strict-transport-security",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
      "x-frame-options",
    ].flatMap((key) => {
      const value = response.headers.get(key);
      return value === null ? [] : [[key, value]];
    }),
  );
}

describe("deployment security headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits the exact production baseline and denies framing on non-embed paths", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(headersFor("/dashboard")).resolves.toEqual({
      ...expectedProductionBaseline,
      "x-frame-options": "DENY",
    });
  });

  it("keeps the baseline on embeds without leaking the global framing rule", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(headersFor("/embed/aud1-11111111-1111-4111-8111-111111111111")).resolves.toEqual(expectedProductionBaseline);
  });
});
