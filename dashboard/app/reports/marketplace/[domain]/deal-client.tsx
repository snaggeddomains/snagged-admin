"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/marketplace-deals.ts + lib/ga.ts ListingRow + newsletter summary.
type SaleStatus = { stage: string; label: string; opened: string | null; closed: string | null; txn: string | null };
type DealThread = {
  subject: string; origin: "inbound" | "pitched"; active: boolean; stale: boolean; declined: boolean;
  hasForm: boolean; qualified: boolean; repliedAfterUs: boolean; pitchKind: "mass" | "individual" | null;
  sequenceName: string | null;
  opens: number | null; clicks: number | null; replies: number | null;
  party: string; partyEmail: string | null;
  budget: string | null; offer: string | null; intent: string | null; outcome: string | null;
  messages: number; first: string; last: string; lastSnippet: string;
};
type PitchExercise = { client: string; description?: string | null; sheetTitle: string; tab: string; url: string; price: string | null; note: string | null };
type ColdRecipient = {
  party: string; email: string; sends: number; opened: boolean; clicked: boolean; replied: boolean;
  responded: boolean; active: boolean; lastSent: string; sequenceName: string | null; outcome: string | null; offer: string | null;
};
type ColdOutreach = { recipients: number; sends: number; opened: number; clicked: number; replied: number; active: number; rows: ColdRecipient[] };
type DealReport = {
  domain: string; inbound: number; inboundQualified: number; inboundEngaged: number; activeNegotiations: number;
  pitched: number; pitchedMass: number; pitchedIndividual: number; pitchSource?: "hubspot" | "heuristic";
  cold: ColdOutreach | null; pitchExercises: PitchExercise[];
  representingSince: string | null; sale: SaleStatus | null; threads: DealThread[];
};
type GaRow = { views: number; sessions: number; users: number; inquiryStarts: number; clicks: number; inquiries: number };
type Newsletter = { count: number; forSale: number; content: number; lastDate: string | null; dates: string[] } | null;
type NlFeature = { date: string | null; type: "for_sale" | "content"; subject: string; archiveUrl: string | null };
type Resp = {
  ok: boolean; domain: string; from: string; to: string;
  deals: { report: DealReport | null; generatedAt: string | null; configured: boolean };
  ga: GaRow | null; newsletter: Newsletter; newsletterFeatures?: NlFeature[]; error?: string;
};

const CORAL = "var(--coral-deep, #c0492f)";
const NAVY = "var(--navy, #254254)";
const fmt = (x: number) => x.toLocaleString();
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

type Preset = "30" | "90" | "365" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "30", label: "Last 30 days" }, { key: "90", label: "Last 90 days" },
  { key: "365", label: "Last 12 months" }, { key: "all", label: "All time" }, { key: "custom", label: "Custom" },
];

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 120, flex: "1 1 120px" }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}
function AggCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? CORAL : "#e3ddcf"}`, borderRadius: 10, padding: "14px 18px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 38, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function statusOf(t: DealThread): { label: string; color: string } {
  if (t.active) return { label: "Active", color: CORAL };
  if (t.declined) return { label: "Declined", color: "#9a3b3b" };
  if (t.stale) return { label: "Stale", color: "#8a8275" };
  if (t.origin === "inbound") return { label: t.qualified ? "Qualified" : "Low-quality", color: t.qualified ? "#2f7d4f" : "#8a8275" };
  return { label: "Pitched", color: "#5a4ec0" };
}

// Compact controls (the dashboard's `.field` class is full-width — too clunky here).
const CTL: React.CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: NAVY, maxWidth: 200, cursor: "pointer" };
const BTN: React.CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: NAVY, cursor: "pointer", whiteSpace: "nowrap" };
const cell: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid var(--line, #eee)", verticalAlign: "top", fontSize: 15, lineHeight: 1.45 };
const head: React.CSSProperties = { ...cell, textAlign: "left", color: "var(--muted, #888)", fontWeight: 600, whiteSpace: "nowrap", fontSize: 13.5 };

function StatusBadge({ t }: { t: DealThread }) {
  const s = statusOf(t);
  return <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color, border: `1px solid ${s.color}`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{s.label}</span>;
}

// Cold mass send (HubSpot sequence) vs an individual 1:1 pitch. For a mass send
// the HubSpot sequence/campaign name is shown beneath the chip when known.
function PitchTypeChip({ kind, sequenceName }: { kind: "mass" | "individual" | null; sequenceName?: string | null }) {
  if (!kind) return <span className="muted">—</span>;
  const mass = kind === "mass";
  const color = mass ? "#8a6d3b" : "#2f7d4f";
  return (
    <div>
      <span title={mass ? "Cold mass send (HubSpot sequence)" : "Individual 1:1 outreach"} style={{ fontSize: 12, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>
        {mass ? "Mass" : "1:1"}
      </span>
      {mass && sequenceName && (
        <div className="muted" title="HubSpot sequence" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.3, maxWidth: 200 }}>📋 {sequenceName}</div>
      )}
    </div>
  );
}

// Inline opens/clicks/replies engagement, from the HubSpot send log. A dash when
// we have no HubSpot data for this party.
function EngageCell({ opens, clicks, replies }: { opens: number | null; clicks: number | null; replies: number | null }) {
  if (opens == null && clicks == null && replies == null) return <span className="muted">—</span>;
  const pill = (n: number, label: string, color: string) => (
    <span title={`${n} ${label}`} style={{ fontSize: 11.5, fontWeight: 700, color: n > 0 ? color : "#b3ab9b", whiteSpace: "nowrap" }}>{n} {label}</span>
  );
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {pill(opens || 0, "opened", "#2f6f8a")}
      {pill(clicks || 0, "clicked", "#8a6d3b")}
      {pill(replies || 0, "replied", "#2f7d4f")}
    </div>
  );
}

// A small two-option segmented toggle (used for the responded/all filters).
function SegToggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d8d0bf", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
      {options.map(([k, lbl]) => (
        <button key={k} onClick={() => onChange(k)} style={{ padding: "5px 12px", fontSize: 12.5, border: "none", cursor: "pointer", background: value === k ? NAVY : "#fff", color: value === k ? "#fff" : NAVY, fontWeight: value === k ? 700 : 500 }}>
          {lbl}
        </button>
      ))}
    </div>
  );
}
function MiniBadge({ on, label, color }: { on: boolean; label: string; color: string }) {
  return <span style={{ fontSize: 11.5, fontWeight: 700, color: on ? color : "#b3ab9b", whiteSpace: "nowrap" }}>{on ? "✓" : "·"} {label}</span>;
}

function NlList({ title, items, color }: { title: string; items: NlFeature[]; color: string }) {
  return (
    <div style={{ flex: "1 1 340px", minWidth: 300 }}>
      <div style={{ fontWeight: 700, fontSize: 14.5, color, marginBottom: 6 }}>{title} ({items.length})</div>
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: 14 }}>None.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((f, i) => (
            <li key={i} style={{ padding: "7px 0", borderBottom: "1px solid var(--line, #eee)", fontSize: 14.5, lineHeight: 1.4 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>{f.date || "—"}</span>{" · "}
              {f.archiveUrl
                ? <a href={f.archiveUrl} target="_blank" rel="noreferrer" style={{ color: CORAL, textDecoration: "none" }}>{f.subject || "(view email ↗)"}</a>
                : <span>{f.subject || "(no subject)"}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function NewsletterSection({ features }: { features: NlFeature[] }) {
  if (!features.length) return null;
  const byDateDesc = (a: NlFeature, b: NlFeature) => ((a.date || "") < (b.date || "") ? 1 : -1);
  const spotlights = features.filter((f) => f.type === "for_sale").sort(byDateDesc);
  const content = features.filter((f) => f.type === "content").sort(byDateDesc);
  return (
    <div style={{ marginTop: 22 }}>
      <h3 style={{ fontSize: 16.5, margin: "0 0 8px" }}>Newsletter exposure</h3>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <NlList title="Monthly Spotlight (for-sale)" items={spotlights} color="#176a2b" />
        <NlList title="Weekly content mentions" items={content} color={NAVY} />
      </div>
    </div>
  );
}

export default function DealClient({ domain }: { domain: string }) {
  const [preset, setPreset] = useState<Preset>("90");
  const [from, setFrom] = useState(etYmd(new Date(Date.now() - 89 * 86400000)));
  const [to, setTo] = useState(TODAY);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [showLowQ, setShowLowQ] = useState(false);
  const [inboundView, setInboundView] = useState<"all" | "engaged">("all");
  const [pitchView, setPitchView] = useState<"all" | "responded">("all");
  const [coldView, setColdView] = useState<"all" | "responded" | "noresp">("all");
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  const range = useMemo(() => {
    if (preset === "30") return { from: etYmd(new Date(Date.now() - 29 * 86400000)), to: TODAY };
    if (preset === "90") return { from: etYmd(new Date(Date.now() - 89 * 86400000)), to: TODAY };
    if (preset === "365") return { from: etYmd(new Date(Date.now() - 364 * 86400000)), to: TODAY };
    if (preset === "all") return { from: "2024-01-01", to: TODAY };
    return { from, to: to || from };
  }, [preset, from, to]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setMsg("");
    try {
      const q = new URLSearchParams({ domain, from: range.from, to: range.to });
      if (refresh) q.set("refresh", "1");
      const res = await fetch(`/api/admin/marketplace/deals?${q.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok || !j.ok) throw new Error(j.error || `Failed (${res.status})`);
      setData(j);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [domain, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const rep = data?.deals.report;
  const ga = data?.ga;
  const nl = data?.newsletter;
  const threads = rep?.threads || [];

  // Section 1 — inbound inquiries & negotiations (active first, then recency).
  const inboundAll = threads.filter((t) => t.origin === "inbound");
  const lowQ = inboundAll.filter((t) => !t.qualified);
  const rank = (t: DealThread) => (t.active ? 0 : t.declined ? 2 : t.stale ? 3 : 1);
  // The visible pool (qualified, plus low-quality when revealed), then the
  // optional "real back-and-forth" filter (buyer replied after our reply).
  const inboundPool = inboundAll.filter((t) => t.qualified || showLowQ);
  const engagedCount = inboundPool.filter((t) => t.repliedAfterUs).length;
  const inboundShown = inboundPool
    .filter((t) => inboundView === "all" || t.repliedAfterUs)
    .sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1));
  // Section 2 — pitched 1:1 (our individual outreach). When the cold roster is
  // available (HubSpot), the mass/sequence pitches live in their own bucket below,
  // so the 1:1 section excludes them; without HubSpot, show all pitched threads.
  const cold = rep?.cold || null;
  const pitchedAll = threads.filter((t) => t.origin === "pitched");
  const pitched1on1 = pitchedAll
    .filter((t) => !cold || t.pitchKind !== "mass")
    .sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1));
  const pitchResponded = (t: DealThread) => (t.replies || 0) > 0 || t.repliedAfterUs;
  const pitch1RespondedCount = pitched1on1.filter(pitchResponded).length;
  const pitched1Shown = pitched1on1.filter((t) => pitchView === "all" || pitchResponded(t));
  const exercises = rep?.pitchExercises || [];

  const hsOn = rep?.pitchSource === "hubspot";
  const p1Opened = pitched1on1.filter((t) => (t.opens || 0) > 0).length;
  const p1Clicked = pitched1on1.filter((t) => (t.clicks || 0) > 0).length;
  const p1Replied = pitched1on1.filter((t) => (t.replies || 0) > 0).length;
  const p1Active = pitched1on1.filter((t) => t.active).length;

  // Section 3 — cold outreach (HubSpot sequences), full audience.
  const coldRows = (cold?.rows || []).filter((r) => coldView === "all" || (coldView === "responded" ? r.responded : !r.responded));

  return (
    <main>
      <div style={{ marginBottom: 6 }}>
        <a href="/reports/marketplace" style={{ color: CORAL, textDecoration: "none", fontSize: 13 }}>← Marketplace</a>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.4rem", margin: 0 }}>{domain}</h1>
        {rep?.sale && (
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: rep.sale.stage === "sold" ? "#2f7d4f" : CORAL, borderRadius: 999, padding: "2px 12px" }}>
            {rep.sale.stage === "sold" ? `Sold${rep.sale.closed ? ` · ${rep.sale.closed}` : ""}` : rep.sale.label}
          </span>
        )}
        {rep?.representingSince && <span className="muted" style={{ fontSize: 12 }}>Representing since {rep.representingSince}</span>}
        <button onClick={share} style={{ ...BTN, marginLeft: "auto" }} title="Copy a shareable link to this report">{copied ? "✓ Link copied" : "🔗 Share"}</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "12px 0 4px" }}>
        <span className="muted" style={{ fontSize: 12 }}>Window:</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={CTL}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {preset === "custom" && (
          <>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)} style={CTL} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)} style={CTL} />
            <button onClick={() => void load(false)} style={BTN} disabled={loading}>Apply</button>
          </>
        )}
        <button onClick={() => void load(true)} style={BTN} disabled={loading} title="Re-scan the mailboxes now (a few minutes)">↻ Regenerate</button>
        {loading && <span className="loading-pulse" style={{ fontSize: 12, color: CORAL }}>working…</span>}
        {!loading && data?.deals.generatedAt && <span className="muted" style={{ fontSize: 12 }}>updated {ago(data.deals.generatedAt)}</span>}
      </div>

      {msg && <p style={{ color: CORAL }}>{msg}</p>}
      {data?.deals.configured === false && <p className="muted">Gmail isn&apos;t configured on this deployment (GOOGLE_SA_KEY).</p>}
      {loading && !rep && <p className="loading-pulse" style={{ color: CORAL }}>Generating the activity report — scanning the deal mailboxes for this domain. This can take a few minutes the first time…</p>}

      <h2 style={{ fontSize: "1.18rem", margin: "16px 0 6px" }}>Traffic <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({range.from === range.to ? range.from : `${range.from} → ${range.to}`})</span></h2>
      {ga ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Visits" value={ga.views} /><StatCard label="Visitors" value={ga.users} />
          <StatCard label="Sessions" value={ga.sessions} /><StatCard label="Inquiries (GA)" value={ga.inquiries} accent />
        </div>
      ) : <p className="muted" style={{ fontSize: 13 }}>No GA traffic for this window.</p>}

      {rep && (
        <>
          <h2 style={{ fontSize: "1.18rem", margin: "20px 0 6px" }}>Deal activity <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(all-time · email{hsOn ? " + HubSpot" : ""})</span></h2>
          <NewsletterSection features={data?.newsletterFeatures || []} />

          {/* ───────── Bucket 1: Inbound ───────── */}
          <h3 style={{ fontSize: 16.5, margin: "22px 0 6px" }}>1 · Inbound inquiries &amp; negotiations <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— buyers who came to us</span></h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <AggCard label="Inbound inquiries" value={rep.inboundQualified} sub={`${rep.inbound} total incl. low-quality`} accent />
            <AggCard label="Responded after we did" value={rep.inboundEngaged} sub={`real back-and-forth of ${rep.inboundQualified}`} />
            <AggCard label="Active negotiations" value={rep.activeNegotiations} sub="live two-way (≤45d, not declined)" />
          </div>
          <SegToggle value={inboundView} onChange={setInboundView} options={[["all", `All (${inboundPool.length})`], ["engaged", `Responded after our reply (${engagedCount})`]]} />
          <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
            “Responded after our reply” = the buyer wrote back after we answered — a real two-way exchange, not just a submitted lead form.
          </p>
          {inboundShown.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>{inboundView === "engaged" ? "No buyers responded after our reply in this set." : "None."}</p> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={head}>Buyer</th><th style={head}>Offer</th><th style={head}>Status</th><th style={head}>Last activity</th><th style={{ ...head, width: "42%" }}>What happened</th></tr></thead>
                <tbody>
                  {inboundShown.map((t, i) => (
                    <tr key={i}>
                      <td style={cell}><div style={{ fontWeight: 600 }}>{t.party}</div>{t.partyEmail && <div className="muted" style={{ fontSize: 11 }}>{t.partyEmail}</div>}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {(t.offer || t.budget)
                          ? <span style={{ fontWeight: 600, color: NAVY }} title={t.offer ? "Buyer offer" : "Budget band (from the inquiry form)"}>{t.offer || t.budget}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td style={cell}><StatusBadge t={t} /></td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{t.last}<span className="muted" style={{ fontSize: 11 }}> · {t.messages} msg</span></td>
                      <td style={cell}>{t.outcome || <span className="muted">{t.lastSnippet || "—"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lowQ.length > 0 && (
            <button onClick={() => setShowLowQ((v) => !v)} className="field" style={{ marginTop: 8, padding: "4px 12px", fontSize: 12, cursor: "pointer" }}>
              {showLowQ ? "Hide" : "Show"} {lowQ.length} low-quality inquir{lowQ.length === 1 ? "y" : "ies"}
            </button>
          )}

          {/* ───────── Bucket 2: Pitched 1:1 ───────── */}
          <h3 style={{ fontSize: 16.5, margin: "28px 0 6px" }}>2 · Pitched 1:1 <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— individual outreach &amp; naming-exercise pitches</span></h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <AggCard label="People pitched 1:1" value={pitched1on1.length + exercises.length} sub={exercises.length ? `incl. ${exercises.length} naming-exercise` : "individual outreach"} accent />
            {hsOn && <><StatCard label="Opened" value={p1Opened} /><StatCard label="Clicked" value={p1Clicked} /><StatCard label="Replied" value={p1Replied} /></>}
            <StatCard label="Active" value={p1Active} />
          </div>
          {pitched1on1.length === 0 && exercises.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>None.</p> : null}
          {pitched1on1.length > 0 && (
            <>
              <SegToggle value={pitchView} onChange={setPitchView} options={[["all", `All (${pitched1on1.length})`], ["responded", `Responded (${pitch1RespondedCount})`]]} />
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr><th style={head}>Pitched to</th><th style={head}>{hsOn ? "Engagement" : "Type"}</th><th style={head}>Status</th><th style={head}>Last contact</th><th style={{ ...head, width: "38%" }}>What happened</th></tr></thead>
                  <tbody>
                    {pitched1Shown.map((t, i) => (
                      <tr key={i}>
                        <td style={cell}><div style={{ fontWeight: 600 }}>{t.party}</div>{t.partyEmail && <div className="muted" style={{ fontSize: 11 }}>{t.partyEmail}</div>}</td>
                        <td style={cell}>{hsOn ? <EngageCell opens={t.opens} clicks={t.clicks} replies={t.replies} /> : <PitchTypeChip kind={t.pitchKind} sequenceName={t.sequenceName} />}</td>
                        <td style={cell}><StatusBadge t={t} /></td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{t.last}<span className="muted" style={{ fontSize: 11 }}> · {t.messages} msg</span></td>
                        <td style={cell}>{t.outcome || <span className="muted">{t.lastSnippet || "—"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Naming-exercise pitches: this domain on a client's pitch sheet. */}
          {exercises.length > 0 && (
            <div style={{ marginTop: pitched1on1.length ? 14 : 4 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: NAVY, marginBottom: 6 }}>
                Naming-exercise pitches <span className="muted" style={{ fontWeight: 400 }}>· included in a client&apos;s curated domain shortlist</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr><th style={head}>Client</th><th style={head}>Exercise</th><th style={head}>Quote</th><th style={{ ...head, width: "42%" }}>Notes</th></tr></thead>
                  <tbody>
                    {exercises.map((e, i) => (
                      <tr key={i}>
                        <td style={cell}>
                          <span style={{ fontWeight: 600 }}>{e.client}</span>
                          {e.description && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{e.description}</div>}
                        </td>
                        <td style={cell}>
                          <a href={e.url} target="_blank" rel="noreferrer" style={{ color: CORAL, textDecoration: "none" }}>{e.sheetTitle || "(sheet ↗)"}</a>
                          {e.tab && <span className="muted" style={{ fontSize: 11 }}> · {e.tab}</span>}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{e.price || <span className="muted">—</span>}</td>
                        <td style={cell}>{e.note || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ───────── Bucket 3: Cold outreach (HubSpot sequences) ───────── */}
          {cold && (
            <>
              <h3 style={{ fontSize: 16.5, margin: "28px 0 6px" }}>3 · Cold outreach <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— HubSpot sequences (the cold campaign)</span></h3>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                <AggCard label="Recipients" value={cold.recipients} sub={`${fmt(cold.sends)} sends`} accent />
                <StatCard label="Opened" value={cold.opened} />
                <StatCard label="Clicked" value={cold.clicked} />
                <StatCard label="Replied" value={cold.replied} accent />
                <StatCard label="Active" value={cold.active} />
              </div>
              {cold.rows.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No cold sequence sends for this domain.</p> : (
                <>
                  <SegToggle
                    value={coldView}
                    onChange={setColdView}
                    options={[["all", `All (${cold.rows.length})`], ["responded", `Responded (${cold.rows.filter((r) => r.responded).length})`], ["noresp", `No response (${cold.rows.filter((r) => !r.responded).length})`]]}
                  />
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr>
                        <th style={head}>Recipient</th><th style={head}>Sends</th><th style={head}>Engagement</th>
                        <th style={head}>Status</th><th style={head}>Last sent</th><th style={{ ...head, width: "34%" }}>Sequence / outcome</th>
                      </tr></thead>
                      <tbody>
                        {coldRows.map((r, i) => (
                          <tr key={i}>
                            <td style={cell}><div style={{ fontWeight: 600 }}>{r.party}</div><div className="muted" style={{ fontSize: 11 }}>{r.email}</div></td>
                            <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.sends}</td>
                            <td style={cell}>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <MiniBadge on={r.opened} label="opened" color="#2f6f8a" />
                                <MiniBadge on={r.clicked} label="clicked" color="#8a6d3b" />
                                <MiniBadge on={r.replied} label="replied" color="#2f7d4f" />
                              </div>
                            </td>
                            <td style={cell}>
                              {r.active
                                ? <span style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, border: `1px solid ${CORAL}`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>Active</span>
                                : r.responded
                                  ? <span style={{ fontSize: 12.5, fontWeight: 700, color: "#2f7d4f", border: "1px solid #2f7d4f", borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>Responded</span>
                                  : <span className="muted" style={{ fontSize: 12 }}>No response</span>}
                            </td>
                            <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.lastSent}</td>
                            <td style={cell}>
                              {r.outcome ? <div>{r.outcome}</div> : null}
                              {r.offer && <div style={{ fontWeight: 600, color: NAVY, fontSize: 13 }}>{r.offer}</div>}
                              {r.sequenceName && <div className="muted" style={{ fontSize: 11, marginTop: r.outcome ? 3 : 0 }}>📋 {r.sequenceName}</div>}
                              {!r.outcome && !r.sequenceName && <span className="muted">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
      {!loading && !rep && data && <p className="muted" style={{ fontSize: 13 }}>No deal data.</p>}
    </main>
  );
}
