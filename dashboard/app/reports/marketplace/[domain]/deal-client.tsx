"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/marketplace-deals.ts + lib/ga.ts ListingRow + newsletter summary.
type SaleStatus = { stage: string; label: string; opened: string | null; closed: string | null; txn: string | null };
type DealThread = {
  subject: string; origin: "inbound" | "pitched"; active: boolean; stale: boolean; declined: boolean;
  hasForm: boolean; qualified: boolean; repliedAfterUs: boolean; spam: boolean; pitchKind: "mass" | "individual" | null;
  sequenceName: string | null;
  opens: number | null; clicks: number | null; replies: number | null;
  party: string; partyEmail: string | null;
  budget: string | null; offer: string | null; intent: string | null; outcome: string | null;
  quote: string | null; quoteKind: QuoteKind | null;
  messages: number; first: string; last: string; lastSnippet: string;
};
type QuoteKind = "interest" | "objection" | "price" | "praise" | "other";
type DealQuote = { text: string; kind: QuoteKind; party: string; attribution: string; origin: "inbound" | "pitched"; date: string; offer: string | null };
type PitchExercise = { client: string; description?: string | null; paused?: boolean; sheetTitle: string; tab: string; url: string; price: string | null; note: string | null };
type ColdRecipient = {
  party: string; email: string; sends: number; opened: boolean; clicked: boolean; replied: boolean;
  responded: boolean; chain: number; active: boolean; lastSent: string; sequenceName: string | null; outcome: string | null; offer: string | null;
};
type ColdOutreach = { recipients: number; sends: number; opened: number; clicked: number; replied: number; responded: number; active: number; rows: ColdRecipient[] };
type OfferRow = { party: string; email: string | null; amount: string; amountNum: number; kind: "offer" | "budget"; date: string; origin: "inbound" | "pitched"; outcome: string | null };
type DealReport = {
  domain: string; inbound: number; inboundQualified: number; inboundEngaged: number; activeNegotiations: number;
  pitched: number; pitchedMass: number; pitchedIndividual: number; pitchSource?: "hubspot" | "heuristic";
  cold: ColdOutreach | null; offers: OfferRow[]; highlights: DealQuote[]; pitchExercises: PitchExercise[];
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

function StatCard({ label, value, accent, onClick, hint }: { label: string; value: number; accent?: boolean; onClick?: () => void; hint?: string }) {
  return (
    <div
      onClick={onClick}
      title={onClick ? hint || "Click to break down" : undefined}
      style={{ border: `1px solid ${onClick ? "#d8d0bf" : "#e3ddcf"}`, borderRadius: 10, padding: "12px 16px", minWidth: 120, flex: "1 1 120px", cursor: onClick ? "pointer" : "default" }}
    >
      <div style={{ fontSize: 30, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>{label}{onClick && <span style={{ color: CORAL }}> ›</span>}</div>
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

const QUOTE_KIND: Record<QuoteKind, { label: string; color: string }> = {
  interest: { label: "Interest", color: "#2f7d4f" },
  objection: { label: "Objection", color: "#b8741f" },
  price: { label: "On price", color: CORAL },
  praise: { label: "Praise", color: "#2f7d4f" },
  other: { label: "Feedback", color: NAVY },
};
function QuoteCard({ q }: { q: DealQuote }) {
  const k = QUOTE_KIND[q.kind] || QUOTE_KIND.other;
  return (
    <div style={{ border: "1px solid #e3ddcf", borderLeft: `4px solid ${k.color}`, borderRadius: 8, padding: "12px 14px", background: "#fbf8ef" }}>
      <div style={{ fontSize: 10, letterSpacing: 1, fontWeight: 700, color: k.color, textTransform: "uppercase" }}>{k.label}</div>
      <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 14.5, fontStyle: "italic", color: NAVY, lineHeight: 1.4, margin: "5px 0 8px" }}>&ldquo;{q.text}&rdquo;</div>
      <div className="muted" style={{ fontSize: 12 }}>
        — {q.party && q.party !== "—" ? q.party : q.attribution}
        <span style={{ opacity: 0.7 }}> · {q.attribution}{q.date ? ` · ${q.date}` : ""}</span>
      </div>
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
  const [inboundView, setInboundView] = useState<"all" | "engaged" | "spam">("all");
  const [pitchView, setPitchView] = useState<"all" | "responded">("all");
  const [coldView, setColdView] = useState<"all" | "responded" | "noresp">("all");
  const [copied, setCopied] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genDoc, setGenDoc] = useState<{ docUrl: string; folderUrl: string } | null>(null);
  const [genErr, setGenErr] = useState("");
  // Broker notes (off-platform activity) — loaded per-domain, saved on demand,
  // folded into the generated client Doc.
  const [notes, setNotes] = useState("");
  const [notesSavedAt, setNotesSavedAt] = useState<string | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  // Generate the client-facing Google Doc (live data → branded Doc in the
  // per-domain Drive subfolder, timestamped — never overwrites a prior version).
  const generateDoc = async () => {
    setGenBusy(true); setGenErr(""); setGenDoc(null);
    try {
      const res = await fetch("/api/admin/marketplace/report-doc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, from: range.from, to: range.to }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `Failed (${res.status})`);
      setGenDoc({ docUrl: j.docUrl, folderUrl: j.folderUrl });
      window.open(j.docUrl, "_blank", "noopener");
    } catch (e) {
      setGenErr(String((e as Error)?.message || e));
    } finally {
      setGenBusy(false);
    }
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

  // Load the saved broker notes for this domain (independent of the date range).
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/marketplace/notes?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
        const j = await res.json();
        if (!cancel && res.ok && j.ok) { setNotes(j.notes || ""); setNotesSavedAt(j.updatedAt || null); setNotesDirty(false); }
      } catch { /* notes are optional */ }
    })();
    return () => { cancel = true; };
  }, [domain]);

  const saveNotes = async () => {
    setNotesSaving(true);
    try {
      const res = await fetch("/api/admin/marketplace/notes", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain, notes }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `Failed (${res.status})`);
      setNotesSavedAt(j.updatedAt || new Date().toISOString());
      setNotesDirty(false);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setNotesSaving(false);
    }
  };

  const rep = data?.deals.report;
  const ga = data?.ga;
  const nl = data?.newsletter;
  const threads = rep?.threads || [];

  // Section 1 — inbound inquiries & negotiations (active first, then recency).
  // Probable spam (unrelated dead-end form junk) is split off into its own filter.
  const inboundAll = threads.filter((t) => t.origin === "inbound");
  const spamList = inboundAll.filter((t) => t.spam);
  const inboundReal = inboundAll.filter((t) => !t.spam);
  const lowQ = inboundReal.filter((t) => !t.qualified);
  const rank = (t: DealThread) => (t.active ? 0 : t.declined ? 2 : t.stale ? 3 : 1);
  // The visible pool (qualified, plus low-quality when revealed), then the
  // optional "real back-and-forth" filter (buyer replied after our reply).
  const inboundPool = inboundReal.filter((t) => t.qualified || showLowQ);
  const engagedCount = inboundPool.filter((t) => t.repliedAfterUs).length;
  const bySort = (a: DealThread, b: DealThread) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1);
  const inboundShown = (inboundView === "spam" ? spamList : inboundPool.filter((t) => inboundView === "all" || t.repliedAfterUs)).slice().sort(bySort);
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
  // Section 2 engagement (opens/clicks) only exists for 1:1 sends actually logged
  // in HubSpot. Many 1:1 pitches are plain Gmail (never logged), so show the
  // engagement cards/column ONLY when HubSpot has data for someone here — never
  // imply tracked metrics that don't exist (all-zeros).
  const p1HasEngagement = pitched1on1.some((t) => t.opens != null || t.clicks != null || t.replies != null);
  const p1Opened = pitched1on1.filter((t) => (t.opens || 0) > 0).length;
  const p1Clicked = pitched1on1.filter((t) => (t.clicks || 0) > 0).length;
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
        <button onClick={() => void generateDoc()} disabled={genBusy} style={{ ...BTN, borderColor: CORAL, color: CORAL, fontWeight: 700 }} title="Generate a branded client activity report as a Google Doc (saved to the Drive folder)">{genBusy ? "Generating…" : "📄 Generate client report"}</button>
      </div>
      {(genDoc || genErr || genBusy) && (
        <div style={{ fontSize: 12.5, margin: "2px 0 0" }}>
          {genBusy && <span className="loading-pulse" style={{ color: CORAL }}>Building the Google Doc — pulling live activity, this can take a moment…</span>}
          {genErr && <span style={{ color: CORAL }}>Report error: {genErr}</span>}
          {genDoc && !genBusy && (
            <span>✓ Doc created — <a href={genDoc.docUrl} target="_blank" rel="noreferrer" style={{ color: CORAL, fontWeight: 600 }}>open it ↗</a> · <a href={genDoc.folderUrl} target="_blank" rel="noreferrer" style={{ color: NAVY }}>domain folder ↗</a> <span className="muted">(saved as a new dated version)</span></span>
          )}
        </div>
      )}

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

          {/* Firm offers received */}
          {(rep.offers || []).length > 0 && (
            <div style={{ margin: "6px 0 4px" }}>
              <h3 style={{ fontSize: 16.5, margin: "10px 0 4px" }}>💰 Offers received <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— offers &amp; stated budgets (≥ $1k); prune low ones in the doc</span></h3>
              <div style={{ height: 2, background: `linear-gradient(90deg, ${CORAL}, transparent)`, borderRadius: 2, margin: "0 0 10px" }} />
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr><th style={head}>From</th><th style={head}>Offer / budget</th><th style={head}>Date</th><th style={head}>Source</th><th style={{ ...head, width: "40%" }}>What happened</th></tr></thead>
                  <tbody>
                    {rep.offers.map((o, i) => (
                      <tr key={i}>
                        <td style={cell}><div style={{ fontWeight: 600 }}>{o.party}</div>{o.email && <div className="muted" style={{ fontSize: 11 }}>{o.email}</div>}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}><span style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 700, fontSize: 18, color: CORAL }}>{o.amount}</span>{o.kind === "budget" && <div className="muted" style={{ fontSize: 10 }}>stated budget</div>}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{o.date}</td>
                        <td style={cell}><span style={{ fontSize: 12, color: o.origin === "inbound" ? "#2f7d4f" : "#5a4ec0" }}>{o.origin === "inbound" ? "Inbound" : "Pitched"}</span></td>
                        <td style={cell}>{o.outcome || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Conversation highlights — verbatim buyer/prospect pull-quotes */}
          {(rep.highlights || []).length > 0 && (
            <div style={{ margin: "16px 0 4px" }}>
              <h3 style={{ fontSize: 16.5, margin: "10px 0 4px" }}>💬 In their own words <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— verbatim from conversations (curate before sending to a client)</span></h3>
              <div style={{ height: 2, background: `linear-gradient(90deg, ${CORAL}, transparent)`, borderRadius: 2, margin: "0 0 10px" }} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
                {rep.highlights.map((q, i) => <QuoteCard key={i} q={q} />)}
              </div>
            </div>
          )}

          <NewsletterSection features={data?.newsletterFeatures || []} />

          {/* ───────── Bucket 1: Inbound ───────── */}
          <h3 style={{ fontSize: 16.5, margin: "22px 0 6px" }}>1 · Inbound inquiries &amp; negotiations <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— buyers who came to us</span></h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <AggCard label="Inbound inquiries" value={rep.inboundQualified} sub={`${rep.inbound} total incl. low-quality`} accent />
            <AggCard label="Responded after we did" value={rep.inboundEngaged} sub={`real back-and-forth of ${rep.inboundQualified}`} />
            <AggCard label="Active negotiations" value={rep.activeNegotiations} sub="live two-way (≤45d, not declined)" />
          </div>
          <SegToggle
            value={inboundView}
            onChange={setInboundView}
            options={[
              ["all", `All (${inboundPool.length})`],
              ["engaged", `Responded after our reply (${engagedCount})`],
              ...(spamList.length ? [["spam", `Probable spam (${spamList.length})`] as [typeof inboundView, string]] : []),
            ]}
          />
          <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
            {inboundView === "spam"
              ? "Probable spam — dead-end form submissions whose message is unrelated to buying a domain. Excluded from the counts above."
              : "“Responded after our reply” = the buyer wrote back after we answered — a real two-way exchange, not just a submitted lead form."}
          </p>
          {inboundShown.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>{inboundView === "engaged" ? "No buyers responded after our reply in this set." : inboundView === "spam" ? "No probable spam." : "None."}</p> : (
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
            {p1HasEngagement && <><StatCard label="Opened" value={p1Opened} /><StatCard label="Clicked" value={p1Clicked} /></>}
            <StatCard label="Responded" value={pitch1RespondedCount} hint="People who replied — click to see who" onClick={() => setPitchView("responded")} />
            <StatCard label="Active" value={p1Active} />
          </div>
          {pitched1on1.length === 0 && exercises.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>None.</p> : null}
          {pitched1on1.length > 0 && (
            <>
              <SegToggle value={pitchView} onChange={setPitchView} options={[["all", `All (${pitched1on1.length})`], ["responded", `Responded (${pitch1RespondedCount})`]]} />
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr><th style={head}>Pitched to</th>{p1HasEngagement && <th style={head}>Engagement</th>}{!p1HasEngagement && !cold && <th style={head}>Type</th>}<th style={head}>Status</th><th style={head}>Last contact</th><th style={{ ...head, width: "38%" }}>What happened</th></tr></thead>
                  <tbody>
                    {pitched1Shown.map((t, i) => (
                      <tr key={i}>
                        <td style={cell}><div style={{ fontWeight: 600 }}>{t.party}</div>{t.partyEmail && <div className="muted" style={{ fontSize: 11 }}>{t.partyEmail}</div>}</td>
                        {p1HasEngagement && <td style={cell}><EngageCell opens={t.opens} clicks={t.clicks} replies={t.replies} /></td>}
                        {!p1HasEngagement && !cold && <td style={cell}><PitchTypeChip kind={t.pitchKind} sequenceName={t.sequenceName} /></td>}
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
                          <span style={{ fontWeight: 600, color: e.paused ? "#8a8275" : NAVY }}>{e.client}</span>
                          {e.paused && <span title="Engagement paused / past in the index" style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "#8a8275", border: "1px solid #cfc7b6", borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" }}>Past</span>}
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
                <StatCard label="Responded" value={cold.responded} accent hint="Unique people who replied — click to see who" onClick={() => setColdView("responded")} />
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
                        <th style={head}>Status</th><th style={head}>Last sent</th><th style={{ ...head, width: "36%" }}>Result</th>
                      </tr></thead>
                      <tbody>
                        {coldRows.map((r, i) => (
                          <tr key={i}>
                            <td style={cell}><div style={{ fontWeight: 600 }}>{r.party}</div><div className="muted" style={{ fontSize: 11 }}>{r.email}</div></td>
                            <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.sends}</td>
                            <td style={cell}>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <MiniBadge on={r.opened} label="opened" color="#2f6f8a" />
                                <MiniBadge on={r.clicked} label="clicked" color="#8a6d3b" />
                                <MiniBadge on={r.replied} label="replied" color="#2f7d4f" />
                                {r.responded && r.chain > 1 && <span title="Emails in the back-and-forth" style={{ fontSize: 11, color: NAVY, fontWeight: 600, whiteSpace: "nowrap" }}>💬 {r.chain} in chain</span>}
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
                              {r.outcome
                                ? <div style={{ fontWeight: r.responded ? 600 : 400, color: r.responded ? NAVY : "var(--muted,#857c6c)" }}>{r.outcome}</div>
                                : <span className="muted">No response</span>}
                              {r.offer && <div style={{ fontWeight: 700, color: CORAL, fontSize: 13, marginTop: 2 }}>{r.offer}</div>}
                              {r.sequenceName && <div className="muted" style={{ fontSize: 10.5, marginTop: 3, opacity: .8 }}>via {r.sequenceName}</div>}
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

      {/* Broker notes — off-platform activity (text/WhatsApp/phone offers, verbal
          context). Saved per domain and folded into the generated client Doc. */}
      <div style={{ marginTop: 30, paddingTop: 18, borderTop: "1px solid #e3ddcf" }}>
        <h3 style={{ fontSize: 16.5, margin: "0 0 4px" }}>📝 Notes <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— off-platform activity (text / WhatsApp / phone offers, context). Saved per domain &amp; included in the generated client report.</span></h3>
        <textarea
          value={notes}
          onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
          placeholder="e.g. Buyer offered $40k over WhatsApp on Jun 12 — we countered at $75k, awaiting reply. Verbal interest from a fintech founder by phone. Owner wants to hold above $60k."
          rows={6}
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5, borderRadius: 10, border: `1px solid ${notesDirty ? CORAL : "#d8d0bf"}`, fontFamily: "inherit", resize: "vertical", color: NAVY }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <button onClick={() => void saveNotes()} disabled={notesSaving || !notesDirty} style={{ ...BTN, borderColor: CORAL, color: notesDirty ? CORAL : "#9a9486", fontWeight: 700, cursor: notesDirty ? "pointer" : "default" }}>{notesSaving ? "Saving…" : notesDirty ? "Save notes" : "Saved"}</button>
          {notesDirty
            ? <span style={{ fontSize: 12, color: CORAL }}>Unsaved changes</span>
            : notesSavedAt && <span className="muted" style={{ fontSize: 12 }}>Last saved {ago(notesSavedAt)}</span>}
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 7 }}>ℹ️ Saved notes are included in the generated client report — shown verbatim in a “Notes &amp; off-platform activity” section, and factored into the drafted executive summary.</p>
      </div>
    </main>
  );
}
