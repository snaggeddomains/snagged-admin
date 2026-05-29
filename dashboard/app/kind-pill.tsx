// A small colored pill that visually distinguishes source/reference `kind`
// values at a glance — used on Sources, Schedule, and Configuration pages.

const KIND_TO_CLASS: Record<string, string> = {
  csv_dump:          "pill--csv",
  api_export:        "pill--api",
  google_doc:        "pill--doc",
  scrape_json:       "pill--scrape",
  drive_file:        "pill--drive",
  orchestrator:      "pill--orchestrator",
  postgres_supabase: "pill--postgres",
};

export default function KindPill({ kind }: { kind: string }) {
  const cls = KIND_TO_CLASS[kind] ?? "pill--default";
  return <span className={`pill ${cls}`}>{kind}</span>;
}
