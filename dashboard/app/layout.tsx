import type { Metadata } from "next";
import type { ReactNode } from "react";
import Nav from "./nav";

export const metadata: Metadata = {
  title: "snagged-admin",
  description: "Marketplace pipeline dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          color: "#111",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "2.5rem 2rem 4rem",
          }}
        >
          <header style={{ marginBottom: 16 }}>
            <h1 style={{ fontSize: 28, margin: 0 }}>snagged-admin</h1>
            <p style={{ color: "#666", marginTop: 6, marginBottom: 0 }}>
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
