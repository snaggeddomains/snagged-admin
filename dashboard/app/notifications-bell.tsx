"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

// The notifications bell for the admin chrome — mirrors the research module's
// bell. Polls unread, shows a red badge, opens a dropdown of recent items, and
// marks read on open / click. Shares the research DB so a lesson submission (or
// any research notification for this user) lands here too.
export default function NotificationsBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items || []);
      setUnread(data.unread || 0);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      try {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        setItems((xs) => xs.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
      } catch {
        /* non-fatal */
      }
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={toggle}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        style={{ position: "relative", background: "none", border: "none", cursor: "pointer", padding: 6, lineHeight: 0, color: "var(--navy)" }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: "absolute", top: 0, right: 0, minWidth: 17, height: 17, padding: "0 4px",
            borderRadius: 999, background: "var(--coral, #e48069)", color: "#fff", fontSize: 10.5,
            fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown" style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, width: 340, maxWidth: "90vw",
          background: "#fff", border: "1px solid var(--line, #e3ddcf)", borderRadius: 12,
          boxShadow: "0 10px 30px rgba(37,66,84,.18)", zIndex: 50, overflow: "hidden",
        }}>
          <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line, #efe9dc)", fontWeight: 700, fontSize: 13.5, color: "var(--navy)" }}>
            Notifications
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {items.length === 0 ? (
              <div className="muted" style={{ padding: "18px 14px", fontSize: 13 }}>No notifications yet.</div>
            ) : (
              items.map((n) => {
                const inner = (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--navy)" }}>{n.title}</div>
                    {n.body && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{n.body}</div>}
                    <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{fmt(n.created_at)}</div>
                  </>
                );
                const style: React.CSSProperties = {
                  display: "block", padding: "10px 14px", borderBottom: "1px solid var(--line, #f1ece0)",
                  background: n.read_at ? "#fff" : "rgba(228,128,105,.06)", textDecoration: "none", color: "inherit",
                };
                return n.link ? (
                  <a key={n.id} href={n.link} style={style} onClick={() => setOpen(false)}>{inner}</a>
                ) : (
                  <div key={n.id} style={style}>{inner}</div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
