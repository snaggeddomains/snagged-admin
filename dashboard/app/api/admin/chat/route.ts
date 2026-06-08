// Reports → Chat Analytics: POST { question } → a Claude agent answers using the
// report data tools. Gated by reports.chat (reports umbrella / is_admin auto-pass).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { askAnalytics, chatConfigured, type PriorTurn } from "@/lib/chat-analytics";

export const runtime = "nodejs";
export const maxDuration = 60;

const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.chat")) return NextResponse.json({ error: "No access to Chat Analytics" }, { status: 403 });
  if (!chatConfigured()) {
    return NextResponse.json({ ok: false, configured: false, error: "Chat not configured — set ANTHROPIC_API_KEY in this project's env." }, { status: 200 });
  }
  const body = (await req.json().catch(() => ({}))) as { question?: string; history?: PriorTurn[] };
  const question = String(body.question || "").trim();
  if (!question) return NextResponse.json({ error: "Missing question" }, { status: 400 });
  if (question.length > 1000) return NextResponse.json({ error: "Question too long" }, { status: 400 });
  const history: PriorTurn[] = Array.isArray(body.history)
    ? body.history.filter((h) => h && typeof h.q === "string" && typeof h.a === "string").map((h) => ({ q: String(h.q).slice(0, 1000), a: String(h.a).slice(0, 4000) })).slice(-6)
    : [];
  try {
    const result = await askAnalytics(question, etYmd(new Date()), history);
    return NextResponse.json({ ok: true, configured: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
