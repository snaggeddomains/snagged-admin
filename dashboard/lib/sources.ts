// Read the source registry from sources.yaml and per-source run_status.json
// state files, returning a unified view for the dashboard.

import yaml from "js-yaml";
import { getFile, listDirectory } from "./github";

export type Product = "snap" | "auctions" | "aux";

export interface SheetDestination {
  tab: string;
  mode: string;
  sheet_id_override?: string;
}

export interface Source {
  source_id: string;
  product: Product;
  kind: string;
  schedule_utc?: string;
  enabled?: boolean;
  reason?: string;
  sheet_destinations?: SheetDestination[];
  slack_channel_for?: string;
  filters_profile?: string;
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

export interface FilterProfile {
  name: string;
  allowed_tlds?: string[];
  sld_length_min?: number;
  sld_length_max?: number;
  allow_digits?: boolean;
  allow_hyphens?: boolean;
  require_vowel?: boolean;
  max_consecutive_consonants?: number;
  dedup_by_domain?: boolean;
  zipf_min?: number;
  zipf_overrides_by_tld?: Record<string, number>;
  allow_three_letter_com?: boolean;
  legacy_module?: string;
}

export interface Storage {
  pipeline_raw_cache_folder_id?: string;
  pipeline_raw_cache_retention_days?: number;
}

export interface Products {
  snap?: { sheet_id?: string; sheet_title?: string; atom_wholesale_sheet_id?: string; atom_wholesale_sheet_title?: string; slack_channel_env?: string; do_not_write_tabs?: string[] };
  auctions?: { sheet_id?: string; sheet_title?: string; slack_channel_env?: string };
}

export interface FullRegistry {
  storage: Storage;
  products: Products;
  filter_profiles: FilterProfile[];
  sources: Source[];
  references: Reference[];
}

export async function loadFullRegistry(): Promise<FullRegistry> {
  const text = await getFile("sources.yaml");
  if (!text) {
    return {
      storage: {},
      products: {},
      filter_profiles: [],
      sources: [],
      references: [],
    };
  }
  const parsed = yaml.load(text) as
    | {
        storage?: Storage;
        products?: Products;
        filter_profiles?: Record<string, Omit<FilterProfile, "name">>;
        sources?: Source[];
        references?: Record<string, Omit<Reference, "ref_id">>;
      }
    | undefined;
  const profilesObj = parsed?.filter_profiles ?? {};
  const refsObj = parsed?.references ?? {};
  return {
    storage: parsed?.storage ?? {},
    products: parsed?.products ?? {},
    filter_profiles: Object.entries(profilesObj).map(([name, body]) => ({
      name,
      ...body,
    })),
    sources: parsed?.sources ?? [],
    references: Object.entries(refsObj).map(([ref_id, body]) => ({
      ref_id,
      ...body,
    })),
  };
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
