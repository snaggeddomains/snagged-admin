// SNAP Names bulk-update PREVIEW (dry-run). Given a set of domains, an action
// (set nameservers / set a DNS record), and a target, it resolves each domain's
// current registrar + nameservers and reports what WOULD change and which rows are
// skipped because their registrar/DNS-host isn't wired up. It performs NO writes.
// Gated by reports.snap_names.write (so viewers can't reach it).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { resolveDomainLive } from "@/lib/domain-dns";
import { PROVIDERS, providerForRegistrar, providerForNsHost, defaultNsForRegistrar } from "@/lib/registrar/registry";

export const runtime = "nodejs";
export const maxDuration = 60;

type Action = "nameservers" | "ns_default" | "dns";
interface DnsRecord {
  type: string;
  host: string;
  value: string;
  ttl?: number;
}

const norm = (arr: string[]) => [...arr].map((s) => s.trim().toLowerCase()).filter(Boolean).sort();

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names.write")) {
    return NextResponse.json({ error: "You don't have SNAP Names write access." }, { status: 403 });
  }

  let body: { domains?: unknown; action?: Action; nameservers?: unknown; record?: DnsRecord };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const domains = Array.isArray(body.domains)
    ? [...new Set(body.domains.map((d) => String(d || "").trim().toLowerCase()).filter((d) => d.includes(".")))].slice(0, 200)
    : [];
  const action: Action = body.action === "dns" ? "dns" : body.action === "ns_default" ? "ns_default" : "nameservers";
  const targetNs = action === "nameservers" ? norm((Array.isArray(body.nameservers) ? body.nameservers : []) as string[]) : [];
  const record = action === "dns" ? body.record : undefined;

  if (!domains.length) return NextResponse.json({ error: "No domains." }, { status: 400 });
  if (action === "nameservers" && targetNs.length < 1) return NextResponse.json({ error: "Enter at least one target nameserver." }, { status: 400 });
  if (action === "dns" && (!record || !record.type || !record.host)) return NextResponse.json({ error: "Enter a DNS record type + host." }, { status: 400 });

  const env = process.env;

  // Resolve current state with bounded concurrency.
  const results = await mapLimit(domains, 8, async (domain) => {
    const live = await resolveDomainLive(domain);
    if (action === "nameservers" || action === "ns_default") {
      const pid = providerForRegistrar(live.registrar);
      const prov = pid ? PROVIDERS[pid] : null;
      // ns_default → each name gets ITS OWN registrar's default nameservers.
      const target = action === "ns_default" ? norm(defaultNsForRegistrar(live.registrar) || []) : targetNs;
      const hasTarget = target.length > 0;
      const wired = !!(prov && prov.canNS && prov.hasKeys(env) && hasTarget);
      const current = norm(live.nameservers);
      const willChange = wired && JSON.stringify(current) !== JSON.stringify(target);
      let skipReason: string | null = null;
      if (!prov) skipReason = live.registrar ? `Registrar "${live.registrar}" has no adapter` : "Registrar unknown (no RDAP/WHOIS)";
      else if (!prov.hasKeys(env)) skipReason = `${prov.label} API key not configured`;
      else if (action === "ns_default" && !hasTarget) skipReason = `No fixed default nameservers for ${prov.label} (assigned per-domain)`;
      return {
        domain,
        registrar: live.registrar,
        provider: prov?.label || null,
        wired,
        willChange,
        noChange: wired && !willChange,
        current: live.nameservers,
        target,
        caveat: wired ? prov?.nsCaveat || null : null,
        skipReason,
      };
    }
    // DNS record: the DNS host is where the NS point, not necessarily the registrar.
    const pid = providerForNsHost(live.ns_provider);
    const prov = pid ? PROVIDERS[pid] : null;
    const wired = !!(prov && prov.canDNS && prov.hasKeys(env));
    let skipReason: string | null = null;
    if (!prov) skipReason = live.ns_provider ? `DNS host "${live.ns_provider}" has no adapter` : "DNS host unknown";
    else if (!prov.hasKeys(env)) skipReason = `${prov.label} API key not configured`;
    return {
      domain,
      registrar: live.registrar,
      dnsHost: live.ns_provider,
      provider: prov?.label || null,
      wired,
      willChange: wired,
      noChange: false,
      target: record,
      skipReason,
    };
  });

  const willUpdate = results.filter((r) => r.wired && r.willChange).length;
  const noChange = results.filter((r) => r.noChange).length;
  const skipped = results.filter((r) => !r.wired).length;

  return NextResponse.json({
    ok: true,
    dryRun: true, // live writes are not enabled yet
    action,
    summary: { total: results.length, willUpdate, noChange, skipped },
    results,
  });
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
