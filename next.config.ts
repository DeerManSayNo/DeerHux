import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let coreVersion = "unknown";
try {
  const corePkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  coreVersion = (JSON.parse(readFileSync(corePkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const buildTraceExcludes = [
  "src-tauri/target/**",
  "codeAgent/**",
  ".next-measure/**",
  ".next-build-check/**",
  ".next-design-preview/**",
  ".deerhux-build-home/**",
];

const nextConfig: NextConfig = {
  // Concurrent design previews must not share the desktop dev server's CSS cache.
  distDir: process.env.NODE_ENV === "development" && process.env.DEERHUX_DESIGN_PREVIEW === "1"
    ? ".next-design-preview"
    : process.env.NODE_ENV === "production" ? (process.env.DEERHUX_BUILD_DIR || ".next") : ".next",
  // Keep Next's persistent webpack cache and isolated build worker. The build
  // still verifies emitted message CSS and theme tokens before packaging.
  webpack(config, { dev, isServer, nextRuntime }) {
    // Webpack defaults to 100 simultaneous module builds. Native transforms
    // allocate outside V8's heap limit, so bound those jobs as well.
    if (!dev) config.parallelism = 8;
    if (!dev && isServer && nextRuntime === "nodejs") {
      // Next 16.2.1 only applies outputFileTracingExcludes after webpack's
      // entry trace. Exclude old bundles during that earlier scan as well.
      // This is a version-sensitive adapter: fail visibly if Next changes it.
      const tracer = config.plugins.find((plugin: { constructor?: { name?: string } } | null) =>
        plugin?.constructor?.name === "TraceEntryPointsPlugin");
      if (!tracer || !Array.isArray(tracer.traceIgnores)) {
        throw new Error("Next trace plugin changed; review DeerHux build exclusions before packaging.");
      }
      tracer.traceIgnores.push(...buildTraceExcludes);
      // Dynamic skill paths become **/SKILL.md globs in @vercel/nft. Its glob
      // walker doesn't prune ignored subdirectories, so directory exclusions
      // alone still walk every old bundle. Skip this runtime-only asset glob;
      // prune-standalone.js explicitly copies the five shipped skill folders.
      tracer.traceIgnores.push("**/SKILL.md");
    }
    return config;
  },
  output: "standalone",
  outputFileTracingRoot: __dirname,
  outputFileTracingExcludes: {
    "/*": buildTraceExcludes,
    // Next uses this key for the shared ignore list in its second (chunk)
    // trace, before walking assets. Built-in skills are copied explicitly.
    "next-server": ["**/SKILL.md"],
  },
  // Image prompts are sent as base64 in JSON. Next's default request clone
  // limit is too small for normal screenshots/photos, causing /api/agent/*
  // POSTs to fail before our route handler sees them.
  experimental: {
    cpus: 2,
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
    // Share pages cannot expose the dev HMR socket. Keep RSC debug data inline
    // so Next 16 hydration does not wait for that private socket in development.
    reactDebugChannel: false,
    proxyClientMaxBodySize: 25 * 1024 * 1024,
  },
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "@mariozechner/clipboard",
    "@silvia-odwyer/photon-node",
    "cross-spawn",
    "glob",
    "hosted-git-info",
    "ignore",
    "jiti",
    "node-cron",
    "proper-lockfile",
    "undici",
    "yaml",
  ],
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_CORE_VERSION: coreVersion,
  },
};

export default nextConfig;
