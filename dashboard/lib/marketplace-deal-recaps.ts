// One-shot LLM recap for a domain's deal threads: a one-line "what happened"
// outcome per thread + the real negotiated buyer OFFER (distinguished from our
// ask price, which regex can't do). One Anthropic call per report generation;
// the report is cached, so page loads never pay for it. Server-only.
//
// Model: DEAL_RECAP_MODEL (default Haiku — cheap, plenty for short extraction).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001";

export type ThreadRecap = { offer: string | null; outcome: string };
export type RecapItem = { idx: number; party: string; origin: "inbound" | "pitched"; subject: string; transcript: string };

const SYSTEM = (domain: string) =>
  `You analyze email threads about ${domain}, a domain we (Snagged, a domain broker) REPRESENT FOR SALE. ` +
  `Each thread is either an inbound buyer inquiry or our outbound pitch to a prospective buyer. ` +
  `For each thread, return:\n` +
  `- "outcome": a single factual clause (max 14 words) describing what happened / the current state — e.g. ` +
  `"Offered $8k, we countered at $20k, awaiting reply", "Went quiet after our reply", "Asked for price, no follow-up", ` +
  `"Declined — over budget", "Said our price was too high", "Not interested", "Agreed terms, moved to escrow". ` +
  `Capture the real result: did they make an offer, decline, balk at the price, or go quiet? No fluff, no quotes of email text.\n` +
  `- "offer": the BUYER's specific dollar offer if they named one, as "$12,000". This is what the BUYER offered to PAY — ` +
  `NEVER our asking/list price that we quoted them. null if the buyer never named an offer.\n` +
  `Return ONLY a JSON array: [{"idx":0,"outcome":"...","offer":"$X"|null}, ...] for every thread given.`;

function parseArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return []; }
}

export async function recapThreads(domain: string, items: RecapItem[], env: NodeJS.ProcessEnv): Promise<Map<number, ThreadRecap>> {
  const out = new Map<number, ThreadRecap>();
  const key = env.ANTHROPIC_API_KEY;
  if (!key || !items.length) return out;

  // Keep the payload bounded — cap threads and per-thread transcript length.
  const slice = items.slice(0, 40);
  const user =
    `Threads for ${domain}:\n\n` +
    slice
      .map((it) => `### idx ${it.idx} · ${it.origin} · party: ${it.party}\nSubject: ${it.subject}\n${it.transcript.slice(0, 1400)}`)
      .join("\n\n");

  let text = "";
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM(domain), messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
  } catch {
    return out;
  }

  for (const row of parseArray(text)) {
    if (!row || typeof row !== "object") continue;
    const r = row as { idx?: number; outcome?: string; offer?: string | null };
    if (typeof r.idx !== "number") continue;
    const offer = r.offer && /\d/.test(String(r.offer)) ? String(r.offer).trim() : null;
    const outcome = (r.outcome || "").toString().trim().slice(0, 140);
    if (outcome || offer) out.set(r.idx, { offer, outcome });
  }
  return out;
}
