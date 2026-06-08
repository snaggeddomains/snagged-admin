"use client";

// Lightweight, dependency-free chart primitives for the Site Analytics report —
// horizontal bar lists + an SVG trend area chart. Pure inline SVG/CSS so we don't
// pull a charting library into the bundle. Colors come from the app's CSS vars.

const NAVY = "var(--navy, #254254)";
const CORAL = "var(--coral-deep, #c0492f)";
const TRACK = "#efeadf"; // bar background

const fmt = (n: number) => n.toLocaleString();
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

export type Bar = { label: string; value: number; href?: string };

// A ranked horizontal bar list — label · bar · value, scaled to the max. Good for
// channels, sources, top pages, self-reported source, budget/intent mixes.
export function BarList({
  rows, color = NAVY, max, empty = "No data in this window.", showShare = false, money = false,
}: { rows: Bar[]; color?: string; max?: number; empty?: string; showShare?: boolean; money?: boolean }) {
  if (!rows.length) return <p className="muted" style={{ fontSize: 13, margin: "6px 0" }}>{empty}</p>;
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(80px, 160px) 1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.label}>
            {r.href ? <a href={r.href} target="_blank" rel="noreferrer">{r.label}</a> : r.label}
          </span>
          <span style={{ position: "relative", height: 16, background: TRACK, borderRadius: 5, overflow: "hidden" }}>
            <span style={{ position: "absolute", insetBlock: 0, left: 0, width: `${Math.max(2, Math.round((r.value / top) * 100))}%`, background: color, borderRadius: 5 }} />
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: 44, textAlign: "right" }}>
            {money ? usd(r.value) : fmt(r.value)}
            {showShare && total > 0 && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> · {Math.round((r.value / total) * 100)}%</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

type TrendPoint = { date: string; sessions: number; pageviews?: number };

// An SVG area+line chart of sessions over the window, with an optional pageviews
// line. Scales to container width via viewBox. Bare-bones but readable.
export function TrendChart({ data, height = 130, labels = ["Sessions", "Pageviews"] }: { data: TrendPoint[]; height?: number; labels?: [string, string] }) {
  if (!data.length) return <p className="muted" style={{ fontSize: 13 }}>No data in this window.</p>;
  const W = 760, H = height, padX = 6, padTop = 10, padBot = 18;
  const max = Math.max(1, ...data.map((d) => Math.max(d.sessions, d.pageviews ?? 0)));
  const nP = data.length;
  const x = (i: number) => (nP <= 1 ? W / 2 : padX + (i / (nP - 1)) * (W - 2 * padX));
  const y = (v: number) => padTop + (1 - v / max) * (H - padTop - padBot);
  const path = (key: "sessions" | "pageviews") =>
    data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key] ?? 0).toFixed(1)}`).join(" ");
  const sessionsLine = path("sessions");
  const hasViews = data.some((d) => typeof d.pageviews === "number");
  const area = `${sessionsLine} L${x(nP - 1).toFixed(1)},${(H - padBot).toFixed(1)} L${x(0).toFixed(1)},${(H - padBot).toFixed(1)} Z`;
  const first = data[0].date, last = data[nP - 1].date;
  const peak = data.reduce((a, b) => (b.sessions > a.sessions ? b : a), data[0]);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Sessions trend">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={NAVY} stopOpacity="0.18" />
            <stop offset="100%" stopColor={NAVY} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#trendFill)" />
        {hasViews && <path d={path("pageviews")} fill="none" stroke="#b9b09a" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        <path d={sessionsLine} fill="none" stroke={NAVY} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {nP > 1 && <circle cx={x(data.indexOf(peak))} cy={y(peak.sessions)} r="3" fill={CORAL} />}
      </svg>
      <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 2 }}>
        <span>{first}</span>
        <span>peak {fmt(peak.sessions)} {labels[0].toLowerCase()} · {peak.date}</span>
        <span>{last}</span>
      </div>
      {hasViews && (
        <div style={{ display: "flex", gap: 14, fontSize: 11, marginTop: 4 }}>
          <Legend color={NAVY} label={labels[0]} />
          <Legend color="#b9b09a" label={labels[1]} dashed />
        </div>
      )}
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} className="muted">
      <span style={{ width: 14, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }} />
      {label}
    </span>
  );
}

export type Step = { name: string; users: number };

// A descending funnel: each step is a bar scaled to the first step, annotated with
// step-to-step conversion %. For the blog → main site → submission path.
export function FunnelChart({ steps, empty = "Funnel data unavailable for this window." }: { steps: Step[]; empty?: string }) {
  if (!steps.length || steps[0].users === 0) return <p className="muted" style={{ fontSize: 13 }}>{empty}</p>;
  const top = steps[0].users;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {steps.map((st, i) => {
        const prev = i > 0 ? steps[i - 1].users : null;
        const conv = prev && prev > 0 ? Math.round((st.users / prev) * 100) : null;
        return (
          <div key={st.name}>
            {i > 0 && (
              <div className="muted" style={{ fontSize: 11, padding: "1px 0 3px 2px" }}>
                ↓ {conv}% continued{prev ? ` (${(prev - st.users).toLocaleString()} dropped off)` : ""}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 200px) 1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
              <span>{i + 1}. {st.name}</span>
              <span style={{ position: "relative", height: 22, background: TRACK, borderRadius: 5, overflow: "hidden" }}>
                <span style={{ position: "absolute", insetBlock: 0, left: 0, width: `${Math.max(2, Math.round((st.users / top) * 100))}%`, background: i === steps.length - 1 ? CORAL : NAVY, borderRadius: 5 }} />
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, minWidth: 52, textAlign: "right" }}>{st.users.toLocaleString()}</span>
            </div>
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>Active users, ordered path over the selected window.</p>
    </div>
  );
}
