// Internal endpoint: build a Google Sheet from row data via the service account and
// return its URL. The research app has NO Google credentials, so its Naming Exercise
// "Export to Google Sheet" POSTs the rows here and admin (which owns the SA) creates
// the sheet in the "Snagged Pipeline" shared drive. Auth: shared-secret header
// `x-internal-secret` == RESEARCH_INTERNAL_SECRET (same pattern as email-threads /
// sales-comps; middleware.ts excludes api/internal). Server-to-server, no session.
//
//   POST { title, values: string[][], shareWith?: email } -> { ok, url, warning? }

import { NextResponse, type NextRequest } from "next/server";
import { googleConfigured } from "@/lib/google-auth";
import { createSheetInSharedDrive } from "@/lib/gsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authStatus(req: NextRequest): "ok" | "unconfigured" | "mismatch" {
  const secret = process.env.RESEARCH_INTERNAL_SECRET || "";
  if (!secret) return "unconfigured";
  const got = (req.headers.get("x-internal-secret") || "").trim();
  return got === secret.trim() ? "ok" : "mismatch";
}

export async function POST(req: NextRequest) {
  const auth = authStatus(req);
  if (auth === "unconfigured") {
    return NextResponse.json(
      { error: "Server has no RESEARCH_INTERNAL_SECRET configured (set it on snagged-admin and redeploy)." },
      { status: 503 },
    );
  }
  if (auth === "mismatch") {
    const serverLen = (process.env.RESEARCH_INTERNAL_SECRET || "").trim().length;
    const recvLen = (req.headers.get("x-internal-secret") || "").trim().length;
    return NextResponse.json(
      { error: `Secret mismatch (admin has ${serverLen} chars, research sent ${recvLen}) — set RESEARCH_INTERNAL_SECRET to the same value in both projects and redeploy both.` },
      { status: 401 },
    );
  }
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Google service account not configured (set GOOGLE_SA_KEY on snagged-admin)." }, { status: 503 });
  }

  let body: { title?: unknown; values?: unknown; shareWith?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const title = typeof body?.title === "string" ? body.title : "Export";
  const shareWith = typeof body?.shareWith === "string" ? body.shareWith : undefined;
  const values = Array.isArray(body?.values)
    ? (body.values as unknown[]).filter(Array.isArray).map((row) => (row as unknown[]).map((c) => (c == null ? "" : (c as string | number))))
    : null;
  if (!values || !values.length) {
    return NextResponse.json({ error: "No rows to export (values required)." }, { status: 400 });
  }

  try {
    const r = await createSheetInSharedDrive({ title, values, shareWith });
    return NextResponse.json({ ok: true, url: r.url, ...(r.shareWarning ? { warning: r.shareWarning } : {}) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
