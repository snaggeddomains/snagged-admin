// Pipedrive connection diagnostic — READ ONLY. Confirms PIPEDRIVE_API_TOKEN authenticates
// and shows the account state (pipelines, stages, deal fields, users) BEFORE we build
// anything that writes. Admin-gated.
//   GET /api/admin/pipedrive/diag

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canEnterAdmin } from "@/lib/permissions";
import { getPipelines, getStages, getDealFields, getUsers, pipedriveConfigured } from "@/lib/pipedrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canEnterAdmin(me)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  if (!pipedriveConfigured()) {
    return NextResponse.json({ ok: false, configured: false, error: "PIPEDRIVE_API_TOKEN not set (redeploy after adding it)." });
  }

  const [pipelines, fields, users] = await Promise.all([getPipelines(), getDealFields(), getUsers()]);
  if (!pipelines.ok) {
    return NextResponse.json({ ok: false, configured: true, error: `Auth/API failed: ${pipelines.error}` }, { status: 502 });
  }

  // Stages for the first pipeline, just to prove the shape.
  const firstPid = pipelines.data && pipelines.data[0] ? pipelines.data[0].id : undefined;
  const stages = firstPid ? await getStages(firstPid) : { ok: true, data: [] as { name: string }[] };

  return NextResponse.json({
    ok: true,
    configured: true,
    pipelines: (pipelines.data || []).map((p) => ({ id: p.id, name: p.name })),
    firstPipelineStages: (stages.data || []).map((s) => s.name),
    dealFieldCount: (fields.data || []).length,
    // Only the custom (hash-keyed) fields — the ones we'll be creating/mapping.
    customDealFields: (fields.data || []).filter((f) => /^[a-f0-9]{20,}$/.test(f.key)).map((f) => ({ key: f.key, name: f.name, type: f.field_type })),
    users: (users.data || []).filter((u) => u.active_flag).map((u) => ({ id: u.id, name: u.name, email: u.email })),
  });
}
