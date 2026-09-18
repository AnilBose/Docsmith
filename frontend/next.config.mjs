/** @type {import('next').NextConfig} */
// The one place the backend origin is defined. `env` below re-exports the
// resolved value so lib/config.ts and the /api proxy can never disagree.
const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8420";

const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_API_URL: API },
  // Everything runs on this machine; never phone home for fonts or telemetry.
  poweredByHeader: false,
  async rewrites() {
    // Proxy /api to the Python service so the browser sees a single origin.
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
