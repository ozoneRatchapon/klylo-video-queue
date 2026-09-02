import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Pin the workspace root; otherwise Turbopack walks up and finds a stray lockfile.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
