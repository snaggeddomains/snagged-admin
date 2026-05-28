import type { Metadata } from "next";
import type { ReactNode } from "react";
import Nav from "./nav";
import "./snagged-brand.css";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "snagged-admin",
  description: "Marketplace pipeline dashboard",
  icons: { icon: "/brand/favicon-32.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap" style={{ paddingTop: "2.5rem", paddingBottom: "4rem" }}>
          <header style={{ marginBottom: 20 }}>
            <div className="wordmark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
              <span className="wm-a">Snagged</span>{" "}
              <span className="wm-b">Admin</span>
            </div>
            <p
              className="muted"
              style={{ marginTop: 6, marginBottom: 0, fontSize: 14 }}
            >
              Marketplace pipeline dashboard
            </p>
          </header>
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
