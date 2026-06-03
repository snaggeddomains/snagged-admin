// Admin Imports endpoint. The client parses the CSV/paste and streams rows here
// in chunks (action:"upsert"), then calls action:"finalize-replace" once at the
// end for Replace mode. Gated by the `admin.imports` module permission.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import {
  upsertUniverse,
  upsertMaster,
  finalizeReplace,
  previewImport,
  countExisting,
  countSourceRows,
  enrichStatus,
  listEnrichedDomains,
  logImport,
  listImports,
  listImportSources,
  listMasterSources,
  deleteImport,
  type ImportRow,
  type Target,
} from "@/lib/imports";
import { dispatchWorkflow } from "@/lib/orchestrator";
import { loadSources } from "@/lib/sources";

export const runtime = "nodejs";
// Universe chunks go through the merge RPC + may halve-retry on a statement
// timeout, so give a single chunk request generous headroom.
export const maxDuration = 300;

// Workflow that recomputes structural + quality scores after an import.
const BACKFILL_UNIVERSE = "backfill-universe-structural.yml";
const BACKFILL_MASTER = "backfill-quality-master.yml";

// Marketplace feeds that belong in Universe but aren't registered pipeline
// sources in sources.yaml (imported by hand via this tool). Seeded into the
// Universe typeahead so they suggest before the first import; once imported,
// the import log carries them too.
const UNIVERSE_EXTRA_SOURCES = ["brandbucket"];

// GET — recent import-history entries for the panel.
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "admin.imports")) {
    return NextResponse.json({ error: "Forbidden — needs admin.imports" }, { status: 403 });
  }
  try {
    const [history, logSources, registry, masterSources] = await Promise.all([
      listImports(25),
      listImportSources(),
      loadSources().catch(() => []),
      listMasterSources(),
    ]);
    const sortUniq = (xs: string[]) =>
      [...new Set(xs)].filter(Boolean).sort((a, b) => a.localeCompare(b));
    const logFor = (t: string) => logSources.filter((r) => r.target === t).map((r) => r.source);
    // Target-aware typeahead pools, so each DB only suggests names that belong
    // in it: Universe = the pipeline registry IDs + anything imported to Universe;
    // Master = the distinct curated `source` names already in the Master table +
    // anything imported to Master.
    const sourcesUniverse = sortUniq([...registry.map((s) => s.source_id), ...UNIVERSE_EXTRA_SOURCES, ...logFor("universe")]);
    const sourcesMaster = sortUniq([...masterSources, ...logFor("master")]);
    return NextResponse.json({ ok: true, history, sourcesUniverse, sourcesMaster });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "admin.imports")) {
    return NextResponse.json({ error: "Forbidden — needs admin.imports" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    action?: string;
    target?: string;
    source?: string;
    rows?: ImportRow[];
    domains?: string[];
    mode?: string;
    importTs?: string;
    today?: string;
    id?: string;
    // post-backfill options
    enrich?: boolean;
    qualityMin?: number | string;
    newSince?: string;
    // log fields
    parsed?: number;
    upserted?: number;
    removed?: number;
    backfilled?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  // The Universe corpus is gated behind a sub-permission; Master is the default
  // for everyone with admin.imports. (delete-log sends no target — not gated.)
  if (body.target === "universe" && !userCanAction(me, "admin.imports.universe")) {
    return NextResponse.json({ error: "Forbidden — Universe imports need admin.imports.universe" }, { status: 403 });
  }

  const target: Target = body.target === "master" ? "master" : "universe";

  // Deleting a history entry needs only an id (no source).
  if (body.action === "delete-log") {
    try {
      await deleteImport(String(body.id || ""));
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // Chunked Preview: count how many of this batch of domains already exist.
  // Takes only domain strings (no source), so the client can stream the file in
  // small batches instead of POSTing it whole (which 413s on large imports).
  if (body.action === "preview-existing") {
    try {
      const domains = Array.isArray(body.domains) ? body.domains : [];
      const count = await countExisting(target, domains);
      return NextResponse.json({ ok: true, count });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  const source = String(body.source || "").trim();
  if (!source) return NextResponse.json({ error: "Missing source name" }, { status: 400 });
  const importTs = String(body.importTs || new Date().toISOString());
  const today = String(body.today || new Date().toISOString().slice(0, 10));
  const mode: "merge" | "replace" = body.mode === "replace" ? "replace" : "merge";

  try {
    if (body.action === "preview-source-total") {
      const count = await countSourceRows(target, source);
      return NextResponse.json({ ok: true, count });
    }
    if (body.action === "enrich-status") {
      const status = await enrichStatus(target, source, Number(body.qualityMin) || 1, body.newSince);
      return NextResponse.json({ ok: true, status });
    }
    if (body.action === "enriched-list") {
      const domains = await listEnrichedDomains(target, source, Number(body.qualityMin) || 1, body.newSince);
      return NextResponse.json({ ok: true, domains });
    }
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
      // Optionally chain a quality-banded LLM enrich-batch AFTER the backfill,
      // scoped to this source so only its new names are charged.
      if (body.enrich) {
        const floor = body.qualityMin != null && String(body.qualityMin).trim() !== ""
          ? String(body.qualityMin)
          : "";
        inputs.then_enrich = "true";
        inputs.enrich_quality_min = floor;
        inputs.enrich_source = source;
        // Net-new only: enrich rows created at/after the import (never re-enrich
        // names that already existed). Falls back to all-eligible if absent.
        if (body.newSince) inputs.enrich_new_since = String(body.newSince);
      }
      const r = await dispatchWorkflow(file, inputs);
      if (!r.ok) return NextResponse.json({ error: r.error || "dispatch failed" }, { status: 502 });
      return NextResponse.json({ ok: true, dispatched: file, enriching: Boolean(body.enrich) });
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
        import_ts: body.importTs ? String(body.importTs) : null,
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
