import type { MetadataRoute } from "next";

// Web app manifest → makes app.snagged.com installable ("Add to Home Screen").
// Served by Next at /manifest.webmanifest. The research SPA (/research/*) is a
// proxied app with its OWN manifest; this one covers the admin/umbrella side.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Snagged Admin",
    short_name: "Snagged",
    description: "Snagged umbrella — admin & research",
    start_url: "/admin",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4eee1",
    theme_color: "#254254",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
