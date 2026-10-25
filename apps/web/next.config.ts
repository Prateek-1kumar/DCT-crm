import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4100";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Uploads go through the /api rewrite; the default 10 MB cut real contracts (~12 MB) off mid-stream.
    // Just above the API's 50 MB per-file limit; the UI uploads one file per request.
    proxyClientMaxBodySize: "55mb",
  },
  // @dct/shared ships TypeScript source.
  transpilePackages: ["@dct/shared"],
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
