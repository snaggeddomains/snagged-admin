// Read the source registry from sources.yaml and per-source run_status.json
// state files, returning a unified view for the dashboard.

import yaml from "js-yaml";
import { getFile, listDirectory } from "./github";

export type Product = "snap" | "auctions" | "aux";

export interface Source {
  source_id: string;
  product: Product;
  kind: string;
  schedule_utc?: string;
  enabled?: boolean;
  reason?: string;
}

export interface RunStatus {
  source: string;
  label: string;
  status: "pending" | "ok" | "failed" | "disabled" | "skipped";
  detail?: string;
  generated_at: string;
  new_count?: number;
  dropped_count?: number;
  price_change_count?: number;
  fresh_added?: number;
  sheet_total_after?: number;
  slack_posted?: boolean;
}

export interface Reference {
  ref_id: string;
  kind: string;
  table?: string;
  cadence?: string;
  notes?: string;
}

export interface SourceWithStatus extends Source {
  /** True if a Python module exists at src/marketplace_pipeline/sources/<id>.py */
  wired: boolean;
  runStatus: RunStatus | null;
}

export async function loadSources(): Promise<Source[]> {
  const text = await getFile("sources.yaml");
  if (!text) return [];
  const parsed = yaml.load(text) as { sources?: Source[] } | undefined;
  return parsed?.sources ?? [];
}

export async function loadReferences(): Promise<Reference[]> {
  const text = await getFile("sources.yaml");
  if (!text) return [];
  const parsed = yaml.load(text) as
    | { references?: Record<string, Omit<Reference, "ref_id">> }
    | undefined;
  const refs = parsed?.references ?? {};
  return Object.entries(refs).map(([ref_id, body]) => ({ ref_id, ...body }));
}

/** Return the set of source_ids that have a Python module under
 * src/marketplace_pipeline/sources/. Filename mapping: source_id directly
 * (no hyphen substitution — modules use underscores).
 */
export async function loadWiredSourceIds(): Promise<Set<string>> {
  const entries = await listDirectory("src/marketplace_pipeline/sources");
  const wired = new Set<string>();
  for (const e of entries) {
    if (e.type !== "file") continue;
    if (!e.name.endsWith(".py")) continue;
    if (e.name === "__init__.py") continue;
    wired.add(e.name.replace(/\.py$/, ""));
  }
  return wired;
}

export async function loadRunStatus(sourceId: string): Promise<RunStatus | null> {
  const text = await getFile(`state/${sourceId}/run_status.json`);
  if (!text) return null;
  try {
    return JSON.parse(text) as RunStatus;
  } catch {
    return null;
  }
}

export async function loadAllSourcesWithStatus(): Promise<SourceWithStatus[]> {
  const [sources, wiredIds] = await Promise.all([
    loadSources(),
    loadWiredSourceIds(),
  ]);
  return Promise.all(
    sources.map(async (s) => ({
      ...s,
      wired: wiredIds.has(s.source_id),
      runStatus: await loadRunStatus(s.source_id),
    })),
  );
}
