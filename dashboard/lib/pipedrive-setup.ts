// One-time (idempotent) setup of the Buy-Side Deal Flow in Pipedrive: the pipeline + its
// stages + the §8 deal custom fields. Safe to re-run — it only creates what's missing.
// Field KEYS are resolved by NAME at runtime (lib/pipedrive-fields.ts), so we don't persist
// a config table; Pipedrive stays the system of record.

import { getPipelines, getStages, getDealFields } from "./pipedrive";

const API = "https://api.pipedrive.com/v1";
async function pdPost<T = { id: number; key?: string }>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return { ok: false, error: "PIPEDRIVE_API_TOKEN not set" };
  try {
    const res = await fetch(`${API}${path}?api_token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
    });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
    if (!res.ok || j.success === false) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true, data: j.data };
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e) }; }
}

export const BUY_PIPELINE = "Buy-Side Deal Flow";
// Won/Lost are Pipedrive-native deal STATUSES, not stages, so the working stages end at
// Negotiating. "Stale" is a status/flag (per §10), not a stage.
export const BUY_STAGES = [
  "Unassigned / Inbox", "Assigned", "Qualifying", "Invoice / Awaiting Payment",
  "Research & Outreach", "In Contact", "Negotiating",
];

// §8 deal custom fields. name is the stable handle we resolve keys by; keep names stable.
type FieldDef = { name: string; field_type: string; options?: string[]; required?: boolean };
export const BUY_FIELDS: FieldDef[] = [
  { name: "Target Domain", field_type: "varchar", required: true },
  { name: "Additional Domains", field_type: "text" },
  { name: "Source / Channel", field_type: "enum", required: true, options: ["Website form", "Inbound email", "Text", "WhatsApp", "Phone", "Referral", "In-person", "Proactive (we're chasing it)"] },
  { name: "Client Name", field_type: "varchar" },
  { name: "Client Contact", field_type: "varchar" },
  { name: "Budget Range", field_type: "varchar" },
  { name: "Appraisal Value", field_type: "monetary" },
  { name: "Priority", field_type: "enum", options: ["Top", "High", "Normal", "Low"] },
  { name: "Research Report Link", field_type: "varchar" },
  { name: "Likely Owner", field_type: "varchar" },
  { name: "Owner Contact", field_type: "varchar" },
  { name: "Asking / Target Price", field_type: "monetary" },
  { name: "Deal Status Marker", field_type: "enum", options: ["Awaiting reply", "Owner responded", "Open to selling", "Went cold", "Declined"] },
  { name: "Auction Handle", field_type: "varchar" },
  { name: "Reachability", field_type: "enum", options: ["Have contact path", "Auction handle only", "No path yet"] },
  { name: "Last Buyer Update", field_type: "date" },
  { name: "Last Owner-Contact", field_type: "date" },
  { name: "Deal BCC Address", field_type: "varchar" },
];

type StepResult = { name: string; state: "exists" | "would-create" | "created" | "error"; detail?: string };

export async function runSetup(dryRun = true): Promise<{ ok: boolean; pipeline: StepResult; stages: StepResult[]; fields: StepResult[]; error?: string }> {
  const pl = await getPipelines();
  if (!pl.ok) return { ok: false, error: `Can't read pipelines: ${pl.error}`, pipeline: { name: BUY_PIPELINE, state: "error" }, stages: [], fields: [] };

  // 1) Pipeline
  let pipelineId = (pl.data || []).find((p) => p.name === BUY_PIPELINE)?.id;
  const pipeline: StepResult = { name: BUY_PIPELINE, state: pipelineId ? "exists" : dryRun ? "would-create" : "created" };
  if (!pipelineId && !dryRun) {
    const r = await pdPost<{ id: number }>("/pipelines", { name: BUY_PIPELINE });
    if (!r.ok || !r.data) { pipeline.state = "error"; pipeline.detail = r.error; return { ok: false, pipeline, stages: [], fields: [] }; }
    pipelineId = r.data.id;
  }

  // 2) Stages (in order). A newly-created pipeline may carry one default stage — we just
  // add ours by name; the stray default can be deleted by hand.
  const stages: StepResult[] = [];
  const existingStages = pipelineId ? (await getStages(pipelineId)).data || [] : [];
  for (let i = 0; i < BUY_STAGES.length; i++) {
    const nm = BUY_STAGES[i];
    const has = existingStages.some((s) => s.name === nm);
    if (has) { stages.push({ name: nm, state: "exists" }); continue; }
    if (dryRun || !pipelineId) { stages.push({ name: nm, state: "would-create" }); continue; }
    const r = await pdPost("/stages", { name: nm, pipeline_id: pipelineId, order_nr: i + 1 });
    stages.push({ name: nm, state: r.ok ? "created" : "error", detail: r.error });
  }

  // 3) Deal custom fields (dealFields are account-wide, not per-pipeline).
  const fields: StepResult[] = [];
  const existingFields = (await getDealFields()).data || [];
  for (const f of BUY_FIELDS) {
    const has = existingFields.some((ef) => ef.name === f.name);
    if (has) { fields.push({ name: f.name, state: "exists" }); continue; }
    if (dryRun) { fields.push({ name: f.name, state: "would-create", detail: f.field_type }); continue; }
    const body: Record<string, unknown> = { name: f.name, field_type: f.field_type };
    if (f.options) body.options = f.options.map((label) => ({ label }));
    const r = await pdPost("/dealFields", body);
    fields.push({ name: f.name, state: r.ok ? "created" : "error", detail: r.error || f.field_type });
  }

  const anyErr = pipeline.state === "error" || stages.some((s) => s.state === "error") || fields.some((f) => f.state === "error");
  return { ok: !anyErr, pipeline, stages, fields };
}
