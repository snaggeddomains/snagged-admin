"use client";

import { useEffect, useRef, useState } from "react";

type Turn = { q: string; a?: string; tools?: string[]; error?: string; loading?: boolean };

const STORE_KEY = "snagged_chat_history";

const SUGGESTIONS = [
  "How many email signups last week, and did a campaign drive it?",
  "Revenue this month — upfront vs success fees?",
  "Which channels drove the most leads on the core site in the last 30 days?",
  "Top search queries hitting the homepage this month",
];

export default function ChatClient({ configured }: { configured: boolean }) {
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => {
    if (typeof window === "undefined") return [];
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? (JSON.parse(raw) as Turn[]).filter((t) => !t.loading) : []; } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);
  // Persist the transcript so it survives navigating away and back.
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(turns.filter((t) => !t.loading))); } catch { /* ignore */ }
  }, [turns]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    const idx = turns.length;
    const history = turns.filter((t) => t.a).map((t) => ({ q: t.q, a: t.a as string }));
    setTurns((t) => [...t, { q: question, loading: true }]);
    setQ("");
    try {
      const res = await fetch("/api/admin/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, history }) });
      const data = await res.json();
      if (data.configured === false) { setTurns((t) => t.map((x, i) => (i === idx ? { ...x, loading: false, error: data.error } : x))); return; }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, loading: false, a: data.answer, tools: data.toolsUsed } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, loading: false, error: String((e as Error).message || e) } : x)));
    } finally { setBusy(false); }
  }

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Chat analytics</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Ask anything about the business in plain English. The assistant pulls from Google Analytics, Search Console, email,
        revenue, and live opportunities to answer — only with real numbers from those sources.
      </p>
      {!configured && <p style={{ fontSize: 13, color: "var(--coral-deep, #c0492f)" }}>Not configured — set <code>ANTHROPIC_API_KEY</code> in the project env.</p>}

      {turns.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button onClick={() => { setTurns([]); try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }} style={{ fontSize: 12 }}>Clear conversation</button>
        </div>
      )}

      <div style={{ margin: "18px 0", display: "flex", flexDirection: "column", gap: 16 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ borderLeft: "3px solid #e3ddcf", paddingLeft: 12 }}>
            <div style={{ fontWeight: 700, color: "var(--navy, #254254)" }}>{t.q}</div>
            {t.loading ? <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>Thinking…</div>
              : t.error ? <div style={{ fontSize: 14, marginTop: 4, color: "var(--coral-deep, #c0492f)" }}>{t.error}</div>
                : (
                  <div style={{ fontSize: 14, marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                    {t.a}
                    {t.tools && t.tools.length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>via {[...new Set(t.tools)].join(", ")}</div>}
                  </div>
                )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {turns.length === 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy || !configured} style={{ fontSize: 12.5, padding: "6px 11px", borderRadius: 999, border: "1px solid #e3ddcf", background: "#fff", cursor: "pointer", color: "var(--navy, #254254)" }}>{s}</button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} style={{ display: "flex", gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about signups, leads, revenue, traffic, SEO…" disabled={busy || !configured} className="field" style={{ flex: 1, fontSize: 14, padding: "9px 12px" }} />
        <button type="submit" disabled={busy || !configured || !q.trim()} className="btn btn--navy">{busy ? "…" : "Ask"}</button>
      </form>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>The conversation has memory (follow-ups work) and persists across tabs on this device. Answers use live report data — double-check anything you act on.</p>
    </main>
  );
}
