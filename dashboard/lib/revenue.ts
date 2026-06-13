// Revenue report — the money end of the funnel, from the "Snagged Domain Tracker"
// Google Sheet (Payments tab). Each row is a payment line item:
//   Domain Names · Paid? · Confirmed Date · Anticipated Pay Date · Client Paid ($) ·
//   Client Paid Date · Snagged Cost · Snagged Paid Date · Transaction Fees ·
//   Commission · Payment Method · Type (Upfront/Success) · Buy/Sale · Lead
//
// "Upfront" (~$599) = the fee to take on the work; "Success" ($2,999+) = the fee
// when we land the acquisition. We aggregate over a [from, to] window by the
// Client Paid Date. Read-only via the service account (must be shared on the sheet).

import { getSheetValues } from "./sheets";

const SHEET_ID = process.env.SNAGGED_TRACKER_SHEET_ID || "1TVAJ2ef_rM03pHZ9rq8C3W4BgyiSBiOc5j7jAbFzGTA";
const RANGE = "Payments!A1:N2000";

export type LabelValue = { label: string; value: number };
export type RevenueReport = {
  totalRevenue: number; // NET — gross Client Paid minus the Snagged Cost we fronted
  gross: number;        // sum of Client Paid (before netting)
  snaggedCost: number;  // sum of Snagged Cost netted out (reimbursed outlay)
  payments: number;
  upfront: { count: number; amount: number };
  success: { count: number; amount: number };
  other: { count: number; amount: number };
  byType: LabelValue[]; // revenue $ by type (net)
  byOwner: LabelValue[]; // revenue $ by Lead/owner (net)
  monthly: { month: string; amount: number }[]; // net
};

export function revenueConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64);
}

function money(v: string | undefined): number {
  if (!v) return 0;
  const x = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

// Parse M/D/YYYY or M/D/YY (the sheet's date format) → YYYY-MM-DD, or "" if junk.
function parseDate(v: string | undefined): string {
  if (!v) return "";
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return "";
  let [, mo, d, y] = m;
  let yr = Number(y);
  if (yr < 100) yr += 2000;
  return `${yr}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function classifyType(t: string | undefined): "upfront" | "success" | "other" {
  const s = String(t || "").toLowerCase();
  if (s.startsWith("upf")) return "upfront";
  if (s.startsWith("suc")) return "success"; // covers the sheet's "Sucess" typo
  return "other";
}

// header name → column index (case/space tolerant)
function indexer(header: string[]): (name: string) => number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map(header.map((h, i) => [norm(h), i]));
  return (name: string) => map.get(norm(name)) ?? -1;
}

export async function revenueReport(from: string, to: string): Promise<RevenueReport> {
  const rows = await getSheetValues(SHEET_ID, RANGE);
  const empty: RevenueReport = {
    totalRevenue: 0, gross: 0, snaggedCost: 0, payments: 0, upfront: { count: 0, amount: 0 }, success: { count: 0, amount: 0 },
    other: { count: 0, amount: 0 }, byType: [], byOwner: [], monthly: [],
  };
  if (!rows.length) return empty;

  const header = rows[0];
  const col = indexer(header);
  const cPaid = col("Client Paid");
  const cDate = col("Client Paid Date");
  const cType = col("Type");
  const cLead = col("Lead");
  const cCost = col("Snagged Cost"); // outlay we fronted for the client (reimbursed in Client Paid)

  const acc = { ...empty, upfront: { count: 0, amount: 0 }, success: { count: 0, amount: 0 }, other: { count: 0, amount: 0 } };
  const ownerAmt = new Map<string, number>();
  const monthAmt = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[cDate]);
    if (!date || date < from || date > to) continue;
    const amount = money(r[cPaid]);
    if (amount === 0) continue;
    // Net out the Snagged Cost we fronted on this deal — Client Paid already
    // includes paying us back for it, so true revenue is Client Paid − Snagged Cost.
    const cost = cCost >= 0 ? money(r[cCost]) : 0;
    const net = amount - cost;
    const kind = classifyType(r[cType]);
    acc.gross += amount;
    acc.snaggedCost += cost;
    acc.totalRevenue += net;
    acc.payments += 1;
    acc[kind].count += 1;
    acc[kind].amount += net;
    const owner = (r[cLead] || "(unassigned)").trim() || "(unassigned)";
    ownerAmt.set(owner, (ownerAmt.get(owner) || 0) + net);
    const month = date.slice(0, 7);
    monthAmt.set(month, (monthAmt.get(month) || 0) + net);
  }

  acc.byType = [
    { label: "Upfront fees", value: acc.upfront.amount },
    { label: "Success fees", value: acc.success.amount },
    ...(acc.other.amount ? [{ label: "Other", value: acc.other.amount }] : []),
  ].filter((x) => x.value > 0);
  acc.byOwner = [...ownerAmt.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 15);
  acc.monthly = [...monthAmt.entries()].map(([month, amount]) => ({ month, amount })).sort((a, b) => (a.month < b.month ? -1 : 1));
  return acc;
}
