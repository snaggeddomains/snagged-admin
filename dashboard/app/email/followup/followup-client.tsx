"use client";

import { useCallback, useEffect, useState } from "react";
import SnippetsPanel from "../snippets-panel";

type ThreadHit = { mailbox: string; threadId: string; subject: string; from: string; fromName: string; date: number; snippet: string };
type Msg = { id: string; from: string; fromName: string; to: string; date: number; subject: string; body: string };
type Note = { id: string; title: string; createdAt: number; attendees: string[]; matched: boolean; search?: string };

const NAVY = "#254254";
const CORAL = "#e8735f";
const OUR = /@snagged\.(com|co)$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function rel(ts: number): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const day = 86400000;
  if (d < day) return "today";
  if (d < 2 * day) return "yesterday";
  if (d < 30 * day) return `${Math.round(d / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}
// Counterparty emails in a thread = every address that isn't one of our deal mailboxes.
function counterpartyEmails(msgs: Msg[]): string[] {
  const out = new Set<string>();
  for (const m of msgs) {
    for (const raw of `${m.from} ${m.to}`.match(EMAIL_RE) || []) {
      const e = raw.toLowerCase();
      if (!OUR.test(e)) out.add(e);
    }
  }
  return [...out];
}

export default function FollowupClient() {
  const [q, setQ] = useState("");
  const [threads, setThreads] = useState<ThreadHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");

  const [active, setActive] = useState<ThreadHit | null>(null);
  const [subject, setSubject] = useState("");
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const [notes, setNotes] = useState<Note[] | null>(null);
  const [notesErr, setNotesErr] = useState("");
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [noteId, setNoteId] = useState("");
  const [noteQuery, setNoteQuery] = useState("");

  const [instruction, setInstruction] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  // Load recent Granola meetings. `match` (counterparty emails) floats+pre-selects the meeting whose
  // attendees match an attached thread; with no match it's just the recent list (thread-less flow).
  const loadNotes = useCallback(async (match: string[]) => {
    setLoadingNotes(true); setNotesErr("");
    try {
      const res = await fetch(`/api/admin/email/followup?action=notes&match=${encodeURIComponent(match.join(","))}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load meetings");
      const list: Note[] = data.notes || [];
      setNotes(list);
      const auto = list.find((n) => n.matched);
      // Only auto-select the attendee-matched meeting when NOTHING is picked yet — never clobber a
      // manual selection when the list re-ranks (e.g. after attaching a thread).
      if (auto) setNoteId((cur) => cur || auto.id);
    } catch (e) {
      setNotesErr(String((e as Error)?.message || e)); setNotes([]);
    } finally {
      setLoadingNotes(false);
    }
  }, []);

  // Meetings load up front so you can draft purely from a call, no email thread needed.
  useEffect(() => { loadNotes([]); }, [loadNotes]);

  const search = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setSearching(true); setErr(""); setThreads(null);
    try {
      const res = await fetch(`/api/admin/email?action=search&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setThreads(data.threads || []);
    } catch (e) {
      setErr(String((e as Error)?.message || e)); setThreads([]);
    } finally {
      setSearching(false);
    }
  }, [q]);

  const openThread = useCallback(async (t: ThreadHit) => {
    setActive(t); setMessages(null); setSubject(t.subject); setDraft(""); setLoadingThread(true); setErr("");
    try {
      const res = await fetch(`/api/admin/email?action=thread&mailbox=${encodeURIComponent(t.mailbox)}&thread_id=${encodeURIComponent(t.threadId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load thread");
      setSubject(data.subject || t.subject);
      const msgs: Msg[] = data.messages || [];
      setMessages(msgs);
      loadNotes(counterpartyEmails(msgs)); // re-rank meetings by this thread's counterparty
    } catch (e) {
      setErr(String((e as Error)?.message || e)); setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }, [loadNotes]);

  const detachThread = useCallback(() => {
    setActive(null); setMessages(null); setSubject(""); setDraft("");
    loadNotes([]); // drop the stale ✓ match flags
  }, [loadNotes]);

  const makeDraft = useCallback(async () => {
    setDrafting(true); setErr(""); setDraft("");
    try {
      const res = await fetch(`/api/admin/email/followup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "draft",
          mailbox: active?.mailbox || "",
          thread_id: active?.threadId || "",
          note_id: noteId,
          instruction,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft failed");
      setDraft(data.draft || "");
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setDrafting(false);
    }
  }, [active, noteId, instruction]);

  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }, [draft]);
  useEffect(() => { setCopied(false); }, [draft]);

  // Insert a snippet's language into the brief (append with spacing).
  const insertSnippet = useCallback((text: string) => {
    setInstruction((cur) => (cur.trim() ? `${cur.trim()}\n\n${text}` : text));
  }, []);

  const card: React.CSSProperties = { border: "1px solid #e4e8ec", borderRadius: 10, background: "#fff" };
  const showList = threads != null;
  const canDraft = !!(noteId || active || instruction.trim());

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "8px 4px 40px" }}>
      <h1 style={{ fontSize: "1.35rem", color: NAVY, margin: "4px 0 2px" }}>Follow-up</h1>
      <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
        Draft the follow-up after a "should we work together?" call. Pick the Granola meeting, add the terms you
        want to propose, and draft — the email thread is optional (attach one to ground the reply in prior emails,
        or draft purely from the call). Draft-only — nothing is sent; copy it into your mail client.
      </p>

      {/* Optional: attach the prospect's email thread */}
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="Optional — attach the prospect's email thread (name, company, or email)"
          style={{ flex: 1, padding: "9px 12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14 }}
        />
        <button type="button" onClick={search} disabled={searching || !q.trim()}
          style={{ padding: "9px 18px", border: "none", borderRadius: 8, background: NAVY, color: "#fff", fontWeight: 600, cursor: "pointer" }}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {active && (
        <div style={{ fontSize: 12.5, color: "#6b7681", marginBottom: 12 }}>
          Thread attached: <strong style={{ color: NAVY }}>{subject || "(no subject)"}</strong>{" "}
          <button type="button" onClick={detachThread} style={{ border: "none", background: "none", color: CORAL, cursor: "pointer", fontWeight: 600, fontSize: 12.5, padding: 0 }}>✕ detach</button>
        </div>
      )}
      {!active && <div style={{ height: 6 }} />}

      {err && <div style={{ background: "#fdecea", color: "#a4271a", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: showList ? "minmax(240px, 320px) 1fr" : "1fr", gap: 16, alignItems: "start" }}>
        {/* Thread search results (optional attach) */}
        {showList && (
          <div style={{ ...card, overflow: "hidden" }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid #eef1f4", fontSize: 12, fontWeight: 600, color: "#6b7681" }}>
              {threads!.length} thread{threads!.length === 1 ? "" : "s"} — click to attach
            </div>
            {threads!.length === 0 && !searching && <div className="muted" style={{ padding: 16, fontSize: 13 }}>No matching threads.</div>}
            {threads!.map((t) => {
              const on = active?.mailbox === t.mailbox && active?.threadId === t.threadId;
              return (
                <button key={`${t.mailbox}:${t.threadId}`} type="button" onClick={() => openThread(t)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: "none", borderBottom: "1px solid #f0f3f5", background: on ? "#f2f7fa" : "transparent", borderLeft: on ? `3px solid ${CORAL}` : "3px solid transparent", cursor: "pointer" }}>
                  <div style={{ fontWeight: 600, color: NAVY, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject || "(no subject)"}</div>
                  <div style={{ fontSize: 12, color: "#6b7681", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.fromName || t.from} · {rel(t.date)} · <span style={{ color: "#9aa5ad" }}>{t.mailbox}</span></div>
                  <div style={{ fontSize: 12, color: "#8a939b", marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.snippet}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Composer — always present; drafts from meeting + brief (+ optional thread) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {active && (
            <div style={{ ...card, padding: 14 }}>
              <div style={{ fontWeight: 700, color: NAVY, marginBottom: 8 }}>{subject || "(no subject)"}</div>
              {loadingThread && <div className="muted" style={{ fontSize: 13 }}>Loading thread…</div>}
              {!loadingThread && messages && (
                <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
                  {messages.map((m) => (
                    <div key={m.id} style={{ borderTop: "1px solid #f0f3f5", paddingTop: 8 }}>
                      <div style={{ fontSize: 12, color: "#6b7681", marginBottom: 3 }}><strong style={{ color: NAVY }}>{m.fromName || m.from}</strong> · {new Date(m.date).toLocaleString()}</div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "#33414b", lineHeight: 1.45 }}>{m.body.slice(0, 4000)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Granola meeting picker */}
          <div style={{ ...card, padding: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7681", marginBottom: 6 }}>📝 Granola meeting{loadingNotes && notes ? <span style={{ color: "#8a939b", fontWeight: 400 }}> · updating…</span> : null}</label>
            {loadingNotes && !notes && <div className="muted" style={{ fontSize: 13 }}>Loading recent meetings…</div>}
            {notesErr && <div style={{ fontSize: 12.5, color: "#a4271a" }}>{notesErr}</div>}
            {!notesErr && notes && (
              notes.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>No recent Granola meetings found.</div>
              ) : (() => {
                // Newest-first (defensive client sort), then filter by the search box. The server sends a
                // `search` blob (title + attendees + AI-summary snippet) so a term in the meeting CONTENT
                // matches, not just the participant-based title; fall back to title/attendees/date.
                const sorted = [...notes].sort((a, b) => b.createdAt - a.createdAt);
                const q = noteQuery.trim().toLowerCase();
                const shown = q
                  ? sorted.filter((n) =>
                      (n.search || `${n.title} ${n.attendees.join(" ")} ${n.createdAt ? new Date(n.createdAt).toLocaleDateString() : ""}`.toLowerCase()).includes(q),
                    )
                  : sorted;
                const rowBase: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: "1px solid #f4f6f8", background: "transparent", borderLeft: "3px solid transparent", cursor: "pointer", fontSize: 13 };
                return (
                  <>
                    <input
                      value={noteQuery}
                      onChange={(e) => setNoteQuery(e.target.value)}
                      placeholder="Search meetings — name, company, or date"
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14, marginBottom: 8, boxSizing: "border-box" }}
                    />
                    <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #eef1f4", borderRadius: 8 }}>
                      <button type="button" onClick={() => setNoteId("")}
                        style={{ ...rowBase, background: noteId === "" ? "#f2f7fa" : "transparent", borderLeft: noteId === "" ? `3px solid ${CORAL}` : "3px solid transparent", color: "#6b7681" }}>
                        — No meeting (draft from the thread + brief) —
                      </button>
                      {shown.map((n) => {
                        const on = noteId === n.id;
                        return (
                          <button key={n.id} type="button" onClick={() => setNoteId(n.id)}
                            style={{ ...rowBase, background: on ? "#f2f7fa" : "transparent", borderLeft: on ? `3px solid ${CORAL}` : "3px solid transparent" }}>
                            {on && <span style={{ color: CORAL, fontWeight: 700 }}>✓ </span>}
                            <span style={{ fontWeight: 600, color: NAVY }}>{n.title}</span>
                            {n.matched && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "#2eb67d" }}>✓ match</span>}
                            <span style={{ color: "#8a939b" }}>
                              {n.createdAt ? ` · ${new Date(n.createdAt).toLocaleDateString()}` : ""}
                              {n.attendees.length ? ` · ${n.attendees.slice(0, 3).join(", ")}` : ""}
                            </span>
                          </button>
                        );
                      })}
                      {shown.length === 0 && <div className="muted" style={{ padding: "10px 12px", fontSize: 13 }}>No meetings match “{noteQuery}”.</div>}
                    </div>
                    {noteId && (() => {
                      const sel = notes.find((n) => n.id === noteId);
                      return sel ? <div style={{ fontSize: 12, color: "#2eb67d", fontWeight: 600, marginTop: 6 }}>✓ Using “{sel.title}” for the draft</div> : null;
                    })()}
                    {active && notes.some((n) => n.matched) && <div style={{ fontSize: 11.5, color: "#2eb67d", marginTop: 5 }}>✓ match = attendee matches the attached thread — pre-selected.</div>}
                    <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>Newest first. A meeting from the last little while appears once Granola finishes generating its summary — refresh the page if it&apos;s not here yet.</div>
                  </>
                );
              })()
            )}
          </div>

          {/* Reusable language */}
          <SnippetsPanel onInsert={insertSnippet} />

          {/* Brief + draft */}
          <div style={{ ...card, padding: 14 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7681", marginBottom: 6 }}>Follow-up brief — terms & anything to emphasize</label>
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)}
              placeholder='e.g. Go with a 10% success fee, no upfront. Reassure them there&apos;s no risk. Confirm they want us to focus on the .com first, and propose a kickoff call next week.'
              rows={4}
              style={{ width: "100%", padding: "9px 12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
              <button type="button" onClick={makeDraft} disabled={drafting || loadingThread || !canDraft}
                title={!canDraft ? "Pick a meeting, attach a thread, or write a brief first" : undefined}
                style={{ padding: "9px 18px", border: "none", borderRadius: 8, background: canDraft ? CORAL : "#d7dde1", color: "#fff", fontWeight: 600, cursor: canDraft ? "pointer" : "not-allowed" }}>
                {drafting ? "Drafting…" : draft ? "Re-draft" : "✨ Draft follow-up"}
              </button>
              {draft && (
                <button type="button" onClick={copy}
                  style={{ padding: "9px 16px", border: `1px solid ${NAVY}`, borderRadius: 8, background: "#fff", color: NAVY, fontWeight: 600, cursor: "pointer" }}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              )}
            </div>
            {draft && (
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={14}
                style={{ width: "100%", marginTop: 12, padding: "12px", border: "1px solid #cfd6dc", borderRadius: 8, fontSize: 14, lineHeight: 1.5, resize: "vertical", fontFamily: "inherit", background: "#fbfcfd" }} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
