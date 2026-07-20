// One-time setup of the Buy-Side pipeline + stages + custom fields in Pipedrive.
// DRY-RUN by default (shows what it WOULD create). Add ?apply=1 to actually create.
// Idempotent + admin-gated.
//   GET /api/admin/pipedrive/setup           → preview (no writes)
//   GET /api/admin/pipedrive/setup?apply=1   → create the missing objects

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canEnterAdmin } from "@/lib/permissions";
import { runSetup } from "@/lib/pipedrive-setup";
import { pipedriveConfigured } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canEnterAdmin(me)) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!pipedriveConfigured()) return NextResponse.json({ ok: false, error: "PIPEDRIVE_API_TOKEN not set" });

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const result = await runSetup(!apply);
  return NextResponse.json({ mode: apply ? "applied" : "dry-run (add ?apply=1 to create)", ...result });
}
