// Mailchimp (Marketing API v3) — server-only. Newsletter/email performance for the
// Reports module. Auth is HTTP Basic with any username + the API key as password;
// the data center is the suffix of the key (e.g. "...-us14" → us14).
//
// Env: MAILCHIMP_API_KEY (set in the snagged-admin Vercel project). No other config —
// we pick the largest audience automatically.

function config(): { key: string; dc: string } {
  const key = (process.env.MAILCHIMP_API_KEY || "").trim();
  const dc = key.includes("-") ? key.split("-").pop() || "" : "";
  return { key, dc };
}

export function mailchimpConfigured(): boolean {
  const { key, dc } = config();
  return Boolean(key && dc);
}

async function mc<T = unknown>(path: string): Promise<T> {
  const { key, dc } = config();
  if (!key || !dc) throw new Error("MAILCHIMP_API_KEY missing or malformed (expected '<key>-<dc>')");
  const auth = Buffer.from(`anystring:${key}`).toString("base64");
  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, {
    headers: { Authorization: `Basic ${auth}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Mailchimp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export type Campaign = { title: string; sendTime: string; sent: number; openRate: number; clickRate: number };
export type GrowthPoint = { month: string; optins: number; subscribed: number };
export type NewsletterReport = {
  audience: string;
  subscribers: number;
  unsubscribes: number;
  cleaned: number;
  openRate: number; // 0-1
  clickRate: number; // 0-1
  netSinceLastSend: number;
  campaigns: Campaign[];
  growth: GrowthPoint[];
};

type ListsResp = { lists?: { id: string; name: string; stats?: Record<string, unknown> }[] };
type ReportsResp = { reports?: { campaign_title?: string; subject_line?: string; emails_sent?: number; send_time?: string; opens?: { open_rate?: number }; clicks?: { click_rate?: number } }[] };
type GrowthResp = { history?: { month?: string; optins?: number; subscribed?: number }[] };

// Pull the primary audience's stats, the campaigns sent within [from, to], and the
// recent growth history. from/to are YYYY-MM-DD (sent-time window for campaigns).
export async function newsletterReport(from: string, to: string): Promise<NewsletterReport | null> {
  const listsResp = await mc<ListsResp>("/lists?count=50&fields=lists.id,lists.name,lists.stats");
  const lists = listsResp.lists || [];
  if (!lists.length) return null;
  // Largest audience by member count.
  const list = lists.slice().sort((a, b) => num(b.stats?.member_count) - num(a.stats?.member_count))[0];
  const s = list.stats || {};

  const params = new URLSearchParams({
    count: "30", sort_field: "send_time", sort_dir: "DESC",
    since_send_time: `${from}T00:00:00+00:00`, before_send_time: `${to}T23:59:59+00:00`,
    fields: "reports.campaign_title,reports.subject_line,reports.emails_sent,reports.send_time,reports.opens.open_rate,reports.clicks.click_rate",
  });
  const reportsResp = await mc<ReportsResp>(`/reports?${params.toString()}`).catch(() => ({ reports: [] }) as ReportsResp);
  // Growth history is best-effort (shape varies by plan/age).
  const growthResp = await mc<GrowthResp>(`/lists/${list.id}/growth-history?count=24&fields=history.month,history.optins,history.subscribed`).catch(() => ({ history: [] }) as GrowthResp);

  return {
    audience: list.name,
    subscribers: num(s.member_count),
    unsubscribes: num(s.unsubscribe_count),
    cleaned: num(s.cleaned_count),
    // Mailchimp returns LIST-level rates as percentages (e.g. 42.1) but CAMPAIGN
    // report rates as fractions (0.6). Normalize the list rates to fractions so the
    // client renders both with the same ×100.
    openRate: num(s.open_rate) / 100,
    clickRate: num(s.click_rate) / 100,
    netSinceLastSend: num(s.member_count_since_send),
    campaigns: (reportsResp.reports || []).map((r) => ({
      title: r.campaign_title || r.subject_line || "(untitled)",
      sendTime: (r.send_time || "").slice(0, 10),
      sent: num(r.emails_sent),
      openRate: num(r.opens?.open_rate),
      clickRate: num(r.clicks?.click_rate),
    })),
    growth: (growthResp.history || [])
      .map((h) => ({ month: h.month || "", optins: num(h.optins), subscribed: num(h.subscribed) }))
      .filter((h) => h.month)
      .sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}
