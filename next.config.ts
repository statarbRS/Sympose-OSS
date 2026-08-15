import type { NextConfig } from "next";

const baselineSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
] as const;

const productionSecurityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  ...(process.env.SYMPOSE_BUILD_SHA ? { output: "standalone" as const } : {}),
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: "26mb",
    },
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        ...baselineSecurityHeaders,
        ...(process.env.NODE_ENV === "production" ? productionSecurityHeaders : []),
      ],
    },
    {
      source: "/((?!embed(?:/|$)).*)",
      headers: [{ key: "X-Frame-Options", value: "DENY" }],
    },
  ],
};

export default nextConfig;
