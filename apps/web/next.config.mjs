// @ts-check

/**
 * Next 15 config for @erebus/web.
 * - transpilePackages: all source-only @erebus/* workspace packages.
 * - webpack extensionAlias: lets ".js" relative imports resolve to ".ts"/".tsx"
 *   (the locked contracts import with ".js" extensions on ESM source).
 * - eslint ignored during builds (UI iteration speed; lint runs separately).
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@erebus/agents",
    "@erebus/content",
    "@erebus/core",
    "@erebus/db",
    "@erebus/ingest",
    "@erebus/shadowboard",
  ],
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
