// Admin Imports endpoint. The client parses the CSV/paste and streams rows here
// in chunks (action:"upsert"), then calls action:"finalize-replace" once at the
// end for Replace mode. Gated by the `admin.sources.edit` action.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import {
  upsertUniverse,
  upsertMaster,
  finalizeReplace,
  previewImport,
  logImport,
  listImports,
  listImportSources,
  type ImportRow,
  type Target,
} from "@/lib/imports";
import { dispatchWorkflow } from "@/lib/orchestrator";
import { loadSources } from "@/lib/sources";

export const runtime = "nodejs";
export const maxDuration = 60;

// Workflow that recomputes structural + quality scores after an import.
const BACKFILL_UNIVERSE = "backfill-universe-structural.yml";
const BACKFILL_MASTER = "backfill-quality-master.yml";

// GET — recent import-history entries for the panel.
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCanAction(me, "admin.sources.edit")) {
    return NextResponse.json({ error: "Forbidden — needs admin.sources.edit" }, { status: 403 });
  }
  try {
    const [history, logSources, registry] = await Promise.all([
      listImports(25),
      listImportSources(),
      loadSources().catch(() => []),
    ]);
    // Typeahead pool: source IDs from the registry + every name ever imported,
    // sorted + deduped, so people normalize to an existing name.
    const sources = [...new Set([...registry.map((s) => s.source_id), ...logSources])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ ok: true, history, sources });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

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
    mode?: string;
    importTs?: string;
    today?: string;
    // log fields
    parsed?: number;
    upserted?: number;
    removed?: number;
    backfilled?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const target: Target = body.target === "master" ? "master" : "universe";
  const source = String(body.source || "").trim();
  if (!source) return NextResponse.json({ error: "Missing source name" }, { status: 400 });
  const importTs = String(body.importTs || new Date().toISOString());
  const today = String(body.today || new Date().toISOString().slice(0, 10));
  const mode: "merge" | "replace" = body.mode === "replace" ? "replace" : "merge";

  try {
    if (body.action === "preview") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const preview = await previewImport(target, source, rows, mode);
      return NextResponse.json({ ok: true, preview });
    }
    if (body.action === "finalize-replace") {
      const removed = await finalizeReplace(target, source, importTs, today);
      return NextResponse.json({ ok: true, removed });
    }
    if (body.action === "post-backfill") {
      // Recompute structural + quality scores for the freshly-imported rows.
      const file = target === "master" ? BACKFILL_MASTER : BACKFILL_UNIVERSE;
      const inputs: Record<string, string> = target === "master" ? { commit: "true" } : {};
      const r = await dispatchWorkflow(file, inputs);
      if (!r.ok) return NextResponse.json({ error: r.error || "dispatch failed" }, { status: 502 });
      return NextResponse.json({ ok: true, dispatched: file });
    }
    if (body.action === "log") {
      await logImport({
        target,
        source,
        mode,
        parsed: Number(body.parsed) || 0,
        upserted: Number(body.upserted) || 0,
        removed: Number(body.removed) || 0,
        backfilled: Boolean(body.backfilled),
        user_email: me.email ?? null,
      });
      return NextResponse.json({ ok: true });
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
