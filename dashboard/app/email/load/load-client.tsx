"use client";

import { useCallback, useEffect, useState } from "react";

type Ledger = {
  mailbox: string;
  reads: number;
  bytes: number;
  by_feature: Record<string, { reads: number; bytes: number }>;
  bg_read_cap: number;
  bg_byte_cap: number;
  bg_read_stop: number;
  bg_byte_stop: number;
  halted: boolean;
};
type Resp = {
  ok: boolean;
  mailboxes: string[];
  ledger: Ledger[];
  caps: { BG_READS: number; BG_BYTES: number; IX_READS: number; IX_BYTES: number; SAFETY: number };
  halted: boolean;
  audit: Record<string, { app: string; events: number }[] | null> | null;
  day: string;
};

const NAVY = "#254254";
const CORAL = "#e8735f";
const GREEN = "#2eb67d";
const AMBER = "#e8912d";
const OUR_SA = "104413441059090976334"; // marketplace-pipeline

function mb(bytes: number): string {
  if (!bytes) return "0";
  const m = bytes / 1024 / 1024;
  return m >= 100 ? `${Math.round(m)} MB` : `${m.toFixed(1)} MB`;
}
function pct(n: number, cap: number): number {
  return cap > 0 ? Math.min(100, Math.round((n / cap) * 100)) : 0;
}
function barColor(p: number): string {
  return p >= 100 ? CORAL : p >= 70 ? AMBER : GREEN;
}

export default function LoadClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [audit, setAudit] = useState(false);

  const load = useCallback(async (withAudit: boolean) => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/api/admin/email/load${withAudit ? "?audit=1" : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to load");
      setData(j);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const card: React.CSSProperties = { border: "1px solid #e4e8ec", borderRadius: 10, background: "#fff", padding: 16, marginBottom: 14 };

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "8px 4px 40px" }}>
      <h1 style={{ fontSize: "1.35rem", color: NAVY, margin: "4px 0 2px" }}>Inbox load</h1>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        How much <b>our own features</b> are reading the deal mailboxes today (UTC {data?.day || "…"}).
        Every Gmail read across the app charges this ledger. Background jobs <b>stop at{" "}
        {data ? Math.round(data.caps.SAFETY * 100) : 70}% of the daily cap</b> (never 100%), and if{" "}
        <b>any one mailbox</b> gets that close, <b>all</b> background reading halts everywhere — so the
        shared per-user quota Superhuman draws on always keeps headroom. The Email tool (interactive) is
        never halted.
      </p>
      <p className="muted" style={{ margin: "0 0 16px", fontSize: 12.5, color: "#8a939b" }}>
        <b>Reading this:</b> 0 / cap with “no reads charged” = healthy — it means nothing of ours has
        touched that mailbox today (the background mailbox crons are currently paused). Numbers climb here
        only when a cron or the Email tool reads. For what <i>every</i> app (Superhuman, us, etc.) did to a
        box, use <b>Pull Google audit</b>.
      </p>
      {data?.halted && (
        <div style={{ background: "#fdecea", color: "#a4271a", padding: "10px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
          ⛔ Background reads are HALTED — a mailbox reached the {Math.round(data.caps.SAFETY * 100)}% safety line.
          All crons are paused on the Gmail side until the daily window resets (interactive Email still works).
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        <button type="button" onClick={() => load(audit)} disabled={loading}
          style={{ padding: "8px 16px", border: "none", borderRadius: 8, background: NAVY, color: "#fff", fontWeight: 600, cursor: "pointer" }}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
        <button type="button" onClick={() => { setAudit(true); load(true); }} disabled={loading}
          style={{ padding: "8px 16px", border: `1px solid ${NAVY}`, borderRadius: 8, background: "#fff", color: NAVY, fontWeight: 600, cursor: "pointer" }}
          title="Pull the Google OAuth-token audit (which apps authorized to each mailbox, last 7d)">
          Pull Google audit (7d)
        </button>
      </div>

      {err && <div style={{ background: "#fdecea", color: "#a4271a", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {data?.ledger?.map((l) => {
        const feats = Object.entries(l.by_feature || {}).sort((a, b) => (b[1]?.bytes || 0) - (a[1]?.bytes || 0));
        const aud = data.audit?.[l.mailbox];
        return (
          <div key={l.mailbox} style={card}>
            <div style={{ fontWeight: 700, color: NAVY, marginBottom: 10 }}>{l.mailbox}</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Meter label={`Reads (stop at ${l.bg_read_stop} · cap ${l.bg_read_cap})`} value={`${l.reads} / ${l.bg_read_stop}`} p={pct(l.reads, l.bg_read_stop)} />
              <Meter label={`Bytes (stop at ${mb(l.bg_byte_stop)} · cap ${mb(l.bg_byte_cap)})`} value={`${mb(l.bytes)} / ${mb(l.bg_byte_stop)}`} p={pct(l.bytes, l.bg_byte_stop)} />
            </div>
            {l.halted && <div style={{ marginTop: 8, fontSize: 12.5, color: CORAL, fontWeight: 600 }}>⛔ At the safety line — background reads on this mailbox are stopped for today.</div>}

            {feats.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7681", marginBottom: 4 }}>By feature (today)</div>
                <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                  <tbody>
                    {feats.map(([f, v]) => (
                      <tr key={f} style={{ borderTop: "1px solid #f0f3f5" }}>
                        <td style={{ padding: "4px 0", color: NAVY }}>{f}</td>
                        <td style={{ padding: "4px 0", textAlign: "right", color: "#6b7681" }}>{v.reads} reads</td>
                        <td style={{ padding: "4px 0", textAlign: "right", color: "#6b7681", width: 90 }}>{mb(v.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {feats.length === 0 && <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No reads charged today — nothing of ours has touched this mailbox (background crons paused).</div>}

            {data.audit && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7681", marginBottom: 4 }}>OAuth token grants · last 7d (Google audit)</div>
                {aud === null && <div className="muted" style={{ fontSize: 12 }}>Audit unavailable (needs the admin.reports scope on the SA).</div>}
                {aud && aud.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No token events.</div>}
                {aud && aud.length > 0 && (
                  <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                    <tbody>
                      {aud.map((a) => {
                        const ours = a.app.includes(OUR_SA);
                        return (
                          <tr key={a.app} style={{ borderTop: "1px solid #f0f3f5" }}>
                            <td style={{ padding: "4px 0", color: ours ? CORAL : NAVY, fontWeight: ours ? 700 : 400 }}>
                              {ours ? "our SA (marketplace-pipeline)" : a.app}
                            </td>
                            <td style={{ padding: "4px 0", textAlign: "right", color: "#6b7681" }}>{a.events}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </main>
  );
}

function Meter({ label, value, p }: { label: string; value: string; p: number }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7681", marginBottom: 3 }}>
        <span>{label}</span><span>{value}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "#eef1f4", overflow: "hidden" }}>
        <div style={{ width: `${p}%`, height: "100%", background: barColor(p) }} />
      </div>
    </div>
  );
}
