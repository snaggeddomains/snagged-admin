// Resolves our stable field NAMES → Pipedrive's opaque custom-field keys, enum LABELS →
// option IDs, and the pipeline/stage names → IDs, all at runtime (cached ~10 min). This is
// why we don't persist a config table — the setup script created the objects by name and
// we look them up here. Fail-open: a name that doesn't resolve is skipped, never throws.

import { getDealFields, getPipelines, getStages, getMe } from "./pipedrive";
import { BUY_PIPELINE } from "./pipedrive-setup";

type Resolved = {
  fieldKey: Map<string, string>;      // "Target Domain" -> "a1b2…"
  optionId: Map<string, number>;      // "Priority||High" -> 42
  fieldType: Map<string, string>;
  pipelineId?: number;
  stageId: Map<string, number>;       // "Assigned" -> 12
  companyDomain?: string;
  at: number;
};

let _cache: Resolved | null = null;

export async function resolvePipedrive(force = false): Promise<Resolved> {
  if (_cache && !force && Date.now() - _cache.at < 10 * 60 * 1000) return _cache;
  const [fields, pipelines, me] = await Promise.all([getDealFields(), getPipelines(), getMe()]);
  const fieldKey = new Map<string, string>();
  const optionId = new Map<string, number>();
  const fieldType = new Map<string, string>();
  for (const f of fields.data || []) {
    fieldKey.set(f.name, f.key);
    fieldType.set(f.name, f.field_type);
    for (const o of f.options || []) optionId.set(`${f.name}||${o.label}`, o.id);
  }
  const pipelineId = (pipelines.data || []).find((p) => p.name === BUY_PIPELINE)?.id;
  const stageId = new Map<string, number>();
  if (pipelineId) for (const s of (await getStages(pipelineId)).data || []) stageId.set(s.name, s.id);
  _cache = { fieldKey, optionId, fieldType, pipelineId, stageId, companyDomain: me.data?.company_domain, at: Date.now() };
  return _cache;
}

// Web URL for a deal (…pipedrive.com/deal/<id>). Falls back to app.pipedrive.com.
export function dealUrl(r: Resolved, id: number): string {
  const host = r.companyDomain ? `${r.companyDomain}.pipedrive.com` : "app.pipedrive.com";
  return `https://${host}/deal/${id}`;
}
