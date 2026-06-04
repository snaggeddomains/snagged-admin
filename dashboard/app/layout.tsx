import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./snagged-brand.css";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Snagged Admin",
  description: "Snagged umbrella — admin & research",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/brand/favicon-32.png", apple: "/icons/apple-touch-icon.png" },
  // Standalone "Add to Home Screen" launch on iOS (status bar + title).
  appleWebApp: { capable: true, title: "Snagged", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#254254",
};

// Root shell only: the per-module chrome (header, nav) lives in each module's
// layout (e.g. app/admin/layout.tsx), so /login renders clean.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap" style={{ paddingTop: "2.5rem", paddingBottom: "4rem" }}>
          {children}
        </div>
      </body>
    </html>
  );
}
