import { loadAllSourcesWithStatus, type SourceWithStatus } from "../lib/sources";

export const revalidate = 60;

const PRODUCT_LABEL: Record<string, string> = {
  snap: "SNAP",
  auctions: "Auctions",
  aux: "Aux feeds",
};

function statusInfo(s: SourceWithStatus): { color: string; label: string } {
  if (s.enabled === false) return { color: "#9ca3af", label: "disabled" };
  if (!s.runStatus) return { color: "#d1d5db", label: "never run" };
  if (s.runStatus.status === "failed") return { color: "#dc2626", label: "failed" };
  if (s.runStatus.status === "ok") {
    const ageHours =
      (Date.now() - new Date(s.runStatus.generated_at).getTime()) / 1000 / 3600;
    if (ageHours < 26) return { color: "#10b981", label: "ok" };
    return { color: "#f59e0b", label: `stale (${Math.round(ageHours)}h)` };
  }
  return { color: "#9ca3af", label: s.runStatus.status };
}

function relativeTime(iso: string): string {
  const ageSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

export default async function Home() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  const sources = hasToken ? await loadAllSourcesWithStatus() : [];

  const byProduct: Record<string, SourceWithStatus[]> = {};
  for (const s of sources) {
    (byProduct[s.product] ||= []).push(s);
  }

  const counts = {
    total: sources.length,
    green: sources.filter((s) => statusInfo(s).color === "#10b981").length,
    failed: sources.filter((s) => statusInfo(s).color === "#dc2626").length,
    stale: sources.filter((s) => statusInfo(s).color === "#f59e0b").length,
    never: sources.filter((s) => s.enabled !== false && !s.runStatus).length,
  };

  return (
    <main
      style={{
        padding: "2.5rem 2rem",
        maxWidth: 1100,
        margin: "0 auto",
        color: "#111",
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>snagged-admin</h1>
        <p style={{ color: "#666", marginTop: 6, marginBottom: 0 }}>
          Marketplace pipeline source health
        </p>
      </header>

      {!hasToken && (
        <div
          style={{
            background: "#fef3c7",
            border: "1px solid #f59e0b",
            padding: 16,
            borderRadius: 6,
            marginBottom: 24,
            fontSize: 14,
          }}
        >
          <strong>GITHUB_TOKEN not set.</strong> The dashboard reads source state
          from the snagged-admin repo via the GitHub Contents API. Set
          GITHUB_TOKEN as an env var (fine-grained PAT with read access) to see
          live data.
        </div>
      )}

      {hasToken && (
        <section
          style={{
            display: "flex",
            gap: 24,
            marginBottom: 32,
            padding: "12px 16px",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          <span>
            <strong>{counts.total}</strong> sources
          </span>
          <span style={{ color: "#10b981" }}>
            ● <strong>{counts.green}</strong> ok
          </span>
          <span style={{ color: "#f59e0b" }}>
            ● <strong>{counts.stale}</strong> stale
          </span>
          <span style={{ color: "#dc2626" }}>
            ● <strong>{counts.failed}</strong> failed
          </span>
          <span style={{ color: "#9ca3af" }}>
            ● <strong>{counts.never}</strong> never run
          </span>
        </section>
      )}

      {(["snap", "auctions", "aux"] as const).map((product) => {
        const items = byProduct[product] ?? [];
        if (!items.length) return null;
        return (
          <section key={product} style={{ marginBottom: 36 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12, fontWeight: 600 }}>
              {PRODUCT_LABEL[product]}{" "}
              <span style={{ color: "#9ca3af", fontWeight: 400 }}>
                · {items.length}
              </span>
            </h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
                  <th style={{ padding: "8px 0", width: 24 }}></th>
                  <th style={{ padding: "8px 0" }}>source_id</th>
                  <th style={{ padding: "8px 0" }}>kind</th>
                  <th style={{ padding: "8px 0" }}>schedule (UTC)</th>
                  <th style={{ padding: "8px 0" }}>last run</th>
                  <th style={{ padding: "8px 0", textAlign: "right" }}>
                    new&nbsp;today
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const info = statusInfo(s);
                  return (
                    <tr
                      key={s.source_id}
                      style={{ borderTop: "1px solid #f3f4f6" }}
                    >
                      <td style={{ padding: "10px 0" }}>
                        <span
                          title={info.label}
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: info.color,
                          }}
                        />
                      </td>
                      <td
                        style={{
                          padding: "10px 0",
                          fontFamily: "ui-monospace, Menlo, monospace",
                        }}
                      >
                        {s.source_id}
                      </td>
                      <td style={{ padding: "10px 0", color: "#6b7280" }}>
                        {s.kind}
                      </td>
                      <td
                        style={{
                          padding: "10px 0",
                          color: "#6b7280",
                          fontFamily: "ui-monospace, Menlo, monospace",
                        }}
                      >
                        {s.schedule_utc ?? "—"}
                      </td>
                      <td style={{ padding: "10px 0", color: "#6b7280" }}>
                        {s.runStatus
                          ? relativeTime(s.runStatus.generated_at)
                          : "never"}
                      </td>
                      <td
                        style={{
                          padding: "10px 0",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {s.runStatus?.new_count ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}

      <footer
        style={{
          marginTop: 48,
          paddingTop: 16,
          borderTop: "1px solid #e5e7eb",
          fontSize: 12,
          color: "#9ca3af",
        }}
      >
        Page revalidates every 60 seconds. Source registry:{" "}
        <code>sources.yaml</code>. State: <code>state/&lt;source_id&gt;/</code>.
      </footer>
    </main>
  );
}
