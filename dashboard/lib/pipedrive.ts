// Pipedrive API client — the buy-side deal-flow bridge (mirrors lib/hubspot.ts, which is
// the SELL-side layer; the two stay independent by design). Pipedrive is the system of
// record: we create/read/update deals here, we don't mirror them into our own DB.
//
// Auth: PIPEDRIVE_API_TOKEN (classic API token → passed as the ?api_token= query param,
// Pipedrive's convention). Base is the generic api.pipedrive.com/v1.
//
// Every call returns { ok, data?, error? } so callers (and the diag) never throw.

const API = "https://api.pipedrive.com/v1";

export function pipedriveConfigured(): boolean {
  return Boolean(process.env.PIPEDRIVE_API_TOKEN);
}

type PdResult<T = unknown> = { ok: boolean; data?: T; error?: string; status?: number };

async function pd<T = unknown>(method: string, path: string, body?: unknown): Promise<PdResult<T>> {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return { ok: false, error: "PIPEDRIVE_API_TOKEN not set" };
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${sep}api_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string; error_info?: string };
    if (!res.ok || json.success === false) {
      return { ok: false, status: res.status, error: json.error || json.error_info || `HTTP ${res.status}` };
    }
    return { ok: true, data: json.data, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// ── Read (non-destructive — safe for the diag) ────────────────────────────────
export type PdPipeline = { id: number; name: string };
export type PdStage = { id: number; name: string; pipeline_id: number; order_nr: number };
export type PdFieldOption = { id: number; label: string };
export type PdDealField = { id: number; key: string; name: string; field_type: string; options?: PdFieldOption[] };
export type PdUser = { id: number; name: string; email: string; active_flag: boolean };

export function getPipelines() { return pd<PdPipeline[]>("GET", "/pipelines"); }
export function getStages(pipelineId?: number) { return pd<PdStage[]>("GET", `/stages${pipelineId ? `?pipeline_id=${pipelineId}` : ""}`); }
export function getDealFields() { return pd<PdDealField[]>("GET", "/dealFields"); }
export function getUsers() { return pd<PdUser[]>("GET", "/users"); }
// All deals in a pipeline (open + won + lost) — for the one-time import into native Deals.
export type PdDeal = { id: number; title: string; stage_id: number; status: string; person_name?: string; org_name?: string; user_id?: { id?: number; email?: string } | number | null; [key: string]: unknown };
export function getDeals(pipelineId: number) { return pd<PdDeal[]>("GET", `/deals?pipeline_id=${pipelineId}&status=all&limit=500`); }
// /users/me carries the company_domain we need to build web deal URLs.
export function getMe() { return pd<{ company_domain?: string; id: number }>("GET", "/users/me"); }

// ── Write (used by Phase 1c create-deal; not exercised by the diag) ───────────
export function searchPersonByEmail(email: string) {
  return pd<{ items?: { item: { id: number } }[] }>("GET", `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true`);
}
export function createPerson(input: { name: string; email?: string; phone?: string }) {
  const body: Record<string, unknown> = { name: input.name };
  if (input.email) body.email = [{ value: input.email, primary: true }];
  if (input.phone) body.phone = [{ value: input.phone, primary: true }];
  return pd<{ id: number }>("POST", "/persons", body);
}
export function createOrganization(name: string) { return pd<{ id: number }>("POST", "/organizations", { name }); }
export function createDeal(fields: Record<string, unknown>) { return pd<{ id: number }>("POST", "/deals", fields); }
export function updateDeal(id: number, fields: Record<string, unknown>) { return pd<{ id: number }>("PUT", `/deals/${id}`, fields); }
// Idempotency: find an existing deal by the target domain (matched against a custom field / title).
export function searchDeals(term: string) {
  return pd<{ items?: { item: { id: number; title: string } }[] }>("GET", `/deals/search?term=${encodeURIComponent(term)}&fields=custom_fields,title`);
}
export function addNote(dealId: number, content: string) { return pd<{ id: number }>("POST", "/notes", { deal_id: dealId, content }); }
