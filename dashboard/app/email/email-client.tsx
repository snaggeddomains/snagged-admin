"use client";

import { useCallback, useState } from "react";

type ThreadHit = {
  mailbox: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: number;
  snippet: string;
};
type Msg = {
  id: string;
  from: string;
  fromName: string;
  to: string;
  date: number;
  subject: string;
  body: string;
};

const NAVY = "#254254";
const CORAL = "#e8735f";

function rel(ts: number): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const day = 86400000;
  if (d < day) return "today";
  if (d < 2 * day) return "yesterday";
  if (d < 30 * day) return `${Math.round(d / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function EmailClient() {
  const [q, setQ] = useState("");
  const [threads, setThreads] = useState<ThreadHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");

  const [active, setActive] = useState<ThreadHit | null>(null);
  const [subject, setSubject] = useState("");
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const [instruction, setInstruction] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const search = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    setErr("");
    setThreads(null);
    setActive(null);
    setMessages(null);
    setDraft("");
    try {
      const res = await fetch(`/api/admin/email?action=search&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setThreads(data.threads || []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setThreads([]);
    } finally {
      setSearching(false);
    }
  }, [q]);

  const openThread = useCallback(async (t: ThreadHit) => {
    setActive(t);
    setMessages(null);
    setSubject(t.subject);
    setDraft("");
    setInstruction("");
    setLoadingThread(true);
    setErr("");
    try {
      const res = await fetch(
        `/api/admin/email?action=thread&mailbox=${encodeURIComponent(t.mailbox)}&thread_id=${encodeURIComponent(t.threadId)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load thread");
      setSubject(data.subject || t.subject);
      setMessages(data.messages || []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  const makeDraft = useCallback(async () => {
    if (!active) return;
    setDrafting(true);
    setErr("");
    setDraft("");
    try {
      const res = await fetch(`/api/admin/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "draft", mailbox: active.mailbox, thread_id: active.threadId, instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft failed");
      setDraft(data.draft || "");
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setDrafting(false);
    }
  }, [active, instruction]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }, [draft]);

  const card: React.CSSProperties = { border: "1px solid #e4e8ec", borderRadius: 10, background: "#fff" };

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 4px 40px" }}>
      <h1 style={{ fontSize: "1.35rem", color: NAVY, margin: "4px 0 2px" }}>Email</h1>
      <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
        Search the deal inbox for a thread (a domain, a name, or keywords), then draft a reply with AI grounded in
        the thread. Draft-only — nothing is sent; copy it into your mail client.
      </p>

      {/* Search bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="Search inbox — e.g. giggle.com, John Smith, offer"
          style={{ flex: 1, padding: "9px 12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14 }}
        />
        <button
          type="button"
          onClick={search}
          disabled={searching || !q.trim()}
          style={{ padding: "9px 18px", border: "none", borderRadius: 8, background: NAVY, color: "#fff", fontWeight: 600, cursor: "pointer" }}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {err && (
        <div style={{ background: "#fdecea", color: "#a4271a", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: active ? "minmax(240px, 320px) 1fr" : "1fr", gap: 16, alignItems: "start" }}>
        {/* Thread list */}
        <div style={{ ...card, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #eef1f4", fontSize: 12, fontWeight: 600, color: "#6b7681" }}>
            {threads == null ? "Results" : `${threads.length} thread${threads.length === 1 ? "" : "s"}`}
          </div>
          {threads == null && !searching && (
            <div className="muted" style={{ padding: 16, fontSize: 13 }}>Search to find a thread.</div>
          )}
          {threads != null && threads.length === 0 && !searching && (
            <div className="muted" style={{ padding: 16, fontSize: 13 }}>No matching threads.</div>
          )}
          {(threads || []).map((t) => {
            const on = active?.mailbox === t.mailbox && active?.threadId === t.threadId;
            return (
              <button
                key={`${t.mailbox}:${t.threadId}`}
                type="button"
                onClick={() => openThread(t)}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                  border: "none", borderBottom: "1px solid #f0f3f5", background: on ? "#f2f7fa" : "transparent",
                  borderLeft: on ? `3px solid ${CORAL}` : "3px solid transparent", cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 600, color: NAVY, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.subject || "(no subject)"}
                </div>
                <div style={{ fontSize: 12, color: "#6b7681", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.fromName || t.from} · {rel(t.date)} · <span style={{ color: "#9aa5ad" }}>{t.mailbox}</span>
                </div>
                <div style={{ fontSize: 12, color: "#8a939b", marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {t.snippet}
                </div>
              </button>
            );
          })}
        </div>

        {/* Thread view + draft */}
        {active && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ ...card, padding: 14 }}>
              <div style={{ fontWeight: 700, color: NAVY, marginBottom: 8 }}>{subject || "(no subject)"}</div>
              {loadingThread && <div className="muted" style={{ fontSize: 13 }}>Loading thread…</div>}
              {!loadingThread && messages && (
                <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
                  {messages.map((m) => (
                    <div key={m.id} style={{ borderTop: "1px solid #f0f3f5", paddingTop: 8 }}>
                      <div style={{ fontSize: 12, color: "#6b7681", marginBottom: 3 }}>
                        <strong style={{ color: NAVY }}>{m.fromName || m.from}</strong> · {new Date(m.date).toLocaleString()}
                      </div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "#33414b", lineHeight: 1.45 }}>
                        {m.body.slice(0, 4000)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ ...card, padding: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7681", marginBottom: 6 }}>
                What should the reply do?
              </label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder='e.g. Acknowledge they said they don&apos;t want to sell, mention I have a $50k offer, and ask if now is a better time.'
                rows={3}
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14, resize: "vertical", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={makeDraft}
                  disabled={drafting || loadingThread}
                  style={{ padding: "9px 18px", border: "none", borderRadius: 8, background: CORAL, color: "#fff", fontWeight: 600, cursor: "pointer" }}
                >
                  {drafting ? "Drafting…" : draft ? "Re-draft" : "✨ Draft reply"}
                </button>
                {draft && (
                  <button
                    type="button"
                    onClick={copy}
                    style={{ padding: "9px 16px", border: `1px solid ${NAVY}`, borderRadius: 8, background: "#fff", color: NAVY, fontWeight: 600, cursor: "pointer" }}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                )}
              </div>

              {draft && (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={12}
                  style={{ width: "100%", marginTop: 12, padding: "12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14, lineHeight: 1.5, resize: "vertical", fontFamily: "inherit", background: "#fbfcfd" }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
