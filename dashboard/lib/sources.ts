// Read the source registry from sources.yaml and per-source run_status.json
// state files, returning a unified view for the dashboard.

import yaml from "js-yaml";
import { getFile } from "./github";

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

export interface SourceWithStatus extends Source {
  runStatus: RunStatus | null;
}

export async function loadSources(): Promise<Source[]> {
  const text = await getFile("sources.yaml");
  if (!text) return [];
  const parsed = yaml.load(text) as { sources?: Source[] } | undefined;
  return parsed?.sources ?? [];
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
  const sources = await loadSources();
  return Promise.all(
    sources.map(async (s) => ({
      ...s,
      runStatus: await loadRunStatus(s.source_id),
    })),
  );
}
