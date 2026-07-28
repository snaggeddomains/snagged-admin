"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Deal = {
  id: string; domain: string; buyer_name: string | null; owner_email: string | null;
  stage: string; priority: string | null; status: string;
};
type ReplyTask = { deal: Deal; comment: { id: string; body: string | null; user_email: string | null; created_at: string } };
type BoomerangTask = { deal: Deal; reminder: { id: string; remind_at: string; note: string | null } };
type SharedTask = { deal: Deal; shared_by: string | null; created_at: string };
type Assignee = { email: string; name: string };
type Payload = {
  replies: ReplyTask[]; assignments: Deal[]; boomerangs: BoomerangTask[]; shared: SharedTask[];
  counts: { replies: number; assignments: number; boomerangs: number; shared: number; actionable: number };
  assignees: Assignee[]; me: string;
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  const past = s >= 0; const a = Math.abs(s);
  const m = Math.round(a / 60), h = Math.round(a / 3600), d = Math.round(a / 86400);
  const val = a < 60 ? "just now" : m < 60 ? `${m}m` : h < 24 ? `${h}h` : d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`;
  if (val === "just now") return val;
  return past ? `${val} ago` : `in ${val}`;
}

export default function TasksClient() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/admin/deals/tasks", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || "Failed to load");
      setData(j as Payload);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nameOf = useMemo(() => {
    const m = new Map((data?.assignees || []).map((a) => [a.email.toLowerCase(), a.name]));
    return (email: string | null | undefined) => {
      if (!email) return "Unassigned";
      return m.get(email.toLowerCase()) || email.split("@")[0];
    };
  }, [data]);

  const c = data?.counts;
  const total = c ? c.replies + c.boomerangs + c.shared + c.assignments : 0;

  return (
    <main style={{ maxWidth: 860, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>My Tasks</h1>
        <button onClick={load} disabled={loading} style={{ fontSize: 13, background: "transparent", border: "1px solid #dbe3e7", borderRadius: 8, padding: "4px 12px", cursor: "pointer", color: "#475569" }}>↻ Refresh</button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Your Deals to-do list — comments to reply to, deals just handed to you, boomerangs that came back, and deals shared with you.
      </p>

      {err && <div style={{ color: "#b91c1c", fontSize: 13, margin: "8px 0" }}>{err}</div>}
      {loading && !data && <div className="muted">Loading…</div>}
      {data && total === 0 && !loading && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>🎉</div>
          <div style={{ fontWeight: 600, marginTop: 6 }}>You&apos;re all caught up</div>
          <div className="muted" style={{ fontSize: 13 }}>No replies owed, no boomerangs due, nothing new on your plate.</div>
        </div>
      )}

      {data && (
        <>
          <Section title="Replies needed" emoji="💬" color="#b45309" count={c!.replies}>
            {data.replies.map((t) => (
              <Row key={t.deal.id + t.comment.id} deal={t.deal} nameOf={nameOf} router={router}
                context={<><b>{nameOf(t.comment.user_email)}</b> mentioned you{t.comment.body ? `: ${t.comment.body.slice(0, 120)}` : ""}</>}
                time={t.comment.created_at} />
            ))}
          </Section>

          <Section title="Boomerangs — time to revisit" emoji="⏰" color="#9a3412" count={c!.boomerangs}>
            {data.boomerangs.map((t) => (
              <Row key={t.deal.id + t.reminder.id} deal={t.deal} nameOf={nameOf} router={router}
                context={<>Snoozed to revisit{t.reminder.note ? ` — ${t.reminder.note}` : ""}</>}
                time={t.reminder.remind_at} />
            ))}
          </Section>

          <Section title="Shared with you" emoji="🤝" color="#1f6b52" count={c!.shared}>
            {data.shared.map((t) => (
              <Row key={t.deal.id} deal={t.deal} nameOf={nameOf} router={router}
                context={<><b>{nameOf(t.shared_by)}</b> looped you in</>}
                time={t.created_at} />
            ))}
          </Section>

          <Section title="New on your plate" emoji="📥" color="#475569" count={c!.assignments}>
            {data.assignments.map((d) => (
              <Row key={d.id} deal={d} nameOf={nameOf} router={router}
                context={<>Assigned to you — {d.stage}</>} time={null} />
            ))}
          </Section>
        </>
      )}
    </main>
  );
}

function Section({ title, emoji, color, count, children }: { title: string; emoji: string; color: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 15 }}>{emoji}</span>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: ".04em", color, margin: 0 }}>{title}</h2>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700 }}>{count}</span>
      </div>
      <div style={{ border: "1px solid #e6ecef", borderRadius: 10, overflow: "hidden", background: "#fff" }}>{children}</div>
    </section>
  );
}

function Row({ deal, context, time, nameOf, router }: {
  deal: Deal; context: React.ReactNode; time: string | null;
  nameOf: (e: string | null | undefined) => string; router: ReturnType<typeof useRouter>;
}) {
  return (
    <button
      onClick={() => router.push(`/deals/${deal.id}`)}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
        padding: "11px 14px", border: "none", borderTop: "1px solid #f0f4f6", background: "transparent", cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#fbf7f0")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#d1d9de", flex: "0 0 auto" }} />
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <b style={{ color: "#1f6b52" }}>{deal.domain}</b>
          {deal.buyer_name && <span className="muted" style={{ fontSize: 12 }}>· {deal.buyer_name}</span>}
        </span>
        <span className="muted" style={{ fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{context}</span>
      </span>
      <span style={{ flex: "0 0 auto", textAlign: "right" }}>
        <span style={{ fontSize: 12, color: "#64748b", display: "block" }}>{nameOf(deal.owner_email)}</span>
        {time && <span style={{ fontSize: 11, color: "#94a3b8" }}>{relTime(time)}</span>}
      </span>
    </button>
  );
}
