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
      // Vanity short URL for Domain DB Search: app.snagged.com/dbsearch (with
      // ?domain=…) and /dbsearch/<domain> both land on the research SPA's
      // dbsearch view. Query strings are forwarded by the rewrite.
      { source: "/dbsearch", destination: `${research}/research/dbsearch` },
      { source: "/dbsearch/:path*", destination: `${research}/research/dbsearch/:path*` },
    ];
  },
};
export default nextConfig;
