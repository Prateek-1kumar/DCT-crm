import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4100";

/**
 * Sample mode: the in-browser sample server stands in for the API. Only the exact value "1" turns it on, and the flag is
 * always inlined, so in a real build `if (MOCK)` folds to false and the sample server and its fixtures aren't bundled.
 */
const SAMPLE = process.env.NEXT_PUBLIC_API_MOCK === "1";
const DEV = process.env.NODE_ENV !== "production";

/**
 * Static, not nonce-based: cacheComponents prerenders a static shell, which can't carry a per-request nonce (Next's CSP
 * guide: PPR is incompatible with nonces), so Next's inline bootstrap scripts need 'unsafe-inline'. Everything else is
 * this origin only: page images come through the /api proxy; sample mode draws pages as data: URLs and saves Excel from
 * a blob:. Dev adds 'unsafe-eval' for React's dev tooling.
 * ponytail: no upgrade-insecure-requests or HSTS while the app is plain HTTP on 127.0.0.1; add both with HTTPS.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_API_MOCK: SAMPLE ? "1" : "" },
  // The e2e run (E2E=1) builds into its own folder: its API_URL is baked into the rewrites at build time.
  distDir: process.env.E2E === "1" ? ".next-e2e" : ".next",
  // The design-system reference (app/design/page.dev.tsx) is for dev and sample builds, not the real app.
  pageExtensions: ["tsx", "ts", ...(DEV || SAMPLE ? ["dev.tsx"] : [])],
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  experimental: {
    // Uploads go through the /api rewrite; the default 10 MB cut real contracts (~12 MB) off mid-stream.
    // Just above the API's 50 MB per-file limit; the UI uploads one file per request.
    proxyClientMaxBodySize: "55mb",
  },
  // @dct/shared ships TypeScript source.
  transpilePackages: ["@dct/shared"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
