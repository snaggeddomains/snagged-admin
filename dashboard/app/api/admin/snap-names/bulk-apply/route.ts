// SNAP Names bulk APPLY — performs the real registrar writes previewed by
// bulk-preview. Gated by reports.snap_names.write. Re-resolves each domain's current
// state, writes via the provider adapter, logs every attempt to the audit table, and
// busts the live cache so the report reflects the change. Bounded concurrency.
//
// DESTRUCTIVE: changes live nameservers / DNS on production domains. The client
// requires an explicit confirm before calling this.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { resolveDomainLive, invalidateLive } from "@/lib/domain-dns";
import { PROVIDERS, providerForRegistrar, providerForNsHost, defaultNsForRegistrar } from "@/lib/registrar/registry";
import { setNameservers, setDnsRecord, nsExecutable, type DnsRecordInput } from "@/lib/registrar/adapters";
import { logWrite } from "@/lib/snap-writes";

export const runtime = "nodejs";
export const maxDuration = 60;

type Action = "nameservers" | "ns_default" | "dns";
const norm = (arr: string[]) => [...arr].map((s) => s.trim().toLowerCase()).filter(Boolean).sort();
const MAX_APPLY = 100;

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names.write")) {
    return NextResponse.json({ error: "You don't have SNAP Names write access." }, { status: 403 });
  }
  const by = me.email || null;

  let body: { domains?: unknown; action?: Action; nameservers?: unknown; record?: DnsRecordInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const domains = Array.isArray(body.domains)
    ? [...new Set(body.domains.map((d) => String(d || "").trim().toLowerCase()).filter((d) => d.includes(".")))].slice(0, MAX_APPLY)
    : [];
  const action: Action = body.action === "dns" ? "dns" : body.action === "ns_default" ? "ns_default" : "nameservers";
  const inputNs = action === "nameservers" ? norm((Array.isArray(body.nameservers) ? body.nameservers : []) as string[]) : [];
  const record = action === "dns" ? body.record : undefined;

  if (!domains.length) return NextResponse.json({ error: "No domains." }, { status: 400 });
  if (action === "nameservers" && inputNs.length < 1) return NextResponse.json({ error: "No target nameservers." }, { status: 400 });
  if (action === "dns" && (!record || !record.type || !record.host)) return NextResponse.json({ error: "No DNS record." }, { status: 400 });

  const env = process.env;

  const results = await mapLimit(domains, 4, async (domain) => {
    const live = await resolveDomainLive(domain);

    if (action === "nameservers" || action === "ns_default") {
      const pid = providerForRegistrar(live.registrar);
      const prov = pid ? PROVIDERS[pid] : null;
      const target = action === "ns_default" ? norm(defaultNsForRegistrar(live.registrar) || []) : inputNs;
      if (!prov || !prov.hasKeys(env)) return { domain, ok: false, skipped: true, provider: prov?.label || null, error: !prov ? "registrar not wired" : `${prov.label} key not configured` };
      if (!pid || !nsExecutable(pid)) return { domain, ok: false, skipped: true, provider: prov.label, error: `${prov.label} execute not enabled yet` };
      if (!target.length) return { domain, ok: false, skipped: true, provider: prov.label, error: "no default nameservers for this registrar" };
      if (JSON.stringify(norm(live.nameservers)) === JSON.stringify(target)) return { domain, ok: true, noChange: true, provider: prov.label, from: live.nameservers, to: target };

      const r = await setNameservers(pid, domain, target, env);
      await logWrite({ domain, provider: prov.label, account: r.account, action: "nameservers", from_ns: live.nameservers, to_ns: target, ok: r.ok, error: r.error, changed_by: by });
      if (r.ok) invalidateLive(domain);
      return { domain, ok: r.ok, provider: prov.label, account: r.account || null, from: live.nameservers, to: target, error: r.error || null };
    }

    // DNS record → the DNS host (where NS point), not the registrar.
    const pid = providerForNsHost(live.ns_provider);
    const prov = pid ? PROVIDERS[pid] : null;
    if (!prov || !prov.hasKeys(env)) return { domain, ok: false, skipped: true, provider: prov?.label || null, error: prov ? `${prov.label} key not configured` : `DNS host "${live.ns_provider || "unknown"}" has no adapter` };
    const r = await setDnsRecord(pid!, domain, record as DnsRecordInput, env);
    await logWrite({ domain, provider: prov.label, action: "dns", record, ok: r.ok, error: r.error, changed_by: by });
    return { domain, ok: r.ok, provider: prov.label, error: r.error || null };
  });

  const applied = results.filter((r) => r.ok && !r.noChange && !r.skipped).length;
  const noChange = results.filter((r) => r.noChange).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  return NextResponse.json({ ok: true, action, summary: { total: results.length, applied, noChange, failed, skipped }, results });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
