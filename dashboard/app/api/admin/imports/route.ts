// Admin Imports endpoint. The client parses the CSV/paste and streams rows here
// in chunks (action:"upsert"), then calls action:"finalize-replace" once at the
// end for Replace mode. Gated by the `admin.sources.edit` action.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { upsertUniverse, upsertMaster, finalizeReplace, type ImportRow, type Target } from "@/lib/imports";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCanAction(me, "admin.sources.edit")) {
    return NextResponse.json({ error: "Forbidden — needs admin.sources.edit" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    action?: string;
    target?: string;
    source?: string;
    rows?: ImportRow[];
    importTs?: string;
    today?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const target: Target = body.target === "master" ? "master" : "universe";
  const source = String(body.source || "").trim();
  if (!source) return NextResponse.json({ error: "Missing source name" }, { status: 400 });
  const importTs = String(body.importTs || new Date().toISOString());
  const today = String(body.today || new Date().toISOString().slice(0, 10));

  try {
    if (body.action === "finalize-replace") {
      const removed = await finalizeReplace(target, source, importTs, today);
      return NextResponse.json({ ok: true, removed });
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const upserted =
      target === "master"
        ? await upsertMaster(source, rows, importTs)
        : await upsertUniverse(source, rows, today);
    return NextResponse.json({ ok: true, upserted });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
