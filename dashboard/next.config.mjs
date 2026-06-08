/** @type {import('next').NextConfig} */
const nextConfig = {
  // Phase 3: nest the research app under /research. Keep-prefix proxy — research
  // serves itself at base path /research (SPA + assets + api), so we forward the
  // prefix through unchanged. Cookies/headers are forwarded by the rewrite, so
  // the shared dr_auth session reaches research's handlers.
  async rewrites() {
    const research = (process.env.RESEARCH_ORIGIN || "https://research.snagged.com").replace(
      /\/$/,
      "",
    );
    return [
      { source: "/research", destination: `${research}/research` },
      { source: "/research/:path*", destination: `${research}/research/:path*` },
      // Vanity short URLs that land on the research SPA. Domain DB Screen
      // (single-domain lookup) at /dbscreen[?domain=]; the filterable DB Search
      // at /dbsearch. Query strings are forwarded by the rewrite.
      { source: "/dbscreen", destination: `${research}/research/dbscreen` },
      { source: "/dbscreen/:path*", destination: `${research}/research/dbscreen/:path*` },
      { source: "/dbsearch", destination: `${research}/research/dbsearch` },
      { source: "/dbsearch/:path*", destination: `${research}/research/dbsearch/:path*` },
    ];
  },
  // Reports graduated from an Admin sub-tab to its own top-level module — keep the
  // old /admin/reports URLs working (analytics is now the default at /reports).
  async redirects() {
    return [
      { source: "/admin/reports/analytics", destination: "/reports", permanent: true },
      { source: "/admin/reports", destination: "/reports/cost", permanent: true },
    ];
  },
};
export default nextConfig;
