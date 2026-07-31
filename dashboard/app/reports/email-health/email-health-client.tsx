"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type MxItem = { Name?: string; Info?: string; Url?: string };
type Check = { key: string; label: string; status: "pass" | "warn" | "fail" | "unavailable"; value: string | null; detail: string | null; failed: MxItem[]; warnings: MxItem[] };
type SelectorStatus = { selector: string; status: Check["status"] };
type ActionItem = { severity: "high" | "medium" | "low"; title: string; detail: string };
type DomainHealth = { domain: string; grade: "A" | "B" | "F" | "?"; checks: Check[]; failing: string[]; dmarc_policy?: "none" | "quarantine" | "reject" | null; dmarc_reporting?: boolean; dkim_selectors?: SelectorStatus[]; actions?: ActionItem[]; checked_at: string };
type Usage = { DnsRequests?: number; DnsMax?: number; NetworkRequests?: number; NetworkMax?: number };
type Resp = { ok: boolean; configured: boolean; reports?: DomainHealth[]; domains?: string[]; selectors?: string[]; usage?: Usage | null; error?: string };

const NAVY = "var(--navy,#254254)";
const BTN: CSSProperties = { padding: "6px 12px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: NAVY, cursor: "pointer", whiteSpace: "nowrap" };
const STATUS: Record<Check["status"], { bg: string; fg: string; dot: string; label: string }> = {
  pass: { bg: "#e6f4ec", fg: "#166534", dot: "#22a866", label: "Pass" },
  warn: { bg: "#fef3c7", fg: "#9a3412", dot: "#e0a020", label: "Warn" },
  fail: { bg: "#fde2e1", fg: "#a3282b", dot: "#d64545", label: "Fail" },
  unavailable: { bg: "#eef1f3", fg: "#6b7680", dot: "#b7bcc2", label: "n/a" },
};
const GRADE: Record<DomainHealth["grade"], string> = { A: "#1f7a5a", B: "#9a6a00", F: "#a3282b", "?": "#8a94a0" };
const SEV: Record<ActionItem["severity"], { bg: string; fg: string; label: string }> = {
  high: { bg: "#fde2e1", fg: "#a3282b", label: "High" },
  medium: { bg: "#fef3c7", fg: "#9a6a00", label: "Medium" },
  low: { bg: "#eef1f3", fg: "#5a6b75", label: "Low" },
};
// DMARC policy chip: enforcing = good, monitor-only (none) = amber.
function dmarcChip(p?: string | null) {
  if (!p) return null;
  const enforcing = p === "reject" || p === "quarantine";
  const c = enforcing ? { bg: "#e6f4ec", fg: "#166534" } : { bg: "#fef3c7", fg: "#9a6a00" };
  return <span style={{ fontSize: 10.5, fontWeight: 700, color: c.fg, background: c.bg, padding: "1px 7px", borderRadius: 999, marginLeft: 8 }}>{`p=${p}`}{enforcing ? "" : " · monitor only"}</span>;
}

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  const m = Math.round(s / 60), h = Math.round(s / 3600), d = Math.round(s / 86400);
  return s < 60 ? "just now" : m < 60 ? `${m}m ago` : h < 24 ? `${h}h ago` : `${d}d ago`;
}

export default function EmailHealthClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);   // domain being refreshed, or "*" for all
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/admin/email-health", { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async (domain?: string) => {
    setBusy(domain || "*"); setErr(null);
    try {
      const res = await fetch("/api/admin/email-health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh", domain }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  }, [load]);

  const reports = data?.reports || [];

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>📧 Email Health</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Deliverability of our sending domains — MX, SPF, DKIM, DMARC, blacklist &amp; DNS via MXToolbox.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data?.usage && (
            <span className="muted" style={{ fontSize: 12 }} title="MXToolbox quota (resets daily 00:00 UTC)">
              DNS {data.usage.DnsRequests ?? 0}/{data.usage.DnsMax ?? "?"} · Net {data.usage.NetworkRequests ?? 0}/{data.usage.NetworkMax ?? "?"}
            </span>
          )}
          <button style={BTN} onClick={() => refresh()} disabled={busy != null}>{busy === "*" ? "Checking…" : "↻ Refresh all"}</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a3282b", fontSize: 13 }}>{err}</div>}
      {data && !data.configured && (
        <div className="muted" style={{ margin: "16px 0", fontSize: 13 }}>
          Not configured — set <code>MXTOOLBOX_API_KEY</code>. Domains to monitor: <code>{(data.domains || []).join(", ")}</code>{" "}
          (override with <code>EMAIL_HEALTH_DOMAINS</code>).
        </div>
      )}
      {loading && !data && <div className="muted" style={{ marginTop: 16 }}>Loading…</div>}
      {data?.configured && !reports.length && !loading && (
        <div className="muted" style={{ margin: "16px 0", fontSize: 13 }}>
          No checks cached yet for <code>{(data.domains || []).join(", ")}</code>. Hit <b>Refresh all</b> to run the first sweep.
        </div>
      )}

      <div style={{ display: "grid", gap: 16, marginTop: 18 }}>
        {reports.map((r) => (
          <section key={r.domain} style={{ border: "1px solid var(--line,#e6e0d3)", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line,#eee)" }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: GRADE[r.grade], color: "#fff", fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>{r.grade}</span>
              <span style={{ fontWeight: 700, fontSize: 15, color: NAVY }}>{r.domain}</span>
              <span className="muted" style={{ fontSize: 12 }}>checked {ago(r.checked_at)}</span>
              <button style={{ ...BTN, marginLeft: "auto", fontSize: 12, padding: "4px 10px" }} onClick={() => refresh(r.domain)} disabled={busy != null}>{busy === r.domain ? "…" : "↻"}</button>
            </div>
            <div style={{ padding: "6px 8px" }}>
              {r.checks.map((c) => {
                const s = STATUS[c.status];
                return (
                  <div key={c.key} style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, padding: "9px 10px", borderTop: "1px solid #f4f1ea", alignItems: "start" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flex: "0 0 auto" }} />
                      <span style={{ fontWeight: 700, fontSize: 12.5, color: NAVY }}>{c.label}</span>
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, color: s.fg, background: s.bg, padding: "1px 7px", borderRadius: 999, marginRight: 8 }}>{s.label}</span>
                      {c.detail && <span className="muted" style={{ fontSize: 11.5, marginRight: 8 }}>{c.detail}</span>}
                      {c.value && <code style={{ fontSize: 11.5, color: "#4a5b66", wordBreak: "break-word" }}>{c.value}</code>}
                      {c.key === "dmarc" && dmarcChip(r.dmarc_policy)}
                      {c.key === "dkim" && (r.dkim_selectors || []).length > 1 && (
                        <span style={{ marginLeft: 8, fontSize: 11 }}>
                          {(r.dkim_selectors || []).map((sel) => (
                            <span key={sel.selector} style={{ marginRight: 8, color: STATUS[sel.status].fg }}>
                              {sel.status === "pass" ? "✓" : "✗"} {sel.selector}
                            </span>
                          ))}
                        </span>
                      )}
                      {(c.failed.length > 0 || c.warnings.length > 0) && (
                        <div style={{ marginTop: 4, display: "grid", gap: 2 }}>
                          {[...c.failed.map((i) => ({ i, kind: "fail" as const })), ...c.warnings.map((i) => ({ i, kind: "warn" as const }))].map(({ i, kind }, idx) => (
                            <div key={idx} style={{ fontSize: 11.5, color: kind === "fail" ? "#a3282b" : "#9a6a00" }}>
                              {kind === "fail" ? "✗" : "⚠"} {i.Name || i.Info}
                              {i.Url && <> · <a href={i.Url} target="_blank" rel="noopener" style={{ color: "var(--coral,#e2674a)" }}>details ↗</a></>}
                            </div>
                          ))}
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {(r.actions || []).length > 0 ? (
              <div style={{ borderTop: "1px solid var(--line,#eee)", padding: "12px 16px", background: "#fbf9f4" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: NAVY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
                  Analysis · Action items
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {(r.actions || []).map((a, i) => {
                    const sv = SEV[a.severity];
                    return (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 10, alignItems: "start" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: sv.fg, background: sv.bg, padding: "2px 7px", borderRadius: 999, textAlign: "center" }}>{sv.label}</span>
                        <span>
                          <span style={{ fontWeight: 700, fontSize: 13, color: NAVY }}>{a.title}</span>
                          <div className="muted" style={{ fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{a.detail}</div>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : r.failing.length > 0 ? (
              // Failing checks but no computed actions = a report cached before the analysis
              // shipped (or before a re-scan). Never claim "healthy" here.
              <div style={{ borderTop: "1px solid var(--line,#eee)", padding: "10px 16px", fontSize: 12.5, color: "#9a6a00" }}>
                ↻ Stale — hit Refresh to compute action items for the current state.
              </div>
            ) : (
              <div style={{ borderTop: "1px solid var(--line,#eee)", padding: "10px 16px", fontSize: 12.5, color: "#1f7a5a" }}>
                ✓ No action items — authentication is healthy{r.dmarc_policy === "reject" || r.dmarc_policy === "quarantine" ? " and DMARC is enforcing" : ""}.
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
