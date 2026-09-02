import path from "node:path";
import type { NextConfig } from "next";

/**
 * Security headers that are identical on every response, so they belong here
 * rather than in `proxy.ts`. The per-request `Content-Security-Policy` (it
 * carries a fresh nonce) is set in `proxy.ts` instead.
 */
const security_headers = [
  // The app is HTTPS-only on Vercel; two years, and eligible for preloading.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // A user-supplied upload must never be re-sniffed into a script content type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-braces for `frame-ancestors 'none'`, which older browsers ignore.
  { key: "X-Frame-Options", value: "DENY" },
  // Signed Storage URLs appear in the address bar of no other origin; keep it that way.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // No Flash/Silverlight cross-domain policy anywhere.
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Don't advertise the framework and version in every response.
  poweredByHeader: false,
  // Pin the workspace root; otherwise Turbopack walks up and finds a stray lockfile.
  turbopack: { root: path.join(__dirname) },
  headers() {
    // `/:path*` also covers the API routes, which `proxy.ts` deliberately skips.
    return Promise.resolve([{ source: "/:path*", headers: security_headers }]);
  },
};

export default nextConfig;
