// Historical form submissions (pre-GA-tracking) — a static, PII-stripped export
// of the two Formspark forms (Mar–Jun 2026), bundled at build time. GA form
// tracking only went live 2026-06-08, so before the cutoff the only record of
// submissions is this dataset; the Site Analytics report blends it (historical)
// with GA (forward) so the submission/source/intent/budget cards aren't empty
// for past windows. Forward-looking submissions come entirely from GA.
//
// Data shape (historical-submissions.json):
//   { cutoff: "YYYY-MM-DD", core: [{date, source, intent, budget}], marketplace: [{date}] }
// core = the services / sell-side contact form; marketplace = the /domains offer form.

import data from "./historical-submissions.json";

export type LabelValue = { label: string; value: number };
type CoreRec = { date: string; source: string | null; intent: string | null; budget: string | null };

const CUTOFF: string = (data as { cutoff?: string }).cutoff || "2026-06-07";
const CORE = (data as { core: CoreRec[] }).core || [];
const MARKET = (data as { marketplace: { date: string }[] }).marketplace || [];

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

// Upper bound is capped at the cutoff so historical never overlaps GA's window.
function capTo(to: string): string {
  return to < CUTOFF ? to : CUTOFF;
}

export function historicalCount(tranche: "core" | "marketplace" | "blog", from: string, to: string): number {
  const end = capTo(to);
  if (from > end) return 0;
  if (tranche === "core") return CORE.filter((r) => inRange(r.date, from, end)).length;
  if (tranche === "marketplace") return MARKET.filter((r) => inRange(r.date, from, end)).length;
  return 0; // blog had no form historically
}

// Self-reported source / intent / budget breakdown of the core (services) form
// over the pre-cutoff portion of [from, to].
export function historicalBreakdown(field: "source" | "intent" | "budget", from: string, to: string): LabelValue[] {
  const end = capTo(to);
  if (from > end) return [];
  const counts = new Map<string, number>();
  for (const r of CORE) {
    if (!inRange(r.date, from, end)) continue;
    const v = r[field];
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// Daily submission counts (for trend blending), capped at the cutoff.
export function historicalDaily(tranche: "core" | "marketplace", from: string, to: string): Map<string, number> {
  const end = capTo(to);
  const m = new Map<string, number>();
  if (from > end) return m;
  const arr = tranche === "core" ? CORE : MARKET;
  for (const r of arr) if (inRange(r.date, from, end)) m.set(r.date, (m.get(r.date) || 0) + 1);
  return m;
}

// Merge a GA breakdown with a historical one, summing by label (exact-string
// match — GA params carry the same form select values the CSV stored).
export function mergeLabelValues(a: LabelValue[], b: LabelValue[]): LabelValue[] {
  const m = new Map<string, number>();
  for (const { label, value } of [...a, ...b]) m.set(label, (m.get(label) || 0) + value);
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value);
}
