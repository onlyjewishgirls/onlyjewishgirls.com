import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Scanner/decoy paths (PORTAL-STANDARD §7) go to a handler that blocks the address.
  // Keep in step with DECOY_PATH_PATTERNS in src/lib/security.ts.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source:
            "/:p((?:\\.env|\\.git|\\.svn|\\.aws|\\.DS_Store|wp-admin|wp-login|wp-content|wp-includes|wp-config|xmlrpc\\.php|phpmyadmin|pma|adminer|cgi-bin|server-status|vendor/phpunit|administrator|actuator).*)",
          destination: "/api/decoy?p=:p",
        },
        { source: "/:p(.*\\.(?:php|asp|aspx|jsp|cgi))", destination: "/api/decoy?p=:p" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;

// Gives `next dev` the same Cloudflare bindings (a local D1 database, .dev.vars secrets) as production.
if (process.env.NODE_ENV === "development") {
  import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev());
}
