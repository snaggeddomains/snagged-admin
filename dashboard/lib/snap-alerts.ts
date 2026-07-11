// SNAP Names — "new untracked name" alerting. When an inventory rebuild finds a domain
// that (a) is newly present in a registrar account since the LAST snapshot and (b) is NOT
// on the SNAP sheet, that's a name we now hold but aren't tracking — surface it. The
// audit already shows ALL untracked names; this narrows to the NEW ones and pushes a
// bell + email so a fresh acquisition (e.g. a Porkbun buy, a caught drop) isn't missed.
//
// Never auto-adds anything to the sheet — it only notifies. Fail-open throughout.

import type { OwnedAt } from "./registrar/inventory";
import type { AccountStatus } from "./snap-inventory";
import { buildSnapNames } from "./snap-names";
import { listUsers } from "./users";
import { canReports } from "./permissions";
import { createNotification } from "./notifications";
import { sendEmail } from "./email";

export interface NewUntracked {
  domain: string;
  provider: string;
  label: string; // "Porkbun", "GoDaddy (rob)", …
  expires?: string | null;
}

const acctKey = (provider: string, account: string) => `${provider}|${account || ""}`;

// Which (provider|account) pairs were successfully listed in the PREVIOUS snapshot. A
// domain only counts as "new" under an account that was OK last time — otherwise a
// transient list failure last run would make its whole account look newly-acquired.
function okAccountKeys(accounts: AccountStatus[] | undefined): Set<string> {
  const s = new Set<string>();
  for (const a of accounts || []) if (a.ok) s.add(acctKey(a.provider, a.account));
  return s;
}

// Compute the newly-appeared, not-on-sheet, not-hidden names. Pure (no side effects) so
// it can be unit-checked; the caller persists + notifies.
export async function computeNewUntracked(
  prevOwned: Record<string, OwnedAt> | undefined,
  prevAccounts: AccountStatus[] | undefined,
  nowOwned: Record<string, OwnedAt>,
  hidden: Set<string>,
): Promise<NewUntracked[]> {
  // First-ever build (no prior owned) → establish a baseline, don't alert on everything.
  if (!prevOwned || !Object.keys(prevOwned).length) return [];
  const prevOk = okAccountKeys(prevAccounts);
  const report = await buildSnapNames().catch(() => null);
  const onSheet = new Set((report?.rows || []).map((r) => r.domain.toLowerCase()));
  const out: NewUntracked[] = [];
  for (const [domain, at] of Object.entries(nowOwned)) {
    if (prevOwned[domain]) continue; // already known last snapshot
    if (!prevOk.has(acctKey(at.provider, at.account))) continue; // account wasn't fully listed last time
    if (onSheet.has(domain) || hidden.has(domain)) continue; // tracked or intentionally hidden
    out.push({ domain, provider: at.provider, label: at.label, expires: at.expires ?? null });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Fire the bell + email for a set of new untracked names (best-effort, never throws).
export async function alertNewUntracked(names: NewUntracked[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!names.length) return;
  try {
    const users = (await listUsers()).filter((u) => canReports(u, "reports.snap_names"));
    const list = names.map((n) => `${n.domain} — ${n.label}`);
    const n = names.length;
    const title = n === 1 ? `New untracked domain: ${names[0].domain}` : `${n} new untracked domains detected`;
    const body = `Found in a registrar account but not on the SNAP list: ${list.slice(0, 8).join("; ")}${n > 8 ? `; +${n - 8} more` : ""}`;
    await createNotification(users.map((u) => u.id), { kind: "snap_untracked", title, body, link: "/reports/snap-names" });
    const to = users.map((u) => u.email).filter(Boolean) as string[];
    if (to.length) {
      const rows = names
        .map((x) => `<li><strong>${x.domain}</strong> — ${x.label}${x.expires ? ` · exp ${String(x.expires).slice(0, 10)}` : ""}</li>`)
        .join("");
      await sendEmail({
        to,
        subject: title,
        html: `<p>These domains are in a registrar account we control but are <strong>not on the SNAP list</strong>:</p><ul>${rows}</ul><p>Reconcile them in <a href="https://app.snagged.com/reports/snap-names">SNAP Names → Audit → “In an account, not on our list”</a>. Nothing was added automatically.</p>`,
      }).catch(() => false);
    }
  } catch {
    /* best-effort */
  }
}
